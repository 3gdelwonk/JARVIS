/**
 * extensionSync.ts — reads data written by pwa-bridge.js into localStorage
 * and applies it to the PWA's IndexedDB.
 *
 * localStorage keys consumed (written by extension/content-scripts/pwa-bridge.js):
 *   milk-manager-status-updates     Array<{ orderId, lactalisRef, submittedAt }>
 *   milk-manager-schedule-from-extension  { nextDelivery, upcomingDeliveries, scrapedAt, source }
 */

import { db } from './db'
import type { DeliverySlot, Order } from './types'

const STATUS_KEY        = 'milk-manager-status-updates'
const SCHEDULE_KEY      = 'milk-manager-schedule-from-extension'
const ORDER_HISTORY_KEY = 'milk-manager-order-history'

interface StatusUpdate {
  orderId:     number
  lactalisRef: string
  submittedAt: number   // Unix ms
}

interface ScrapedSlot {
  deliveryDate:      string
  orderCutoffDate?:  string
  orderCutoffTime?:  string
}

// ─── Status updates (portal submission → order marked "submitted") ───────────

/**
 * Reads pending status updates from localStorage, updates matching Orders in
 * IndexedDB (approved → submitted), then clears the localStorage key.
 *
 * Returns the number of orders updated.
 */
export async function applyStatusUpdates(): Promise<number> {
  const raw = localStorage.getItem(STATUS_KEY)
  if (!raw) return 0

  let updates: StatusUpdate[]
  try {
    updates = JSON.parse(raw)
  } catch {
    return 0
  }

  if (!Array.isArray(updates) || updates.length === 0) return 0

  let applied = 0
  for (const u of updates) {
    if (!u.orderId) continue
    const order = await db.orders.get(u.orderId)
    if (!order) continue
    if (order.status === 'approved') {
      await db.orders.update(u.orderId, {
        status: 'submitted',
        submittedAt: new Date(u.submittedAt),
        lactalisOrderNumber: u.lactalisRef ?? undefined,
      })
      applied++
    }
  }

  localStorage.removeItem(STATUS_KEY)
  return applied
}

// ─── Schedule sync (scraped portal slots → deliverySlots table) ─────────────

/**
 * Reads the scraped delivery schedule from localStorage, upserts each slot
 * into the deliverySlots table, then returns the number of slots upserted.
 * Does NOT overwrite a slot's status if it's already ordered/delivered.
 */
export async function applyExtensionSchedule(): Promise<number> {
  const raw = localStorage.getItem(SCHEDULE_KEY)
  if (!raw) return 0

  let schedule: { nextDelivery?: ScrapedSlot; upcomingDeliveries?: ScrapedSlot[] }
  try {
    schedule = JSON.parse(raw)
  } catch {
    return 0
  }

  const slots: ScrapedSlot[] = schedule.upcomingDeliveries
    ?? (schedule.nextDelivery ? [schedule.nextDelivery] : [])

  if (slots.length === 0) return 0

  return upsertSlots(slots)
}

/** Upsert scraped delivery slots into the database. */
async function upsertSlots(slots: ScrapedSlot[]): Promise<number> {
  let upserted = 0
  for (const slot of slots) {
    if (!slot.deliveryDate) continue

    const existing = await db.deliverySlots.where('deliveryDate').equals(slot.deliveryDate).first()

    if (existing) {
      // Only update cutoff data — don't reset a slot that's already ordered/delivered
      await db.deliverySlots.update(existing.id!, {
        orderCutoffDate: slot.orderCutoffDate ?? existing.orderCutoffDate,
        orderCutoffTime: slot.orderCutoffTime ?? existing.orderCutoffTime,
        scrapedAt: new Date(),
      })
    } else {
      const newSlot: Omit<DeliverySlot, 'id'> = {
        deliveryDate:     slot.deliveryDate,
        orderCutoffDate:  slot.orderCutoffDate ?? slot.deliveryDate,
        orderCutoffTime:  slot.orderCutoffTime ?? '17:00',
        status:           'upcoming',
        scrapedAt:        new Date(),
        manualEntry:      false,
      }
      await db.deliverySlots.add(newSlot)
    }

    upserted++
  }

  return upserted
}

