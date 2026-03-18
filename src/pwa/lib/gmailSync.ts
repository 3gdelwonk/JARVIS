/**
 * gmailSync.ts — Gmail OAuth (Google Identity Services) + order history sync.
 *
 * Reads Lactalis order confirmation emails from Gmail, parses them with
 * emailParser.ts, and upserts the results into IndexedDB via extensionSync.ts.
 *
 * localStorage keys:
 *   milk-manager-gmail-client-id    — OAuth Client ID (set in Settings)
 *   milk-manager-gmail-token        — current access token
 *   milk-manager-gmail-token-expiry — Unix ms expiry
 *   milk-manager-gmail-last-sync    — ISO timestamp of last successful sync
 *   milk-manager-gmail-auto-sync    — 'true'/'false'
 */

import { db } from './db'
import { parseOrderEmail } from './emailParser'
import { upsertOrderHistory } from './extensionSync'
import type { GmailSyncRecord, ScrapedOrder } from './types'

// ─── Constants ────────────────────────────────────────────────────────────────

const LS_CLIENT_ID   = 'milk-manager-gmail-client-id'
const LS_TOKEN       = 'milk-manager-gmail-token'
const LS_EXPIRY      = 'milk-manager-gmail-token-expiry'
const LS_LAST_SYNC   = 'milk-manager-gmail-last-sync'
const LS_AUTO_SYNC   = 'milk-manager-gmail-auto-sync'

const GMAIL_API      = 'https://www.googleapis.com/gmail/v1/users/me'
const SCOPE          = 'https://www.googleapis.com/auth/gmail.readonly'
const LACTALIS_FROM  = 'from:noreply@au.lactalis.com'

// ─── GIS script loader ────────────────────────────────────────────────────────

let gisLoaded = false

async function loadGis(): Promise<void> {
  if (gisLoaded || typeof window === 'undefined') return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((window as any).google?.accounts) {
    gisLoaded = true
    return
  }
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.onload = () => { gisLoaded = true; resolve() }
    s.onerror = () => reject(new Error('Failed to load Google Identity Services'))
    document.head.appendChild(s)
  })
}

// ─── Token management ─────────────────────────────────────────────────────────

function isTokenValid(): boolean {
  const token = localStorage.getItem(LS_TOKEN)
  const expiry = localStorage.getItem(LS_EXPIRY)
  if (!token || !expiry) return false
  // 2-minute buffer
  return Date.now() < Number(expiry) - 120_000
}

async function getValidToken(): Promise<string> {
  if (isTokenValid()) return localStorage.getItem(LS_TOKEN)!

  await loadGis()
  const clientId = localStorage.getItem(LS_CLIENT_ID)
  if (!clientId) throw new Error('Gmail Client ID not configured — set it in Settings')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gis = (window as any).google as {
    accounts: {
      oauth2: {
        initTokenClient: (config: {
          client_id: string
          scope: string
          prompt: string
          callback: (resp: { access_token?: string; expires_in?: number; error?: string }) => void
          error_callback?: (err: { type: string }) => void
        }) => { requestAccessToken: () => void }
      }
    }
  }

  return new Promise<string>((resolve, reject) => {
    const client = gis.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      prompt: '',
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error ?? 'OAuth failed'))
          return
        }
        const expiresAt = Date.now() + (resp.expires_in ?? 3600) * 1000
        localStorage.setItem(LS_TOKEN, resp.access_token)
        localStorage.setItem(LS_EXPIRY, String(expiresAt))
        resolve(resp.access_token)
      },
      error_callback: (_err) => {
        // Silent auth failed — trigger interactive popup
        const interactive = gis.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPE,
          prompt: 'select_account',
          callback: (resp2) => {
            if (resp2.error || !resp2.access_token) {
              reject(new Error(resp2.error ?? 'OAuth failed'))
              return
            }
            const expiresAt = Date.now() + (resp2.expires_in ?? 3600) * 1000
            localStorage.setItem(LS_TOKEN, resp2.access_token)
            localStorage.setItem(LS_EXPIRY, String(expiresAt))
            resolve(resp2.access_token)
          },
        })
        interactive.requestAccessToken()
      },
    })
    client.requestAccessToken()
  })
}

// ─── Gmail REST helpers ───────────────────────────────────────────────────────

