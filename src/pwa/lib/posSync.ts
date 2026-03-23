/**
 * posSync.ts — Shared POS-to-Dexie sync
 *
 * Fetches live POS performance data (MILK + DAIRY departments) and persists
 * both stock snapshots and sales records to Dexie with correct productId linking.
 *
 * All tabs (Order Builder, Products, Performance) read from the same Dexie tables,
 * so this single sync feeds them all.
 */

import { db } from './db'
import { getDairyPerformance, type ItemPerformance } from './posRelay'
import type { Product } from './types'

// ── POS item matching ────────────────────────────────────────────────────────

/** Match POS itemCode (e.g. "STR0019100") to a PWA product (itemNumber "19100") */
export function posItemMatchesProduct(itemCode: string, product: Product): boolean {
  if (product.itemNumber === itemCode) return true
  return itemCode.replace(/^STR0*/, '') === product.itemNumber
}

/** Strip STR0* prefix for map key normalisation */
export function stripPosPrefix(itemCode: string): string {
  return itemCode.replace(/^STR0*/, '')
}

// ── Build POS lookup map ─────────────────────────────────────────────────────

export function buildPosMap(posItems: ItemPerformance[]): Map<string, ItemPerformance> {
  const posMap = new Map<string, ItemPerformance>()
  for (const item of posItems) {
    const stripped = stripPosPrefix(item.itemCode)
    posMap.set(stripped, item)
    posMap.set(item.itemCode, item)
  }
  return posMap
}

/** Lookup a product in posMap by its itemNumber */
export function lookupPosItem(
  posMap: Map<string, ItemPerformance>,
  product: Product,
): ItemPerformance | null {
  return (
    posMap.get(product.itemNumber) ||
    posMap.get(product.itemNumber.replace(/^0+/, '')) ||
    null
  )
}

// ── Persist POS data to Dexie ────────────────────────────────────────────────

export interface PosSyncResult {
  posMap: Map<string, ItemPerformance>
  snapshotsWritten: number
  salesWritten: number
  matched: number
  unmatched: number
}

/**
 * Fetch live POS data and persist stock snapshots + sales records to Dexie.
 * Safe to call from any tab — idempotent per day (deduplicates by batchId date).
 */
export async function syncPosData(days = 7): Promise<PosSyncResult> {
  const posItems = await getDairyPerformance(days)
  const posMap = buildPosMap(posItems)

  if (posItems.length === 0) {
    return { posMap, snapshotsWritten: 0, salesWritten: 0, matched: 0, unmatched: 0 }
  }

  const products = await db.products.where('active').equals(1).toArray()
    .catch(() => db.products.toArray().then(ps => ps.filter(p => p.active)))

  const today = new Date().toISOString().split('T')[0]
  const batchId = `pos_live_${today}`

  // Check if we already synced today
  const existing = await db.stockSnapshots
    .where('importBatchId')
    .equals(batchId)
    .first()
  if (existing) {
    // Already synced today — just return the map for live use
    return { posMap, snapshotsWritten: 0, salesWritten: 0, matched: 0, unmatched: 0 }
  }

  const snapshots: Array<{
    productId: number
    barcode: string
    qoh: number
    importedAt: Date
    source: 'pos_live'
    importBatchId: string
  }> = []

  const salesRecords: Array<{
    productId: number
    barcode: string
    date: string
    qtySold: number
    salesValue: number
    cogs: number
    department: string
    importBatchId: string
    importedAt: Date
  }> = []

  let matched = 0
  let unmatched = 0

  for (const item of posItems) {
    const product = products.find(p => posItemMatchesProduct(item.itemCode, p))
    if (!product) {
      unmatched++
      continue
    }
    matched++

    // Stock snapshot
    snapshots.push({
      productId: product.id!,
      barcode: product.barcode,
      qoh: item.qoh,
      importedAt: new Date(),
      source: 'pos_live',
      importBatchId: batchId,
    })

    // Sales record (only if POS reports sales data)
    if (item.qtySold > 0 || item.revenue > 0) {
      salesRecords.push({
        productId: product.id!,
        barcode: product.barcode,
        date: today,
        qtySold: item.qtySold,
        salesValue: item.revenue,
        cogs: item.cost,
        department: product.department || 'dairy',
        importBatchId: batchId,
        importedAt: new Date(),
      })
    }
  }

  if (snapshots.length > 0) {
    await db.stockSnapshots.bulkAdd(snapshots).catch(() => {})
  }
  if (salesRecords.length > 0) {
    await db.salesRecords.bulkAdd(salesRecords).catch(() => {})
  }

  console.log(`[POS Sync] ${matched} matched, ${unmatched} unmatched, ${snapshots.length} snapshots, ${salesRecords.length} sales`)

  return {
    posMap,
    snapshotsWritten: snapshots.length,
    salesWritten: salesRecords.length,
    matched,
    unmatched,
  }
}
