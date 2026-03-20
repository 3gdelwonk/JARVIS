/**
 * stockAnalytics.ts — Stock performance analytics
 *
 * Pure functions over in-memory data — no DB calls. Call from useLiveQuery or async effects.
 *
 * Key metrics:
 *  - ABC classification (revenue-based Pareto: A=80%, B=15%, C=4%, D=dead)
 *  - GMROI (Gross Margin Return on Inventory Investment)
 *  - Stock turn rate (annualised inventory turns)
 *  - Velocity trend (last 4w vs prev 4w)
 *  - Shrinkage (expected QOH from deliveries/sales vs actual QOH)
 */

import type { Product, SalesRecord, StockSnapshot, InvoiceLine, StockPerformance } from './types'
import { parseLocalDate } from './constants'

// ─── Internal helpers ─────────────────────────────────────────────────────────

function daysBetween(a: string, b: string): number {
  return Math.abs(
    (parseLocalDate(b).getTime() - parseLocalDate(a).getTime()) / 86400000,
  )
}

function offsetDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().split('T')[0]
}

// ─── ABC Classification ───────────────────────────────────────────────────────

/**
 * Classify products by ABC method using recent sales revenue.
 * A = top 80% of total revenue, B = next 15%, C = next 4%, D = 0/dead (<1 sale in 30d)
 */
export function classifyABC(
  products: Product[],
  salesRecords: SalesRecord[],
  periodDays = 90,
): Map<number, 'A' | 'B' | 'C' | 'D'> {
  const cutoff = offsetDate(periodDays)
  const recentSales = salesRecords.filter((s) => s.date >= cutoff)
  const deadCutoff = offsetDate(30)

  // Revenue per product
  const revenueByProduct = new Map<number, number>()
  for (const s of recentSales) {
    if (!s.productId) continue
    revenueByProduct.set(s.productId, (revenueByProduct.get(s.productId) ?? 0) + s.salesValue)
  }

  // Products with any sale in last 30 days
  const activeLast30 = new Set(
    salesRecords.filter((s) => s.date >= deadCutoff && s.productId).map((s) => s.productId!),
  )

  const result = new Map<number, 'A' | 'B' | 'C' | 'D'>()

  // Sort by revenue descending
  const sorted = products
    .filter((p) => p.id !== undefined)
    .sort((a, b) => (revenueByProduct.get(b.id!) ?? 0) - (revenueByProduct.get(a.id!) ?? 0))

  const totalRevenue = [...revenueByProduct.values()].reduce((s, v) => s + v, 0)

  let cumulative = 0
  for (const p of sorted) {
    const rev = revenueByProduct.get(p.id!) ?? 0

    if (rev === 0 || !activeLast30.has(p.id!)) {
      result.set(p.id!, 'D')
      continue
    }

    cumulative += rev
    const pct = totalRevenue > 0 ? cumulative / totalRevenue : 0

    if (pct <= 0.80) result.set(p.id!, 'A')
    else if (pct <= 0.95) result.set(p.id!, 'B')
    else if (pct <= 0.99) result.set(p.id!, 'C')
    else result.set(p.id!, 'D')
  }

  // Products with no POS data at all — default to 'D' if no sales at all
  for (const p of products) {
    if (p.id !== undefined && !result.has(p.id)) {
      result.set(p.id!, 'D')
    }
  }

  return result
}

// ─── Velocity trend ───────────────────────────────────────────────────────────

/** % change in sales velocity: last 4 weeks vs the 4 weeks before that */
export function computeTrend(
  salesRecords: SalesRecord[],
  productId: number | undefined,
  barcode: string,
): number {
  const now = new Date().toISOString().split('T')[0]
  const w4ago = offsetDate(28)
  const w8ago = offsetDate(56)

  const relevant = salesRecords.filter(
    (s) => s.date <= now && (s.productId === productId || s.barcode === barcode),
  )

  const recent4w = relevant.filter((s) => s.date >= w4ago)
  const prev4w = relevant.filter((s) => s.date >= w8ago && s.date < w4ago)

  const recentQty = recent4w.reduce((s, r) => s + r.qtySold, 0) / 28
  const prevQty = prev4w.reduce((s, r) => s + r.qtySold, 0) / 28

  if (prevQty === 0) return recentQty > 0 ? 100 : 0
  return Math.round(((recentQty - prevQty) / prevQty) * 100)
}

// ─── Shrinkage ────────────────────────────────────────────────────────────────

/**
 * Shrinkage = expected QOH (prevQOH + delivered - sold) minus actual QOH.
 * Positive = more gone than sold (theft/waste/spoilage).
 */
export function computeShrinkage(
  currentQOH: number,
  prevQOH: number,
  delivered: number,
  sold: number,
): number {
  const expected = prevQOH + delivered - sold
  return Math.max(0, expected - currentQOH)
}

// ─── Latest QOH ───────────────────────────────────────────────────────────────

/** Most recent quantity-on-hand per product from a flat snapshot array. */
export function getLatestQoh(snapshots: StockSnapshot[]): Map<number, number> {
  const qohMap = new Map<number, number>()
  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.importedAt).getTime() - new Date(b.importedAt).getTime(),
  )
  for (const s of sorted) qohMap.set(s.productId, s.qoh)
  return qohMap
}

// ─── Stock value ──────────────────────────────────────────────────────────────

