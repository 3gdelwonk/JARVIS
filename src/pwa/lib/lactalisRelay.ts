/**
 * lactalisRelay.ts — JARVISmart Lactalis relay client
 *
 * Submits orders and fetches delivery slots via the JARVISmart server's
 * Lactalis relay, instead of requiring the Chrome Extension.
 *
 * Connection settings stored in localStorage:
 *   'jarvis-relay-url' — tunnel or LAN URL
 *   'jarvis-api-key'   — API key for authenticated access
 */

const DEFAULT_RELAY_URL = 'https://api.jarvismart196410.uk'
const URL_KEY = 'jarvis-relay-url'
const API_KEY_KEY = 'jarvis-api-key'

export function getRelayUrl(): string {
  return localStorage.getItem(URL_KEY) || DEFAULT_RELAY_URL
}

export function setRelayUrl(url: string) {
  localStorage.setItem(URL_KEY, url.replace(/\/+$/, ''))
}

export function getApiKey(): string {
  return localStorage.getItem(API_KEY_KEY) || ''
}

export function setApiKey(key: string) {
  localStorage.setItem(API_KEY_KEY, key.trim())
}

async function relayFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const base = getRelayUrl()
  const apiKey = getApiKey()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  }
  if (apiKey) headers['X-API-Key'] = apiKey

  const res = await fetch(`${base}${path}`, { ...options, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error || body.detail || `Relay ${res.status}`)
  }
  return res.json() as Promise<T>
}

// ── Health check ──

interface HealthResponse {
  connected: boolean
  reason?: string
  sessionCookies?: number
  expiresIn?: string
}

export async function checkRelay(): Promise<HealthResponse> {
  try {
    const data = await relayFetch<any>('/api/lactalis/health')
    // Handle JARVISmart format: { session: { valid, cookieCount, expiresIn } }
    if (data.session) {
      return {
        connected: !!data.session.valid,
        sessionCookies: data.session.cookieCount,
        expiresIn: typeof data.session.expiresIn === 'number'
          ? Math.round(data.session.expiresIn / 60) + ' min'
          : data.session.expiresIn,
        reason: data.session.valid ? undefined : 'Session invalid',
      }
    }
    // Handle JARVIS format: { connected, sessionCookies, expiresIn }
    return data as HealthResponse
  } catch (err: any) {
    return { connected: false, reason: err.message }
  }
}

// ── Submit order ──

interface SubmitResult {
  success: boolean
  redirectUrl?: string | null
  error?: string
}

interface OrderLine {
  itemNumber: string
  qty: number
}

export async function submitOrder(lines: OrderLine[]): Promise<SubmitResult> {
  return relayFetch<SubmitResult>('/api/lactalis/submit-order', {
    method: 'POST',
    body: JSON.stringify({ lines }),
  })
}

// ── Delivery slots ──

interface DeliverySlot {
  deliveryDate: string
  orderCutoffDate: string
  orderCutoffTime: string
  status: number
}

interface SlotsResponse {
  slots: DeliverySlot[]
  nextDelivery: DeliverySlot | null
  count: number
}

export async function getDeliverySlots(): Promise<SlotsResponse> {
  return relayFetch<SlotsResponse>('/api/lactalis/delivery-slots')
}
