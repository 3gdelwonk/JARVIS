/**
 * lactalis-bridge.js — Bookmarklet bridge for Lactalis portal
 *
 * Loaded via bookmarklet on phone browser while logged into mylactalis.com.au.
 * Reads config (Worker URL + secret) from the script tag's hash fragment.
 * Provides schedule syncing and order submission using same-origin requests.
 *
 * Usage: injected via bookmarklet:
 *   javascript:void(function(){var s=document.createElement('script');
 *   s.src='https://3gdelwonk.github.io/JARVIS/lactalis-bridge.js#'
 *   +encodeURIComponent(JSON.stringify({w:'WORKER_URL',k:'SECRET'}));
 *   document.head.appendChild(s)})()
 */
;(function () {
  'use strict'

  // ─── Double-injection guard ─────────────────────────────────────────────────
  if (document.getElementById('__lactalis-bridge-host__')) return

  // ─── Config extraction ──────────────────────────────────────────────────────

  let CONFIG = null

  // Method 1: global variable (set by bookmarklet before loading this script)
  if (window.__LACTALIS_BRIDGE_CONFIG__) {
    CONFIG = window.__LACTALIS_BRIDGE_CONFIG__
  }

  // Method 2: script tag hash fragment (fallback)
  if (!CONFIG) {
    try {
      // Try document.currentScript first (most reliable during execution)
      const current = document.currentScript
      if (current && current.src) {
        const hash = new URL(current.src).hash.slice(1)
        if (hash) CONFIG = JSON.parse(decodeURIComponent(hash))
      }
    } catch { /* ignore */ }
  }

  if (!CONFIG) {
    try {
      const scripts = document.querySelectorAll('script[src*="lactalis-bridge"]')
      for (const s of scripts) {
        const hash = new URL(s.src).hash.slice(1)
        if (hash) {
          CONFIG = JSON.parse(decodeURIComponent(hash))
          break
        }
      }
    } catch { /* ignore */ }
  }

  if (!CONFIG || !CONFIG.w || !CONFIG.k) {
    alert('[Milk Manager] Bridge config not found — re-copy the bookmarklet from Settings.')
    console.error('[Lactalis Bridge] Missing config — no global var or script hash found')
    return
  }

  const WORKER_URL = CONFIG.w.replace(/\/+$/, '')
  const SECRET = CONFIG.k
  const SLOT_CONFIG_ID = 869
  const SYNC_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

  // ─── Worker fetch helper ──────────────────────────────────────────────────

  async function workerFetch(path, options = {}) {
    const url = WORKER_URL + path
    const headers = {
      'Authorization': `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    }

    try {
      const res = await fetch(url, { ...options, headers })
      if (!res.ok) {
        log(`Worker ${path} returned ${res.status}`, 'error')
        return null
      }
      return res.json()
    } catch (err) {
      log(`Worker ${path} failed: ${err.message}`, 'error')
      return null
    }
  }

  // ─── Date/time helpers (ported from scheduleScraper.js) ───────────────────

  function utcToMelbourneDateTime(utcString) {
    const d = new Date(utcString)
    const date = d.toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' })
    const time = d.toLocaleTimeString('en-GB', { timeZone: 'Australia/Melbourne', hour: '2-digit', minute: '2-digit', hour12: false })
    return { date, time }
  }

  function prevBusinessDay(dateStr) {
    const [y, mo, d] = dateStr.split('-').map(Number)
    const dt = new Date(y, mo - 1, d)
    dt.setDate(dt.getDate() - 1)
    if (dt.getDay() === 0) dt.setDate(dt.getDate() - 2)
    if (dt.getDay() === 6) dt.setDate(dt.getDate() - 1)
    return dt.toISOString().slice(0, 10)
  }

  // ─── Schedule sync ────────────────────────────────────────────────────────

  async function fetchAndSyncSchedule() {
    log('Fetching delivery slots…')
    updateStatus('syncing')

    try {
      const resp = await fetch(`/delivery-slots/get-slots/${SLOT_CONFIG_ID}?preselectCurrentSlot=1`, {
        credentials: 'include',
        headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      })

      if (!resp.ok) {
        // Check for redirect to login page
        if (resp.status === 401 || resp.status === 403 || resp.redirected) {
          log('Session expired — please log in again', 'error')
          updateStatus('error')
          return null
        }
        log(`Lactalis returned ${resp.status}`, 'error')
        updateStatus('error')
        return null
      }

      const contentType = resp.headers.get('Content-Type') || ''
      if (!contentType.includes('json')) {
        const text = await resp.text()
        if (text.includes('/customer/user/login') || text.includes('login-form')) {
          log('Session expired — redirected to login', 'error')
          updateStatus('error')
          return null
        }
        log('Unexpected response format', 'error')
        updateStatus('error')
        return null
      }

      const data = await resp.json()
      if (!Array.isArray(data)) {
        log('Unexpected API response format', 'error')
        updateStatus('error')
        return null
      }

      const slots = []
      for (const day of data) {
        const ts = day.time_slots?.find((t) => t.status === 1 || t.status === 2)
        if (!ts) continue

        let orderCutoffDate = prevBusinessDay(day.date)
        let orderCutoffTime = '23:59'

        if (ts.cutoff) {
          const local = utcToMelbourneDateTime(ts.cutoff)
          orderCutoffDate = local.date
          orderCutoffTime = local.time
        }

        slots.push({ deliveryDate: day.date, orderCutoffDate, orderCutoffTime })
      }

      if (slots.length === 0) {
        log('No delivery slots found', 'warn')
        updateStatus('idle')
        return null
      }

      // Filter to future slots only
      const today = new Date().toISOString().slice(0, 10)
      const futureSlots = slots
        .filter((s) => s.deliveryDate >= today)
        .sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate))

      if (futureSlots.length === 0) {
        log('All delivery dates are in the past', 'warn')
        updateStatus('idle')
        return null
      }

      const schedule = {
        nextDelivery: futureSlots[0],
        upcomingDeliveries: futureSlots.slice(0, 5),
        scrapedAt: Date.now(),
        source: 'bookmarklet_bridge',
      }

      // Push to Worker
      const result = await workerFetch('/extension/schedule', {
        method: 'POST',
        body: JSON.stringify(schedule),
      })

      if (result) {
        log(`Synced ${futureSlots.length} deliveries — next: ${futureSlots[0].deliveryDate}`, 'success')
        lastSyncTime = new Date()
        renderScheduleInfo(schedule)
        updateStatus('idle')
      } else {
        log('Failed to push schedule to Worker', 'error')
        updateStatus('error')
      }

      return schedule
    } catch (err) {
      log(`Schedule fetch error: ${err.message}`, 'error')
      updateStatus('error')
      return null
    }
  }

  // ─── Order history scraping ──────────────────────────────────────────────

  let lastOrderSyncTime = null
  let orderSyncStats = { total: 0, withDetails: 0 }

  /**
   * Fetch a single order detail page and parse line items.
   * Returns array of { itemNumber, productName, qty, price, lineTotal } or null.
   */
  async function fetchOrderDetailLines(orderId) {
    const url = `/customer/order/view/${orderId}`
    log(`Fetching order detail ${orderId}…`)

    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { 'Accept': 'text/html' },
      })
      if (!resp.ok) {
        log(`Detail ${orderId}: HTTP ${resp.status}`, 'warn')
        return undefined // not found, but not Incapsula
      }
      const html = await resp.text()

      // Incapsula detection — return null to signal "stop fetching"
      if (html.includes('_Incapsula_') || html.includes('incap_ses')) {
        log('Incapsula detected — stopping detail fetches', 'error')
        return null
      }
      if (html.length < 500 || (html.includes('login') && html.length < 2000)) {
        log(`Detail ${orderId}: session expired or empty`, 'warn')
        return undefined
      }

      const doc = new DOMParser().parseFromString(html, 'text/html')
      return parseDetailLineItems(doc)
    } catch (err) {
      log(`Detail ${orderId} error: ${err.message}`, 'error')
      return undefined
    }
  }

  /**
   * Parse line items from an order detail page document.
   * Handles both table layout (desktop) and mobile vertical layout.
   */
  function parseDetailLineItems(doc) {
    const lines = []

    // Strategy A: Table-based layout (desktop)
    const tables = doc.querySelectorAll('table')
    for (const table of tables) {
      const headers = [...table.querySelectorAll('th, thead td')].map(
        (th) => (th.innerText ?? th.textContent ?? '').trim().toLowerCase()
      )
      const productIdx = headers.findIndex((h) => h.includes('product'))
      const qtyIdx = headers.findIndex((h) => h.includes('quantity') || h.includes('qty'))
      if (productIdx < 0 || qtyIdx < 0) continue

      const priceIdx = headers.findIndex((h) => h === 'price' || h.includes('unit price'))
      const totalIdx = headers.findIndex((h) => h.includes('rtet') || h.includes('line total') || h.includes('subtotal'))

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
        const lineTotal = totalIdx >= 0 ? parseFloat((cells[totalIdx]?.textContent ?? '').replace(/[$,]/g, '')) || 0 : 0
        if (itemNumber || productName) {
          lines.push({ itemNumber, productName, qty, price, lineTotal })
        }
      }
      if (lines.length > 0) return lines
    }

    // Strategy B: Mobile/responsive layout (no table — vertical label:value stacks)
    const bodyText = (doc.body?.innerText ?? doc.body?.textContent ?? '')
    const itemsSection = bodyText.split(/ITEMS\s+ORDERED/i)[1]
    if (itemsSection) {
      const itemBlocks = itemsSection.split(/(?=Item\s*#\s*:?\s*\d)/i)
      for (const block of itemBlocks) {
        const itemMatch = block.match(/Item\s*#\s*:?\s*(\d+)/i)
        if (!itemMatch) continue

        const itemNumber = itemMatch[1]
        let productName = ''
        const nameIdx = block.indexOf(itemMatch[0])
        if (nameIdx > 0) {
          productName = block.substring(0, nameIdx).trim().split('\n').pop()?.trim() ?? ''
        }

        const afterItem = block.substring(block.indexOf(itemMatch[0]) + itemMatch[0].length)
        const amounts = []
        const pricePattern = /\$?([\d,]+\.?\d*)/g
        let match
        while ((match = pricePattern.exec(afterItem)) !== null) {
          const val = parseFloat(match[1].replace(/,/g, ''))
          if (!isNaN(val)) amounts.push(val)
        }

        const qty = amounts.length > 0 ? amounts[0] : 0
        const price = amounts.length > 1 ? amounts[1] : 0
        const lineTotal = amounts.length > 2 ? amounts[amounts.length - 1] : qty * price

        if (itemNumber) {
          lines.push({ itemNumber, productName, qty, price, lineTotal })
        }
      }
    }

    // Strategy C: Find all "Item #: XXXXX" patterns
    if (lines.length === 0) {
      const allText = bodyText
      const itemPattern = /Item\s*#\s*:?\s*(\d+)/gi
      let m
      while ((m = itemPattern.exec(allText)) !== null) {
        const itemNumber = m[1]
        const context = allText.substring(m.index - 100, m.index + 200)
        const contextLines = context.split('\n').map((l) => l.trim()).filter(Boolean)
        const itemLineIdx = contextLines.findIndex((l) => l.includes(m[0]))
        let productName = ''
        if (itemLineIdx > 0) {
          productName = contextLines[itemLineIdx - 1] || ''
        }
        const afterText = context.substring(context.indexOf(m[0]) + m[0].length)
        const priceAmounts = [...afterText.matchAll(/\$?([\d,]+\.\d{2})/g)].map(
          (x) => parseFloat(x[1].replace(/,/g, ''))
        )
        const qtyMatch = afterText.match(/^\s*(\d+)\s/m)
        const qty = qtyMatch ? Number(qtyMatch[1]) : 0
        const price = priceAmounts.length > 0 ? priceAmounts[0] : 0
        const lineTotal = priceAmounts.length > 1 ? priceAmounts[priceAmounts.length - 1] : qty * price
        lines.push({ itemNumber, productName, qty, price, lineTotal })
      }
    }

    return lines.length > 0 ? lines : null
  }

  /**
   * Fetch order history via datagrid API, enrich top 5 with line items,
   * and push to Worker.
   */
  async function fetchAndSyncOrderHistory() {
    log('Fetching order history…')
    updateStatus('syncing-orders')

    try {
      // Fetch order list via OroCommerce datagrid API
      const gridName = 'frontend-orders-grid-alternative'
      const url = `/datagrid/${gridName}?${gridName}%5B_pager%5D%5B_page%5D=1&${gridName}%5B_pager%5D%5B_per_page%5D=50`

      const resp = await fetch(url, {
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
      })

      if (!resp.ok) {
        log(`Order grid returned ${resp.status}`, 'error')
        updateStatus('error')
        return null
      }

      const contentType = resp.headers.get('content-type') || ''
      if (!contentType.includes('json')) {
        const text = await resp.text()
        if (text.includes('_Incapsula_') || text.includes('incap_ses')) {
          log('Incapsula blocked order grid request', 'error')
        } else if (text.includes('login')) {
          log('Session expired — please log in again', 'error')
        } else {
          log('Order grid returned non-JSON response', 'error')
        }
        updateStatus('error')
        return null
      }

      const data = await resp.json()
      const rows = data.data || data.rows || data.results || []
      if (!Array.isArray(rows) || rows.length === 0) {
        log('No orders found in datagrid', 'warn')
        updateStatus('idle')
        return null
      }

      // Map datagrid fields to our order format
      const orders = rows.map((r) => {
        const orderNumber = r.identifier || r.orderNumber || r.poNumber || r.id || ''
        const internalId = r.id || r.entityId || r.entity_id || null
        return {
          orderNumber: String(orderNumber),
          internalId: internalId ? String(internalId) : null,
          createdAt: r.createdAt || r.created_at || r.dateOrdered || null,
          deliveryDate: r.deliveryDate || r.delivery_date || r.shipDate || null,
          orderStatus: r.statusName || r.internalStatusName || r.status || null,
          portalStatus: r.erpOrderStatus || null,
          refNumber: r.erp_number || r.customerNotes || r.referenceNumber || null,
          poNumber: r.poNumber || r.po_number || null,
          totalQty: Number(r.totalQuantity || r.total_quantity || 0) || 0,
          total: parseFloat(String(r.total || r.grandTotal || r.subtotal || 0).replace(/[$,AUD\s]/g, '')) || 0,
          onlineOrder: r.onlineOrder ?? r.isOnline ?? null,
          lineItems: null,
        }
      }).filter((o) => o.orderNumber && /\d/.test(o.orderNumber))

      if (orders.length === 0) {
        log('No valid orders parsed from grid', 'warn')
        updateStatus('idle')
        return null
      }

      log(`Found ${orders.length} orders — fetching details for top 5…`)
      orderSyncStats.total = orders.length

      // Fetch line items for the most recent 5 orders
      const MAX_DETAILS = 5
      const DETAIL_DELAY = 1500
      let detailCount = 0

      const needsDetails = orders.slice(0, MAX_DETAILS)
      for (let i = 0; i < needsDetails.length; i++) {
        const order = needsDetails[i]
        const id = order.internalId || order.orderNumber
        if (!id) continue

        const lines = await fetchOrderDetailLines(id)
        if (lines === null) {
          // Incapsula — stop
          break
        }
        if (lines && lines.length > 0) {
          order.lineItems = lines
          detailCount++
          if (!order.totalQty) {
            order.totalQty = lines.reduce((sum, l) => sum + l.qty, 0)
          }
          if (!order.total) {
            order.total = lines.reduce((sum, l) => sum + l.lineTotal, 0)
          }
        }

        // Rate limit between detail page fetches
        if (i < needsDetails.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, DETAIL_DELAY))
        }
      }

      orderSyncStats.withDetails = detailCount

      // Push full order history to Worker
      const payload = {
        orders,
        scrapedAt: Date.now(),
        source: 'bookmarklet_bridge',
      }

      const result = await workerFetch('/extension/order-history', {
        method: 'POST',
        body: JSON.stringify(payload),
      })

      if (result) {
        log(`Synced ${orders.length} orders (${detailCount} with details)`, 'success')
        lastOrderSyncTime = new Date()
        renderOrderHistoryInfo()
        updateStatus('idle')
      } else {
        log('Failed to push order history to Worker', 'error')
        updateStatus('error')
      }

      return orders
    } catch (err) {
      log(`Order history error: ${err.message}`, 'error')
      updateStatus('error')
      return null
    }
  }

  // ─── Order submission ─────────────────────────────────────────────────────

  async function checkPendingOrder() {
    const result = await workerFetch('/extension/pending-order')
    if (!result?.order || result.order.status !== 'pending') {
      return null
    }
    return result.order
  }

  async function submitOrder(order) {
    log('Submitting order…')
    updateStatus('submitting')

    // Extract CSRF token from the quick-order page
    const csrfInput = document.querySelector('input[name="oro_product_quick_add[_token]"]')
    if (!csrfInput) {
      log('CSRF token not found — navigate to Quick Order page first', 'error')
      updateStatus('error')
      return { ok: false, error: 'CSRF token not found' }
    }
    const csrfToken = csrfInput.value

    const products = order.lines
      .filter((l) => l.qty > 0)
      .map((l, index) => ({ sku: l.itemNumber, unit: 'item', quantity: l.qty, index }))

    if (!products.length) {
      log('Order has no items with qty > 0', 'error')
      updateStatus('error')
      return { ok: false, error: 'No items' }
    }

    const formData = new FormData()
    formData.append('oro_product_quick_add[component]', 'oro_shopping_list_to_checkout_quick_add_processor')
    formData.append('oro_product_quick_add[additional]', '')
    formData.append('oro_product_quick_add[transition]', 'start_from_quickorderform')
    formData.append('oro_product_quick_add[_token]', csrfToken)
    formData.append('oro_product_quick_add[products]', JSON.stringify(products))

    try {
      const resp = await fetch('/customer/product/quick-add/', {
        method: 'POST',
        body: formData,
        credentials: 'include',
        redirect: 'manual',
      })

      let success = false

      if (resp.status === 302 || resp.status === 301) {
        const loc = resp.headers.get('Location')
        if (loc) {
          success = true
          log('Order submitted — redirecting to checkout', 'success')
        }
      } else if (resp.ok) {
        const text = await resp.text()
        try {
          const json = JSON.parse(text)
          if (json.redirectUrl || json.url) success = true
        } catch { /* not JSON */ }
        if (!success) success = true // 200 OK is still good
        log('Order submitted successfully', 'success')
      }

      // Report result to Worker
      await workerFetch('/extension/order-result', {
        method: 'POST',
        body: JSON.stringify({
          orderId: order.orderId,
          success,
          lactalisRef: null,
        }),
      })

      if (success) {
        updateStatus('idle')
        pendingOrder = null
        renderOrderInfo(null)

        // Follow redirect if we got one
        if ((resp.status === 302 || resp.status === 301) && resp.headers.get('Location')) {
          window.location.href = resp.headers.get('Location')
        }
      } else {
        log(`Server returned ${resp.status}`, 'error')
        updateStatus('error')
      }

      return { ok: success }
    } catch (err) {
      log(`Order submit error: ${err.message}`, 'error')
      await workerFetch('/extension/order-result', {
        method: 'POST',
        body: JSON.stringify({
          orderId: order.orderId,
          success: false,
          error: err.message,
        }),
      })
      updateStatus('error')
      return { ok: false, error: err.message }
    }
  }

  // ─── State ────────────────────────────────────────────────────────────────

  let lastSyncTime = null
  let pendingOrder = null
  let syncIntervalId = null
  const activityLog = []

  function log(msg, level = 'info') {
    const time = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })
    activityLog.unshift({ msg, level, time })
    if (activityLog.length > 10) activityLog.pop()
    console.log(`[Lactalis Bridge] ${msg}`)
    renderLog()
  }

  // ─── Floating Widget (Shadow DOM) ─────────────────────────────────────────

  const host = document.createElement('div')
  host.id = '__lactalis-bridge-host__'
  document.documentElement.appendChild(host)

  const shadow = host.attachShadow({ mode: 'open' })

  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 14px;
      }

      #widget {
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 16px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.18);
        width: 320px;
        overflow: hidden;
        transition: height 0.2s ease;
        touch-action: none;
      }
      #widget.minimised #body { display: none; }

      #header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        background: #1d4ed8;
        color: #fff;
        cursor: grab;
        user-select: none;
        -webkit-user-select: none;
      }
      #header-title { font-size: 15px; font-weight: 700; }
      #header-sub { font-size: 11px; opacity: 0.75; margin-top: 2px; }
      #minimise-btn {
        background: rgba(255,255,255,0.2);
        border: none;
        color: #fff;
        font-size: 18px;
        line-height: 1;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      #minimise-btn:hover { background: rgba(255,255,255,0.35); }

      #body { padding: 12px 16px 16px; }

      #status-indicator {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: #6b7280;
        margin-bottom: 10px;
      }
      #status-dot {
        width: 8px; height: 8px;
        border-radius: 50%;
        background: #9ca3af;
        flex-shrink: 0;
      }
      #status-dot.idle { background: #22c55e; }
      #status-dot.syncing, #status-dot.syncing-orders, #status-dot.submitting { background: #f59e0b; animation: pulse 1s infinite; }
      #status-dot.error { background: #ef4444; }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

      #schedule-info, #order-info, #order-history-info {
        background: #f9fafb;
        border-radius: 10px;
        padding: 10px 12px;
        margin-bottom: 10px;
        font-size: 13px;
        color: #374151;
      }
      #schedule-info strong, #order-info strong, #order-history-info strong { color: #1d4ed8; }

      .btn {
        display: block;
        width: 100%;
        padding: 10px 14px;
        border-radius: 10px;
        border: none;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        text-align: center;
        margin-bottom: 6px;
        transition: opacity 0.15s, background 0.15s;
      }
      .btn:last-child { margin-bottom: 0; }
      .btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .btn-primary { background: #2563eb; color: #fff; }
      .btn-primary:not(:disabled):hover { background: #1d4ed8; }
      .btn-secondary { background: #f3f4f6; color: #374151; }
      .btn-secondary:not(:disabled):hover { background: #e5e7eb; }

      #log-area {
        max-height: 120px;
        overflow-y: auto;
        margin-top: 10px;
        border-top: 1px solid #f3f4f6;
        padding-top: 8px;
      }
      .log-entry {
        font-size: 11px;
        color: #6b7280;
        padding: 2px 0;
        display: flex;
        gap: 6px;
      }
      .log-entry .time { color: #9ca3af; flex-shrink: 0; }
      .log-entry.success .msg { color: #16a34a; }
      .log-entry.error .msg { color: #dc2626; }
      .log-entry.warn .msg { color: #d97706; }
    </style>

    <div id="widget">
      <div id="header">
        <div>
          <div id="header-title">Milk Manager</div>
          <div id="header-sub">Lactalis Bridge</div>
        </div>
        <button id="minimise-btn" title="Minimise">&mdash;</button>
      </div>

      <div id="body">
        <div id="status-indicator">
          <div id="status-dot" class="idle"></div>
          <span id="status-text">Ready</span>
        </div>

        <div id="schedule-info">No schedule data yet</div>
        <div id="order-history-info">No order history yet</div>
        <div id="order-info" style="display:none"></div>

        <button class="btn btn-primary" id="sync-btn">Sync Schedule</button>
        <button class="btn btn-primary" id="sync-orders-btn" style="background:#7c3aed">Sync Orders</button>
        <button class="btn btn-secondary" id="order-btn" style="display:none" disabled>Submit Order</button>

        <div id="log-area"></div>
      </div>
    </div>`

  // ─── Widget helpers ───────────────────────────────────────────────────────

  function updateStatus(status) {
    const dot = shadow.getElementById('status-dot')
    const text = shadow.getElementById('status-text')
    dot.className = status
    const labels = {
      idle: lastSyncTime ? `Last sync: ${lastSyncTime.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}` : 'Ready',
      syncing: 'Syncing schedule…',
      'syncing-orders': 'Syncing orders…',
      submitting: 'Submitting order…',
      error: 'Error — check log',
    }
    text.textContent = labels[status] || 'Ready'
  }

  function renderScheduleInfo(schedule) {
    const el = shadow.getElementById('schedule-info')
    if (!schedule || !schedule.upcomingDeliveries?.length) {
      el.textContent = 'No delivery slots found'
      return
    }
    const next = schedule.nextDelivery
    const count = schedule.upcomingDeliveries.length
    el.innerHTML = ''
    const strong = document.createElement('strong')
    strong.textContent = next.deliveryDate
    el.appendChild(document.createTextNode('Next delivery: '))
    el.appendChild(strong)
    el.appendChild(document.createElement('br'))
    el.appendChild(document.createTextNode(`Cutoff: ${next.orderCutoffDate} ${next.orderCutoffTime}`))
    el.appendChild(document.createElement('br'))
    el.appendChild(document.createTextNode(`${count} upcoming slot${count !== 1 ? 's' : ''}`))
  }

  function renderOrderHistoryInfo() {
    const el = shadow.getElementById('order-history-info')
    if (!orderSyncStats.total) {
      el.textContent = 'No order history yet'
      return
    }
    el.innerHTML = ''
    const strong = document.createElement('strong')
    strong.textContent = `${orderSyncStats.total} orders`
    el.appendChild(strong)
    el.appendChild(document.createTextNode(` synced (${orderSyncStats.withDetails} with details)`))
    if (lastOrderSyncTime) {
      el.appendChild(document.createElement('br'))
      el.appendChild(document.createTextNode(`Last: ${lastOrderSyncTime.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}`))
    }
  }

  function renderOrderInfo(order) {
    const el = shadow.getElementById('order-info')
    const btn = shadow.getElementById('order-btn')
    if (!order) {
      el.style.display = 'none'
      btn.style.display = 'none'
      return
    }
    const activeLines = order.lines.filter((l) => l.qty > 0)
    el.style.display = 'block'
    el.innerHTML = ''
    const strong = document.createElement('strong')
    strong.textContent = `${activeLines.length} items`
    el.appendChild(document.createTextNode('Pending order: '))
    el.appendChild(strong)
    el.appendChild(document.createTextNode(` (${order.orderId})`))

    // Only show submit button on quick-order page
    const hasCsrf = !!document.querySelector('input[name="oro_product_quick_add[_token]"]')
    btn.style.display = 'block'
    btn.disabled = !hasCsrf
    if (!hasCsrf) {
      btn.textContent = 'Submit Order (go to Quick Order page)'
    } else {
      btn.textContent = 'Submit Order'
    }
  }

  function renderLog() {
    const el = shadow.getElementById('log-area')
    el.innerHTML = ''
    for (const entry of activityLog) {
      const row = document.createElement('div')
      row.className = `log-entry ${entry.level}`
      const timeSpan = document.createElement('span')
      timeSpan.className = 'time'
      timeSpan.textContent = entry.time
      const msgSpan = document.createElement('span')
      msgSpan.className = 'msg'
      msgSpan.textContent = entry.msg
      row.appendChild(timeSpan)
      row.appendChild(msgSpan)
      el.appendChild(row)
    }
  }

  // ─── Draggable via touch ──────────────────────────────────────────────────

  let isDragging = false
  let dragOffsetX = 0
  let dragOffsetY = 0

  const header = shadow.getElementById('header')

  header.addEventListener('touchstart', (e) => {
    if (e.target.id === 'minimise-btn') return
    isDragging = true
    const touch = e.touches[0]
    const rect = host.getBoundingClientRect()
    dragOffsetX = touch.clientX - rect.left
    dragOffsetY = touch.clientY - rect.top
    header.style.cursor = 'grabbing'
  }, { passive: true })

  document.addEventListener('touchmove', (e) => {
    if (!isDragging) return
    const touch = e.touches[0]
    const x = touch.clientX - dragOffsetX
    const y = touch.clientY - dragOffsetY
    host.style.position = 'fixed'
    host.style.left = Math.max(0, Math.min(x, window.innerWidth - 320)) + 'px'
    host.style.top = Math.max(0, Math.min(y, window.innerHeight - 50)) + 'px'
    host.style.right = 'auto'
    host.style.bottom = 'auto'
  }, { passive: true })

  document.addEventListener('touchend', () => {
    isDragging = false
    header.style.cursor = 'grab'
  }, { passive: true })

  // ─── Event listeners ──────────────────────────────────────────────────────

  // Minimise toggle
  shadow.getElementById('minimise-btn').addEventListener('click', () => {
    const widget = shadow.getElementById('widget')
    widget.classList.toggle('minimised')
    shadow.getElementById('minimise-btn').innerHTML =
      widget.classList.contains('minimised') ? '&#9650;' : '&mdash;'
  })

  // Sync schedule button
  shadow.getElementById('sync-btn').addEventListener('click', async () => {
    shadow.getElementById('sync-btn').disabled = true
    await fetchAndSyncSchedule()
    shadow.getElementById('sync-btn').disabled = false

    // Also check for pending orders
    pendingOrder = await checkPendingOrder()
    renderOrderInfo(pendingOrder)
  })

  // Sync orders button
  shadow.getElementById('sync-orders-btn').addEventListener('click', async () => {
    shadow.getElementById('sync-orders-btn').disabled = true
    await fetchAndSyncOrderHistory()
    shadow.getElementById('sync-orders-btn').disabled = false
  })

  // Submit order button
  shadow.getElementById('order-btn').addEventListener('click', async () => {
    if (!pendingOrder) return
    shadow.getElementById('order-btn').disabled = true
    await submitOrder(pendingOrder)
    shadow.getElementById('order-btn').disabled = false
  })

  // ─── Auto-refresh schedule every 30 min ───────────────────────────────────

  async function autoRefresh() {
    await fetchAndSyncSchedule()
    await fetchAndSyncOrderHistory()
    pendingOrder = await checkPendingOrder()
    renderOrderInfo(pendingOrder)
  }

  syncIntervalId = setInterval(autoRefresh, SYNC_INTERVAL_MS)

  // ─── Initial run ──────────────────────────────────────────────────────────

  log('Bridge loaded — syncing schedule…')
  autoRefresh()
})()
