/**
 * posSync.ts — Shared POS-to-Dexie sync with backfill
 *
 * Fetches live POS performance data (MILK + DAIRY departments) and persists
 * both stock snapshots and sales records to Dexie with correct productId linking.
 *
 * Backfill: On each sync, detects missed days since last sync and makes
 * successive API calls (days=1..N) to compute per-day sales via subtraction.
 *
 * Dedup: Uses date+productId compound index to prevent cross-device duplication.
 */

import { db } from './db'
import { getDairyPerformance, type ItemPerformance } from './posRelay'
import type { Product } from './types'

// ── Last sync tracking ──────────────────────────────────────────────────────

const LAST_SYNC_KEY = 'milk-manager-pos-last-sync'

function getLastSyncDate(): string | null {
  return localStorage.getItem(LAST_SYNC_KEY)
}

function setLastSyncDate(date: string): void {
  localStorage.setItem(LAST_SYNC_KEY, date)
}

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
  backfilledDays: number
}

/** Format a Date as YYYY-MM-DD in local time */
function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Count calendar days between two YYYY-MM-DD strings */
function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00')
  const db = new Date(b + 'T00:00:00')
  return Math.round((db.getTime() - da.getTime()) / 86400000)
}

/**
 * Write sales records for a single date with date+productId dedup.
 * Deletes any existing records matching the same date+productId combos before inserting.
 */
async function writeSalesRecords(
  records: Array<{
    productId: number
    barcode: string
    date: string
    qtySold: number
    salesValue: number
    cogs: number
    department: string
    importBatchId: string
    importedAt: Date
  }>,
): Promise<void> {
  if (records.length === 0) return

  const date = records[0]!.date

  // Delete existing records for this date + any of these productIds
  // Use compound index [date+productId] for efficient deletion
  const productIds = records.map(r => r.productId)
  await db.salesRecords
    .where('[date+productId]')
    .anyOf(productIds.map(pid => [date, pid]))
    .delete()

  await db.salesRecords.bulkAdd(records).catch(() => {})
}

/**
 * Fetch live POS data and persist stock snapshots + sales records to Dexie.
 * Backfills missed days using successive API subtraction.
 * Deduplicates by date+productId to prevent cross-device duplication.
 */
