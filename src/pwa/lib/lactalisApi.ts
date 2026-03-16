/**
 * lactalisApi.ts — PWA client for the Cloudflare Worker proxy
 *
 * Handles login, schedule fetch, and order submission to the Lactalis portal
 * via the Worker proxy (bypasses CORS restrictions on phone).
 */

const WORKER_URL_KEY = 'milk-manager-worker-url'
const SESSION_TOKEN_KEY = 'milk-manager-lactalis-session'
const SESSION_EXPIRY_KEY = 'milk-manager-lactalis-session-expiry'

// ─── Configuration ────────────────────────────────────────────────────────────

export function getWorkerUrl(): string {
  return localStorage.getItem(WORKER_URL_KEY) ?? ''
}

export function setWorkerUrl(url: string) {
  localStorage.setItem(WORKER_URL_KEY, url.replace(/\/+$/, ''))
}

export function getSessionToken(): string | null {
  const token = localStorage.getItem(SESSION_TOKEN_KEY)
  const expiry = localStorage.getItem(SESSION_EXPIRY_KEY)
  if (!token || !expiry) return null
  if (Date.now() > Number(expiry)) {
    clearSession()
    return null
  }
  return token
}

export function clearSession() {
  localStorage.removeItem(SESSION_TOKEN_KEY)
  localStorage.removeItem(SESSION_EXPIRY_KEY)
}

export function hasActiveSession(): boolean {
  return getSessionToken() !== null
}

export function isConfigured(): boolean {
  return getWorkerUrl().length > 0
}

// ─── API calls ────────────────────────────────────────────────────────────────

async function workerFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const base = getWorkerUrl()
  if (!base) throw new Error('Worker URL not configured — set it in Settings')

  const token = getSessionToken()
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) ?? {}),
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const res = await fetch(`${base}${path}`, { ...options, headers })
  return res
}

/**
 * Log in to Lactalis via the Worker proxy.
 * Stores the session token in localStorage on success.
 */
export async function lactalisLogin(username: string, password: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await workerFetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })

    const data = await res.json() as { sessionToken?: string; expiresAt?: number; error?: string }

    if (!res.ok || !data.sessionToken) {
      return { success: false, error: data.error ?? `Login failed (${res.status})` }
    }

    localStorage.setItem(SESSION_TOKEN_KEY, data.sessionToken)
    localStorage.setItem(SESSION_EXPIRY_KEY, String(data.expiresAt ?? Date.now() + 86400000))
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Network error' }
  }
}

/**
 * Fetch the delivery schedule from the Lactalis portal via the Worker.
 * Returns an array of delivery slot objects.
 */
export async function fetchDeliverySchedule(): Promise<{
  slots: Array<{ deliveryDate: string; cutoffDate?: string; cutoffTime?: string }>
  error?: string
}> {
  try {
    const res = await workerFetch('/schedule')
    const data = await res.json() as {
      slots?: Array<{ deliveryDate: string; cutoffDate?: string; cutoffTime?: string }>
      error?: string
    }

    if (!res.ok) {
      return { slots: [], error: data.error ?? `Failed (${res.status})` }
    }

    return { slots: data.slots ?? [] }
  } catch (err) {
    return { slots: [], error: err instanceof Error ? err.message : 'Network error' }
  }
}

/**
 * Submit an order to the Lactalis portal via the Worker.
 */
export async function submitOrderToLactalis(
  lines: Array<{ itemNumber: string; qty: number }>,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await workerFetch('/submit-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines }),
    })

    const data = await res.json() as { success?: boolean; error?: string }

    if (!res.ok || !data.success) {
      return { success: false, error: data.error ?? `Submit failed (${res.status})` }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Network error' }
  }
}

/**
 * Check if the Worker + session are healthy.
 */
export async function checkWorkerHealth(): Promise<boolean> {
  try {
    const base = getWorkerUrl()
    if (!base) return false
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch {
    return false
  }
}
