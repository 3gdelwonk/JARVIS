/**
 * cloudSync.ts — Two-way cloud sync via JARVISmart
 *
 * Pushes local Dexie changes to JARVISmart SQLite, pulls remote changes back.
 * Uses syncId (UUID) as global identifier and syncUpdatedAt for incremental sync.
 *
 * Sync order: parents first (products, orders, invoiceRecords) then children.
 */

import { db } from './db'
import { getRelayUrl, getApiKey } from './lactalisRelay'

// ── Config ──

const DEVICE_ID_KEY = 'milk-manager-device-id'
const LAST_PUSH_KEY = 'milk-manager-sync-last-push'
const LAST_PULL_KEY = 'milk-manager-sync-last-pull'
const AUTO_SYNC_KEY = 'milk-manager-sync-auto'

// Tables in sync order: parents first, then children
const PARENT_TABLES = ['products', 'orders', 'invoiceRecords', 'deliverySlots'] as const
const CHILD_TABLES = [
  'orderLines', 'stockSnapshots', 'invoiceLines', 'priceHistory',
  'expiryBatches', 'wasteLog', 'claimRecords', 'gmailSyncLog', 'salesRecords',
] as const
const ALL_TABLES = [...PARENT_TABLES, ...CHILD_TABLES] as const

// FK mappings: child table → { fkField → parentTable }
const FK_MAP: Record<string, Record<string, string>> = {
  orderLines:     { orderSyncId: 'orders', productSyncId: 'products' },
  stockSnapshots: { productSyncId: 'products' },
  invoiceLines:   { invoiceRecordSyncId: 'invoiceRecords' },
  priceHistory:   { productSyncId: 'products' },
  expiryBatches:  { productSyncId: 'products', orderSyncId: 'orders' },
  wasteLog:       { productSyncId: 'products', expiryBatchSyncId: 'expiryBatches' },
  claimRecords:   { productSyncId: 'products', orderSyncId: 'orders' },
  salesRecords:   { productSyncId: 'products' },
}

// FK local ID fields corresponding to syncId fields
const FK_LOCAL_ID: Record<string, string> = {
  orderSyncId: 'orderId',
  productSyncId: 'productId',
  invoiceRecordSyncId: 'invoiceRecordId',
  expiryBatchSyncId: 'expiryBatchId',
}

// ── Device ID ──

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

// ── Sync status ──

export interface SyncStatus {
  deviceId: string
  lastPush: number | null
  lastPull: number | null
  autoSync: boolean
}

export function getSyncStatus(): SyncStatus {
  return {
    deviceId: getDeviceId(),
    lastPush: Number(localStorage.getItem(LAST_PUSH_KEY)) || null,
    lastPull: Number(localStorage.getItem(LAST_PULL_KEY)) || null,
    autoSync: localStorage.getItem(AUTO_SYNC_KEY) !== 'false',
  }
}

// ── HTTP helper ──

async function syncFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const base = getRelayUrl()
  const apiKey = getApiKey()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  }
  if (apiKey) headers['X-API-Key'] = apiKey

  const res = await fetch(`${base}/api/sync${path}`, { ...options, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error || `Sync ${res.status}`)
  }
  return res.json() as Promise<T>
}

// ── Push ──

export async function syncPush(): Promise<number> {
  const deviceId = getDeviceId()
  const lastPush = Number(localStorage.getItem(LAST_PUSH_KEY)) || 0
  const payload: Record<string, any[]> = {}
  let totalPushed = 0

  for (const tableName of ALL_TABLES) {
    const table = db.table(tableName)
    const changed = await table
      .where('syncUpdatedAt')
      .above(lastPush)
      .toArray()

    if (changed.length > 0) {
      // Populate FK syncIds for child records
      if (FK_MAP[tableName]) {
        for (const rec of changed) {
          for (const [syncIdField, parentTable] of Object.entries(FK_MAP[tableName])) {
            const localIdField = FK_LOCAL_ID[syncIdField]
            if (localIdField && rec[localIdField] && !rec[syncIdField]) {
              // Look up parent's syncId
              const parent = await db.table(parentTable).get(rec[localIdField])
              if (parent?.syncId) {
                rec[syncIdField] = parent.syncId
              }
            }
          }
        }
      }
      payload[tableName] = changed
      totalPushed += changed.length
    }
  }

  if (totalPushed === 0) return 0

  await syncFetch('/push', {
    method: 'POST',
    body: JSON.stringify({ deviceId, tables: payload }),
  })

  localStorage.setItem(LAST_PUSH_KEY, String(Date.now()))
  return totalPushed
}

