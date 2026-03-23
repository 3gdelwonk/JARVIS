/**
 * historyAnalyzer.ts — Invoice-driven historical analysis
 *
 * Primary data source: InvoiceLines (from parsed Lactalis invoices)
 * Secondary: StockSnapshots (from Smart Retail exports)
 *
 * PITFALL #15: Invoice qty = DELIVERED qty (not ordered). Credit notes tracked separately.
 */

import { db } from './db'
import type { InvoiceLine, InvoiceRecord, Product } from './types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function median(nums: number[]): number {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
}

function dayName(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y!, m! - 1, d!).toLocaleDateString('en-AU', { weekday: 'long' })
}

function weekKey(dateStr: string): string {
  // Key = ISO date of the Monday that starts this week.
  // Sorts lexicographically and is correct across year boundaries.
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(y!, m! - 1, d!)
  const day = date.getDay() // 0=Sun … 6=Sat
  date.setDate(date.getDate() - ((day + 6) % 7)) // roll back to Monday
  return date.toISOString().slice(0, 10)
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProductStats {
  productId: number
  productCode: string       // 8-digit invoice code
  itemNumber: string        // stripped (no leading zeros)
  productName: string
  category: string
  // Frequency
  deliveriesOrdered: number // how many distinct deliveries included this product
  totalDeliveries: number   // total distinct deliveries in the dataset
  frequencyPct: number      // deliveriesOrdered / totalDeliveries × 100
  // Quantity
  avgQtyPerDelivery: number
  medianQtyPerDelivery: number
  minQty: number
  maxQty: number
  totalQtyDelivered: number
  // Pricing
  latestCost: number
  avgCost: number
  priceChanges: number      // how many distinct prices observed
  firstSeen: string         // YYYY-MM-DD
  lastSeen: string          // YYYY-MM-DD
  // Spend
  totalSpend: number
  // Raw deliveries for drill-down
  deliveries: { date: string; qty: number; unitType: string; cost: number }[]
}

export interface OverallStats {
  totalInvoices: number
  totalDeliveries: number          // distinct delivery note numbers
  totalLineItems: number
  totalSpend: number
  avgSpendPerDelivery: number
  weeklyAvgSpend: number
  dateRange: { from: string; to: string } | null
  dayOfWeekPattern: Record<string, number>   // "Monday" → count
  weeklySpend: { week: string; spend: number }[]
  activeProductCount: number
}

export interface InvoiceSummary {
  id: number
  documentNumber: string
  documentType: 'invoice' | 'credit_note' | 'adjustment'
  invoiceDate: string
  dateOrdered: string
  totalAmount: number
  deliveryCount: number
  lineCount: number
}

// ─── Main analyzer ───────────────────────────────────────────────────────────

export async function analyzeHistory(): Promise<{
  overall: OverallStats
  products: ProductStats[]
}> {
  const [allLines, allRecords, allProducts] = await Promise.all([
    db.invoiceLines.toArray(),
    db.invoiceRecords.toArray(),
    db.products.toArray(),
  ])

  const productMap = new Map<string, Product>(allProducts.map((p) => [p.invoiceCode, p]))
  const recordMap = new Map<number, InvoiceRecord>(allRecords.map((r) => [r.id!, r]))

  // Only use lines from actual invoices (not credit notes) for quantity analysis
  const invoiceLinesByRecord = new Map<number, InvoiceLine[]>()
  for (const line of allLines) {
    const record = recordMap.get(line.invoiceRecordId)
    if (!record || record.documentType !== 'invoice') continue
    const arr = invoiceLinesByRecord.get(line.invoiceRecordId) ?? []
    arr.push(line)
    invoiceLinesByRecord.set(line.invoiceRecordId, arr)
  }

  const invoiceLines = [...invoiceLinesByRecord.values()].flat()

  // All distinct delivery dates across dataset
  const allDeliveryDates = [...new Set(invoiceLines.map((l) => l.deliveryDate))].sort()
  const totalDeliveries = allDeliveryDates.length

  // ── Per-product stats ───────────────────────────────────────────────────
  const byCode = new Map<string, InvoiceLine[]>()
  for (const line of invoiceLines) {
    const arr = byCode.get(line.productCode) ?? []
    arr.push(line)
    byCode.set(line.productCode, arr)
  }

  const products: ProductStats[] = []

  for (const [code, lines] of byCode) {
    const product = productMap.get(code)
    // Sort by delivery date so latestCost and dates are always chronological,
    // regardless of the order invoices were imported.
    const sorted = [...lines].sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate))
    const qtys = sorted.map((l) => l.quantity)
    const costs = sorted.map((l) => l.pricePerItem).filter((c) => c > 0)
    const dates = [...new Set(sorted.map((l) => l.deliveryDate))]
    const distinctPrices = new Set(costs.map((c) => c.toFixed(3))).size

    products.push({
      productId: product?.id ?? 0,
      productCode: code,
      itemNumber: product?.itemNumber ?? parseInt(code, 10).toString(),
      productName: product?.name ?? lines[0]?.productName ?? code,
      category: product?.category ?? 'fresh',
      deliveriesOrdered: dates.length,
      totalDeliveries,
      frequencyPct: totalDeliveries > 0 ? (dates.length / totalDeliveries) * 100 : 0,
      avgQtyPerDelivery: Math.round(avg(qtys) * 10) / 10,
      medianQtyPerDelivery: median(qtys),
      minQty: Math.min(...qtys),
      maxQty: Math.max(...qtys),
      totalQtyDelivered: qtys.reduce((a, b) => a + b, 0),
      latestCost: costs[costs.length - 1] ?? 0,
      avgCost: Math.round(avg(costs) * 100) / 100,
      priceChanges: Math.max(0, distinctPrices - 1),
      firstSeen: dates[0] ?? '',
      lastSeen: dates[dates.length - 1] ?? '',
      totalSpend: lines.reduce((s, l) => s + l.extendedPrice, 0),
      deliveries: dates.map((date) => {
        const dayLines = lines.filter((l) => l.deliveryDate === date)
        const totalQty = dayLines.reduce((s, l) => s + l.quantity, 0)
        const cost = dayLines[0]?.pricePerItem ?? 0
        return { date, qty: totalQty, unitType: dayLines[0]?.unitType ?? 'EA', cost }
      }),
    })
  }

  products.sort((a, b) => b.totalSpend - a.totalSpend)

  // ── Overall stats ───────────────────────────────────────────────────────
  // invoiceLines is already filtered to invoice-type records — no re-scan needed.
  const allSpend = invoiceLines.reduce((s, l) => s + l.extendedPrice, 0)

  // Day of week pattern
  const dayPattern: Record<string, number> = {}
  for (const date of allDeliveryDates) {
    const day = dayName(date)
    dayPattern[day] = (dayPattern[day] ?? 0) + 1
  }

  // Weekly spend — from invoices + submitted/delivered orders (deduplicated)
  const weeklyMap = new Map<string, number>()
  for (const line of invoiceLines) {
    const wk = weekKey(line.deliveryDate)
    weeklyMap.set(wk, (weeklyMap.get(wk) ?? 0) + line.extendedPrice)
  }

  // Merge submitted/delivered orders that don't have a matching invoice already counted
  const orders = await db.orders.toArray()
  const invoiceNums = new Set(allRecords.map((r) => r.documentNumber).filter(Boolean))
  let orderSpend = 0
  for (const order of orders) {
    if (order.status === 'draft' || order.status === 'cancelled') continue
    if (order.invoiceNumber && invoiceNums.has(order.invoiceNumber)) continue
    const cost = order.totalCostActual ?? order.totalCostEstimate
    if (cost > 0) {
      const wk = weekKey(order.deliveryDate)
      weeklyMap.set(wk, (weeklyMap.get(wk) ?? 0) + cost)
      orderSpend += cost
    }
  }

  const weeklySpend = [...weeklyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, spend]) => ({ week, spend: Math.round(spend * 100) / 100 }))

  const totalSpendCombined = allSpend + orderSpend
  const uniqueWeeks = weeklySpend.length
  const weeklyAvgSpend = uniqueWeeks > 0 ? totalSpendCombined / uniqueWeeks : 0

  const overall: OverallStats = {
    totalInvoices: allRecords.filter((r) => r.documentType === 'invoice').length,
    totalDeliveries,
    totalLineItems: invoiceLines.length,
    totalSpend: Math.round(totalSpendCombined * 100) / 100,
    avgSpendPerDelivery: totalDeliveries > 0 ? Math.round((allSpend / totalDeliveries) * 100) / 100 : 0,
    weeklyAvgSpend: Math.round(weeklyAvgSpend * 100) / 100,
    dateRange: allDeliveryDates.length
      ? { from: allDeliveryDates[0]!, to: allDeliveryDates[allDeliveryDates.length - 1]! }
      : null,
    dayOfWeekPattern: dayPattern,
    weeklySpend,
    activeProductCount: byCode.size,
  }

  return { overall, products }
}

