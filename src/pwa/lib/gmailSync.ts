/**
 * gmailSync.ts — Gmail OAuth (Google Identity Services) + order history sync.
 *
 * Mobile note: iOS Safari kills the popup-open user-gesture context across any
 * `await`. Fix: pre-load GIS and pre-create the token client in prepareGmailClient()
 * (called from useEffect on mount), so connectGmail() calls requestAccessToken()
 * with zero async delay between tap and popup.
 */

import { db } from './db'
import { parseOrderEmail } from './emailParser'
import { upsertOrderHistory } from './extensionSync'
import type { GmailSyncRecord, ScrapedOrder } from './types'

// ─── Constants ────────────────────────────────────────────────────────────────

const LS_CLIENT_ID  = 'milk-manager-gmail-client-id'
const LS_TOKEN      = 'milk-manager-gmail-token'
const LS_EXPIRY     = 'milk-manager-gmail-token-expiry'
const LS_LAST_SYNC  = 'milk-manager-gmail-last-sync'
const LS_AUTO_SYNC  = 'milk-manager-gmail-auto-sync'
const LS_EMAIL      = 'milk-manager-gmail-email'

const GMAIL_API     = 'https://www.googleapis.com/gmail/v1/users/me'
const SCOPE         = 'https://www.googleapis.com/auth/gmail.readonly'
const LACTALIS_FROM = 'from:noreply@au.lactalis.com'

// ─── GIS script loader ────────────────────────────────────────────────────────

let gisLoaded = false

async function loadGis(): Promise<void> {
  if (gisLoaded || typeof window === 'undefined') return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((window as any).google?.accounts) { gisLoaded = true; return }
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.onload = () => { gisLoaded = true; resolve() }
    s.onerror = () => reject(new Error('Failed to load Google Identity Services'))
    document.head.appendChild(s)
  })
}

// ─── Pre-initialised token client (mobile popup fix) ─────────────────────────
//
// Mobile browsers lose the user-gesture context across any await/microtask.
// We pre-create the token client in prepareGmailClient() (called from useEffect),
// then connectGmail() just calls .requestAccessToken() synchronously on tap.

type TokenResp = { access_token?: string; expires_in?: number; error?: string }

let cachedClient: { requestAccessToken: (overrides?: { prompt?: string; login_hint?: string }) => void } | null = null
let pendingResolve: ((email: string) => void) | null = null
let pendingReject: ((err: Error) => void) | null = null

function buildTokenClient(clientId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gis = (window as any).google
  if (!gis?.accounts?.oauth2) return null

  return gis.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: async (resp: TokenResp) => {
      if (resp.error || !resp.access_token) {
        pendingReject?.(new Error(resp.error ?? 'OAuth failed'))
        pendingResolve = null; pendingReject = null
        return
      }
      const expiresAt = Date.now() + (resp.expires_in ?? 3600) * 1000
      localStorage.setItem(LS_TOKEN, resp.access_token)
      localStorage.setItem(LS_EXPIRY, String(expiresAt))
      try {
        const info = await fetch(`${GMAIL_API}/profile`, {
          headers: { 'Authorization': `Bearer ${resp.access_token}` },
        }).then((r) => r.json()) as { emailAddress?: string }
        if (info.emailAddress) localStorage.setItem(LS_EMAIL, info.emailAddress)
        pendingResolve?.(info.emailAddress ?? 'connected')
      } catch {
        pendingResolve?.('connected')
      }
      pendingResolve = null; pendingReject = null
    },
  })
}

/**
 * Pre-load GIS and create the token client.
 * Call this from a useEffect so it's ready before the user taps Connect.
 */
export async function prepareGmailClient(): Promise<void> {
  const clientId = localStorage.getItem(LS_CLIENT_ID)
  if (!clientId) return
  try {
    await loadGis()
    cachedClient = buildTokenClient(clientId)
  } catch {
    // Non-fatal — connectGmail will retry inline
  }
}

// ─── Token management ─────────────────────────────────────────────────────────

function isTokenValid(): boolean {
  const token = localStorage.getItem(LS_TOKEN)
  const expiry = localStorage.getItem(LS_EXPIRY)
  if (!token || !expiry) return false
  return Date.now() < Number(expiry) - 120_000
}

/** For syncGmailOrders — not triggered by a tap, so await is fine here. */
async function getValidToken(): Promise<string> {
  if (isTokenValid()) return localStorage.getItem(LS_TOKEN)!
  await loadGis()
  const clientId = localStorage.getItem(LS_CLIENT_ID)
  if (!clientId) throw new Error('Gmail Client ID not configured — set it in Settings')
  if (!cachedClient) cachedClient = buildTokenClient(clientId)
  if (!cachedClient) throw new Error('Google Identity Services failed to load')

  const email = localStorage.getItem(LS_EMAIL)
  const hint = email ? { login_hint: email } : {}

  // Try silent refresh first (no popup)
  try {
    return await new Promise<string>((resolve, reject) => {
      pendingResolve = resolve
      pendingReject = reject
      cachedClient!.requestAccessToken({ prompt: 'none', ...hint })
    })
  } catch {
    // Silent failed — fall back to minimal prompt (no account picker)
    return new Promise<string>((resolve, reject) => {
      pendingResolve = resolve
      pendingReject = reject
      cachedClient!.requestAccessToken({ prompt: '', ...hint })
    })
  }
}

// ─── Gmail REST helpers ───────────────────────────────────────────────────────

interface GmailMessage { id: string; threadId: string }

interface GmailPart {
  mimeType: string
  body: { data?: string; size: number }
  parts?: GmailPart[]
}

