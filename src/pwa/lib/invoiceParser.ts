/**
 * invoiceParser.ts — Lactalis PDF invoice text parser
 *
 * PITFALLS addressed:
 *  #1  Product code concatenated with name (no space): "PAULS SMARTER...1L00039466"
 *  #2  ** suffix on product names
 *  #3  Credit notes / Adjustment notes (CR suffix, negative amounts)
 *  #4  Multi-delivery invoices (2–3 Delivery Notes per invoice)
 *  #5  Price Per Item is the actual cost (last column)
 *  #6  CTN vs EA unit types
 */

import { db } from './db'
import type { InvoiceRecord, InvoiceLine } from './types'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ParsedLine {
  productCode: string       // 8-digit with leading zeros, e.g. "00014584"
  productName: string
  quantity: number
  unitType: 'EA' | 'CTN'
  listPrice: number
  lineDiscount?: number     // negative (CR) value stripped to positive for storage
  containerScheme?: number
  gst?: number
  extendedPrice: number
  pricePerItem: number      // ACTUAL cost — always use this
}

export interface ParsedDelivery {
  noteNumber: string
  deliveryDate: string      // YYYY-MM-DD
  purchaseOrderNumber: string
  lines: ParsedLine[]
  subTotal: number
}

export interface ParsedInvoice {
  documentNumber: string
  documentType: 'invoice' | 'credit_note' | 'adjustment'
  dateOrdered: string       // YYYY-MM-DD
  invoiceDate: string       // YYYY-MM-DD
  totalAmount: number
  deliveries: ParsedDelivery[]
  lineCount: number
  rawText: string           // full extracted PDF/paste text
  unparsedLines: string[]   // buffers with a product code that still failed parseLineItem
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function parseInvoiceDate(s: string): string {
  // Handles DD.MM.YYYY, D.M.YYYY, D.M.YY
  // Returns '' on failure so callers/forecastEngine's VALID_DATE_RE filter drops it
  const parts = s.trim().split('.')
  if (parts.length !== 3) return ''
  const day = parts[0].padStart(2, '0')
  const month = parts[1].padStart(2, '0')
  const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2]
  const result = `${year}-${month}-${day}`
  // Sanity-check: must parse as a real date
  const parsed = new Date(`${result}T00:00:00`)
  if (isNaN(parsed.getTime())) return ''
  return result
}

function parseAmount(s: string): number {
  const isCredit = /CR/i.test(s)
  const num = parseFloat(s.replace(/[^0-9.]/g, '')) || 0
  return isCredit ? -num : num
}

// ─── Line item parser ────────────────────────────────────────────────────────

// 8-digit invoice codes always start with "00" (two or more leading zeros)
const CODE_RE = /(?<![0-9])(00[0-9]{6})(?![0-9])/

function parseLineItem(raw: string): ParsedLine | null {
  // Strip ** suffix and normalise whitespace
  const line = raw.replace(/\*+/g, ' ').replace(/\s+/g, ' ').trim()

  const codeMatch = line.match(CODE_RE)
  if (!codeMatch) return null

  const codeIdx = line.indexOf(codeMatch[1])
  const productCode = codeMatch[1]
  const productName = line.slice(0, codeIdx).trim()

  // Everything after the 8-digit code
  const rest = line.slice(codeIdx + 8).trim()

  // Must start with QTY UNIT
  const restMatch = rest.match(/^(\d+)\s+(EA|CTN)\s+(.+)$/)
  if (!restMatch) return null

  const quantity = parseInt(restMatch[1], 10)
  const unitType = restMatch[2] as 'EA' | 'CTN'
  const pricesPart = restMatch[3].trim()

  // Extract all numeric tokens (some may have CR suffix)
  const tokens = pricesPart.match(/[0-9]+(?:\.[0-9]+)?(?:CR)?/gi) ?? []
  if (tokens.length < 2) return null

  // Column layout (rightmost is always pricePerItem):
  // 2 cols:  listPrice  pricePerItem           (no extended price — unusual)
  // 3 cols:  listPrice  extendedPrice  pricePerItem
  // 4 cols:  listPrice  lineDisc  extendedPrice  pricePerItem
  // 5 cols:  listPrice  lineDisc  container  extendedPrice  pricePerItem
  // 6 cols:  listPrice  lineDisc  container  gst  extendedPrice  pricePerItem
  const pricePerItem = Math.abs(parseAmount(tokens[tokens.length - 1] ?? '0'))
  const extendedPrice = tokens.length >= 3 ? Math.abs(parseAmount(tokens[tokens.length - 2] ?? '0')) : pricePerItem
  const listPrice = parseAmount(tokens[0] ?? '0')

  let lineDiscount: number | undefined
  let containerScheme: number | undefined
  let gst: number | undefined

  if (tokens.length === 4) {
    lineDiscount = Math.abs(parseAmount(tokens[1]))
  } else if (tokens.length === 5) {
    lineDiscount = Math.abs(parseAmount(tokens[1]))
    containerScheme = parseAmount(tokens[2])
  } else if (tokens.length >= 6) {
    lineDiscount = Math.abs(parseAmount(tokens[1]))
    containerScheme = parseAmount(tokens[2])
    gst = parseAmount(tokens[3])
  }

  if (!productName || productName.length < 2) return null

  return {
    productCode,
    productName,
    quantity,
    unitType,
    listPrice,
    lineDiscount,
    containerScheme,
    gst,
    extendedPrice,
    pricePerItem,
  }
}