// ─── Invoice list for history view ───────────────────────────────────────────

export async function getInvoiceSummaries(): Promise<InvoiceSummary[]> {
  const [records, lines] = await Promise.all([
    db.invoiceRecords.orderBy('invoiceDate').reverse().toArray(),
    db.invoiceLines.toArray(),
  ])

  const linesByRecord = new Map<number, InvoiceLine[]>()
  for (const l of lines) {
    const arr = linesByRecord.get(l.invoiceRecordId) ?? []
    arr.push(l)
    linesByRecord.set(l.invoiceRecordId, arr)
  }

  return records.map((r) => {
    const rLines = linesByRecord.get(r.id!) ?? []
    const deliveries = new Set(rLines.map((l) => l.deliveryNoteNumber)).size
    return {
      id: r.id!,
      documentNumber: r.documentNumber,
      documentType: r.documentType,
      invoiceDate: r.invoiceDate,
      dateOrdered: r.dateOrdered,
      totalAmount: r.totalAmount,
      deliveryCount: deliveries,
      lineCount: rLines.length,
    }
  })
}

export async function getInvoiceLines(invoiceRecordId: number): Promise<InvoiceLine[]> {
  return db.invoiceLines.where('invoiceRecordId').equals(invoiceRecordId).toArray()
}

// ─── Auto-update defaultOrderQty from invoice history ────────────────────────

export async function updateDefaultQtysFromHistory(): Promise<number> {
  const { products } = await analyzeHistory()
  let updated = 0
  for (const stats of products) {
    if (!stats.productId || stats.deliveriesOrdered < 2) continue
    const medQty = Math.round(stats.medianQtyPerDelivery)
    if (medQty <= 0) continue
    await db.products.update(stats.productId, {
      defaultOrderQty: medQty,
      updatedAt: new Date(),
    })
    updated++
  }
  return updated
}
