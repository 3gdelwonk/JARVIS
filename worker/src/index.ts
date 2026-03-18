/**
 * Cloudflare Worker — Lactalis portal proxy
 *
 * Routes:
 *   POST /login          — authenticate with Lactalis, return session token
 *   GET  /schedule       — proxy delivery schedule (checks KV cache first)
 *   POST /submit-order   — proxy quick-order submission (falls back to extension relay)
 *   GET  /debug-login    — diagnostic: shows what the login page looks like
 *   GET  /health         — simple liveness check
 *
 * Extension cloud sync routes (auth'd with EXTENSION_SECRET or session token):
 *   POST /extension/schedule       — extension pushes scraped schedule → KV
 *   GET  /extension/pending-order  — extension polls for pending orders
 *   POST /extension/order-result   — extension pushes submission result
 *   POST /extension/cookies        — extension pushes Lactalis cookies
 *   GET  /extension/order-status   — PWA polls for order completion
 *
 * Auth: PWA sends `Authorization: Bearer <sessionToken>` for protected routes.
 * The Worker stores Lactalis session cookies in KV, keyed by sessionToken.
 *
 * Note: Lactalis is behind Cloudflare. Worker→Cloudflare subrequests can fail
 * with error 1016 (origin DNS error). We work around this by resolving DNS
 * via DoH and fetching by IP with the Host header.
 */

export interface Env {
  SESSIONS: KVNamespace
  LACTALIS_BASE: string
  SLOT_CONFIG_ID: string
  ALLOWED_ORIGIN?: string
  EXTENSION_SECRET?: string
}

interface SessionData {
  cookies: string
  expiresAt: number // Unix ms
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function corsHeaders(origin: string, env: Env): Record<string, string> {
  const envAllowed = env.ALLOWED_ORIGIN || 'https://3gdelwonk.github.io'
  if (envAllowed === '*') {
    return {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    }
  }
  const allowList = new Set([
    envAllowed,
    'https://mylactalis.com.au',
    'https://my.lactalis.com.au',
    'https://www.mylactalis.com.au',
  ])
  // Allow Chrome extension origins (chrome-extension://...)
  const isExtension = origin.startsWith('chrome-extension://')
  const effectiveOrigin = allowList.has(origin) || isExtension ? origin : envAllowed
  return {
    'Access-Control-Allow-Origin': effectiveOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }
}

function jsonResponse(data: unknown, status: number, origin: string, env: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin, env),
    },
  })
}

function generateToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Extract all Set-Cookie values and merge into a single cookie header string. */
function extractCookies(response: Response): string {
  const cookies: string[] = []
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const nameVal = header.split(';')[0]
    if (nameVal) cookies.push(nameVal.trim())
  }
  return cookies.join('; ')
}

// ─── DNS resolution + fetch bypass for Cloudflare→Cloudflare ─────────────────

/** Cache resolved IPs for 10 minutes to avoid hammering DoH on every request. */
const dnsCache = new Map<string, { ip: string; expiresAt: number }>()

/**
 * Resolve a hostname to an IP via Cloudflare DNS-over-HTTPS.
 * This is needed because Worker→Cloudflare-proxied-origin requests fail with error 1016.
 */
async function resolveHost(hostname: string): Promise<string | null> {
  const cached = dnsCache.get(hostname)
  if (cached && cached.expiresAt > Date.now()) return cached.ip

  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      { headers: { 'Accept': 'application/dns-json' } },
    )
    const data = await res.json() as { Answer?: Array<{ type: number; data: string }> }
    const aRecord = data.Answer?.find((r) => r.type === 1)
    if (aRecord?.data) {
      dnsCache.set(hostname, { ip: aRecord.data, expiresAt: Date.now() + 600_000 })
      return aRecord.data
    }
  } catch {
    // Fall through
  }

  // Fallback: try Google DoH
  try {
    const res = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`,
    )
    const data = await res.json() as { Answer?: Array<{ type: number; data: string }> }
    const aRecord = data.Answer?.find((r) => r.type === 1)
    if (aRecord?.data) {
      dnsCache.set(hostname, { ip: aRecord.data, expiresAt: Date.now() + 600_000 })
      return aRecord.data
    }
  } catch {
    // Fall through
  }

  return null
}

/**
 * Fetch a URL, working around Cloudflare error 1016 by resolving DNS manually
 * and connecting to the origin IP with a Host header.
 */
async function proxyFetch(url: string, init: RequestInit = {}): Promise<Response> {
  // First, try a normal fetch
  const directRes = await fetch(url, init)

  // If we get a Cloudflare error (530/1016), retry via IP
  if (directRes.status === 530) {
    const parsed = new URL(url)
    const ip = await resolveHost(parsed.hostname)
    if (!ip) throw new Error(`DNS resolution failed for ${parsed.hostname}`)

    // Rewrite URL to use IP, add Host header
    const ipUrl = `${parsed.protocol}//${ip}${parsed.pathname}${parsed.search}`
    const headers = new Headers(init.headers as HeadersInit)
    headers.set('Host', parsed.hostname)

    return fetch(ipUrl, {
      ...init,
      headers,
    })
  }

  return directRes
}

