/**
 * emailParser.ts — Parse Lactalis order confirmation emails into ScrapedOrder.
 *
 * Lactalis sender: noreply@au.lactalis.com
 * Email format: HTML with order details table. Australian dates (D/M/YYYY).
 *
 * Strategy:
 *  1. HTML table extraction via DOMParser (primary — email is HTML)
 *  2. Regex on plain text (fallback)
 */

import type { ScrapedOrder } from './types'

// ─── Regex patterns ───────────────────────────────────────────────────────────

const ORDER_NUMBER  = /order\s*(?:number|confirmation|no\.?)?\s*[#:]\s*(\d+)/i
const ORDER_NUM_FALLBACK = /\b(\d{6,})\b/  // fallback: first 6+ digit number
const ORDER_DATE    = /Order Date:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i
const DELIVERY_DATE = /Delivery Date:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i
const TOTAL_LINE    = /\bTotal\s+\$([0-9,]+\.\d{2})/
const LINE_ITEM     = /(.+?)\s+SKU\s*#:\s*(\d+)\s+(\d+)\s+items?\s+\$([0-9.]+)\s+\$([0-9.]+)/gi

function parseDMY(d: string, m: string, y: string): string {
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
}

function parseAmount(s: string): number {
  return parseFloat(s.replace(/,/g, '')) || 0
}

// ─── HTML table extraction ────────────────────────────────────────────────────

function extractFromHtml(html: string): ScrapedOrder | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return null
  }

  const text = doc.body.textContent ?? ''

  // Extract order number — try specific pattern first, then fallback to any large number
  const numMatch = text.match(ORDER_NUMBER) || text.match(ORDER_NUM_FALLBACK)
  if (!numMatch) return null
  const orderNumber = numMatch[1]

  // Extract dates
  const odMatch = text.match(ORDER_DATE)
  const ddMatch = text.match(DELIVERY_DATE)
  const createdAt = odMatch ? parseDMY(odMatch[1], odMatch[2], odMatch[3]) : null
  const deliveryDate = ddMatch ? parseDMY(ddMatch[1], ddMatch[2], ddMatch[3]) : null

  // Extract total
  const totalMatch = text.match(TOTAL_LINE)
  const total = totalMatch ? parseAmount(totalMatch[1]) : 0

  // Find the line items table — look for a table whose header row contains "Item"
  const tables = Array.from(doc.querySelectorAll('table'))
  let lineItems: ScrapedOrder['lineItems'] = []

  const SUMMARY_ROWS = /^(subtotal|discount|delivery|gst|tax|total)/i

  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll('tr'))
    if (rows.length < 2) continue

    // Check if this table has a header row with product/item/sku keywords
    const headerText = (rows[0].textContent ?? '').toLowerCase()
    if (!headerText.includes('item') && !headerText.includes('product') && !headerText.includes('sku') && !headerText.includes('description')) continue

    const parsed: ScrapedOrder['lineItems'] = []

    for (let i = 1; i < rows.length; i++) {
      const cells = Array.from(rows[i].querySelectorAll('td'))
      if (cells.length < 3) continue

      const col0 = cells[0].textContent?.trim() ?? ''
      if (!col0 || SUMMARY_ROWS.test(col0)) continue

      // Try to split "Product Name SKU #: 12345" on "SKU"
      let productName = ''
      let itemNumber = ''
      const skuIdx = col0.toLowerCase().indexOf('sku')
      if (skuIdx !== -1) {
        productName = col0.slice(0, skuIdx).replace(/\s+#:\s*$/, '').trim()
        const skuPart = col0.slice(skuIdx)
        const skuMatch = skuPart.match(/SKU\s*#?:?\s*(\d+)/i)
        itemNumber = skuMatch?.[1] ?? ''
      } else {
        // No SKU in first column — use full text as product name, look for number
        productName = col0.replace(/\s*#?\d{4,}\s*$/, '').trim()
        const numInCol = col0.match(/(\d{4,})/)
        itemNumber = numInCol?.[1] ?? ''
      }

      const qtyText = cells[1].textContent?.trim() ?? ''
      const qty = parseInt(qtyText) || 0

      const priceText = cells[2].textContent?.replace('$', '').trim() ?? ''
      const price = parseAmount(priceText)

      const lineTotal = cells.length >= 4
        ? parseAmount(cells[3].textContent?.replace('$', '').trim() ?? '')
        : qty * price

      if (!productName || qty === 0) continue

      parsed.push({ itemNumber, productName, qty, price, lineTotal })
    }

    if (parsed.length > 0) {
      lineItems = parsed
      break
    }
  }

  const totalQty = lineItems?.reduce((sum, li) => sum + li.qty, 0) ?? 0

  return {
    orderNumber,
    createdAt: createdAt ? `${createdAt}T00:00:00.000Z` : null,
    deliveryDate,
    orderStatus: 'submitted',
    refNumber: null,
    totalQty,
    total,
    lineItems,
  }
}

// ─── Plain text fallback ──────────────────────────────────────────────────────

function extractFromText(text: string): ScrapedOrder | null {
  const numMatch = text.match(ORDER_NUMBER) || text.match(ORDER_NUM_FALLBACK)
  if (!numMatch) return null
  const orderNumber = numMatch[1]

  const odMatch = text.match(ORDER_DATE)
  const ddMatch = text.match(DELIVERY_DATE)
  const createdAt = odMatch ? parseDMY(odMatch[1], odMatch[2], odMatch[3]) : null
  const deliveryDate = ddMatch ? parseDMY(ddMatch[1], ddMatch[2], ddMatch[3]) : null

  const totalMatch = text.match(TOTAL_LINE)
  const total = totalMatch ? parseAmount(totalMatch[1]) : 0

  const lineItems: ScrapedOrder['lineItems'] = []
  LINE_ITEM.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LINE_ITEM.exec(text)) !== null) {
    const productName = m[1].trim()
    const itemNumber = m[2]
    const qty = parseInt(m[3]) || 0
    const price = parseAmount(m[4])
    const lineTotal = parseAmount(m[5])
    if (productName && qty > 0) {
      lineItems.push({ itemNumber, productName, qty, price, lineTotal })
    }
  }

  const totalQty = lineItems.reduce((sum, li) => sum + li.qty, 0)

  return {
    orderNumber,
    createdAt: createdAt ? `${createdAt}T00:00:00.000Z` : null,
    deliveryDate,
    orderStatus: 'submitted',
    refNumber: null,
    totalQty,
    total,
    lineItems,
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a Lactalis order confirmation email body into a ScrapedOrder.
 * Tries HTML extraction first, falls back to plain text regex.
 * Returns null if the order number cannot be extracted.
 */
export function parseOrderEmail(content: string, isHtml: boolean): ScrapedOrder | null {
  if (isHtml) {
    const result = extractFromHtml(content)
    if (result) return result
    // HTML parse failed — strip tags and try text
    const stripped = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    return extractFromText(stripped)
  }
  return extractFromText(content)
}