// ── Pull ──

interface PullResponse {
  tables: Record<string, any[]>
  serverTime: number
  hasMore: boolean
}

export async function syncPull(): Promise<number> {
  const deviceId = getDeviceId()
  const lastPull = Number(localStorage.getItem(LAST_PULL_KEY)) || 0
  let totalPulled = 0
  let since = lastPull

  // Paginated pull
  let hasMore = true
  while (hasMore) {
    const data = await syncFetch<PullResponse>(
      `/pull?since=${since}&deviceId=${encodeURIComponent(deviceId)}`
    )
    hasMore = data.hasMore

    // Build syncId→localId maps for parent tables (needed for FK resolution)
    const syncIdMaps = new Map<string, Map<string, number>>()
    for (const tableName of PARENT_TABLES) {
      const map = new Map<string, number>()
      const all = await db.table(tableName).toArray()
      for (const rec of all) {
        if (rec.syncId) map.set(rec.syncId, rec.id)
      }
      syncIdMaps.set(tableName, map)
    }
    // Also need expiryBatches map for wasteLog FK
    const ebMap = new Map<string, number>()
    const allEb = await db.expiryBatches.toArray()
    for (const rec of allEb) {
      if (rec.syncId) ebMap.set(rec.syncId, rec.id!)
    }
    syncIdMaps.set('expiryBatches', ebMap)

    // Process parents first, then children
    for (const tableName of ALL_TABLES) {
      const records = data.tables[tableName]
      if (!records || records.length === 0) continue

      const table = db.table(tableName)

      for (const remote of records) {
        // Find existing local record by syncId
        const existing = await table.where('syncId').equals(remote.syncId).first()

        if (existing) {
          // Update only if remote is newer
          if (remote.syncUpdatedAt > (existing.syncUpdatedAt || 0)) {
            const { id: _remoteId, ...updates } = remote
            await table.update(existing.id, updates)
            totalPulled++
          }
        } else {
          // New record — resolve FK syncIds to local IDs
          const toInsert = { ...remote }
          delete toInsert.id // Let Dexie assign local ID

          if (FK_MAP[tableName]) {
            for (const [syncIdField, parentTable] of Object.entries(FK_MAP[tableName])) {
              const localIdField = FK_LOCAL_ID[syncIdField]
              if (localIdField && toInsert[syncIdField]) {
                const parentMap = syncIdMaps.get(parentTable)
                const localId = parentMap?.get(toInsert[syncIdField])
                if (localId) {
                  toInsert[localIdField] = localId
                }
              }
            }
          }

          const newId = await table.add(toInsert).catch(() => null)
          if (newId !== null) {
            totalPulled++
            // Update syncId map so subsequent children can resolve
            const parentMap = syncIdMaps.get(tableName)
            if (parentMap && toInsert.syncId) {
              parentMap.set(toInsert.syncId, newId as number)
            }
          }
        }
      }
    }

    // Move since forward for pagination
    if (data.serverTime) {
      since = data.serverTime
    }
  }

  localStorage.setItem(LAST_PULL_KEY, String(Date.now()))
  return totalPulled
}

// ── Full sync ──

export async function fullSync(): Promise<{ pushed: number; pulled: number }> {
  const pushed = await syncPush()
  const pulled = await syncPull()
  return { pushed, pulled }
}

// ── Auto-sync (debounced push + periodic full sync) ──

let pushTimer: ReturnType<typeof setTimeout> | null = null
let periodicTimer: ReturnType<typeof setInterval> | null = null

export function schedulePush(delayMs = 500): void {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    syncPush().catch(console.warn)
    pushTimer = null
  }, delayMs)
}

export function startPeriodicSync(intervalMs = 5 * 60 * 1000): void {
  if (periodicTimer) return
  periodicTimer = setInterval(() => {
    if (localStorage.getItem(AUTO_SYNC_KEY) === 'false') return
    fullSync().catch(console.warn)
  }, intervalMs)
}

export function stopPeriodicSync(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer)
    periodicTimer = null
  }
}
