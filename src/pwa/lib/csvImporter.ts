/**
 * csvImporter.ts — Smart Retail CSV/XLSX parsers
 *
 * Handles:
 *  - Item Maintenance Report (prices, supplier codes)
 *  - Item Stock Report (QOH snapshots)
 *
 * PITFALLS addressed:
 *  #7  Negative QOH — stored as-is, velocity used for forecasting
 *  #8  Dual-supplier rows — Lactalis (01240657) + Metcash (90770)
 *  #9  Cost anomalies — flag cost > $20 as likely carton cost
 *  #10 Lactalis rows have no Order Code — that's expected
 */

import * as XLSX from 'xlsx'
import Papa from 'papaparse'
import { db } from './db'

export interface MaintenanceImportResult {
  updated: number
  newProducts: number
  anomalies: string[]
  skipped: number
  lastImportedAt: Date
  detectedColumns: string[]   // e.g. ["✓ Barcode → \"Barcode\"", "✗ Order Code (not found)"]
}

export interface StockImportResult {
  snapshots: number
  matched: number
  unmatched: number
  lastImportedAt: Date
}

// ─── File → rows ────────────────────────────────────────────────────────────

type Row = Record<string, string>

async function fileToRows(file: File): Promise<Row[]> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''

  if (ext === 'xlsx' || ext === 'xls') {
    return xlsxToRows(file)
  }
  return csvToRows(file)
}

// Normalise header strings — handles non-breaking spaces and extra whitespace
// that Smart Retail XLSX exports sometimes include.
function normalizeHeader(h: string): string {
  return h.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

function xlsxToRows(file: File): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = e.target?.result
        const workbook = XLSX.read(data, { type: 'array' })
        const sheet = workbook.Sheets[workbook.SheetNames[0]]
        // Smart Retail exports sometimes have a truncated !ref (e.g. A1:C1)
        // that doesn't cover all columns/rows. Recalculate from actual cells.
        const actualRef = XLSX.utils.encode_range(
          XLSX.utils.decode_range(
            Object.keys(sheet)
              .filter((k) => !k.startsWith('!'))
              .reduce((ref, cell) => {
                const r = XLSX.utils.decode_cell(cell)
                const cur = ref ? XLSX.utils.decode_range(ref) : { s: r, e: r }
                cur.s.r = Math.min(cur.s.r, r.r)
                cur.s.c = Math.min(cur.s.c, r.c)
                cur.e.r = Math.max(cur.e.r, r.r)
                cur.e.c = Math.max(cur.e.c, r.c)
                return XLSX.utils.encode_range(cur)
              }, sheet['!ref'] ?? 'A1'),
          ),
        )
        sheet['!ref'] = actualRef
        const raw = XLSX.utils.sheet_to_json<Row>(sheet, {
          defval: '',
          raw: false,
        })
        // Remap all keys through the header normaliser
        const rows = raw.map((row) => {
          const normalised: Row = {}
          for (const [k, v] of Object.entries(row)) {
            normalised[normalizeHeader(k)] = v
          }
          return normalised
        })
        resolve(rows)
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

function csvToRows(file: File): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      // Strip BOM if present
      let text = (e.target?.result as string) ?? ''
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

      // Auto-detect delimiter: try tab first, fall back to comma
      const delimiter = text.includes('\t') ? '\t' : ','

      const result = Papa.parse<Row>(text, {
        header: true,
        delimiter,
        skipEmptyLines: true,
        transformHeader: (h) => normalizeHeader(h),
        transform: (v) => v.trim(),
      })

      if (result.errors.length && result.data.length === 0) {
        reject(new Error(result.errors[0].message))
      } else {
        resolve(result.data)
      }
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file, 'utf-8')
  })
}

// ─── Import mode ─────────────────────────────────────────────────────────────

export type ImportMode = 'dairy' | 'liquor' | 'all'

