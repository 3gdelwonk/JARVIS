/**
 * jarvismartImporter.ts — JARVISmart / Smart Retail POS sales data importer
 *
 * Handles CSV/XLSX exports from the JARVISmart SQL bridge into Smart Retail.
 * Auto-detects report type (sales vs stock vs catalog) and routes accordingly.
 *
 * Sales report import pipeline:
 *  1. Parse CSV or XLSX
 *  2. Normalize column names (lowercase, strip whitespace/special chars)
 *  3. Detect required columns via flexible alias map
 *  4. Match barcode → product (productId FK)
 *  5. Aggregate to daily totals per barcode
 *  6. Upsert into salesRecords (update if barcode+date exists)
 *  7. Return summary: matched, unmatched, duplicateSkipped, anomalies
 */

import { db } from './db'
import type { SalesRecord } from './types'

// ─── Column alias map ─────────────────────────────────────────────────────────

const SALES_COLUMN_MAP: Record<string, string[]> = {
  barcode:    ['plu', 'pluno', 'barcode', 'item_no', 'sku', 'item_number', 'code'],
  date:       ['date', 'sale_date', 'trans_date', 'period', 'trade_date', 'business_date'],
  qtySold:    ['qty_sold', 'units_sold', 'sales_qty', 'quantity', 'qty', 'sold_qty', 'units'],
  salesValue: ['sales_value', 'total_sales', 'revenue', 'net_sales', 'sales_ex_gst', 'sales_inc_gst', 'amount'],
  cogs:       ['cogs', 'cost', 'cost_of_goods', 'total_cost', 'cost_value', 'cost_amount'],
  department: ['department', 'dept', 'dept_code', 'section', 'section_code'],
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeColName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

/** Map raw header names to our canonical field names */
function buildColumnIndex(headers: string[]): Map<string, string> {
  const normalized = headers.map(normalizeColName)
  const index = new Map<string, string>()  // canonical → raw header
  for (const [canonical, aliases] of Object.entries(SALES_COLUMN_MAP)) {
    for (const alias of aliases) {
      const idx = normalized.indexOf(alias)
      if (idx !== -1) {
        index.set(canonical, headers[idx])
        break
      }
    }
  }
  return index
}

function normalizeDate(raw: string | number | undefined): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  // Handle Excel serial date numbers (number type from xlsx)
  if (typeof raw === 'number') {
    const epoch = new Date(Date.UTC(1899, 11, 30))
    epoch.setUTCDate(epoch.getUTCDate() + raw)
    return epoch.toISOString().split('T')[0]
  }
  const s = String(raw).trim()
  // YYYY-MM-DD already
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // DD/MM/YYYY or DD/MM/YY
  const dmyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch
    const year = y!.length === 2 ? `20${y}` : y
    return `${year}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`
  }
  // Try native parse as last resort
  const parsed = new Date(s)
  if (!isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0]
  return null
}

function parseNum(v: string | number | undefined): number {
  if (v === undefined || v === null || v === '') return 0
  return parseFloat(String(v).replace(/[,$]/g, '')) || 0
}

// ─── Detection ────────────────────────────────────────────────────────────────

export type JarvisReportType = 'sales' | 'unknown'

export function detectJarvisReportType(rows: Record<string, unknown>[]): JarvisReportType {
  if (!rows.length) return 'unknown'
  const headers = Object.keys(rows[0]).map(normalizeColName)
  const hasSalesQty = ['qty_sold', 'units_sold', 'sales_qty', 'quantity', 'qty', 'sold_qty'].some(
    (a) => headers.includes(a),
  )
  const hasBarcode = ['plu', 'pluno', 'barcode', 'item_no', 'sku'].some((a) => headers.includes(a))
  const hasDate = ['date', 'sale_date', 'trans_date', 'period', 'trade_date', 'business_date'].some(
    (a) => headers.includes(a),
  )
  if (hasSalesQty && hasBarcode && hasDate) return 'sales'
  return 'unknown'
}

// ─── Result type ─────────────────────────────────────────────────────────────

export interface SalesImportResult {
  matched: number
  unmatched: number
  duplicateUpdated: number
  newRecords: number
  anomalies: string[]
  dateRange: { from: string; to: string } | null
  lastImportedAt: Date
  detectedColumns: string[]
}

// ─── Main import function ─────────────────────────────────────────────────────