// ─── Extension status ping ───────────────────────────────────────────────────

/**
 * Pings pwa-bridge.js to check if the extension is connected and whether a
 * Lactalis portal tab was active in the last 30 minutes.
 * Resolves with { connected: false } after 1 s if the bridge doesn't respond.
 */
export async function getExtensionStatus(): Promise<{ connected: boolean; lactalisLoggedIn: boolean }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ connected: false, lactalisLoggedIn: false }), 1000)
    window.addEventListener('milk-manager-pong', (e: Event) => {
      clearTimeout(timeout)
      resolve({ connected: true, lactalisLoggedIn: (e as CustomEvent).detail?.loggedIn ?? false })
    }, { once: true })
    window.dispatchEvent(new CustomEvent('milk-manager-ping'))
  })
}

// ─── Trigger helpers (fire-and-forget via pwa-bridge.js) ────────────────────

/** Ask the extension to re-scrape the Lactalis delivery schedule. */
export function triggerScheduleRefresh() {
  window.dispatchEvent(new CustomEvent('milk-manager-refresh-schedule'))
}

/** Ask the extension to re-scrape the Lactalis order history. */
export function triggerOrderHistoryRefresh() {
  window.dispatchEvent(new CustomEvent('milk-manager-refresh-orders'))
}

/** Ask the extension to open the Lactalis Quick Order page and auto-submit. */
export function triggerOrderSubmit() {
  window.dispatchEvent(new CustomEvent('milk-manager-submit-order'))
}

// ─── Cloud relay functions (via Cloudflare Worker) ──────────────────────────

const CLOUD_TOKEN_KEY = 'milk-manager-cloud-token'
const CLOUD_TOKEN_EXPIRY_KEY = 'milk-manager-cloud-token-expiry'

function getWorkerUrl(): string | null {
  return localStorage.getItem('milk-manager-worker-url')?.replace(/\/+$/, '') || null
}

function getCloudToken(): string | null {
  const token = localStorage.getItem(CLOUD_TOKEN_KEY)
  const expiry = localStorage.getItem(CLOUD_TOKEN_EXPIRY_KEY)
  if (!token) return null
  // Check if token has expired
  if (expiry && Date.now() > Number(expiry)) {
    localStorage.removeItem(CLOUD_TOKEN_KEY)
    localStorage.removeItem(CLOUD_TOKEN_EXPIRY_KEY)
    return null
  }
  return token
}

function cloudHeaders(): Record<string, string> {
  const token = getCloudToken()
  return token ? { 'Authorization': `Bearer ${token}` } : {}
}

/**
 * Authenticate with Lactalis via the Worker's /login endpoint.
 * Stores the session token in localStorage for subsequent cloud calls.
 * Returns { success, error? }.
 */