export async function syncPosData(days = 1): Promise<PosSyncResult> {
  const posItems = await getDairyPerformance(days)
  const posMap = buildPosMap(posItems)

  if (posItems.length === 0) {
    return { posMap, snapshotsWritten: 0, salesWritten: 0, matched: 0, unmatched: 0, backfilledDays: 0 }
  }

  const allProducts = await db.products.toArray()
  const products = allProducts.filter(p => p.active !== false)

  const today = toDateStr(new Date())
  const batchId = `pos_live_${today}`

  // Check if stock snapshots already written today
  const snapshotsExist = await db.stockSnapshots
    .where('importBatchId')
    .equals(batchId)
    .first()

  const snapshots: Array<{
    productId: number
    barcode: string
    qoh: number
    importedAt: Date
    source: 'pos_live'
    importBatchId: string
  }> = []

  const todaySales: Array<{
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

  // Build itemCode → product mapping for reuse in backfill
  const itemProductMap = new Map<string, Product>()

  for (const item of posItems) {
    const product = findMatchingProduct(item, products)
    if (!product) {
      unmatched++
      continue
    }
    matched++

    // Cache the match for backfill
    itemProductMap.set(item.itemCode, product)

    // Stock snapshot
    snapshots.push({
      productId: product.id!,
      barcode: product.barcode,
      qoh: item.qoh,
      importedAt: new Date(),
      source: 'pos_live',
      importBatchId: batchId,
    })

    // Sales record — actual daily totals (days=1 gives today's real figures)
    if (item.qtySold > 0 || item.revenue > 0) {
      todaySales.push({
        productId: product.id!,
        barcode: product.barcode,
        date: today,
        qtySold: item.qtySold,
        salesValue: Math.round(item.revenue * 100) / 100,
        cogs: Math.round(item.cost * 100) / 100,
        department: product.department || 'dairy',
        importBatchId: batchId,
        importedAt: new Date(),
      })
    }
  }

  // Write stock snapshots only if not already done today
  if (!snapshotsExist && snapshots.length > 0) {
    await db.stockSnapshots.bulkAdd(snapshots).catch(() => {})
  }

  // Write today's sales with date+productId dedup
  await writeSalesRecords(todaySales)

  let totalSalesWritten = todaySales.length
  let backfilledDays = 0

  // ── Backfill missed days ──────────────────────────────────────────────────
  const lastSync = getLastSyncDate()
  if (lastSync && lastSync !== today) {
    const missed = Math.min(7, daysBetween(lastSync, today) - 1)

    if (missed > 0) {
      console.log(`[POS Sync] Backfilling ${missed} missed day(s) since ${lastSync}`)

      // We already have days=1 result (posItems). Fetch days=2 through days=(missed+1) in parallel.
      const cumulativeResults = new Map<number, ItemPerformance[]>()
      cumulativeResults.set(1, posItems)

      const fetchPromises: Promise<void>[] = []
      for (let d = 2; d <= missed + 1; d++) {
        fetchPromises.push(
          getDairyPerformance(d).then(items => {
            cumulativeResults.set(d, items)
          }),
        )
      }
      await Promise.all(fetchPromises)

      // For each missed day, compute per-day data via subtraction
      for (let d = 1; d <= missed; d++) {
        const cumLarger = cumulativeResults.get(d + 1)  // days=(d+1) cumulative
        const cumSmaller = cumulativeResults.get(d)      // days=d cumulative
        if (!cumLarger || !cumSmaller) continue

        // Build lookup by itemCode for the smaller cumulative
        const smallerByCode = new Map<string, ItemPerformance>()
        for (const item of cumSmaller) {
          smallerByCode.set(item.itemCode, item)
        }

        // Compute the date for this backfill day
        const backfillDate = new Date()
        backfillDate.setDate(backfillDate.getDate() - d)
        const dateStr = toDateStr(backfillDate)
        const backfillBatchId = `pos_backfill_${dateStr}`

        const backfillSales: typeof todaySales = []

        for (const item of cumLarger) {
          const smaller = smallerByCode.get(item.itemCode)
          const product = itemProductMap.get(item.itemCode)
          if (!product) continue

          // Subtract to get this specific day's values
          const dailyQty = Math.max(0, item.qtySold - (smaller?.qtySold ?? 0))
          const dailyRevenue = Math.max(0, item.revenue - (smaller?.revenue ?? 0))
          const dailyCost = Math.max(0, item.cost - (smaller?.cost ?? 0))

          if (dailyQty > 0 || dailyRevenue > 0) {
            backfillSales.push({
              productId: product.id!,
              barcode: product.barcode,
              date: dateStr,
              qtySold: dailyQty,
              salesValue: Math.round(dailyRevenue * 100) / 100,
              cogs: Math.round(dailyCost * 100) / 100,
              department: product.department || 'dairy',
              importBatchId: backfillBatchId,
              importedAt: new Date(),
            })
          }
        }

        await writeSalesRecords(backfillSales)
        totalSalesWritten += backfillSales.length
        backfilledDays++
      }

      console.log(`[POS Sync] Backfilled ${backfilledDays} day(s)`)
    }
  }

  // Update last sync date
  setLastSyncDate(today)

  console.log(`[POS Sync] ${matched} matched, ${unmatched} unmatched, ${snapshots.length} snapshots, ${totalSalesWritten} sales (${backfilledDays} backfilled days)`)

  return {
    posMap,
    snapshotsWritten: snapshots.length,
    salesWritten: totalSalesWritten,
    matched,
    unmatched,
    backfilledDays,
  }
}