interface GmailMessage {
  id: string
  threadId: string
}

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
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  }
  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`Gmail API ${path} → ${res.status}: ${err.slice(0, 200)}`)
  }
  return res.json()
}

async function listMessages(token: string, afterDate?: string): Promise<GmailMessage[]> {
  let q = LACTALIS_FROM
  if (afterDate) q += ` after:${afterDate}`

  const data = await gmailGet(token, '/messages', { q, maxResults: '100' }) as {
    messages?: GmailMessage[]
  }
  return data.messages ?? []
}

async function fetchMessage(token: string, id: string): Promise<GmailFullMessage> {
  return gmailGet(token, `/messages/${id}`, { format: 'full' }) as Promise<GmailFullMessage>
}

function base64UrlDecode(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    s.length + (4 - s.length % 4) % 4, '=',
  )
  try {
    return decodeURIComponent(
      atob(padded).split('').map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
    )
  } catch {
    return atob(padded)
  }
}

function findPart(parts: GmailPart[], mimeType: string): GmailPart | undefined {
  for (const part of parts) {
    if (part.mimeType === mimeType && part.body.data) return part
    if (part.parts) {
      const found = findPart(part.parts, mimeType)
      if (found) return found
    }
  }
  return undefined
}

function extractBody(msg: GmailFullMessage): { content: string; isHtml: boolean } {
  const payload = msg.payload
  const parts = payload.parts ?? []

  // Prefer text/html
  const htmlPart = parts.length > 0
    ? findPart(parts, 'text/html')
    : (payload.mimeType === 'text/html' ? payload as unknown as GmailPart : undefined)

  if (htmlPart?.body.data) {
    return { content: base64UrlDecode(htmlPart.body.data), isHtml: true }
  }

  // Fall back to text/plain
  const textPart = parts.length > 0
    ? findPart(parts, 'text/plain')
    : (payload.mimeType === 'text/plain' ? payload as unknown as GmailPart : undefined)

  if (textPart?.body.data) {
    return { content: base64UrlDecode(textPart.body.data), isHtml: false }
  }

  // Last resort: top-level body
  if (payload.body.data) {
    return {
      content: base64UrlDecode(payload.body.data),
      isHtml: payload.mimeType === 'text/html',
    }
  }

  return { content: msg.snippet ?? '', isHtml: false }
}

function getHeader(msg: GmailFullMessage, name: string): string {
  return msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

// ─── Main sync ────────────────────────────────────────────────────────────────

export async function syncGmailOrders(): Promise<{ count: number; processed: number; errors: string[] }> {
  const token = await getValidToken()
  const errors: string[] = []

  // Build after: date — last sync minus 7-day overlap
  const lastSync = localStorage.getItem(LS_LAST_SYNC)
  let afterDate: string | undefined
  if (lastSync) {
    const d = new Date(lastSync)
    d.setDate(d.getDate() - 7)
    // Gmail after: filter uses yyyy/mm/dd
    afterDate = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
  }

  const messages = await listMessages(token, afterDate)
  const parsedOrders: ScrapedOrder[] = []
  let processed = 0

  for (const msg of messages) {
    // Check if already synced
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
  if (parsedOrders.length > 0) {
    count = await upsertOrderHistory(parsedOrders)
  }

  localStorage.setItem(LS_LAST_SYNC, new Date().toISOString())

  return { count, processed, errors }
}

// ─── OAuth connect / disconnect ───────────────────────────────────────────────

export async function connectGmail(): Promise<string> {
  // Clear any stale token so we force the full interactive flow
  localStorage.removeItem(LS_TOKEN)
  localStorage.removeItem(LS_EXPIRY)
  const token = await getValidToken()

  // Fetch the user's email address for display
  const info = await fetch(`${GMAIL_API}/profile`, {
    headers: { 'Authorization': `Bearer ${token}` },
  }).then((r) => r.json()) as { emailAddress?: string }

  return info.emailAddress ?? 'connected'
}

export function disconnectGmail(): void {
  localStorage.removeItem(LS_TOKEN)
  localStorage.removeItem(LS_EXPIRY)
  localStorage.removeItem(LS_LAST_SYNC)
  localStorage.removeItem(LS_CLIENT_ID)
  localStorage.removeItem(LS_AUTO_SYNC)
}

export function isGmailConnected(): boolean {
  return isTokenValid()
}

export function getGmailLastSync(): string | null {
  return localStorage.getItem(LS_LAST_SYNC)
}