// ─── Main parser ─────────────────────────────────────────────────────────────

const DELIVERY_NOTE_RE =
  /^Delivery\s+Note\s+(\d+)\s+for\s+([\d.]+)\s+Purchase\s+Order\s+(\d+)/i

export function parseInvoiceText(text: string): ParsedInvoice | null {
  const lines = text.split('\n').map((l) => l.trim())

  let documentType: 'invoice' | 'credit_note' | 'adjustment' = 'invoice'
  let documentNumber = ''
  let dateOrdered = ''
  let invoiceDate = ''
  let totalAmount = 0

  // Detect document type from first match
  for (const line of lines) {
    if (/Credit\s+Adjustment\s+Note/i.test(line)) { documentType = 'adjustment'; break }
    if (/Adjustment\s+Note/i.test(line)) { documentType = 'credit_note'; break }
    if (/TAX\s+INVOICE/i.test(line)) { documentType = 'invoice'; break }
  }

  // Extract header fields (scan all lines — headers may repeat on page 2)
  for (const line of lines) {
    if (!documentNumber) {
      const m = line.match(/Document\s*No[.:]?\s*([0-9]{6,})/i)
      if (m) documentNumber = m[1]
    }
    if (!dateOrdered) {
      const m = line.match(/Date\s*Ordered[.:]?\s*([\d]+\.[\d]+\.[\d]+)/i)
      if (m) dateOrdered = parseInvoiceDate(m[1])
    }
    if (!invoiceDate) {
      const m = line.match(/Invoice\s*Date[.:]?\s*([\d]+\.[\d]+\.[\d]+)/i)
      if (m) invoiceDate = parseInvoiceDate(m[1])
    }
    if (!totalAmount) {
      const m = line.match(/Total\s*Amount[.:]?\s*\$?\s*([0-9,]+(?:\.[0-9]+)?(?:CR)?)/i)
      if (m) totalAmount = Math.abs(parseAmount(m[1].replace(',', '')))
    }
  }

  // Parse delivery notes and their line items
  const deliveries: ParsedDelivery[] = []
  const unparsedLines: string[] = []
  let current: ParsedDelivery | null = null

  // Multi-line row reconstruction: pdfjs-dist sometimes emits one text
  // fragment per column, so a single invoice row may arrive as 2-3 lines.
  // We buffer consecutive lines and flush when we hit a new CODE_RE or a
  // section boundary, then pass the joined buffer to parseLineItem.
  let lineBuffer: string[] = []
  let bufferHasCode = false

  const flushBuffer = () => {
    if (!bufferHasCode || lineBuffer.length === 0) {
      lineBuffer = []
      bufferHasCode = false
      return
    }
    const joined = lineBuffer.join(' ').replace(/\s+/g, ' ').trim()
    lineBuffer = []
    bufferHasCode = false
    if (!current || !joined) return
    const item = parseLineItem(joined)
    if (item) {
      current.lines.push(item)
    } else {
      unparsedLines.push(joined)
    }
  }

  for (const line of lines) {
    if (!line) continue

    // New delivery note block — flush buffer first
    const dnMatch = line.match(DELIVERY_NOTE_RE)
    if (dnMatch) {
      flushBuffer()
      current = {
        noteNumber: dnMatch[1],
        deliveryDate: parseInvoiceDate(dnMatch[2]),
        purchaseOrderNumber: dnMatch[3],
        lines: [],
        subTotal: 0,
      }
      deliveries.push(current)
      continue
    }

    if (!current) continue

    // Sub-total line — flush and end this delivery block
    if (/^Sub-?\s*total/i.test(line)) {
      flushBuffer()
      const m = line.match(/([0-9,]+\.[0-9]+(?:CR)?)/)
      if (m) current.subTotal = Math.abs(parseAmount(m[1].replace(',', '')))
      continue
    }

    // Skip clearly non-item lines (flush first so we don't lose a partial buffer)
    if (/^(Totals|TOTAL|GST|Page|Document|Date|Invoice|Delivery|Purchase|IGA|Account)/i.test(line)) {
      flushBuffer()
      continue
    }

    // Multi-line joining logic
    if (CODE_RE.test(line)) {
      // This line has a product code — flush old buffer, start new one
      flushBuffer()
      lineBuffer = [line]
      bufferHasCode = true
    } else if (bufferHasCode && lineBuffer.length < 3) {
      // Continuation line (numeric columns on a separate fragment) — append
      lineBuffer.push(line)
    }
    // else: no active buffer with code — line is not part of an item row
  }

  // Final flush for any remaining buffer
  flushBuffer()

  const lineCount = deliveries.reduce((n, d) => n + d.lines.length, 0)

  // Cannot save without a document number — return null so callers show a clear error
  if (!documentNumber) return null

  return {
    documentNumber,
    documentType,
    dateOrdered,
    invoiceDate,
    totalAmount,
    deliveries,
    lineCount,
    rawText: text,
    unparsedLines,
  }
}

