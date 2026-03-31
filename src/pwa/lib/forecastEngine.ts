/**
 * forecastEngine.ts — Invoice-driven demand forecasting
 *
 * Algorithm (per product):
 *  1. Group invoice lines by delivery date → qty per delivery event
 *  2. Compute avgDailySales from total qty / period days (requires ≥2 data points)
 *  3. Safety stock  = safetyStockMultiplier × σ(deliveryQtys) × √leadTimeDays
 *  4. Suggested qty = (targetDays × avgDailySales) + safetyStock − currentStock
 *  5. Apply globalMultiplier, clamp to 0, round to whole units
 *
 * Fallbacks:
 *  - 1 data point  → use that single delivery's qty, no velocity calc
 *  - 0 data points → use product.defaultOrderQty (set manually or from invoice median)
 *  - No stock data → treat currentStock as 0 (conservative)
 */

import { db } from './db'
import { parseLocalDate } from './constants'
import type { InvoiceLine, Product, SalesRecord } from './types'
import { type ItemPerformance } from './posRelay'
import { syncPosData, lookupPosItem } from './posSync'

// ─── Settings ─────────────────────────────────────────────────────────────────

export interface ForecastSettings {
  leadTimeDays: number            // Hours between cutoff and delivery, expressed in days (default 1)
  safetyStockMultiplier: number   // σ multiplier — FMCG standard is 1.5
  targetDaysOfStock: number       // Global default; overridden by product.targetDaysOfStock
  globalMultiplier: number        // Scale all suggestions (1.0 = no change)
}

export const DEFAULT_SETTINGS: ForecastSettings = {
  leadTimeDays: 1,
  safetyStockMultiplier: 1.5,
  targetDaysOfStock: 3,
  globalMultiplier: 1.0,
}

const SETTINGS_KEY = 'milk-manager-forecast-settings'

export function getSettings(): ForecastSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: ForecastSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  // Notify same-window listeners (e.g. BuildView) that settings changed
  window.dispatchEvent(new CustomEvent('forecast-settings-changed'))
}

// ─── Forecast output type ─────────────────────────────────────────────────────

export interface Forecast {
  productId: number
  productName: string
  itemNumber: string
  invoiceCode: string
  category: 'fresh' | 'flavoured' | 'uht' | 'specialty'
  isGstBearing: boolean
  orderUnit: string
  unitsPerOrder: number

  // Velocity metrics
  avgDailySales: number         // Units consumed per day
  avgPerDelivery: number        // Avg qty per delivery event
  deliveryFrequency: number     // Deliveries per week (from invoice pattern)

  // Order suggestion
  suggestedQty: number          // Ready to paste into portal
  safetyStock: number           // Buffer included in suggestedQty
  reorderPoint: number          // Stock level that triggers reorder

  // Stock
  currentStock: number | null   // From latest Smart Retail snapshot (null = unknown)
  daysUntilStockout: number | null

  // Pricing
  lactalisCostPrice: number
  sellPrice: number

  // Confidence
  confidence: 'high' | 'medium' | 'low'
  dataPoints: number            // Invoice delivery events used (or POS days when velocitySource='pos_scan')
  insufficientData: boolean     // < 2 events — suggestion is a rough estimate
  velocitySource: 'pos_scan' | 'invoice' | 'default'
  posDataDays: number           // Days of POS scan data available (0 if none)