interface GmailFullMessage {
  id: string
  snippet: string
  payload: {
    mimeType: string
    headers: Array<{ name: string; value: string }>
    body: { data?: string; size: number }
    parts?: GmailPart[]
  }
}

async function gmailGet(token: string, path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`${GMAIL_API}${path}`)
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), { headers: { 'Authorization': `Bearer ${token}` } })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`Gmail API ${path} → ${res.status}: ${err.slice(0, 200)}`)
  }
  return res.json()
}

async function listMessages(token: string, afterDate?: string): Promise<GmailMessage[]> {
  let q = LACTALIS_FROM
  if (afterDate) q += ` after:${afterDate}`
  const data = await gmailGet(token, '/messages', { q, maxResults: '100' }) as { messages?: GmailMessage[] }
  return data.messages ?? []
}

async function fetchMessage(token: string, id: string): Promise<GmailFullMessage> {
  return gmailGet(token, `/messages/${id}`, { format: 'full' }) as Promise<GmailFullMessage>
}

function base64UrlDecode(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + (4 - s.length % 4) % 4, '=')
  try {
    return decodeURIComponent(atob(padded).split('').map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''))
  } catch {
    return atob(padded)
  }
}

function findPart(parts: GmailPart[], mimeType: string): GmailPart | undefined {
  for (const part of parts) {
    if (part.mimeType === mimeType && part.body.data) return part
    if (part.parts) { const f = findPart(part.parts, mimeType); if (f) return f }
  }
}

function extractBody(msg: GmailFullMessage): { content: string; isHtml: boolean } {
  const payload = msg.payload
  const parts = payload.parts ?? []

  const htmlPart = parts.length > 0
    ? findPart(parts, 'text/html')
    : (payload.mimeType === 'text/html' ? payload as unknown as GmailPart : undefined)
  if (htmlPart?.body.data) return { content: base64UrlDecode(htmlPart.body.data), isHtml: true }

  const textPart = parts.length > 0
    ? findPart(parts, 'text/plain')
    : (payload.mimeType === 'text/plain' ? payload as unknown as GmailPart : undefined)
  if (textPart?.body.data) return { content: base64UrlDecode(textPart.body.data), isHtml: false }

  if (payload.body.data) return { content: base64UrlDecode(payload.body.data), isHtml: payload.mimeType === 'text/html' }
  return { content: msg.snippet ?? '', isHtml: false }
}

function getHeader(msg: GmailFullMessage, name: string): string {
  return msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

// ─── Main sync ────────────────────────────────────────────────────────────────

export async function syncGmailOrders(): Promise<{ count: number; processed: number; errors: string[] }> {
  const token = await getValidToken()
  const errors: string[] = []

  const lastSync = localStorage.getItem(LS_LAST_SYNC)
  let afterDate: string | undefined
  if (lastSync) {
    const d = new Date(lastSync)
    d.setDate(d.getDate() - 7)
    afterDate = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
  }

  const messages = await listMessages(token, afterDate)
  const parsedOrders: ScrapedOrder[] = []
  let processed = 0

  for (const msg of messages) {
    const existing = await db.gmailSyncLog.where('messageId').equals(msg.id).first()
    if (existing) continue

    try {
      const full = await fetchMessage(token, msg.id)
      const subject = getHeader(full, 'subject')
      const { content, isHtml } = extractBody(full)
      const parsed = parseOrderEmail(content, isHtml)

      const record: Omit<GmailSyncRecord, 'id'> = {
        messageId: msg.id,
        syncedAt: new Date(),
        parsed: parsed !== null,
        subject,
        orderNumber: parsed?.orderNumber,
        parseError: parsed ? undefined : 'Could not extract order number',
      }
      await db.gmailSyncLog.add(record)
      processed++
      if (parsed) parsedOrders.push(parsed)
    } catch (e) {
      errors.push(`Message ${msg.id}: ${(e as Error).message}`)
    }
  }

  let count = 0
  if (parsedOrders.length > 0) count = await upsertOrderHistory(parsedOrders)
  localStorage.setItem(LS_LAST_SYNC, new Date().toISOString())
  return { count, processed, errors }
}

// ─── OAuth connect / disconnect ───────────────────────────────────────────────

/**
 * Trigger the OAuth popup. Must be called directly from a tap handler with
 * no awaits before it — prepareGmailClient() must have been called first.
 */
export function connectGmail(): Promise<string> {
  localStorage.removeItem(LS_TOKEN)
  localStorage.removeItem(LS_EXPIRY)

  if (!cachedClient) {
    const clientId = localStorage.getItem(LS_CLIENT_ID)
    if (clientId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gis = (window as any).google
      if (gis?.accounts?.oauth2) cachedClient = buildTokenClient(clientId)
    }
  }

  return new Promise<string>((resolve, reject) => {
    if (!cachedClient) {
      reject(new Error('Not ready — refresh the page and try again'))
      return
    }
    pendingResolve = resolve
    pendingReject = reject
    cachedClient.requestAccessToken({ prompt: 'select_account' })
  })
}

export function disconnectGmail(): void {
  cachedClient = null
  localStorage.removeItem(LS_TOKEN)
  localStorage.removeItem(LS_EXPIRY)
  localStorage.removeItem(LS_LAST_SYNC)
  localStorage.removeItem(LS_CLIENT_ID)
  localStorage.removeItem(LS_AUTO_SYNC)
  localStorage.removeItem(LS_EMAIL)
}

export function isGmailConnected(): boolean { return isTokenValid() }
export function getGmailLastSync(): string | null { return localStorage.getItem(LS_LAST_SYNC) }
export function getGmailEmail(): string | null { return localStorage.getItem(LS_EMAIL) }