/** Retrieve a valid session from KV, or null if expired/missing. */
async function getSession(token: string | null, env: Env): Promise<SessionData | null> {
  if (!token) return null
  const raw = await env.SESSIONS.get(token)
  if (!raw) return null
  try {
    const session: SessionData = JSON.parse(raw)
    if (session.expiresAt < Date.now()) {
      await env.SESSIONS.delete(token)
      return null
    }
    return session
  } catch {
    return null
  }
}

function bearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7).trim() || null
}

function isExtensionAuthed(request: Request, env: Env): boolean {
  const secret = env.EXTENSION_SECRET
  if (!secret) return false
  return bearerToken(request) === secret
}

/** Detect Incapsula bot-protection block in response HTML. */
function isIncapsulaBlocked(html: string): boolean {
  return html.includes('_Incapsula_Resource')
    || html.includes('incap_ses')
    || html.includes('Request unsuccessful')
    || html.includes('Incapsula incident')
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleLogin(request: Request, env: Env, origin: string): Promise<Response> {
  let body: { username?: string; password?: string }
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, origin, env)
  }

  const { username, password } = body
  if (!username || !password) {
    return jsonResponse({ error: 'username and password required' }, 400, origin, env)
  }

  const base = env.LACTALIS_BASE

  // Step 1: GET the login page to obtain a CSRF token + initial cookies
  let loginPageRes: Response
  try {
    loginPageRes = await proxyFetch(`${base}/customer/user/login`, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
  } catch (e) {
    return jsonResponse({ error: `Cannot reach Lactalis: ${(e as Error).message}` }, 502, origin, env)
  }

  const loginPageCookies = extractCookies(loginPageRes)
  const loginHtml = await loginPageRes.text()

  // If we got redirected, follow to get the actual login page
  if (loginPageRes.status >= 300 && loginPageRes.status < 400) {
    const redirectUrl = loginPageRes.headers.get('Location') ?? ''
    const fullRedirectUrl = redirectUrl.startsWith('http') ? redirectUrl : `${base}${redirectUrl}`
    try {
      const redirectRes = await proxyFetch(fullRedirectUrl, {
        redirect: 'manual',
        headers: { 'Cookie': loginPageCookies, 'User-Agent': 'Mozilla/5.0' },
      })
      const redirectHtml = await redirectRes.text()
      const redirectCookies = extractCookies(redirectRes)
      return doLogin(username, password, redirectHtml,
        [loginPageCookies, redirectCookies].filter(Boolean).join('; '),
        base, env, origin)
    } catch {
      // Fall through to use original page
    }
  }

  return doLogin(username, password, loginHtml, loginPageCookies, base, env, origin)
}