  // Waste
  wasteRate: number | null      // fraction wasted (wastedQty / receivedQty); null = no data
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

function sampleStdDev(nums: number[]): number {
  if (nums.length < 2) return 0
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length
  return Math.sqrt(
    nums.reduce((s, n) => s + (n - mean) ** 2, 0) / (nums.length - 1),
  )
}

// Fallback delivery frequency (deliveries/week) by product's orderFrequency label
const FREQ_WEEKLY: Record<string, number> = {
  every: 3,
  most: 2.5,
  some: 1.5,
  occasional: 0.5,
}

// ─── Per-product forecast ─────────────────────────────────────────────────────

function forecastProduct(
  product: Product,
  lines: InvoiceLine[],          // invoice-type lines only, unsorted
  currentStock: number | null,
  settings: ForecastSettings,
  wasteRate: number | null,
  posRecords: SalesRecord[] = [],  // POS sales from salesRecords table (last 90d, pre-filtered)
): Forecast {
  const targetDays = product.targetDaysOfStock || settings.targetDaysOfStock

  // Defaults — overwritten when we have sufficient data
  let avgDailySales = 0
  let avgPerDelivery = product.defaultOrderQty
  let deliveryFrequency = FREQ_WEEKLY[product.orderFrequency] ?? 2
  let safetyStock = 0
  let suggestedQty: number = product.defaultOrderQty
  let dataPoints = 0
  let velocitySource: Forecast['velocitySource'] = 'default'
  let posDataDays = 0

  // ── Phase 1: Try POS-based velocity (demand-side — more accurate) ──────────
  if (posRecords.length > 0) {
    const uniqueDates = [...new Set(posRecords.map((r) => r.date))].sort()
    posDataDays = uniqueDates.length

    if (posDataDays >= 7) {
      const periodDays = Math.max(
        1,
        (parseLocalDate(uniqueDates[uniqueDates.length - 1]!).getTime() -
          parseLocalDate(uniqueDates[0]!).getTime()) /
          86400000 +
          1,
      )
      const totalQty = posRecords.reduce((s, r) => s + r.qtySold, 0)
      avgDailySales = totalQty / periodDays

      // Daily variance for safety stock calculation
      const dailyQtys = uniqueDates.map((d) =>
        posRecords.filter((r) => r.date === d).reduce((s, r) => s + r.qtySold, 0),
      )
      const σ = sampleStdDev(dailyQtys)
      safetyStock = Math.max(
        0,
        settings.safetyStockMultiplier * σ * Math.sqrt(settings.leadTimeDays),
      )

      const stock = currentStock !== null && currentStock > 0 ? currentStock : 0
      suggestedQty = targetDays * avgDailySales + safetyStock - stock
      velocitySource = 'pos_scan'
      dataPoints = posDataDays
    }
  }

  // ── Phase 2: Fall back to invoice-based velocity ───────────────────────────
  if (velocitySource === 'default') {
    // Aggregate qty per delivery date — skip lines with malformed dates to prevent
    // sort corruption (PITFALL: invoiceParser may produce null/invalid deliveryDate)
    const VALID_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
    const byDate = new Map<string, number>()
    for (const l of lines) {
      if (!VALID_DATE_RE.test(l.deliveryDate)) continue
      byDate.set(l.deliveryDate, (byDate.get(l.deliveryDate) ?? 0) + l.quantity)
    }

    const deliveryDates = [...byDate.keys()].sort()
    const deliveryQtys = deliveryDates.map((d) => byDate.get(d)!)
    dataPoints = deliveryDates.length

    if (dataPoints >= 2) {
      // parseLocalDate() uses new Date(y,m,d) — guaranteed local midnight, no
      // string-parsing ambiguity, consistent across DST transitions (CLAUDE.md)
      const periodDays = Math.max(
        1,
        (parseLocalDate(deliveryDates[dataPoints - 1]!).getTime() -
          parseLocalDate(deliveryDates[0]!).getTime()) /
          86400000,
      )
      const totalQty = deliveryQtys.reduce((a, b) => a + b, 0)

      avgDailySales = totalQty / periodDays
      avgPerDelivery = totalQty / dataPoints
      deliveryFrequency = Math.min(7, (dataPoints / periodDays) * 7)

      const σ = sampleStdDev(deliveryQtys)
      safetyStock = Math.max(
        0,
        settings.safetyStockMultiplier * σ * Math.sqrt(settings.leadTimeDays),
      )

      const stock = currentStock !== null && currentStock > 0 ? currentStock : 0
      suggestedQty = targetDays * avgDailySales + safetyStock - stock
      velocitySource = 'invoice'
    } else if (dataPoints === 1) {
      avgPerDelivery = deliveryQtys[0] ?? product.defaultOrderQty
      suggestedQty = avgPerDelivery
      velocitySource = 'invoice'
    }
    // else: velocitySource stays 'default', suggestedQty = defaultOrderQty
  }

  // Apply global multiplier and round; never go negative
  suggestedQty = Math.max(0, Math.round(suggestedQty * settings.globalMultiplier))

  const reorderPoint =
    avgDailySales > 0
      ? Math.ceil(avgDailySales * settings.leadTimeDays + safetyStock)
      : 0

  const daysUntilStockout =
    currentStock !== null && currentStock > 0 && avgDailySales > 0
      ? Math.round((currentStock / avgDailySales) * 10) / 10
      : null

  // POS data has higher confidence threshold (daily data vs delivery events)
  const confidence: Forecast['confidence'] =
    velocitySource === 'pos_scan'
      ? posDataDays >= 14 ? 'high' : posDataDays >= 7 ? 'medium' : 'low'
      : dataPoints >= 8 ? 'high' : dataPoints >= 3 ? 'medium' : 'low'

  return {
    productId: product.id!,
    productName: product.name,
    itemNumber: product.itemNumber,
    invoiceCode: product.invoiceCode,
    category: product.category,
    isGstBearing: product.isGstBearing,
    orderUnit: product.orderUnit,
    unitsPerOrder: product.unitsPerOrder,
    avgDailySales: Math.round(avgDailySales * 100) / 100,
    avgPerDelivery: Math.round(avgPerDelivery * 10) / 10,
    deliveryFrequency: Math.round(deliveryFrequency * 10) / 10,
    suggestedQty,
    safetyStock: Math.round(safetyStock * 10) / 10,
    reorderPoint,
    currentStock,
    daysUntilStockout,
    lactalisCostPrice: product.lactalisCostPrice,
    sellPrice: product.sellPrice,
    confidence,
    dataPoints,
    insufficientData: velocitySource === 'default' || dataPoints < 2,
    velocitySource,
    posDataDays,
    wasteRate,
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function generateForecasts(
  settings: ForecastSettings = getSettings(),
): Promise<{ forecasts: Forecast[]; posMap: Map<string, ItemPerformance> }> {
  // Fetch + persist POS data in parallel with DB queries
  const posPromise = syncPosData(1)

  const [allProducts, allLines, allRecords, allSnapshots, allBatches, allWaste, allSales] = await Promise.all([
    db.products.toArray(),
    db.invoiceLines.toArray(),
    db.invoiceRecords.toArray(),
    db.stockSnapshots.toArray(),
    db.expiryBatches.toArray(),
    db.wasteLog.toArray(),
    db.salesRecords.toArray(),
  ])

  const products = allProducts.filter((p) => p.active)

  const { posMap } = await posPromise

  // Index invoice-type record IDs
  const invoiceIds = new Set(
    allRecords.filter((r) => r.documentType === 'invoice').map((r) => r.id!),
  )

  // Group lines by product invoice code (filter to invoices only)
  const linesByCode = new Map<string, InvoiceLine[]>()
  for (const line of allLines) {
    if (!invoiceIds.has(line.invoiceRecordId)) continue
    const arr = linesByCode.get(line.productCode) ?? []
    arr.push(line)
    linesByCode.set(line.productCode, arr)
  }

  // Waste rate per product (total wasted / total received from expiry tracking)
  const receivedByProduct = new Map<number, number>()
  const wastedByProduct   = new Map<number, number>()
  for (const b of allBatches) {
    receivedByProduct.set(b.productId, (receivedByProduct.get(b.productId) ?? 0) + b.quantity)
  }
  for (const w of allWaste) {
    wastedByProduct.set(w.productId, (wastedByProduct.get(w.productId) ?? 0) + w.quantity)
  }

  // Latest QOH per product — last snapshot wins (snapshots sorted ascending by import time)
  const latestQoh = new Map<number, number>()
  const sortedSnaps = [...allSnapshots].sort(
    (a, b) => new Date(a.importedAt).getTime() - new Date(b.importedAt).getTime(),
  )
  for (const s of sortedSnaps) {
    latestQoh.set(s.productId, s.qoh)
  }

  // POS sales grouped by productId and barcode for fast lookup
  // Filter to last 90 days so we don't use stale sales data for forecasting
  const cutoff90 = (() => {
    const d = new Date()
    d.setDate(d.getDate() - 90)
    return d.toISOString().split('T')[0]
  })()
  const recentSales = allSales.filter((s) => s.date >= cutoff90)

  const salesByProductId = new Map<number, typeof recentSales>()
  const salesByBarcode = new Map<string, typeof recentSales>()
  for (const s of recentSales) {
    if (s.productId) {
      const arr = salesByProductId.get(s.productId) ?? []
      arr.push(s)
      salesByProductId.set(s.productId, arr)
    }
    const arr2 = salesByBarcode.get(s.barcode) ?? []
    arr2.push(s)
    salesByBarcode.set(s.barcode, arr2)
  }

  const forecasts = products.map((p) => {
    const received = receivedByProduct.get(p.id!) ?? 0
    const wasted   = wastedByProduct.get(p.id!) ?? 0
    const wasteRate = received > 0 ? Math.round((wasted / received) * 1000) / 1000 : null

    // Use productId-matched sales first, then barcode fallback
    const posRecords =
      salesByProductId.get(p.id!) ??
      (p.barcode ? salesByBarcode.get(p.barcode) : undefined) ??
      []

    // Override currentStock with live POS QOH if available
    let currentStock = latestQoh.has(p.id!) ? (latestQoh.get(p.id!) ?? null) : null
    const livePosItem = lookupPosItem(posMap, p)
    if (livePosItem) {
      currentStock = livePosItem.qoh
    }

    return forecastProduct(
      p,
      linesByCode.get(p.invoiceCode) ?? [],
      currentStock,
      settings,
      wasteRate,
      posRecords,
    )
  })

  return { forecasts, posMap }
}
