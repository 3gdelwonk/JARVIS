/**
 * orderHistoryScraper.js — Lactalis portal order history extractor
 *
 * Loaded as a content script on all https://*.lactalis.com.au/* pages.
 * Activates only on /customer/order/ pages.
 *
 * Scrapes the order history table and (on detail pages) line items.
 * Stores results in chrome.storage.local key 'orderHistory'.
 *
 * Storage format:
 * {
 *   orders: [{ orderNumber, createdAt, deliveryDate, orderStatus, refNumber, totalQty, total, lineItems? }],
 *   scrapedAt: number,
 * }
 */

;(function () {
  'use strict'

  const DEBUG = false

  // Only run on order-related pages
  const url = location.href.toLowerCase()
  const isOrderListPage = url.includes('/customer/order') && !url.includes('/customer/order/view')
  const isOrderDetailPage = url.includes('/customer/order/view')

  if (!isOrderListPage && !isOrderDetailPage) return

  // Avoid double-injection
  if (window.__milkManagerOrderScraperActive__) return
  window.__milkManagerOrderScraperActive__ = true

  if (DEBUG) console.log('[Milk Manager Order Scraper] Active on:', isOrderListPage ? 'list' : 'detail')

  // ─── Date parsing ─────────────────────────────────────────────────────────

  /**
   * Parse AU date formats:
   *   "17/3/2026, 11:53 AM" → "2026-03-17"
   *   "18/3/2026" → "2026-03-18"
   *   "13/3/2026" → "2026-03-13"
   */
  function parseAUDate(text) {
    if (!text) return null
    const m = text.trim().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
    if (!m) return null
    const d = Number(m[1])
    const mo = Number(m[2])
    const y = Number(m[3])
    if (d > 31 || mo > 12 || y < 2020) return null
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }

  function parseAUDateTime(text) {
    if (!text) return null
    const date = parseAUDate(text)
    if (!date) return null
    // Try to extract time part
    const timeMatch = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i)
    if (timeMatch) {
      let h = Number(timeMatch[1])
      const min = timeMatch[2]
      const ampm = timeMatch[3].toUpperCase()
      if (ampm === 'PM' && h < 12) h += 12
      if (ampm === 'AM' && h === 12) h = 0
      return `${date}T${String(h).padStart(2, '0')}:${min}:00`
    }
    return date
  }

  // ─── Order list scraper ───────────────────────────────────────────────────

  function scrapeOrderListTable() {
    const tables = document.querySelectorAll('table')
    if (tables.length === 0) return []

    for (const table of tables) {
      const headers = [...table.querySelectorAll('th, thead td')].map(
        (th) => (th.innerText ?? th.textContent ?? '').trim().toLowerCase()
      )

      // Must have "order number" column to be the right table
      const orderNumIdx = headers.findIndex((h) => h.includes('order') && h.includes('number'))
      if (orderNumIdx < 0) continue

      // Map column indices by header text
      const createdAtIdx = headers.findIndex((h) => h.includes('created'))
      const deliveryDateIdx = headers.findIndex((h) => h.includes('delivery') && h.includes('date'))

      // Two "order status" columns — first is typically "Open", second is "Created"/"Delivered"
      const statusIndices = []
      headers.forEach((h, i) => {
        if (h.includes('order') && h.includes('status')) statusIndices.push(i)
      })
      // The meaningful status is the second one (Created/Delivered), fall back to first
      const orderStatusIdx = statusIndices.length >= 2 ? statusIndices[1] : statusIndices[0] ?? -1

      const refNumIdx = headers.findIndex((h) => h.includes('ref') && h.includes('number'))
      const totalQtyIdx = headers.findIndex((h) => h.includes('total') && h.includes('quantity'))
      const totalIdx = headers.findIndex((h) => h === 'total')
      const onlineIdx = headers.findIndex((h) => h.includes('online'))

      const orders = []
      const rows = table.querySelectorAll('tbody tr')

      for (const row of rows) {
        const cells = [...row.querySelectorAll('td')].map(
          (c) => (c.innerText ?? c.textContent ?? '').trim()
        )
        if (cells.length < 3) continue

        const orderNumber = orderNumIdx >= 0 ? cells[orderNumIdx] : null
        if (!orderNumber) continue

        // Extract the detail page link from the row (eye icon or order number link)
        let detailUrl = null
        const links = row.querySelectorAll('a[href*="/customer/order/view"]')
        if (links.length > 0) {
          detailUrl = links[0].href
        }

        orders.push({
          orderNumber,
          createdAt: createdAtIdx >= 0 ? parseAUDateTime(cells[createdAtIdx]) : null,
          deliveryDate: deliveryDateIdx >= 0 ? parseAUDate(cells[deliveryDateIdx]) : null,
          orderStatus: orderStatusIdx >= 0 ? cells[orderStatusIdx] : null,
          refNumber: refNumIdx >= 0 ? cells[refNumIdx] : null,
          totalQty: totalQtyIdx >= 0 ? Number(cells[totalQtyIdx]) || 0 : 0,
          total: totalIdx >= 0 ? parseFloat((cells[totalIdx] || '').replace(/[$,]/g, '')) || 0 : 0,
          onlineOrder: onlineIdx >= 0 ? cells[onlineIdx].toLowerCase() === 'yes' : null,
          detailUrl,
        })
      }

      if (orders.length > 0) {
        if (DEBUG) console.log(`[Milk Manager Order Scraper] Found ${orders.length} orders in table`)
        return orders
      }
    }

    return []
  }

  // ─── Order detail scraper (line items) ────────────────────────────────────

  function scrapeOrderDetailLines() {
    const tables = document.querySelectorAll('table')
    const lines = []

    for (const table of tables) {
      const headers = [...table.querySelectorAll('th, thead td')].map(
        (th) => (th.innerText ?? th.textContent ?? '').trim().toLowerCase()
      )

      // Look for the items table — must have "product" and "quantity" columns
      const productIdx = headers.findIndex((h) => h.includes('product'))
      const qtyIdx = headers.findIndex((h) => h.includes('quantity'))
      if (productIdx < 0 || qtyIdx < 0) continue

      const priceIdx = headers.findIndex((h) => h === 'price')
      const rtetIdx = headers.findIndex((h) => h.includes('rtet'))

      const rows = table.querySelectorAll('tbody tr')
      for (const row of rows) {
        const cells = [...row.querySelectorAll('td')]
        if (cells.length < 2) continue

        const productCell = cells[productIdx]
        const productText = (productCell?.innerText ?? productCell?.textContent ?? '').trim()

        // Extract item number from "Item #: XXXXX" pattern
        const itemMatch = productText.match(/item\s*#\s*:\s*(\d+)/i)
        const itemNumber = itemMatch ? itemMatch[1] : null

        // Product name is the first line (before "Item #:")
        const productName = productText.split(/\n/)[0]?.trim() ?? productText

        const qty = qtyIdx >= 0 ? Number((cells[qtyIdx]?.textContent ?? '').trim()) || 0 : 0
        const price = priceIdx >= 0 ? parseFloat((cells[priceIdx]?.textContent ?? '').replace(/[$,]/g, '')) || 0 : 0
        const lineTotal = rtetIdx >= 0 ? parseFloat((cells[rtetIdx]?.textContent ?? '').replace(/[$,]/g, '')) || 0 : 0

        if (itemNumber || productName) {
          lines.push({ itemNumber, productName, qty, price, lineTotal })
        }
      }

      if (lines.length > 0) break
    }

    // Also extract order-level info from the detail page
    const pageText = document.body.innerText ?? ''
    const statusMatch = pageText.match(/Order\s+Status\s+(\w+)/i)
    const orderStatus = statusMatch ? statusMatch[1] : null

    // Try to get order number from breadcrumb or heading
    const orderNumMatch = pageText.match(/(?:Order\s*#?\s*|order\s+number\s*:?\s*)(\d{6,})/i)
    const orderNumber = orderNumMatch ? orderNumMatch[1] : null

    return { orderNumber, orderStatus, lines }
  }

  // ─── Store and relay ──────────────────────────────────────────────────────

  async function scrapeAndStore() {
    if (isOrderListPage) {
      const orders = scrapeOrderListTable()
      if (orders.length === 0) {
        if (DEBUG) console.log('[Milk Manager Order Scraper] No orders found on list page')
        return
      }

      const data = { orders, scrapedAt: Date.now() }
      chrome.storage.local.set({ orderHistory: data }, () => {
        if (DEBUG) console.log(`[Milk Manager Order Scraper] Saved ${orders.length} orders`)
      })
      chrome.runtime.sendMessage({ type: 'ORDER_HISTORY_UPDATE', payload: data })

    } else if (isOrderDetailPage) {
      const detail = scrapeOrderDetailLines()
      if (detail.lines.length === 0) return

      // Merge line items into existing orderHistory
      chrome.storage.local.get('orderHistory', (result) => {
        const history = result.orderHistory ?? { orders: [], scrapedAt: Date.now() }

        if (detail.orderNumber) {
          const existing = history.orders.find((o) => o.orderNumber === detail.orderNumber)
          if (existing) {
            existing.lineItems = detail.lines
            if (detail.orderStatus) existing.orderStatus = detail.orderStatus
          } else {
            history.orders.unshift({
              orderNumber: detail.orderNumber,
              orderStatus: detail.orderStatus,
              lineItems: detail.lines,
              createdAt: null,
              deliveryDate: null,
              refNumber: null,
              totalQty: detail.lines.reduce((sum, l) => sum + l.qty, 0),
              total: detail.lines.reduce((sum, l) => sum + l.lineTotal, 0),
            })
          }
        }

        history.scrapedAt = Date.now()
        chrome.storage.local.set({ orderHistory: history })
        chrome.runtime.sendMessage({ type: 'ORDER_HISTORY_UPDATE', payload: history })
      })
    }
  }

  // ─── Run ──────────────────────────────────────────────────────────────────

  // Delay to allow page to finish rendering
  setTimeout(scrapeAndStore, 1500)

  // Re-run on significant DOM changes (SPA navigation, table re-render)
  let mutationDebounce = null
  let mutationReRunCount = 0
  const MAX_RERUNS = 3

  const observer = new MutationObserver(() => {
    if (mutationReRunCount >= MAX_RERUNS) {
      observer.disconnect()
      return
    }
    clearTimeout(mutationDebounce)
    mutationDebounce = setTimeout(() => {
      mutationReRunCount++
      scrapeAndStore()
      if (mutationReRunCount >= MAX_RERUNS) observer.disconnect()
    }, 3000)
  })
  observer.observe(document.body, { childList: true, subtree: false })

  // On-demand refresh from popup/background
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SCRAPE_ORDER_HISTORY') {
      scrapeAndStore().then(() => sendResponse({ ok: true }))
      return true
    }
  })
})()