const LIQUOR_DEPT_TERMS = ['liquor', 'beer', 'wine', 'spirits', 'beverages', 'alcohol', 'drinks', 'cider', 'rtd']

function isLiquorDept(raw: string): boolean {
  const v = raw.toLowerCase().trim()
  return LIQUOR_DEPT_TERMS.some((t) => v.includes(t))
}

function mapLiquorCategory(deptName: string): import('./types').Product['category'] {
  const v = deptName.toLowerCase().trim()
  if (v.includes('beer'))    return 'beer'
  if (v.includes('wine'))    return 'wine'
  if (v.includes('spirit'))  return 'spirits'
  if (v.includes('cider'))   return 'cider'
  if (v.includes('rtd'))     return 'rtd'
  return 'specialty'
}

// ─── Auto-detect report type ─────────────────────────────────────────────────

export type ReportType = 'item_maintenance' | 'item_stock' | 'unknown'

export function detectReportType(rows: Row[]): ReportType {
  if (rows.length === 0) return 'unknown'
  const headers = Object.keys(rows[0]).map((h) => h.toLowerCase())
  if (headers.some((h) => h.includes('supplier code'))) return 'item_maintenance'
  if (headers.some((h) => h.includes('qoh') || h.includes('qty on hand'))) return 'item_stock'
  // Fallback heuristics
  if (headers.some((h) => h.includes('normal cost') || h.includes('normal sell'))) return 'item_maintenance'
  if (headers.some((h) => h.includes('carton qty'))) return 'item_stock'
  return 'unknown'
}

// ─── Column finder (fuzzy match) ─────────────────────────────────────────────

function findCol(row: Row, candidates: string[]): string {
  const keys = Object.keys(row)
  for (const c of candidates) {
    const found = keys.find((k) => k.toLowerCase().trim() === c.toLowerCase())
    if (found) return found
  }
  // Partial match fallback
  for (const c of candidates) {
    const found = keys.find((k) => k.toLowerCase().includes(c.toLowerCase()))
    if (found) return found
  }
  return ''
}

function getVal(row: Row, candidates: string[]): string {
  const key = findCol(row, candidates)
  return key ? (row[key] ?? '').trim() : ''
}

function parsePrice(s: string): number {
  return parseFloat(s.replace(/[^0-9.-]/g, '')) || 0
}

// ─── Item Maintenance Parser ─────────────────────────────────────────────────

const LACTALIS_SUPPLIER = '01240657'
const METCASH_SUPPLIER = '90770'

// Relaxed active check: accept yes/y/1/true/active and empty (active-only exports)
const ACTIVE_ACCEPTED = new Set(['yes', 'y', '1', 'true', 'active'])
function isActive(raw: string): boolean {
  const v = raw.toLowerCase().trim()
  return v === '' || ACTIVE_ACCEPTED.has(v)
}

// Relaxed department check: accept milk/dairy/chilled/fresh and empty
const MILK_DEPT_TERMS = ['milk', 'dairy', 'chilled', 'fresh']
function isMilkDept(raw: string): boolean {
  const v = raw.toLowerCase().trim()
  return v === '' || MILK_DEPT_TERMS.some((t) => v.includes(t))
}

