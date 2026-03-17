/**
 * orderHistoryScraper.js — Lactalis portal order history extractor
 *
 * Loaded as a content script on ALL https://*.lactalis.com.au/* pages.
 * Primary strategy: fetch('/customer/order/') from any page (like scheduleScraper).
 * Fallback: DOM scraping when actually on the order history page.
 *
 * Storage format (chrome.storage.local key: 'orderHistory'):
 * {
 *   orders: [{ orderNumber, createdAt, deliveryDate, orderStatus, refNumber, totalQty, total }],
 *   scrapedAt: number,
 * }
 */

;(function () {
  'use strict'

  const DEBUG = false

  // Avoid double-injection
  if (window.__milkManagerOrderScraperActive__) return
  window.__milkManagerOrderScraperActive__ = true

  // ─── Date parsing ─────────────────────────────────────────────────────────

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

  // ─── Table parser (works on any Document/Element) ─────────────────────────

  function scrapeOrderListFromDoc(doc) {
    const tables = doc.querySelectorAll('table')
    if (tables.length === 0) return []

    for (const table of tables) {
      const headers = [...table.querySelectorAll('th, thead td')].map(
        (th) => (th.innerText ?? th.textContent ?? '').trim().toLowerCase()
      )

      const orderNumIdx = headers.findIndex((h) => h.includes('order') && h.includes('number'))
      if (orderNumIdx < 0) continue

      const createdAtIdx = headers.findIndex((h) => h.includes('created'))
      const deliveryDateIdx = headers.findIndex((h) => h.includes('delivery') && h.includes('date'))

      const statusIndices = []
      headers.forEach((h, i) => {
        if (h.includes('order') && h.includes('status')) statusIndices.push(i)
      })
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

        orders.push({
          orderNumber,
          createdAt: createdAtIdx >= 0 ? parseAUDateTime(cells[createdAtIdx]) : null,
          deliveryDate: deliveryDateIdx >= 0 ? parseAUDate(cells[deliveryDateIdx]) : null,
          orderStatus: orderStatusIdx >= 0 ? cells[orderStatusIdx] : null,
          refNumber: refNumIdx >= 0 ? cells[refNumIdx] : null,
          totalQty: totalQtyIdx >= 0 ? Number(cells[totalQtyIdx]) || 0 : 0,
          total: totalIdx >= 0 ? parseFloat((cells[totalIdx] || '').replace(/[$,]/g, '')) || 0 : 0,
          onlineOrder: onlineIdx >= 0 ? cells[onlineIdx].toLowerCase() === 'yes' : null,
        })
      }

      if (orders.length > 0) {
        if (DEBUG) console.log(`[Milk Manager Order Scraper] Found ${orders.length} orders`)
        return orders
      }
    }

    return []
  }

  // ─── Strategy 0: Fetch order history page via API (works from any page) ───

  async function fetchOrderHistoryAPI() {
    try {
      const resp = await fetch('/customer/order/', {
        credentials: 'include',
        headers: { 'Accept': 'text/html' },
      })
      if (!resp.ok) return null
      const html = await resp.text()

      // Check for login redirect or Incapsula block
      if (html.includes('login') && html.length < 2000) return null
      if (html.includes('_Incapsula_') || html.includes('incap_ses')) return null

      const doc = new DOMParser().parseFromString(html, 'text/html')
      const orders = scrapeOrderListFromDoc(doc)
      return orders.length > 0 ? orders : null
    } catch (e) {
      if (DEBUG) console.log('[Milk Manager Order Scraper] Fetch API failed:', e.message)
      return null
    }
  }

  // ─── Strategy 1: DOM scraping (when on the order history page) ────────────

  function scrapeLivePage() {
    const url = location.href.toLowerCase()
    if (!url.includes('/customer/order') || url.includes('/customer/order/view')) return null
    return scrapeOrderListFromDoc(document)
  }

  // ─── Order detail scraper (line items — only on detail pages) ─────────────

  function scrapeOrderDetailLines() {
    const url = location.href.toLowerCase()
    if (!url.includes('/customer/order/view')) return null

    const tables = document.querySelectorAll('table')
    const lines = []

    for (const table of tables) {
      const headers = [...table.querySelectorAll('th, thead td')].map(
        (th) => (th.innerText ?? th.textContent ?? '').trim().toLowerCase()
      )

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

        const itemMatch = productText.match(/item\s*#\s*:\s*(\d+)/i)
        const itemNumber = itemMatch ? itemMatch[1] : null
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

    const pageText = document.body.innerText ?? ''
    const statusMatch = pageText.match(/Order\s+Status\s+(\w+)/i)
    const orderStatus = statusMatch ? statusMatch[1] : null
    const orderNumMatch = pageText.match(/(?:Order\s*#?\s*|order\s+number\s*:?\s*)(\d{6,})/i)
    const orderNumber = orderNumMatch ? orderNumMatch[1] : null

    return lines.length > 0 ? { orderNumber, orderStatus, lines } : null
  }

  // ─── Store and relay ──────────────────────────────────────────────────────

  function storeAndRelay(orders) {
    const data = { orders, scrapedAt: Date.now() }
    chrome.storage.local.set({ orderHistory: data }, () => {
      if (DEBUG) console.log(`[Milk Manager Order Scraper] Saved ${orders.length} orders`)
    })
    chrome.runtime.sendMessage({ type: 'ORDER_HISTORY_UPDATE', payload: data })
  }

  async function scrapeAndStore() {
    // Strategy 0: Fetch via API (works from any Lactalis page)
    const apiOrders = await fetchOrderHistoryAPI()
    if (apiOrders && apiOrders.length > 0) {
      storeAndRelay(apiOrders)
      return
    }

    // Strategy 1: DOM scraping (fallback when on the actual order page)
    const domOrders = scrapeLivePage()
    if (domOrders && domOrders.length > 0) {
      storeAndRelay(domOrders)
      return
    }

    // Detail page: scrape line items and merge into existing history
    const detail = scrapeOrderDetailLines()
    if (detail) {
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

    if (DEBUG) console.log('[Milk Manager Order Scraper] No order data found')
  }

  // ─── Run ──────────────────────────────────────────────────────────────────

  // Delay to let page render + avoid racing with scheduleScraper
  setTimeout(scrapeAndStore, 2000)

  // Re-run on significant DOM changes (SPA navigation)
  let mutationDebounce = null
  let mutationReRunCount = 0
  const MAX_RERUNS = 2

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
    }, 5000)
  })
  observer.observe(document.body, { childList: true, subtree: false })

  // On-demand refresh
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SCRAPE_ORDER_HISTORY') {
      scrapeAndStore().then(() => sendResponse({ ok: true }))
      return true
    }
  })
})()
