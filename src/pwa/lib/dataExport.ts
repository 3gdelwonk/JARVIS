/**
 * dataExport.ts — Full IndexedDB backup and restore
 *
 * exportAllData()  → JSON string containing every table
 * importAllData()  → Wipes and restores from JSON backup
 *
 * Format: { version: 1, exportedAt: ISO string, tables: { [tableName]: row[] } }
 */

import { db } from './db'

export interface BackupPayload {
  version: 1
  exportedAt: string
  settings?: {
    claudeKey?: string
    geminiKey?: string
    storeName?: string
    lactalisEmail?: string
  }
  tables: {
    products: unknown[]
    stockSnapshots: unknown[]
    deliverySlots: unknown[]
    orders: unknown[]
    orderLines: unknown[]
    invoiceRecords: unknown[]
    invoiceLines: unknown[]
    priceHistory: unknown[]
    expiryBatches: unknown[]
    wasteLog: unknown[]
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export async function exportAllData(): Promise<string> {
  const [
    products,
    stockSnapshots,
    deliverySlots,
    orders,
    orderLines,
    invoiceRecords,
    invoiceLines,
    priceHistory,
    expiryBatches,
    wasteLog,
  ] = await Promise.all([
    db.products.toArray(),
    db.stockSnapshots.toArray(),
    db.deliverySlots.toArray(),
    db.orders.toArray(),
    db.orderLines.toArray(),
    db.invoiceRecords.toArray(),
    db.invoiceLines.toArray(),
    db.priceHistory.toArray(),
    db.expiryBatches.toArray(),
    db.wasteLog.toArray(),
  ])

  const payload: BackupPayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: {
      claudeKey:     localStorage.getItem('milk-manager-claude-key')     ?? undefined,
      geminiKey:     localStorage.getItem('milk-manager-gemini-key')     ?? undefined,
      storeName:     localStorage.getItem('milk-manager-store-name')     ?? undefined,
      lactalisEmail: localStorage.getItem('milk-manager-lactalis-email') ?? undefined,
    },
    tables: {
      products,
      stockSnapshots,
      deliverySlots,
      orders,
      orderLines,
      invoiceRecords,
      invoiceLines,
      priceHistory,
      expiryBatches,
      wasteLog,
    },
  }

  return JSON.stringify(payload, null, 2)
}

/** Triggers a browser file download of the backup JSON */
export function downloadBackup(json: string): void {
  const date = new Date().toISOString().slice(0, 10)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `milk-manager-backup-${date}.json`
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Import / Restore ─────────────────────────────────────────────────────────

export async function importAllData(json: string): Promise<void> {
  const payload = JSON.parse(json) as BackupPayload

  if (payload.version !== 1) {
    throw new Error(`Unsupported backup version: ${payload.version}`)
  }

  const t = payload.tables

  // Wipe all tables then re-populate — wrapped in a transaction where possible
  await db.transaction(
    'rw',
    [
      db.products,
      db.stockSnapshots,
      db.deliverySlots,
      db.orders,
      db.orderLines,
      db.invoiceRecords,
      db.invoiceLines,
      db.priceHistory,
      db.expiryBatches,
      db.wasteLog,
    ],
    async () => {
      await Promise.all([
        db.products.clear(),
        db.stockSnapshots.clear(),
        db.deliverySlots.clear(),
        db.orders.clear(),
        db.orderLines.clear(),
        db.invoiceRecords.clear(),
        db.invoiceLines.clear(),
        db.priceHistory.clear(),
        db.expiryBatches.clear(),
        db.wasteLog.clear(),
      ])

      await Promise.all([
        db.products.bulkAdd(t.products as never[]),
        db.stockSnapshots.bulkAdd(t.stockSnapshots as never[]),
        db.deliverySlots.bulkAdd(t.deliverySlots as never[]),
        db.orders.bulkAdd(t.orders as never[]),
        db.orderLines.bulkAdd(t.orderLines as never[]),
        db.invoiceRecords.bulkAdd(t.invoiceRecords as never[]),
        db.invoiceLines.bulkAdd(t.invoiceLines as never[]),
        db.priceHistory.bulkAdd(t.priceHistory as never[]),
        db.expiryBatches.bulkAdd(t.expiryBatches as never[]),
        db.wasteLog.bulkAdd(t.wasteLog as never[]),
      ])
    },
  )

  // Restore localStorage settings if present in backup
  const s = payload.settings
  if (s) {
    if (s.claudeKey)     localStorage.setItem('milk-manager-claude-key',     s.claudeKey)
    if (s.geminiKey)     localStorage.setItem('milk-manager-gemini-key',     s.geminiKey)
    if (s.storeName)     localStorage.setItem('milk-manager-store-name',     s.storeName)
    if (s.lactalisEmail) localStorage.setItem('milk-manager-lactalis-email', s.lactalisEmail)
  }
}