async function doLogin(
  username: string, password: string, loginHtml: string, cookies: string,
  base: string, env: Env, origin: string,
): Promise<Response> {
  // Extract CSRF token from form — try multiple patterns
  const csrfMatch = loginHtml.match(/name="_csrf_token"\s+value="([^"]+)"/)
    ?? loginHtml.match(/name="_csrf_token"[^>]*value="([^"]+)"/)
    ?? loginHtml.match(/value="([^"]+)"[^>]*name="_csrf_token"/)
    ?? loginHtml.match(/csrf[_-]?token[^"]*"[^"]*value="([^"]+)"/)
    ?? loginHtml.match(/name="([^"]*token[^"]*)"[^>]*value="([^"]+)"/)
  const csrfToken = csrfMatch?.[2] ?? csrfMatch?.[1] ?? ''

  // Detect form field names from actual HTML
  const usernameField = loginHtml.match(/name="([^"]*username[^"]*)"/)
  const passwordField = loginHtml.match(/name="([^"]*password[^"]*)"/)
  const usernameKey = usernameField?.[1] ?? '_username'
  const passwordKey = passwordField?.[1] ?? '_password'

  // Find the actual form action URL
  const formAction = loginHtml.match(/form[^>]*action="([^"]+)"[^>]*method="post"/i)
    ?? loginHtml.match(/method="post"[^>]*action="([^"]+)"/i)
  const loginUrl = formAction?.[1]
    ? (formAction[1].startsWith('http') ? formAction[1] : `${base}${formAction[1]}`)
    : `${base}/customer/user/login-check`

  // Build form body
  const params: Record<string, string> = {
    [usernameKey]: username,
    [passwordKey]: password,
  }
  if (csrfToken) params['_csrf_token'] = csrfToken

  const formBody = new URLSearchParams(params)

  const loginRes = await proxyFetch(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookies,
      'User-Agent': 'Mozilla/5.0',
      'Referer': `${base}/customer/user/login`,
    },
    body: formBody.toString(),
    redirect: 'manual',
  })

  // Collect cookies from login response
  const postCookies = extractCookies(loginRes)
  const allCookies = [cookies, postCookies].filter(Boolean).join('; ')

  const location = loginRes.headers.get('Location') ?? ''

  // Failure detection
  const isRedirectToLogin = location.includes('/login') && !location.includes('/login-check')
  const isClientError = loginRes.status >= 400

  if (isClientError) {
    return jsonResponse({
      error: 'Login failed — check username/password',
      debug: { status: loginRes.status, location, csrfFound: !!csrfToken, loginUrl, usernameKey, passwordKey },
    }, 401, origin, env)
  }

  if (isRedirectToLogin) {
    return jsonResponse({
      error: 'Login failed — Lactalis redirected back to login page',
      debug: { status: loginRes.status, location, csrfFound: !!csrfToken, loginUrl },
    }, 401, origin, env)
  }

  // Follow redirect to confirm session
  let finalCookies = allCookies
  if (location) {
    const fullUrl = location.startsWith('http') ? location : `${base}${location}`
    try {
      const dashRes = await proxyFetch(fullUrl, {
        headers: { 'Cookie': allCookies, 'User-Agent': 'Mozilla/5.0' },
        redirect: 'manual',
      })
      finalCookies = [allCookies, extractCookies(dashRes)].filter(Boolean).join('; ')
    } catch {
      // Non-fatal — proceed with cookies we have
    }
  }

  // Store session in KV (24h TTL)
  const sessionToken = generateToken()
  const session: SessionData = {
    cookies: finalCookies,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  }
  await env.SESSIONS.put(sessionToken, JSON.stringify(session), { expirationTtl: 86400 })

  return jsonResponse({ sessionToken, expiresAt: session.expiresAt }, 200, origin, env)
}

