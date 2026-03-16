/**
 * extensionSync.ts — reads data written by pwa-bridge.js into localStorage
 * and applies it to the PWA's IndexedDB.
 *
 * localStorage keys consumed (written by extension/content-scripts/pwa-bridge.js):
 *   milk-manager-status-updates     Array<{ orderId, lactalisRef, submittedAt }>
 *   milk-manager-schedule-from-extension  { nextDelivery, upcomingDeliveries, scrapedAt, source }
 */

import { db } from './db'
import type { DeliverySlot } from './types'

const STATUS_KEY   = 'milk-manager-status-updates'
const SCHEDULE_KEY = 'milk-manager-schedule-from-extension'

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

/** Ask the extension to open the Lactalis Quick Order page and auto-submit. */
export function triggerOrderSubmit() {
  window.dispatchEvent(new CustomEvent('milk-manager-submit-order'))
}

// ─── Cloud relay functions (via Cloudflare Worker) ──────────────────────────

function getWorkerUrl(): string | null {
  return localStorage.getItem('milk-manager-worker-url')?.replace(/\/+$/, '') || null
}

/**
 * Fetch schedule from the Worker (which checks KV cache first).
 * Returns number of slots upserted, or 0 if unavailable.
 */
export async function fetchCloudSchedule(): Promise<number> {
  const base = getWorkerUrl()
  if (!base) return 0

  try {
    const res = await fetch(`${base}/schedule`)
    if (!res.ok) return 0
    const data = await res.json()

    // The cloud cache returns the same format as the extension schedule
    const slots: ScrapedSlot[] = data.upcomingDeliveries
      ?? (data.nextDelivery ? [data.nextDelivery] : [])
      ?? (data.slots ?? []).map((s: { deliveryDate: string }) => ({ deliveryDate: s.deliveryDate }))

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
    headers: { 'Content-Type': 'application/json' },
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
    const res = await fetch(`${base}/extension/order-status`)
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}