// ─── Save to IndexedDB ────────────────────────────────────────────────────────

export async function saveInvoice(
  parsed: ParsedInvoice,
): Promise<{ saved: boolean; reason?: string }> {
  if (!parsed.documentNumber) return { saved: false, reason: 'Could not extract document number' }

  const existing = await db.invoiceRecords
    .where('documentNumber')
    .equals(parsed.documentNumber)
    .first()
  if (existing) {
    return { saved: false, reason: `Invoice ${parsed.documentNumber} already saved` }
  }

  const record: InvoiceRecord = {
    documentNumber: parsed.documentNumber,
    documentType: parsed.documentType,
    dateOrdered: parsed.dateOrdered,
    invoiceDate: parsed.invoiceDate,
    totalAmount: parsed.totalAmount,
    parsedAt: new Date(),
    rawText: parsed.rawText,
  }

  const recordId = (await db.invoiceRecords.add(record)) as number

  const invoiceLines: InvoiceLine[] = parsed.deliveries.flatMap((d) =>
    d.lines.map((l) => ({
      invoiceRecordId: recordId,
      deliveryNoteNumber: d.noteNumber,
      deliveryDate: d.deliveryDate,
      purchaseOrderNumber: d.purchaseOrderNumber,
      productCode: l.productCode,
      productName: l.productName,
      quantity: l.quantity,
      unitType: l.unitType,
      listPrice: l.listPrice,
      lineDiscount: l.lineDiscount,
      containerScheme: l.containerScheme,
      gst: l.gst,
      extendedPrice: l.extendedPrice,
      pricePerItem: l.pricePerItem,
    })),
  )

  await db.invoiceLines.bulkAdd(invoiceLines)

  // Update product cost prices — iterate in delivery-date order so the last
  // write per product always reflects the most recent delivery in the invoice.
  const linesChronological = [...invoiceLines].sort((a, b) =>
    a.deliveryDate.localeCompare(b.deliveryDate),
  )
  for (const line of linesChronological) {
    if (line.pricePerItem <= 0) continue
    const product = await db.products.where('invoiceCode').equals(line.productCode).first()
    if (!product) continue
    await db.products.update(product.id!, {
      lactalisCostPrice: line.pricePerItem,
      updatedAt: new Date(),
    })
    // Upsert — prevents duplicate entries when the same invoice is re-parsed
    const existingPH = await db.priceHistory
      .where('[productId+effectiveDate]')
      .equals([product.id!, line.deliveryDate])
      .first()
    if (existingPH) {
      await db.priceHistory.update(existingPH.id!, { costPrice: line.pricePerItem, source: 'invoice' })
    } else {
      await db.priceHistory.add({
        productId: product.id!,
        invoiceCode: line.productCode,
        effectiveDate: line.deliveryDate,
        costPrice: line.pricePerItem,
        source: 'invoice',
      })
    }
  }

  return { saved: true }
}

// ─── PDF text extraction ──────────────────────────────────────────────────────

export async function extractTextFromPDF(file: File): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist')

  // Use CDN worker — avoids complex bundler setup; falls back to paste if offline
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`

  const arrayBuffer = await file.arrayBuffer()
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) })
  const pdf = await loadingTask.promise

  const pageTexts: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    // Join items — preserve line breaks by checking y-position gaps
    let pageText = ''
    let lastY: number | null = null
    for (const item of content.items) {
      if (!('str' in item)) continue
      const currentY = (item as { transform: number[] }).transform[5]
      if (lastY !== null && Math.abs(currentY - lastY) > 2) {
        pageText += '\n'
      }
      pageText += item.str + ' '
      lastY = currentY
    }
    pageTexts.push(pageText)
  }

  return pageTexts.join('\n')
}
