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

  if (!CONFIG || !CONFIG.w || !CONFIG.k) {
    console.error('[Lactalis Bridge] Missing config — bookmarklet URL must include Worker URL and secret in hash')
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
      #status-dot.syncing, #status-dot.submitting { background: #f59e0b; animation: pulse 1s infinite; }
      #status-dot.error { background: #ef4444; }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

      #schedule-info, #order-info {
        background: #f9fafb;
        border-radius: 10px;
        padding: 10px 12px;
        margin-bottom: 10px;
        font-size: 13px;
        color: #374151;
      }
      #schedule-info strong, #order-info strong { color: #1d4ed8; }

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
        <div id="order-info" style="display:none"></div>

        <button class="btn btn-primary" id="sync-btn">Sync Schedule</button>
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
    pendingOrder = await checkPendingOrder()
    renderOrderInfo(pendingOrder)
  }

  syncIntervalId = setInterval(autoRefresh, SYNC_INTERVAL_MS)

  // ─── Initial run ──────────────────────────────────────────────────────────

  log('Bridge loaded — syncing schedule…')
  autoRefresh()
})()