async function handleSchedule(request: Request, env: Env, origin: string): Promise<Response> {
  // Check KV cache first (populated by extension cloud sync)
  const cached = await env.SESSIONS.get('schedule:latest')
  if (cached) {
    try {
      const data = JSON.parse(cached)
      return jsonResponse({ ...data, source: 'cloud-cache' }, 200, origin, env)
    } catch {
      // Corrupted cache — fall through to live fetch
    }
  }

  const session = await getSession(bearerToken(request), env)
  if (!session) {
    return jsonResponse({ error: 'Not authenticated' }, 401, origin, env)
  }

  const base = env.LACTALIS_BASE
  const slotId = env.SLOT_CONFIG_ID

  const res = await proxyFetch(
    `${base}/delivery-slots/get-slots/${slotId}?preselectCurrentSlot=1`,
    {
      headers: {
        'Cookie': session.cookies,
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json, text/html, */*',
        'X-Requested-With': 'XMLHttpRequest',
      },
    },
  )

  if (!res.ok) {
    return jsonResponse(
      { error: `Lactalis returned ${res.status}` },
      res.status === 401 || res.status === 403 ? 401 : 502,
      origin, env,
    )
  }

  const contentType = res.headers.get('Content-Type') ?? ''

  if (contentType.includes('application/json')) {
    const data = await res.json()
    return jsonResponse(data, 200, origin, env)
  }

  const html = await res.text()

  // Detect Incapsula block — return cached if available, else 503
  if (isIncapsulaBlocked(html)) {
    return jsonResponse(
      { error: 'Blocked by Incapsula — schedule will be provided by extension cloud sync' },
      503, origin, env,
    )
  }

  const slots = parseScheduleHtml(html)
  return jsonResponse({ slots, raw: html.length > 10000 ? '(truncated)' : html }, 200, origin, env)
}

function parseScheduleHtml(html: string): Array<{ deliveryDate: string; cutoffDate?: string; cutoffTime?: string }> {
  const slots: Array<{ deliveryDate: string; cutoffDate?: string; cutoffTime?: string }> = []

  const dateRegex = /(\d{4}-\d{2}-\d{2})/g
  const seen = new Set<string>()

  for (const m of html.matchAll(dateRegex)) {
    const date = m[1]
    if (!seen.has(date)) {
      seen.add(date)
      slots.push({ deliveryDate: date })
    }
  }

  const auDateRegex = /(\d{1,2})\/(\d{1,2})\/(\d{4})/g
  for (const m of html.matchAll(auDateRegex)) {
    const date = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
    if (!seen.has(date)) {
      seen.add(date)
      slots.push({ deliveryDate: date })
    }
  }

  return slots.sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate))
}

async function handleSubmitOrder(request: Request, env: Env, origin: string): Promise<Response> {
  const session = await getSession(bearerToken(request), env)
  if (!session) {
    return jsonResponse({ error: 'Not authenticated' }, 401, origin, env)
  }

  let body: { lines?: Array<{ itemNumber: string; qty: number }> }
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, origin, env)
  }

  if (!body.lines?.length) {
    return jsonResponse({ error: 'lines array required' }, 400, origin, env)
  }

  const base = env.LACTALIS_BASE

  const pageRes = await proxyFetch(`${base}/customer/product/quick-add/`, {
    headers: {
      'Cookie': session.cookies,
      'User-Agent': 'Mozilla/5.0',
    },
  })

  if (!pageRes.ok) {
    return jsonResponse(
      { error: `Failed to load quick-order page (${pageRes.status})` },
      pageRes.status === 401 || pageRes.status === 403 ? 401 : 502,
      origin, env,
    )
  }

  const pageHtml = await pageRes.text()
  const csrfMatch = pageHtml.match(/name="([^"]*csrf[^"]*)"[^>]*value="([^"]+)"/)
    ?? pageHtml.match(/name="_token"[^>]*value="([^"]+)"/)
  const csrfName = csrfMatch?.[1] ?? '_token'
  const csrfValue = csrfMatch?.[2] ?? csrfMatch?.[1] ?? ''

  const pageCookies = extractCookies(pageRes)
  const mergedCookies = [session.cookies, pageCookies].filter(Boolean).join('; ')

  const pasteString = body.lines
    .filter((l) => l.qty > 0)
    .map((l) => `${l.itemNumber},${l.qty}`)
    .join(';')

  const formData = new FormData()
  formData.append(csrfName, csrfValue)
  formData.append('oro_product_quick_add[component]', 'autocomplete')
  formData.append('oro_product_quick_add[products]', pasteString)

  const submitRes = await proxyFetch(`${base}/customer/product/quick-add/`, {
    method: 'POST',
    headers: {
      'Cookie': mergedCookies,
      'User-Agent': 'Mozilla/5.0',
    },
    body: formData,
    redirect: 'manual',
  })

  const submitCookies = extractCookies(submitRes)
  const location = submitRes.headers.get('Location') ?? ''

  const updatedCookies = [mergedCookies, submitCookies].filter(Boolean).join('; ')
  const updatedSession: SessionData = { ...session, cookies: updatedCookies }
  const token = bearerToken(request)!
  await env.SESSIONS.put(token, JSON.stringify(updatedSession), {
    expirationTtl: Math.max(1, Math.round((session.expiresAt - Date.now()) / 1000)),
  })

  if (submitRes.status >= 300 && submitRes.status < 400) {
    return jsonResponse({
      success: true,
      redirect: location,
      itemCount: body.lines.length,
    }, 200, origin, env)
  }

  if (submitRes.ok) {
    // Check if the response is actually an Incapsula block page
    const responseHtml = await submitRes.clone().text()
    if (isIncapsulaBlocked(responseHtml)) {
      return queueOrderForExtension(body.lines, env, origin)
    }
    return jsonResponse({
      success: true,
      itemCount: body.lines.length,
    }, 200, origin, env)
  }

  // On failure, try extension relay as fallback
  return queueOrderForExtension(body.lines, env, origin)
}

/** Queue order in KV for the extension to pick up and submit via real browser. */
async function queueOrderForExtension(
  lines: Array<{ itemNumber: string; qty: number }>,
  env: Env,
  origin: string,
): Promise<Response> {
  const orderId = `cloud-${Date.now()}`
  const pendingOrder = {
    orderId,
    lines,
    status: 'pending',
    queuedAt: Date.now(),
  }
  await env.SESSIONS.put('pending-order:latest', JSON.stringify(pendingOrder), {
    expirationTtl: 3600, // 1h TTL
  })
  return jsonResponse({ queued: true, orderId, itemCount: lines.length }, 202, origin, env)
}

async function handleDebugLogin(env: Env, origin: string): Promise<Response> {
  const base = env.LACTALIS_BASE
  const hostname = new URL(base).hostname

  // Step 1: resolve DNS
  const ip = await resolveHost(hostname)

  // Step 2: fetch login page (with IP fallback)
  try {
    const res = await proxyFetch(`${base}/customer/user/login`, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })

    const status = res.status
    const location = res.headers.get('Location')
    const cookies = extractCookies(res)
    const html = await res.text()

    const csrfMatch = html.match(/name="_csrf_token"\s+value="([^"]+)"/)
      ?? html.match(/name="_csrf_token"[^>]*value="([^"]+)"/)
      ?? html.match(/value="([^"]+)"[^>]*name="_csrf_token"/)
    const formAction = html.match(/form[^>]*action="([^"]+)"[^>]*method="post"/i)
      ?? html.match(/method="post"[^>]*action="([^"]+)"/i)
    const usernameField = html.match(/name="([^"]*username[^"]*)"/)
    const passwordField = html.match(/name="([^"]*password[^"]*)"/)

    return jsonResponse({
      resolvedIp: ip,
      loginPageStatus: status,
      redirectLocation: location,
      cookiesReceived: cookies.length > 0,
      csrfTokenFound: !!csrfMatch,
      csrfToken: csrfMatch?.[1] ? `${csrfMatch[1].slice(0, 8)}...` : null,
      formAction: formAction?.[1] ?? null,
      usernameFieldName: usernameField?.[1] ?? null,
      passwordFieldName: passwordField?.[1] ?? null,
      htmlLength: html.length,
      htmlTitle: html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? null,
      htmlSnippet: html.slice(0, 2000),
    }, 200, origin, env)
  } catch (e) {
    return jsonResponse({
      error: `Cannot reach Lactalis: ${(e as Error).message}`,
      resolvedIp: ip,
    }, 502, origin, env)
  }
}