/** Total inventory value at cost (QOH × cost price) */
export function stockValue(
  products: Product[],
  snapshots: StockSnapshot[],
): number {
  const latestQoh = getLatestQoh(snapshots)
  return products.reduce((total, p) => {
    const qoh = latestQoh.get(p.id!) ?? 0
    return total + qoh * p.lactalisCostPrice
  }, 0)
}

// ─── Per-product performance ──────────────────────────────────────────────────

export function computePerformance(
  product: Product,
  opts: {
    salesRecords: SalesRecord[]    // all sales records (not pre-filtered)
    snapshots: StockSnapshot[]     // all stock snapshots (not pre-filtered)
    invoiceLines: InvoiceLine[]    // all invoice lines (not pre-filtered)
    abcClass?: 'A' | 'B' | 'C' | 'D'
    leadTimeDays?: number  // reserved for future safety stock calc
  },
): StockPerformance {
  const { salesRecords, snapshots, invoiceLines, abcClass } = opts

  // Filter to this product
  const productSales = salesRecords.filter(
    (s) => s.productId === product.id || s.barcode === product.barcode,
  )
  const productSnaps = snapshots.filter((s) => s.productId === product.id)
  const productLines = invoiceLines.filter((l) => l.productCode === product.invoiceCode)

  // Latest QOH
  const sortedSnaps = [...productSnaps].sort(
    (a, b) => new Date(b.importedAt).getTime() - new Date(a.importedAt).getTime(),
  )
  const currentQOH = sortedSnaps[0]?.qoh ?? 0

  // ── Velocity from POS sales (prefer demand-side) ──────────────────────────
  const cutoff90 = offsetDate(90)
  const recentSales = productSales.filter((s) => s.date >= cutoff90)
  const salesDates = [...new Set(recentSales.map((s) => s.date))].sort()

  let avgDailySales = 0
  let dataSource: StockPerformance['dataSource'] = 'default'
  let lastSaleDate: string | undefined

  if (salesDates.length >= 7) {
    const periodDays = Math.max(
      1,
      daysBetween(salesDates[0]!, salesDates[salesDates.length - 1]!) + 1,
    )
    const totalQty = recentSales.reduce((s, r) => s + r.qtySold, 0)
    avgDailySales = totalQty / periodDays
    dataSource = 'pos_scan'
    lastSaleDate = salesDates[salesDates.length - 1]
  } else {
    // Fall back to invoice-based velocity
    const VALID_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
    const byDate = new Map<string, number>()
    for (const l of productLines) {
      if (!VALID_DATE_RE.test(l.deliveryDate)) continue
      byDate.set(l.deliveryDate, (byDate.get(l.deliveryDate) ?? 0) + l.quantity)
    }
    const deliveryDates = [...byDate.keys()].sort()
    if (deliveryDates.length >= 2) {
      const periodDays = Math.max(
        1,
        daysBetween(deliveryDates[0]!, deliveryDates[deliveryDates.length - 1]!),
      )
      const totalQty = [...byDate.values()].reduce((a, b) => a + b, 0)
      avgDailySales = totalQty / periodDays
      dataSource = 'invoice'
    }
  }

  // ── Derived metrics ───────────────────────────────────────────────────────

  const costPrice = product.lactalisCostPrice || 0
  const sellPrice = product.sellPrice || 0
  const marginPerUnit = sellPrice - costPrice

  const annualUnits = avgDailySales * 365
  const annualCOGS = annualUnits * costPrice
  const annualGrossMargin = annualUnits * marginPerUnit

  // Average inventory cost = (QOH / 2) * costPrice (assumes linear depletion between deliveries)
  const avgInventoryCost = Math.max(currentQOH * costPrice, costPrice)  // at least one unit cost as floor

  const stockTurnRate = annualCOGS > 0 && avgInventoryCost > 0
    ? annualCOGS / avgInventoryCost
    : 0

  const gmroi = annualGrossMargin > 0 && avgInventoryCost > 0
    ? annualGrossMargin / avgInventoryCost
    : 0

  const daysOfStock = avgDailySales > 0
    ? Math.round((currentQOH / avgDailySales) * 10) / 10
    : currentQOH > 0 ? 999 : 0

  const velocityTrend = computeTrend(salesRecords, product.id, product.barcode)

  // Shrinkage: compare last two snapshots (rough estimate)
  let shrinkage: number | undefined
  if (sortedSnaps.length >= 2) {
    const currentSnap = sortedSnaps[0]!
    const prevSnap = sortedSnaps[1]!
    const snapDates = [prevSnap, currentSnap].map((s) => new Date(s.importedAt).toISOString().split('T')[0])
    const soldBetween = productSales
      .filter((s) => s.date >= snapDates[0]! && s.date <= snapDates[1]!)
      .reduce((sum, r) => sum + r.qtySold, 0)
    const deliveredBetween = productLines
      .filter((l) => l.deliveryDate >= snapDates[0]! && l.deliveryDate <= snapDates[1]!)
      .reduce((sum, l) => sum + l.quantity, 0)
    shrinkage = computeShrinkage(currentSnap.qoh, prevSnap.qoh, deliveredBetween, soldBetween)
  }

  return {
    productId: product.id!,
    avgDailySales: Math.round(avgDailySales * 100) / 100,
    dataSource,
    stockTurnRate: Math.round(stockTurnRate * 10) / 10,
    gmroi: Math.round(gmroi * 100) / 100,
    daysOfStock,
    velocityTrend,
    shrinkage,
    abcClass: abcClass ?? 'D',
    lastSaleDate,
  }
}