export async function parseSalesReport(file: File): Promise<SalesImportResult> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  let rows: Record<string, unknown>[]

  if (ext === 'xlsx' || ext === 'xls') {
    const buf = await file.arrayBuffer()
    const { read, utils } = await import('xlsx')
    const wb = read(buf, { type: 'array', cellDates: false })
    const ws = wb.Sheets[wb.SheetNames[0]]
    rows = utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: true })
  } else {
    const text = await file.text()
    const { read, utils } = await import('xlsx')
    const wb = read(text, { type: 'string', cellDates: false })
    const ws = wb.Sheets[wb.SheetNames[0]]
    rows = utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: false })
  }

  if (!rows.length) throw new Error('File is empty or has no data rows')

  const headers = Object.keys(rows[0])
  const colIndex = buildColumnIndex(headers)

  const detectedColumns = Object.entries(SALES_COLUMN_MAP).map(([canonical]) => {
    const found = colIndex.get(canonical)
    return found ? `✓ ${canonical} → "${found}"` : `✗ ${canonical} (not found)`
  })

  const barcodeCol = colIndex.get('barcode')
  const dateCol = colIndex.get('date')
  const qtyCol = colIndex.get('qtySold')

  if (!barcodeCol || !dateCol || !qtyCol) {
    const missing = ['barcode', 'date', 'qtySold'].filter((c) => !colIndex.get(c))
    throw new Error(`Cannot detect required columns: ${missing.join(', ')}. Check the column mapping below.`)
  }

  const salesValueCol = colIndex.get('salesValue')
  const cogsCol = colIndex.get('cogs')
  const deptCol = colIndex.get('department')

  // Build barcode → productId lookup
  const allProducts = await db.products.toArray()
  const barcodeToProductId = new Map<string, number>()
  for (const p of allProducts) {
    if (p.barcode) barcodeToProductId.set(p.barcode.trim(), p.id!)
    if (p.invoiceCode) barcodeToProductId.set(p.invoiceCode.trim(), p.id!)
    if (p.itemNumber) barcodeToProductId.set(p.itemNumber.trim(), p.id!)
  }

  // Aggregate raw rows to daily totals per barcode
  const dailyMap = new Map<string, {
    barcode: string
    date: string
    qtySold: number
    salesValue: number
    cogs: number
    department?: string
    productId?: number
  }>()

  const anomalies: string[] = []
  let skippedRows = 0

  for (const row of rows) {
    const rawBarcode = String(row[barcodeCol] ?? '').trim()
    const rawDate = row[dateCol]
    const rawQty = row[qtyCol]

    if (!rawBarcode) { skippedRows++; continue }
    const date = normalizeDate(rawDate as string | number | undefined)
    if (!date) {
      anomalies.push(`Row skipped — invalid date: "${rawDate}" for barcode ${rawBarcode}`)
      skippedRows++
      continue
    }

    const qty = parseNum(rawQty as string | number | undefined)
    if (qty === 0) continue  // skip zero-qty rows

    const key = `${rawBarcode}::${date}`
    const existing = dailyMap.get(key)
    const salesValue = salesValueCol ? parseNum(row[salesValueCol] as string | number | undefined) : 0
    const cogs = cogsCol ? parseNum(row[cogsCol] as string | number | undefined) : 0
    const department = deptCol ? String(row[deptCol] ?? '').trim() : undefined

    if (existing) {
      existing.qtySold += qty
      existing.salesValue += salesValue
      existing.cogs += cogs
    } else {
      dailyMap.set(key, {
        barcode: rawBarcode,
        date,
        qtySold: qty,
        salesValue,
        cogs,
        department: department || undefined,
        productId: barcodeToProductId.get(rawBarcode),
      })
    }
  }

  if (skippedRows > 5) {
    anomalies.push(`${skippedRows} rows skipped due to missing barcode or invalid date`)
  }

  const dailyRecords = [...dailyMap.values()]
  if (dailyRecords.length === 0) {
    throw new Error('No valid sales records found in file after parsing')
  }

  // Date range
  const dates = dailyRecords.map((r) => r.date).sort()
  const dateRange = { from: dates[0]!, to: dates[dates.length - 1]! }

  // Match stats
  const matched = dailyRecords.filter((r) => r.productId !== undefined).length
  const unmatched = dailyRecords.length - matched

  if (unmatched > 0) {
    const unmatchedBarcodes = [...new Set(
      dailyRecords.filter((r) => r.productId === undefined).map((r) => r.barcode),
    )].slice(0, 5)
    anomalies.push(`${unmatched} records have unmatched barcodes (e.g. ${unmatchedBarcodes.join(', ')})`)
  }

  // Upsert: fetch existing records for these barcodes, update or add
  const importedBarcodes = [...new Set(dailyRecords.map((r) => r.barcode))]
  const existingRecords = await db.salesRecords.where('barcode').anyOf(importedBarcodes).toArray()
  const existingMap = new Map(existingRecords.map((r) => [`${r.barcode}::${r.date}`, r]))

  const importBatchId = `jarvis-${Date.now()}`
  const importedAt = new Date()

  const toAdd: SalesRecord[] = []
  let duplicateUpdated = 0

  for (const record of dailyRecords) {
    const key = `${record.barcode}::${record.date}`
    const ex = existingMap.get(key)
    if (ex) {
      await db.salesRecords.update(ex.id!, {
        qtySold: record.qtySold,
        salesValue: record.salesValue,
        cogs: record.cogs,
        productId: record.productId,
        importBatchId,
        importedAt,
      })
      duplicateUpdated++
    } else {
      toAdd.push({
        ...record,
        importBatchId,
        importedAt,
      })
    }
  }

  if (toAdd.length > 0) {
    await db.salesRecords.bulkAdd(toAdd)
  }

  return {
    matched,
    unmatched,
    duplicateUpdated,
    newRecords: toAdd.length,
    anomalies,
    dateRange,
    lastImportedAt: importedAt,
    detectedColumns,
  }
}