// ─── Extension cloud sync handlers ────────────────────────────────────────────

/** POST /extension/schedule — extension pushes scraped schedule to KV */
async function handleExtensionSchedulePush(request: Request, env: Env, origin: string): Promise<Response> {
  if (!isExtensionAuthed(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401, origin, env)
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, origin, env)
  }
  await env.SESSIONS.put('schedule:latest', JSON.stringify(body), {
    expirationTtl: 86400, // 24h TTL
  })
  return jsonResponse({ ok: true }, 200, origin, env)
}

/** GET /extension/pending-order — extension polls for pending orders */
async function handleExtensionPendingOrder(request: Request, env: Env, origin: string): Promise<Response> {
  if (!isExtensionAuthed(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401, origin, env)
  }
  const raw = await env.SESSIONS.get('pending-order:latest')
  if (!raw) {
    return jsonResponse({ order: null }, 200, origin, env)
  }
  try {
    const order = JSON.parse(raw)
    return jsonResponse({ order }, 200, origin, env)
  } catch {
    return jsonResponse({ order: null }, 200, origin, env)
  }
}

/** POST /extension/order-result — extension pushes submission result */
async function handleExtensionOrderResult(request: Request, env: Env, origin: string): Promise<Response> {
  if (!isExtensionAuthed(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401, origin, env)
  }
  let body: { orderId?: string; success?: boolean; lactalisRef?: string; error?: string }
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, origin, env)
  }

  // Update the pending order status in KV
  const raw = await env.SESSIONS.get('pending-order:latest')
  if (raw) {
    try {
      const order = JSON.parse(raw)
      order.status = body.success ? 'completed' : 'failed'
      order.lactalisRef = body.lactalisRef ?? null
      order.error = body.error ?? null
      order.completedAt = Date.now()
      await env.SESSIONS.put('pending-order:latest', JSON.stringify(order), {
        expirationTtl: 3600, // Keep result for 1h
      })
    } catch {
      // Ignore parse errors
    }
  }

  return jsonResponse({ ok: true }, 200, origin, env)
}