export async function parseItemMaintenance(
  file: File,
  importMode: ImportMode = 'dairy',
): Promise<MaintenanceImportResult> {
  const rows = await fileToRows(file)

  const result: MaintenanceImportResult = {
    updated: 0,
    newProducts: 0,
    anomalies: [],
    skipped: 0,
    lastImportedAt: new Date(),
    detectedColumns: [],
  }

  // Build detected-columns report from the first row
  if (rows.length > 0) {
    const firstRow = rows[0]
    const expectedCols: Array<[string, string[]]> = [
      ['Active', ['Active', 'active']],
      ['Department Name', ['Department Name', 'department name', 'dept name']],
      ['Barcode', ['Barcode', 'barcode', 'EAN']],
      ['Supplier Code', ['Supplier Code', 'supplier code', 'supplier_code']],
      ['Description', ['Description', 'description']],
      ['Order Code', ['Order Code', 'order code', 'order_code', 'item number']],
      ['Normal Sell', ['Normal Sell', 'normal sell', 'sell price']],
      ['Normal Cost', ['Normal Cost', 'normal cost', 'cost price']],
    ]
    for (const [label, candidates] of expectedCols) {
      const found = findCol(firstRow, candidates)
      result.detectedColumns.push(
        found ? `✓ ${label} → "${found}"` : `✗ ${label} (not found)`,
      )
    }
  }

  // Group rows by barcode — collect both supplier rows
  const byBarcode = new Map<string, { lactalis?: Row; metcash?: Row }>()

  for (const row of rows) {
    const active = getVal(row, ['Active', 'active'])
    const deptName = getVal(row, ['Department Name', 'department name', 'dept name'])

    if (!isActive(active)) { result.skipped++; continue }

    const deptAccepted =
      importMode === 'liquor' ? isLiquorDept(deptName)
      : importMode === 'all'  ? (isMilkDept(deptName) || isLiquorDept(deptName))
      : isMilkDept(deptName)  // 'dairy' — existing behaviour unchanged

    if (!deptAccepted) { result.skipped++; continue }

    const barcode = getVal(row, ['Barcode', 'barcode', 'EAN'])
    if (!barcode || barcode === 'NH') { result.skipped++; continue }

    const supplierCode = getVal(row, ['Supplier Code', 'supplier code', 'supplier_code'])

    const entry = byBarcode.get(barcode) ?? {}
    if (supplierCode === LACTALIS_SUPPLIER)      entry.lactalis = row
    else if (supplierCode === METCASH_SUPPLIER)  entry.metcash = row
    else if (importMode !== 'dairy')             entry.lactalis = entry.lactalis ?? row
    // liquor suppliers get stored in the primary slot; first row per barcode wins
    byBarcode.set(barcode, entry)
  }

  for (const [barcode, { lactalis, metcash }] of byBarcode) {
    const sourceRow = lactalis ?? metcash
    if (!sourceRow) continue

    const sellPriceRaw = getVal(sourceRow, ['Normal Sell', 'normal sell', 'sell price'])
    const sellPrice = parsePrice(sellPriceRaw)

    let lactalisCost: number | undefined
    let metcashCost: number | undefined

    const anomalyThreshold = importMode === 'liquor' ? 200 : 20

    if (lactalis) {
      const cost = parsePrice(getVal(lactalis, ['Normal Cost', 'normal cost', 'cost price']))
      if (cost > anomalyThreshold) {
        const name = getVal(lactalis, ['Description', 'description'])
        result.anomalies.push(`Lactalis cost $${cost.toFixed(2)} for "${name}" (barcode ${barcode}) — likely carton cost — price NOT updated, enter unit price manually`)
      } else {
        lactalisCost = cost
      }
    }

    if (metcash) {
      const cost = parsePrice(getVal(metcash, ['Normal Cost', 'normal cost', 'cost price']))
      if (cost > anomalyThreshold) {
        const name = getVal(metcash, ['Description', 'description'])
        result.anomalies.push(`Metcash cost $${cost.toFixed(2)} for "${name}" (barcode ${barcode}) — likely carton cost — price NOT updated, enter unit price manually`)
      } else {
        metcashCost = cost
      }
    }

    // Look up existing product by barcode
    const existing = await db.products.where('barcode').equals(barcode).first()

    if (existing) {
      const updates: Partial<typeof existing> = { updatedAt: new Date() }
      if (lactalisCost !== undefined) updates.lactalisCostPrice = lactalisCost
      if (metcashCost !== undefined) updates.metcashCostPrice = metcashCost
      if (sellPrice > 0) updates.sellPrice = sellPrice
      await db.products.update(existing.id!, updates)
      result.updated++
    } else {
      // Auto-create new product from Smart Retail data
      const name = getVal(sourceRow, ['Description', 'description'])
      const orderCode = getVal(sourceRow, ['Order Code', 'order code', 'order_code', 'item number'])
      const itemNumber = orderCode ? parseInt(orderCode, 10).toString() : ''
      const invoiceCode = itemNumber ? itemNumber.padStart(8, '0') : barcode
      const deptNameForRow = getVal(sourceRow, ['Department Name', 'department name', 'dept name'])
      const isLiquorRow = importMode !== 'dairy' && isLiquorDept(deptNameForRow)
      try {
        await db.products.add({
          barcode,
          invoiceCode,
          itemNumber,
          name,
          smartRetailName: name,
          category: isLiquorRow ? mapLiquorCategory(deptNameForRow) : 'fresh',
          department: isLiquorRow ? 'liquor' : undefined,
          isGstBearing: false,
          active: true,
          orderUnit: 'EA',
          unitsPerOrder: 1,
          minStockLevel: 0,
          defaultOrderQty: 1,
          targetDaysOfStock: 7,
          lactalisCostPrice: lactalisCost ?? 0,
          metcashCostPrice: metcashCost,
          sellPrice,
          orderFrequency: 'occasional',
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        result.newProducts++
        result.anomalies.push(
          `Auto-created: "${name}" (item# ${itemNumber || barcode}) — review category and GST status`,
        )
      } catch {
        // Duplicate invoiceCode or other Dexie constraint — demote to anomaly
        result.anomalies.push(
          `New product not in catalogue: "${name}" (barcode ${barcode}) — add manually if needed`,
        )
      }
    }
  }

  return result
}

// ─── Item Stock Report Parser ────────────────────────────────────────────────

export async function parseStockReport(
  file: File,
): Promise<StockImportResult> {
  const rows = await fileToRows(file)

  const result: StockImportResult = {
    snapshots: 0,
    matched: 0,
    unmatched: 0,
    lastImportedAt: new Date(),
  }

  const importBatchId = `stock-${Date.now()}`
  const importedAt = new Date()

  for (const row of rows) {
    const barcode = getVal(row, ['Barcode', 'barcode', 'EAN'])
    if (!barcode || barcode === 'NH') continue

    const qohRaw = getVal(row, ['QOH', 'qoh', 'Qty On Hand', 'qty on hand', 'Quantity On Hand'])
    const qoh = parseInt(qohRaw, 10)
    if (isNaN(qoh)) continue

    const product = await db.products.where('barcode').equals(barcode).first()

    if (product) {
      await db.stockSnapshots.add({
        productId: product.id!,
        barcode,
        qoh,
        importedAt,
        source: 'item_stock_report',
        importBatchId,
      })
      result.matched++
    } else {
      result.unmatched++
    }

    result.snapshots++
  }

  // H3 — cleanup old snapshots, but always keep the 2 most recent per product
  // so forecastEngine retains velocity data even after a long import gap.
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 90)
  const allSnaps = await db.stockSnapshots.toArray()

  // Group by productId, sort each group newest-first
  const byProduct = new Map<number, typeof allSnaps>()
  for (const s of allSnaps) {
    const arr = byProduct.get(s.productId) ?? []
    arr.push(s)
    byProduct.set(s.productId, arr)
  }

  const toDelete: number[] = []
  for (const snaps of byProduct.values()) {
    const sorted = snaps.sort(
      (a, b) => new Date(b.importedAt).getTime() - new Date(a.importedAt).getTime(),
    )
    // Keep the 2 most recent unconditionally; delete older ones past the cutoff
    for (const s of sorted.slice(2)) {
      if (new Date(s.importedAt) < cutoff) toDelete.push(s.id!)
    }
  }

  if (toDelete.length) await db.stockSnapshots.bulkDelete(toDelete)

  return result
}