export async function loginToCloud(
  username: string,
  password: string,
): Promise<{ success: boolean; error?: string }> {
  const base = getWorkerUrl()
  if (!base) return { success: false, error: 'Worker URL not configured' }

  try {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const data = await res.json()

    if (!res.ok) {
      return { success: false, error: data.error || `Login failed (${res.status})` }
    }

    if (data.sessionToken) {
      localStorage.setItem(CLOUD_TOKEN_KEY, data.sessionToken)
      if (data.expiresAt) {
        localStorage.setItem(CLOUD_TOKEN_EXPIRY_KEY, String(data.expiresAt))
      }
      return { success: true }
    }

    return { success: false, error: 'No session token in response' }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
}

/** Check whether a cloud session token exists and isn't expired. */
export function isCloudLoggedIn(): boolean {
  return getCloudToken() !== null
}

/** Clear the stored cloud session token. */
export function cloudLogout(): void {
  localStorage.removeItem(CLOUD_TOKEN_KEY)
  localStorage.removeItem(CLOUD_TOKEN_EXPIRY_KEY)
}

/**
 * Fetch schedule from the Worker (which checks KV cache first).
 * Returns number of slots upserted, or 0 if unavailable.
 */
export async function fetchCloudSchedule(): Promise<number> {
  const base = getWorkerUrl()
  if (!base) return 0

  try {
    const res = await fetch(`${base}/schedule`, { headers: cloudHeaders() })
    if (!res.ok) return 0
    const data = await res.json()

    // The cloud cache returns the same format as the extension schedule
    const slots: ScrapedSlot[] = data.upcomingDeliveries
      ?? (data.nextDelivery ? [data.nextDelivery] : (data.slots ?? []).map((s: { deliveryDate: string }) => ({ deliveryDate: s.deliveryDate })))

    if (slots.length === 0) return 0
    return upsertSlots(slots)
  } catch {
    return 0
  }
}

/**
 * Submit order via the Worker. If Incapsula blocks direct submission,
 * the Worker queues the order in KV for the extension to pick up.
 * Returns { success, queued, orderId } or throws.
 */
export async function submitOrderViaCloud(
  lines: Array<{ itemNumber: string; qty: number }>,
): Promise<{ success: boolean; queued: boolean; orderId?: string }> {
  const base = getWorkerUrl()
  if (!base) throw new Error('Worker URL not configured')

  const res = await fetch(`${base}/submit-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cloudHeaders() },
    body: JSON.stringify({ lines }),
  })

  const data = await res.json()

  if (res.status === 202 && data.queued) {
    return { success: false, queued: true, orderId: data.orderId }
  }

  if (data.success) {
    return { success: true, queued: false }
  }

  throw new Error(data.error || `Submit failed (${res.status})`)
}

/**
 * Poll the Worker for order completion status.
 * Returns the current status of the pending cloud order.
 */
export async function pollOrderStatus(): Promise<{
  orderId: string | null
  status: string | null
  lactalisRef: string | null
  error: string | null
} | null> {
  const base = getWorkerUrl()
  if (!base) return null

  try {
    const res = await fetch(`${base}/extension/order-status`, { headers: cloudHeaders() })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

/**
 * Fetch order history from the Worker (cloud KV cache).
 * Returns number of orders upserted, or 0 if unavailable.
 */
export async function fetchCloudOrderHistory(): Promise<number> {
  const base = getWorkerUrl()
  if (!base) {
    console.log('[Milk Manager] No Worker URL configured — skipping cloud order history')
    return 0
  }

  try {
    const res = await fetch(`${base}/extension/order-history`, { headers: cloudHeaders() })
    if (!res.ok) {
      console.log(`[Milk Manager] Cloud order history fetch failed: ${res.status}`)
      return 0
    }
    const data = await res.json()

    if (!data.orders || !Array.isArray(data.orders) || data.orders.length === 0) {
      console.log('[Milk Manager] Cloud order history empty')
      return 0
    }

    console.log(`[Milk Manager] Got ${data.orders.length} orders from cloud`)
    return upsertOrderHistory(data.orders)
  } catch (e) {
    console.log('[Milk Manager] Cloud order history error:', e)
    return 0
  }
}

// ─── Order history sync (scraped portal orders → IndexedDB) ─────────────

interface ScrapedOrder {
  orderNumber: string
  createdAt: string | null
  deliveryDate: string | null
  orderStatus: string | null
  refNumber: string | null
  totalQty: number
  total: number
  onlineOrder: boolean | null
  lineItems?: Array<{
    itemNumber: string | null
    productName: string
    qty: number
    price: number
    lineTotal: number
  }>
}

function mapPortalStatus(status: string | null): Order['status'] {
  if (!status) return 'submitted'
  const s = status.toLowerCase()
  if (s === 'delivered' || s === 'closed' || s === 'complete') return 'delivered'
  if (s === 'cancelled' || s === 'canceled') return 'cancelled'
  // "Created", "Open", "Processing", "Shipped" etc. → submitted
  return 'submitted'
}

/**
 * Reads scraped order history from localStorage, upserts into IndexedDB.
 * - Matches existing PWA orders by lactalisOrderNumber
 * - Creates new Order records for portal-only orders (portalSource: true)
 * Returns the number of orders upserted.
 */
export async function applyOrderHistory(): Promise<number> {
  const raw = localStorage.getItem(ORDER_HISTORY_KEY)
  if (!raw) {
    console.log('[Milk Manager] No order history in localStorage')
    return 0
  }

  let data: { orders: ScrapedOrder[]; scrapedAt: number }
  try {
    data = JSON.parse(raw)
  } catch {
    console.warn('[Milk Manager] Failed to parse order history from localStorage')
    return 0
  }

  if (!data.orders || !Array.isArray(data.orders) || data.orders.length === 0) {
    console.log('[Milk Manager] Order history empty or invalid')
    return 0
  }

  console.log(`[Milk Manager] Applying ${data.orders.length} scraped orders from extension`)
  const count = await upsertOrderHistory(data.orders)
  console.log(`[Milk Manager] Upserted ${count} orders into IndexedDB`)
  if (count > 0) localStorage.removeItem(ORDER_HISTORY_KEY)
  return count
}

/** Shared upsert logic for order history — used by both localStorage bridge and cloud fetch. */
async function upsertOrderHistory(scrapedOrders: ScrapedOrder[]): Promise<number> {
  const existingOrders = await db.orders.toArray()
  let upserted = 0

  for (const scraped of scrapedOrders) {
    if (!scraped.orderNumber) continue

    const existing = existingOrders.find(
      (o) => o.lactalisOrderNumber === scraped.orderNumber,
    )

    if (existing) {
      const updates: Partial<Order> = {
        portalStatus: scraped.orderStatus ?? undefined,
        portalRefNumber: scraped.refNumber ?? undefined,
      }
      if (
        existing.status === 'submitted' &&
        mapPortalStatus(scraped.orderStatus) === 'delivered'
      ) {
        updates.status = 'delivered'
      }
      await db.orders.update(existing.id!, updates)

      // If line items arrived for an existing order that didn't have them yet
      if (scraped.lineItems && scraped.lineItems.length > 0) {
        const existingLines = await db.orderLines.where('orderId').equals(existing.id!).count()
        if (existingLines === 0) {
          const products = await db.products.toArray()
          const productMap = new Map(products.map((p) => [p.itemNumber, p]))
          const orderLines = scraped.lineItems
            .filter((li) => li.itemNumber)
            .map((li) => {
              const product = productMap.get(li.itemNumber!)
              return {
                orderId: existing.id!,
                productId: product?.id ?? 0,
                itemNumber: li.itemNumber!,
                productName: li.productName ?? product?.name ?? '',
                suggestedQty: 0,
                approvedQty: li.qty,
                unitPrice: li.price,
                lineTotal: li.lineTotal || li.qty * li.price,
              }
            })
          if (orderLines.length > 0) {
            await db.orderLines.bulkAdd(orderLines)
          }
        }
      }

      upserted++
    } else {
      const newOrder: Omit<Order, 'id'> = {
        deliveryDate: scraped.deliveryDate ?? '',
        createdAt: scraped.createdAt ? new Date(scraped.createdAt) : new Date(),
        submittedAt: scraped.createdAt ? new Date(scraped.createdAt) : new Date(),
        status: mapPortalStatus(scraped.orderStatus),
        totalCostEstimate: scraped.total,
        lactalisOrderNumber: scraped.orderNumber,
        portalSource: true,
        portalStatus: scraped.orderStatus ?? undefined,
        portalRefNumber: scraped.refNumber ?? undefined,
      }
      const orderId = await db.orders.add(newOrder)

      if (scraped.lineItems && scraped.lineItems.length > 0) {
        const products = await db.products.toArray()
        const productMap = new Map(products.map((p) => [p.itemNumber, p]))

        const orderLines = scraped.lineItems
          .filter((li) => li.itemNumber)
          .map((li) => {
            const product = productMap.get(li.itemNumber!)
            return {
              orderId: orderId as number,
              productId: product?.id ?? 0,
              itemNumber: li.itemNumber!,
              productName: li.productName ?? product?.name ?? '',
              suggestedQty: 0,
              approvedQty: li.qty,
              unitPrice: li.price,
              lineTotal: li.lineTotal || li.qty * li.price,
            }
          })

        if (orderLines.length > 0) {
          await db.orderLines.bulkAdd(orderLines)
        }
      }

      upserted++
    }
  }

  return upserted
}
