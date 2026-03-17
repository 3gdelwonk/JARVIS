/**
 * orderHistoryScraper.js — Lactalis portal order history extractor
 *
 * Loaded as a content script on ALL https://*.lactalis.com.au/* pages.
 * Strategies (tried in order):
 *   0. OroCommerce datagrid JSON API (fastest, most reliable)
 *   1. Fetch /customer/order/ HTML + parse tables (flexible header matching)
 *   2. DOM scraping when actually on the order history page
 *   3. Text-scan fallback (regex extraction from raw HTML)
 *   4. Order detail page line-item scraping
 *
 * Storage format (chrome.storage.local key: 'orderHistory'):
 * {
 *   orders: [{ orderNumber, createdAt, deliveryDate, orderStatus, refNumber, totalQty, total }],
 *   scrapedAt: number,
 * }
 */

;(function () {
  'use strict'

  const LOG = '[Milk Manager Order Scraper]'

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

  // ─── Flexible header matching ──────────────────────────────────────────────

  function matchHeader(header, ...patterns) {
    const h = header.toLowerCase().replace(/[#.]/g, '').trim()
    return patterns.some((p) => {
      if (typeof p === 'string') return h.includes(p)
      return p.test(h)
    })
  }

  function findOrderNumCol(headers) {
    // Try specific matches first, then broader
    let idx = headers.findIndex((h) => matchHeader(h, 'order number', 'order no'))
    if (idx >= 0) return idx
    idx = headers.findIndex((h) => matchHeader(h, 'order #', 'order#'))
    if (idx >= 0) return idx
    idx = headers.findIndex((h) => /^order\s*$/i.test(h.replace(/[#.]/g, '').trim()))
    if (idx >= 0) return idx
    // Check for 'po number', 'po #'
    idx = headers.findIndex((h) => matchHeader(h, 'po number', 'po no', 'po #', 'po#'))
    if (idx >= 0) return idx
    return -1
  }

  function findStatusCol(headers) {
    // Try 'order status' first, then just 'status'
    let idx = headers.findIndex((h) => matchHeader(h, 'order status'))
    if (idx >= 0) return idx
    // If multiple 'status' columns, prefer the second one (first is often a checkbox)
    const indices = []
    headers.forEach((h, i) => { if (matchHeader(h, 'status')) indices.push(i) })
    return indices.length >= 2 ? indices[1] : indices[0] ?? -1
  }

  function findTotalCol(headers) {
    let idx = headers.findIndex((h) => /^total$/i.test(h.trim()))
    if (idx >= 0) return idx
    idx = headers.findIndex((h) => matchHeader(h, 'amount', 'value', 'grand total'))
    return idx
  }

  // ─── Table parser (works on any Document/Element) ─────────────────────────

  function scrapeOrderListFromDoc(doc, label) {
    const tables = doc.querySelectorAll('table')
    console.log(`${LOG} [${label}] Tables found: ${tables.length}`)

    if (tables.length === 0) {
      // Also check for grid/div-based layouts
      const gridRows = doc.querySelectorAll('[class*="grid"] [class*="row"], .oro-datagrid tbody tr, .grid-body tr')
      console.log(`${LOG} [${label}] Grid rows found: ${gridRows.length}`)
      return []
    }

    for (let t = 0; t < tables.length; t++) {
      const table = tables[t]
      const headerEls = table.querySelectorAll('th, thead td')
      const headers = [...headerEls].map(
        (th) => (th.innerText ?? th.textContent ?? '').trim()
      )
      const headersLower = headers.map((h) => h.toLowerCase())

      console.log(`${LOG} [${label}] Table ${t} headers (${headers.length}):`, JSON.stringify(headers))

      const orderNumIdx = findOrderNumCol(headers)
      if (orderNumIdx < 0) {
        console.log(`${LOG} [${label}] Table ${t}: no order number column found, skipping`)
        continue
      }

      const createdAtIdx = headersLower.findIndex((h) => h.includes('created') || h.includes('date ordered'))
      const deliveryDateIdx = headersLower.findIndex((h) =>
        (h.includes('delivery') && h.includes('date')) || h.includes('ship date') || h.includes('deliver')
      )
      const orderStatusIdx = findStatusCol(headers)
      const refNumIdx = headersLower.findIndex((h) =>
        (h.includes('ref') && (h.includes('number') || h.includes('no') || h.includes('#'))) || h.includes('reference')
      )
      const totalQtyIdx = headersLower.findIndex((h) => h.includes('total') && h.includes('qty') || h.includes('total') && h.includes('quantity'))
      const totalIdx = findTotalCol(headers)
      const onlineIdx = headersLower.findIndex((h) => h.includes('online'))

      console.log(`${LOG} [${label}] Column indices: order=${orderNumIdx} created=${createdAtIdx} delivery=${deliveryDateIdx} status=${orderStatusIdx} ref=${refNumIdx} total=${totalIdx}`)

      const orders = []
      const rows = table.querySelectorAll('tbody tr')
      console.log(`${LOG} [${label}] Table ${t} data rows: ${rows.length}`)

      for (const row of rows) {
        const cells = [...row.querySelectorAll('td')].map(
          (c) => (c.innerText ?? c.textContent ?? '').trim()
        )
        if (cells.length < 2) continue

        const orderNumber = orderNumIdx >= 0 && orderNumIdx < cells.length ? cells[orderNumIdx] : null
        if (!orderNumber || !/\d/.test(orderNumber)) continue  // must contain at least one digit

        orders.push({
          orderNumber: orderNumber.replace(/^#\s*/, ''),  // strip leading "#"
          createdAt: createdAtIdx >= 0 ? parseAUDateTime(cells[createdAtIdx]) : null,
          deliveryDate: deliveryDateIdx >= 0 ? parseAUDate(cells[deliveryDateIdx]) : null,
          orderStatus: orderStatusIdx >= 0 ? cells[orderStatusIdx] : null,
          refNumber: refNumIdx >= 0 ? cells[refNumIdx] : null,
          totalQty: totalQtyIdx >= 0 ? Number(cells[totalQtyIdx]) || 0 : 0,
          total: totalIdx >= 0 ? parseFloat((cells[totalIdx] || '').replace(/[$,AUD\s]/g, '')) || 0 : 0,
          onlineOrder: onlineIdx >= 0 ? cells[onlineIdx].toLowerCase() === 'yes' : null,
        })
      }

      if (orders.length > 0) {
        console.log(`${LOG} [${label}] Found ${orders.length} orders from table ${t}`)
        return orders
      } else {
        console.log(`${LOG} [${label}] Table ${t} had matching headers but 0 valid rows`)
      }
    }

    return []
  }

  // ─── Strategy 0: OroCommerce datagrid JSON API ─────────────────────────────

  async function fetchOrderGridAPI() {
    // OroCommerce uses datagrid endpoints for AJAX table loading
    const gridNames = [
      'frontend-customer-user-orders-grid',
      'customer-orders-grid',
      'order-grid',
      'frontend-orders-grid',
    ]

    for (const gridName of gridNames) {
      try {
        const url = `/datagrid/${gridName}?${gridName}%5B_pager%5D%5B_page%5D=1&${gridName}%5B_pager%5D%5B_per_page%5D=50`
        console.log(`${LOG} Trying datagrid: ${gridName}`)
        const resp = await fetch(url, {
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
        })
        if (!resp.ok) {
          console.log(`${LOG} Datagrid ${gridName}: ${resp.status}`)
          continue
        }
        const contentType = resp.headers.get('content-type') || ''
        if (!contentType.includes('json')) {
          console.log(`${LOG} Datagrid ${gridName}: not JSON (${contentType})`)
          continue
        }
        const data = await resp.json()
        console.log(`${LOG} Datagrid ${gridName} response keys:`, Object.keys(data))

        // OroCommerce datagrid format: { data: [ { ... }, ... ], options: { totalRecords: N } }
        const rows = data.data || data.rows || data.results || []
        if (!Array.isArray(rows) || rows.length === 0) {
          console.log(`${LOG} Datagrid ${gridName}: no rows`)
          continue
        }

        console.log(`${LOG} Datagrid ${gridName}: ${rows.length} rows, first row keys:`, Object.keys(rows[0]))

        // Map datagrid fields to our order format
        const orders = rows.map((r) => {
          // Try common OroCommerce field names
          const orderNumber = r.identifier || r.orderNumber || r.poNumber || r.id || r.order_number || ''
          return {
            orderNumber: String(orderNumber),
            createdAt: r.createdAt || r.created_at || r.dateOrdered || r.date_ordered || null,
            deliveryDate: r.deliveryDate || r.delivery_date || r.shipDate || r.ship_date || null,
            orderStatus: r.internalStatusName || r.statusLabel || r.status || r.internal_status_name || null,
            refNumber: r.customerNotes || r.poNumber || r.po_number || r.referenceNumber || null,
            totalQty: Number(r.totalQuantity || r.total_quantity || 0) || 0,
            total: parseFloat(String(r.total || r.grandTotal || r.subtotal || r.totalValue || 0).replace(/[$,AUD\s]/g, '')) || 0,
            onlineOrder: r.isOnline ?? r.is_online ?? null,
          }
        }).filter((o) => o.orderNumber && /\d/.test(o.orderNumber))

        if (orders.length > 0) {
          console.log(`${LOG} Datagrid ${gridName}: parsed ${orders.length} orders`)
          return orders
        }
      } catch (e) {
        console.log(`${LOG} Datagrid ${gridName} error:`, e.message)
      }
    }

    return null
  }

  // ─── Strategy 1: Fetch order history page HTML ─────────────────────────────

  async function fetchOrderHistoryHTML() {
    try {
      console.log(`${LOG} Fetching /customer/order/ ...`)
      const resp = await fetch('/customer/order/', {
        credentials: 'include',
        headers: { 'Accept': 'text/html' },
      })
      if (!resp.ok) {
        console.log(`${LOG} Fetch failed: ${resp.status}`)
        return null
      }
      const html = await resp.text()
      console.log(`${LOG} Got HTML: ${html.length} chars`)

      // Check for login redirect or Incapsula block
      if (html.includes('login') && html.length < 2000) {
        console.log(`${LOG} Blocked — login redirect detected`)
        return null
      }
      if (html.includes('_Incapsula_') || html.includes('incap_ses')) {
        console.log(`${LOG} Blocked — Incapsula challenge detected`)
        return null
      }

      const doc = new DOMParser().parseFromString(html, 'text/html')

      // Try table parsing first
      const orders = scrapeOrderListFromDoc(doc, 'fetch-html')
      if (orders.length > 0) return orders

      // Try text-scan fallback on the fetched HTML
      const textOrders = textScanForOrders(doc)
      if (textOrders.length > 0) return textOrders

      return null
    } catch (e) {
      console.log(`${LOG} Fetch HTML failed:`, e.message)
      return null
    }
  }

  // ─── Strategy 2: DOM scraping (when on the order history page) ────────────

  function scrapeLivePage() {
    const url = location.href.toLowerCase()
    if (!url.includes('/customer/order') || url.includes('/customer/order/view')) return null

    console.log(`${LOG} Trying live DOM scrape on ${location.href}`)
    const orders = scrapeOrderListFromDoc(document, 'live-dom')
    if (orders.length > 0) return orders

    // Try text-scan fallback on live page
    return textScanForOrders(document)
  }

  // ─── Strategy 3: Text-scan fallback ────────────────────────────────────────

  function textScanForOrders(doc) {
    // Look for order numbers in the page text using patterns
    const bodyText = (doc.body?.innerText ?? doc.body?.textContent ?? '')
    if (!bodyText || bodyText.length < 100) return []

    console.log(`${LOG} Text-scan: body text ${bodyText.length} chars`)

    // Look for links to /customer/order/view/ID
    const links = doc.querySelectorAll('a[href*="/customer/order/view/"]')
    console.log(`${LOG} Text-scan: found ${links.length} order detail links`)

    if (links.length === 0) return []

    const orders = []
    const seen = new Set()

    for (const link of links) {
      const href = link.getAttribute('href') || ''
      const orderIdMatch = href.match(/\/customer\/order\/view\/(\d+)/)
      if (!orderIdMatch) continue

      const orderNumber = orderIdMatch[1]
      if (seen.has(orderNumber)) continue
      seen.add(orderNumber)

      // Try to find order data in the surrounding row
      const row = link.closest('tr') || link.closest('[class*="row"]') || link.parentElement?.parentElement
      const rowText = row ? (row.innerText ?? row.textContent ?? '') : ''

      // Extract dates from row text (DD/MM/YYYY pattern)
      const dates = [...rowText.matchAll(/(\d{1,2}\/\d{1,2}\/\d{4})/g)].map((m) => m[1])
      const createdAt = dates.length > 0 ? parseAUDateTime(dates[0]) : null
      const deliveryDate = dates.length > 1 ? parseAUDate(dates[1]) : null

      // Extract monetary amounts ($X,XXX.XX pattern)
      const amounts = [...rowText.matchAll(/\$[\d,]+\.?\d*/g)].map((m) =>
        parseFloat(m[0].replace(/[$,]/g, '')) || 0
      )
      const total = amounts.length > 0 ? amounts[amounts.length - 1] : 0

      // Extract status words
      const statusWords = ['Delivered', 'Closed', 'Open', 'Created', 'Shipped', 'Processing', 'Cancelled', 'Complete']
      const orderStatus = statusWords.find((s) => rowText.includes(s)) || null

      // Try to find the display order number (might differ from URL ID)
      const linkText = (link.innerText ?? link.textContent ?? '').trim()
      const displayNumber = linkText.match(/\d{6,}/) ? linkText.replace(/^#\s*/, '').trim() : orderNumber

      orders.push({
        orderNumber: displayNumber,
        createdAt,
        deliveryDate,
        orderStatus,
        refNumber: null,
        totalQty: 0,
        total,
        onlineOrder: null,
      })
    }

    console.log(`${LOG} Text-scan: extracted ${orders.length} orders from links`)
    return orders
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
      const qtyIdx = headers.findIndex((h) => h.includes('quantity') || h.includes('qty'))
      if (productIdx < 0 || qtyIdx < 0) continue

      const priceIdx = headers.findIndex((h) => h === 'price' || h.includes('unit price'))
      const rtetIdx = headers.findIndex((h) => h.includes('rtet') || h.includes('line total') || h.includes('subtotal'))

      const rows = table.querySelectorAll('tbody tr')
      for (const row of rows) {
        const cells = [...row.querySelectorAll('td')]
        if (cells.length < 2) continue

        const productCell = cells[productIdx]
        const productText = (productCell?.innerText ?? productCell?.textContent ?? '').trim()

        const itemMatch = productText.match(/item\s*#\s*:?\s*(\d+)/i)
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
      console.log(`${LOG} Saved ${orders.length} orders to chrome.storage`)
    })
    chrome.runtime.sendMessage({ type: 'ORDER_HISTORY_UPDATE', payload: data }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn(`${LOG} sendMessage failed:`, chrome.runtime.lastError.message)
      } else {
        console.log(`${LOG} Background acknowledged:`, response?.ok)
      }
    })
  }

  async function scrapeAndStore() {
    console.log(`${LOG} Starting scrape from ${location.href}`)

    // Strategy 0: OroCommerce datagrid JSON API
    const gridOrders = await fetchOrderGridAPI()
    if (gridOrders && gridOrders.length > 0) {
      console.log(`${LOG} SUCCESS via datagrid API: ${gridOrders.length} orders`)
      storeAndRelay(gridOrders)
      return
    }

    // Strategy 1: Fetch HTML + parse tables/text
    const htmlOrders = await fetchOrderHistoryHTML()
    if (htmlOrders && htmlOrders.length > 0) {
      console.log(`${LOG} SUCCESS via HTML fetch: ${htmlOrders.length} orders`)
      storeAndRelay(htmlOrders)
      return
    }

    // Strategy 2: DOM scraping (only when on order history page)
    const domOrders = scrapeLivePage()
    if (domOrders && domOrders.length > 0) {
      console.log(`${LOG} SUCCESS via live DOM: ${domOrders.length} orders`)
      storeAndRelay(domOrders)
      return
    }

    // Strategy 3: Detail page line items
    const detail = scrapeOrderDetailLines()
    if (detail) {
      console.log(`${LOG} Found detail page for order ${detail.orderNumber} with ${detail.lines.length} lines`)
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
      return
    }

    console.log(`${LOG} All strategies failed — no order data found on ${location.href}`)
  }

  // ─── Run ──────────────────────────────────────────────────────────────────

  // Delay to let page render + avoid racing with scheduleScraper
  setTimeout(scrapeAndStore, 2500)

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
