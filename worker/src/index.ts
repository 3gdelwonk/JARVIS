/**
 * Cloudflare Worker — Lactalis portal proxy
 *
 * Routes:
 *   POST /login          — authenticate with Lactalis, return session token
 *   GET  /schedule       — proxy delivery schedule
 *   POST /submit-order   — proxy quick-order submission
 *   GET  /health         — simple liveness check
 *
 * Auth: PWA sends `Authorization: Bearer <sessionToken>` for protected routes.
 * The Worker stores Lactalis session cookies in KV, keyed by sessionToken.
 */

export interface Env {
  SESSIONS: KVNamespace
  LACTALIS_BASE: string
  SLOT_CONFIG_ID: string
  ALLOWED_ORIGIN?: string
}

interface SessionData {
  cookies: string
  expiresAt: number // Unix ms
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function corsHeaders(origin: string, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGIN || '*'
  return {
    'Access-Control-Allow-Origin': allowed === '*' ? (origin || '*') : allowed,
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
  // Response.headers.getSetCookie() is available in Workers runtime
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const nameVal = header.split(';')[0]
    if (nameVal) cookies.push(nameVal.trim())
  }
  return cookies.join('; ')
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
  const loginPageRes = await fetch(`${base}/customer/user/login`, {
    redirect: 'manual',
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  const loginPageCookies = extractCookies(loginPageRes)
  const loginHtml = await loginPageRes.text()

  // Extract CSRF token from form
  const csrfMatch = loginHtml.match(/name="_csrf_token"\s+value="([^"]+)"/)
    ?? loginHtml.match(/csrf[_-]?token[^"]*"[^"]*value="([^"]+)"/)
  const csrfToken = csrfMatch?.[1] ?? ''

  // Step 2: POST credentials
  const formBody = new URLSearchParams({
    '_username': username,
    '_password': password,
    '_csrf_token': csrfToken,
  })

  const loginRes = await fetch(`${base}/customer/user/login-check`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': loginPageCookies,
      'User-Agent': 'Mozilla/5.0',
    },
    body: formBody.toString(),
    redirect: 'manual',
  })

  // Collect cookies from login response (merged with initial ones)
  const postCookies = extractCookies(loginRes)
  const allCookies = [loginPageCookies, postCookies].filter(Boolean).join('; ')

  // OroCommerce redirects to /customer/user/login on failure, /customer on success
  const location = loginRes.headers.get('Location') ?? ''
  const isLoginPage = location.includes('/login') && !location.includes('/login-check')
  if (loginRes.status >= 400 || isLoginPage) {
    return jsonResponse({ error: 'Login failed — check username/password' }, 401, origin, env)
  }

  // Step 3: Follow redirect to confirm session is live
  const dashRes = await fetch(location.startsWith('http') ? location : `${base}${location}`, {
    headers: { 'Cookie': allCookies, 'User-Agent': 'Mozilla/5.0' },
    redirect: 'manual',
  })
  const finalCookies = [allCookies, extractCookies(dashRes)].filter(Boolean).join('; ')

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
  const session = await getSession(bearerToken(request), env)
  if (!session) {
    return jsonResponse({ error: 'Not authenticated' }, 401, origin, env)
  }

  const base = env.LACTALIS_BASE
  const slotId = env.SLOT_CONFIG_ID

  const res = await fetch(
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

  // The endpoint may return JSON or HTML (with embedded slot data)
  if (contentType.includes('application/json')) {
    const data = await res.json()
    return jsonResponse(data, 200, origin, env)
  }

  // Parse HTML response for delivery slot information
  const html = await res.text()
  const slots = parseScheduleHtml(html)
  return jsonResponse({ slots, raw: html.length > 10000 ? '(truncated)' : html }, 200, origin, env)
}

/** Best-effort parse of the delivery schedule HTML for slot dates. */
function parseScheduleHtml(html: string): Array<{ deliveryDate: string; cutoffDate?: string; cutoffTime?: string }> {
  const slots: Array<{ deliveryDate: string; cutoffDate?: string; cutoffTime?: string }> = []

  // Look for date patterns in delivery slot elements — adjust regex as portal HTML becomes clearer
  const dateRegex = /(\d{4}-\d{2}-\d{2})/g
  const matches = html.matchAll(dateRegex)
  const seen = new Set<string>()

  for (const m of matches) {
    const date = m[1]
    if (!seen.has(date)) {
      seen.add(date)
      slots.push({ deliveryDate: date })
    }
  }

  // Also try dd/mm/yyyy format
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

  // Step 1: GET the quick order page to extract CSRF token
  const pageRes = await fetch(`${base}/customer/product/quick-add/`, {
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

  // Merge any new cookies from the page fetch
  const pageCookies = extractCookies(pageRes)
  const mergedCookies = [session.cookies, pageCookies].filter(Boolean).join('; ')

  // Step 2: Build the paste string (itemNumber,qty;itemNumber,qty;...)
  const pasteString = body.lines
    .filter((l) => l.qty > 0)
    .map((l) => `${l.itemNumber},${l.qty}`)
    .join(';')

  // Step 3: POST the order via FormData
  const formData = new FormData()
  formData.append(csrfName, csrfValue)
  formData.append('oro_product_quick_add[component]', 'autocomplete')
  formData.append('oro_product_quick_add[products]', pasteString)

  const submitRes = await fetch(`${base}/customer/product/quick-add/`, {
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

  // Update stored session cookies
  const updatedCookies = [mergedCookies, submitCookies].filter(Boolean).join('; ')
  const updatedSession: SessionData = { ...session, cookies: updatedCookies }
  const token = bearerToken(request)!
  await env.SESSIONS.put(token, JSON.stringify(updatedSession), {
    expirationTtl: Math.max(1, Math.round((session.expiresAt - Date.now()) / 1000)),
  })

  // Check for success — typically a redirect to the shopping list or cart
  if (submitRes.status >= 300 && submitRes.status < 400) {
    return jsonResponse({
      success: true,
      redirect: location,
      itemCount: body.lines.length,
    }, 200, origin, env)
  }

  if (submitRes.ok) {
    return jsonResponse({
      success: true,
      itemCount: body.lines.length,
    }, 200, origin, env)
  }

  return jsonResponse({
    error: `Submit returned ${submitRes.status}`,
    redirect: location || undefined,
  }, 502, origin, env)
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

        case '/health':
          return jsonResponse({ ok: true, time: Date.now() }, 200, origin, env)
      }

      return jsonResponse({ error: 'Not found' }, 404, origin, env)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error'
      return jsonResponse({ error: message }, 500, origin, env)
    }
  },
}