/** POST /extension/cookies — extension pushes Lactalis session cookies */
async function handleExtensionCookies(request: Request, env: Env, origin: string): Promise<Response> {
  if (!isExtensionAuthed(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401, origin, env)
  }
  let body: { cookies?: string }
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, origin, env)
  }
  if (!body.cookies) {
    return jsonResponse({ error: 'cookies required' }, 400, origin, env)
  }
  await env.SESSIONS.put('cookies:lactalis', body.cookies, {
    expirationTtl: 3600, // 1h TTL
  })
  return jsonResponse({ ok: true }, 200, origin, env)
}

/** GET /extension/order-status — PWA polls for order completion */
async function handleExtensionOrderStatus(request: Request, env: Env, origin: string): Promise<Response> {
  // Require either a valid session token or extension secret
  const token = bearerToken(request)
  const session = await getSession(token, env)
  if (!session && !isExtensionAuthed(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401, origin, env)
  }
  const raw = await env.SESSIONS.get('pending-order:latest')
  if (!raw) {
    return jsonResponse({ order: null }, 200, origin, env)
  }
  try {
    const order = JSON.parse(raw)
    return jsonResponse({
      orderId: order.orderId,
      status: order.status,
      lactalisRef: order.lactalisRef ?? null,
      error: order.error ?? null,
      queuedAt: order.queuedAt,
      completedAt: order.completedAt ?? null,
    }, 200, origin, env)
  } catch {
    return jsonResponse({ order: null }, 200, origin, env)
  }
}

// ─── Main fetch handler ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin') ?? ''

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) })
    }

    try {
      switch (url.pathname) {
        case '/login':
          if (request.method !== 'POST') break
          return handleLogin(request, env, origin)

        case '/schedule':
          if (request.method !== 'GET') break
          return handleSchedule(request, env, origin)

        case '/submit-order':
          if (request.method !== 'POST') break
          return handleSubmitOrder(request, env, origin)

        case '/debug-login':
          if (request.method !== 'GET') break
          if (!isExtensionAuthed(request, env)) {
            return jsonResponse({ error: 'Unauthorized' }, 401, origin, env)
          }
          return handleDebugLogin(env, origin)

        case '/health':
          return jsonResponse({ ok: true, time: Date.now() }, 200, origin, env)

        // Extension cloud sync routes
        case '/extension/schedule':
          if (request.method !== 'POST') break
          return handleExtensionSchedulePush(request, env, origin)

        case '/extension/pending-order':
          if (request.method !== 'GET') break
          return handleExtensionPendingOrder(request, env, origin)

        case '/extension/order-result':
          if (request.method !== 'POST') break
          return handleExtensionOrderResult(request, env, origin)

        case '/extension/cookies':
          if (request.method !== 'POST') break
          return handleExtensionCookies(request, env, origin)

        case '/extension/order-status':
          if (request.method !== 'GET') break
          return handleExtensionOrderStatus(request, env, origin)
      }

      return jsonResponse({ error: 'Not found' }, 404, origin, env)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error'
      return jsonResponse({ error: message }, 500, origin, env)
    }
  },
}
