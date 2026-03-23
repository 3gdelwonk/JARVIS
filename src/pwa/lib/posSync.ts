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

/** Strip STR0* prefix for map key normalisation */
export function stripPosPrefix(itemCode: string): string {
  return itemCode.replace(/^STR0*/, '')
}

/** Normalise a string for fuzzy comparison: lowercase, collapse whitespace, strip common noise */
function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Token-overlap similarity: intersection / min(tokensA, tokensB). Returns 0–1. */
function tokenSimilarity(a: string, b: string): number {
  const tokA = new Set(normalise(a).split(' ').filter(t => t.length > 1))
  const tokB = new Set(normalise(b).split(' ').filter(t => t.length > 1))
  if (tokA.size === 0 || tokB.size === 0) return 0
  let overlap = 0
  for (const t of tokA) if (tokB.has(t)) overlap++
  return overlap / Math.min(tokA.size, tokB.size)
}

const FUZZY_THRESHOLD = 0.6

/**
 * Match POS item to PWA product. Priority:
 * 1. Exact itemCode match (strip STR0* prefix)
 * 2. Barcode match
 * 3. Fuzzy description match (token overlap ≥ 60%)
 */
export function findMatchingProduct(
  item: ItemPerformance,
  products: Product[],
): Product | null {
  const stripped = stripPosPrefix(item.itemCode)

  // 1. Exact code match
  for (const p of products) {
    if (p.itemNumber === stripped || p.itemNumber === item.itemCode) return p
  }

  // 2. Barcode match (if POS description contains a barcode-like string)
  // Not applicable here — POS ItemPerformance has no barcode field

  // 3. Fuzzy description match
  let bestProduct: Product | null = null
  let bestScore = 0
  const posDesc = item.description
  for (const p of products) {
    // Compare against product name and smartRetailName
    const nameScore = tokenSimilarity(posDesc, p.name)
    const srScore = p.smartRetailName ? tokenSimilarity(posDesc, p.smartRetailName) : 0
    const score = Math.max(nameScore, srScore)
    if (score > bestScore) {
      bestScore = score
      bestProduct = p
    }
  }

  if (bestScore >= FUZZY_THRESHOLD && bestProduct) {
    return bestProduct
  }

  return null
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
    const product = findMatchingProduct(item, products)
    if (!product) {
      unmatched++
      console.log(`[POS Sync] No match: ${item.itemCode} "${item.description}"`)
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
