/**
 * quickOrder.js — Quick Order auto-fill content script
 *
 * Activates only when window.__milkManagerPageType__ === 'quick_order'
 * (set by main.js which loads before this file).
 *
 * Flow:
 *  1. Read pendingOrder from chrome.storage.local
 *  2. If found, inject a floating panel (shadow DOM) into the page
 *  3. Fill via Paste: set paste textarea value → trigger verify
 *  4. Fill via CSV: build CSV Blob → set on file input → trigger change
 *  5. After fill: highlight the "Create Order" button with a reminder
 *  6. Detect successful submission, update chrome.storage status
 *
 * NEVER auto-clicks "Create Order" — the owner always does that manually.
 */

;(function () {
  'use strict'

  const DEBUG = false

  // Only run on the Quick Order page
  if (window.__milkManagerPageType__ !== 'quick_order') return

  // Avoid double-injection on SPA re-renders
  if (document.getElementById('__milk-manager-host__')) return

  // ─── Order data ────────────────────────────────────────────────────────────

  let currentOrder = null         // { orderId, date, lines: [{itemNumber, qty}] }
  let panelState = 'idle'         // idle | filling | filled | error
  let createOrderObserver = null  // MutationObserver ref — disconnected on dismiss

  // ─── Format helpers ────────────────────────────────────────────────────────

  function buildPasteString(lines) {
    return lines
      .filter((l) => l.qty > 0)
      .map((l) => `${l.itemNumber},${l.qty}`)
      .join(';')
  }

  function buildCsvString(lines) {
    const rows = lines.filter((l) => l.qty > 0).map((l) => `${l.itemNumber},${l.qty}`)
    return ['Item Number,Quantity', ...rows].join('\n')
  }

  function formatDate(dateStr) {
    if (!dateStr) return '—'
    try {
      const [y, m, d] = dateStr.split('-').map(Number)
      return new Date(y, m - 1, d).toLocaleDateString('en-AU', {
        weekday: 'short', day: 'numeric', month: 'short',
      })
    } catch {
      return dateStr
    }
  }

  // ─── DOM element finders ──────────────────────────────────────────────────

  function isVisible(el) {
    if (!el) return false
    const style = window.getComputedStyle(el)
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      el.offsetParent !== null
    )
  }

  /**
   * findPasteInput — finds the textarea / text input for the paste-entry method.
   * Tries specific patterns first, falls back to any visible textarea.
   */
  function findPasteInput() {
    const selectors = [
      // Specific patterns for Lactalis Quick Order (guessed from common B2B portals)
      'textarea[id*="quick" i]',
      'textarea[id*="paste" i]',
      'textarea[id*="bulk" i]',
      'textarea[name*="quick" i]',
      'textarea[name*="paste" i]',
      'textarea[name*="order" i]',
      'textarea[placeholder*="paste" i]',
      'textarea[placeholder*="item" i]',
      'textarea[placeholder*="sku" i]',
      'textarea[placeholder*="order" i]',
      '[id*="quickOrderInput" i]',
      '[id*="quick-order-input" i]',
      '[id*="bulkOrder" i]',
      // Generic fallbacks
      'textarea',
      'input[type="text"][id*="order" i]',
      'input[type="text"][name*="order" i]',
    ]

    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel)
        if (el && isVisible(el)) return el
      } catch { /* invalid selector — skip */ }
    }
    return null
  }

  /**
   * findFileInput — finds the CSV file input.
   */
  function findFileInput() {
    const selectors = [
      'input[type="file"][accept*="csv" i]',
      'input[type="file"][accept*="text" i]',
      'input[type="file"][id*="upload" i]',
      'input[type="file"][id*="csv" i]',
      'input[type="file"][name*="upload" i]',
      'input[type="file"][name*="csv" i]',
      'input[type="file"]',
    ]
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel)
        if (el) return el  // file inputs are often hidden by design
      } catch { /* skip */ }
    }
    return null
  }

  /**
   * findVerifyButton — finds the button that submits the paste/upload for preview.
   * Lactalis likely has "Verify Items", "Process", "Add Items", or "Search".
   */
  function findVerifyButton() {
    const TEXT_PATTERNS = [
      /\bverify\b/i, /\bprocess\b/i, /\badd\s+items?\b/i,
      /\bcheck\s+items?\b/i, /\bsearch\b/i, /\bimport\b/i,
      /\bload\b/i, /\bsubmit\b/i,
    ]
    const buttons = [
      ...document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"]'),
    ]

    // Try ID/class selectors first
    for (const el of buttons) {
      const id = (el.id ?? '').toLowerCase()
      const cls = (el.className ?? '').toLowerCase()
      if (
        id.includes('verify') || id.includes('process') || id.includes('add') ||
        cls.includes('verify') || cls.includes('process')
      ) {
        if (isVisible(el)) return el
      }
    }

    // Fall back to text content matching
    for (const el of buttons) {
      const text = (el.innerText ?? el.value ?? '').trim()
      if (text && TEXT_PATTERNS.some((re) => re.test(text)) && isVisible(el)) return el
    }

    return null
  }

  /**
   * findCreateOrderButton — finds the final "Create Order" button to highlight.
   */
  function findCreateOrderButton() {
    const TEXT_PATTERNS = [
      /\bcreate\s+order\b/i, /\bplace\s+order\b/i, /\bsubmit\s+order\b/i,
      /\bconfirm\s+order\b/i, /\bfinalise\b/i, /\bfinalize\b/i,
      /\bcheck\s*out\b/i,
    ]
    const buttons = [...document.querySelectorAll('button, input[type="submit"], a[role="button"]')]
    for (const el of buttons) {
      const text = (el.innerText ?? el.value ?? '').trim()
      if (text && TEXT_PATTERNS.some((re) => re.test(text))) return el
    }
    return null
  }

  // ─── React-compatible value setter ────────────────────────────────────────

  /**
   * setInputValue — sets a value on a form element in a way that React / Vue
   * controlled components will respond to.
   */
  function setInputValue(el, value) {
    // Use the native setter to bypass framework synthetic event tracking
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (nativeSetter) {
      nativeSetter.call(el, value)
    } else {
      el.value = value
    }
    el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }))
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }))
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }))
  }

  // ─── Direct API submit ────────────────────────────────────────────────────

  /**
   * fillViaAPI — posts directly to /customer/product/quick-add/ using the
   * verified OroCommerce payload format. Extracts CSRF token from the form.
   * On success the page redirects to the checkout — user then clicks Submit Order.
   */
  async function fillViaAPI(order) {
    const csrfToken = document.querySelector('input[name="oro_product_quick_add[_token]"]')?.value
    if (!csrfToken) {
      return { ok: false, error: 'CSRF token not found — make sure you are on the Quick Order page.' }
    }

    const products = order.lines
      .filter((l) => l.qty > 0)
      .map((l, index) => ({ sku: l.itemNumber, unit: 'item', quantity: l.qty, index }))

    if (!products.length) return { ok: false, error: 'Order has no items with qty > 0' }

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

      // Success = 302 redirect to checkout page
      if (resp.status === 302 || resp.status === 301) {
        const loc = resp.headers.get('Location')
        if (loc) { window.location.href = loc; return { ok: true } }
      }

      // Some OroCommerce versions return 200 with JSON containing redirectUrl
      if (resp.ok) {
        const text = await resp.text()
        try {
          const json = JSON.parse(text)
          const url = json.redirectUrl || json.url
          if (url) { window.location.href = url; return { ok: true } }
        } catch { /* not JSON, fall through */ }
        return { ok: true }
      }

      return { ok: false, error: `Server returned ${resp.status} — try the Paste method instead` }
    } catch (e) {
      return { ok: false, error: `Network error: ${e.message}` }
    }
  }

  // ─── Fill methods ─────────────────────────────────────────────────────────

  /**
   * fillViaPaste — injects the semicolon-separated paste string into the
   * Quick Order textarea, then clicks the Verify button.
   */
  async function fillViaPaste(order) {
    const input = findPasteInput()
    if (!input) {
      return {
        ok: false,
        error: 'Could not find the paste input field. The portal layout may have changed.',
      }
    }

    const pasteStr = buildPasteString(order.lines)
    if (!pasteStr) return { ok: false, error: 'Order has no items with qty > 0' }
    if (!/^\d+,\d+(?:;\d+,\d+)*$/.test(pasteStr)) {
      return { ok: false, error: 'Order data is malformed — re-send from the PWA.' }
    }

    // Focus the field and set value
    input.focus()
    setInputValue(input, pasteStr)

    setStatus('Paste string entered — looking for Verify button…', 'info')

    // Small delay then click verify (portal may have debounced handlers)
    await delay(400)

    const verifyBtn = findVerifyButton()
    if (verifyBtn) {
      verifyBtn.click()
      setStatus(`Clicked "${(verifyBtn.innerText ?? verifyBtn.value ?? 'Verify').trim()}" — check the portal`, 'success')
    } else {
      setStatus('Paste string entered. Press the Verify / Process button on the page.', 'warn')
    }

    return { ok: true }
  }

  /**
   * fillViaCsvUpload — builds a CSV Blob and sets it on the file input.
   */
  async function fillViaCsvUpload(order) {
    const fileInput = findFileInput()
    if (!fileInput) {
      return {
        ok: false,
        error: 'Could not find a file upload input. Try the Paste method instead.',
      }
    }

    const csvContent = buildCsvString(order.lines)
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const filename = `lactalis-order-${order.date ?? 'export'}.csv`
    const file = new File([blob], filename, { type: 'text/csv' })

    const dt = new DataTransfer()
    dt.items.add(file)

    try {
      fileInput.files = dt.files
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
      fileInput.dispatchEvent(new Event('input',  { bubbles: true }))
    } catch (e) {
      return { ok: false, error: `Could not set file on input: ${e.message}` }
    }

    setStatus(`CSV "${filename}" loaded — confirm the upload in the portal`, 'success')
    return { ok: true }
  }

  // ─── Post-fill: highlight Create Order ───────────────────────────────────

  /**
   * Watches for a "Create Order" button to appear / become enabled,
   * then highlights it and shows a reminder. Never clicks it.
   */
  function watchForCreateOrderButton() {
    function tryHighlight() {
      const btn = findCreateOrderButton()
      if (!btn) return false
      if (btn.dataset.milkManagerHighlighted) return true  // already done

      btn.dataset.milkManagerHighlighted = '1'
      const orig = btn.getAttribute('style') ?? ''
      btn.setAttribute(
        'style',
        orig + '; outline: 3px solid #f59e0b !important; outline-offset: 3px !important; ' +
        'box-shadow: 0 0 0 6px rgba(245,158,11,0.25) !important;',
      )

      showReminder(`⚠️ Review the order above, then click "${(btn.innerText ?? '').trim() || 'Create Order'}"`)
      return true
    }

    if (tryHighlight()) return

    // Watch for it to appear (portal may show it after verification)
    createOrderObserver = new MutationObserver(() => {
      if (tryHighlight()) createOrderObserver?.disconnect()
    })
    createOrderObserver.observe(document.body, { childList: true, subtree: true })

    // Stop watching after 30 seconds regardless
    setTimeout(() => createOrderObserver?.disconnect(), 30_000)
  }

  // ─── Success detection ────────────────────────────────────────────────────

  /**
   * Watch the page for signs that the order was successfully submitted.
   * Looks for an order/purchase number appearing in the DOM.
   */
  function watchForOrderSuccess() {
    const SUCCESS_RE = /(?:order|purchase|confirmation)\s*(?:no|number|#|ref)[:\s]+([A-Z0-9\-]+)/i
    let successDebounce = null

    const observer = new MutationObserver(() => {
      // Debounce: avoid running document.body.innerText on every mutation
      clearTimeout(successDebounce)
      successDebounce = setTimeout(() => {
        const text = document.body.innerText ?? ''
        const m = text.match(SUCCESS_RE)
        if (!m) return

        const orderRef = m[1]
        if (DEBUG) console.log(`[Milk Manager] Order submitted! Reference: ${orderRef}`)

        // Store the submission in chrome.storage for the popup and PWA to read
        chrome.storage.local.get('pendingOrder', (result) => {
          const order = result.pendingOrder
          if (!order) return
          chrome.storage.local.set({
            lastSubmission: {
              orderId: order.orderId,
              lactalisRef: orderRef,
              submittedAt: Date.now(),
            },
          })
          // Clear the pending order now it's been submitted
          chrome.storage.local.remove('pendingOrder')
        })

        showReminder(`Order submitted! Reference: ${orderRef}`, 'success')
        observer.disconnect()
      }, 2000)
    })

    observer.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => observer.disconnect(), 5 * 60_000)  // stop after 5 min
  }

  // ─── Shadow DOM panel ─────────────────────────────────────────────────────

  const host = document.createElement('div')
  host.id = '__milk-manager-host__'
  document.documentElement.appendChild(host)

  const shadow = host.attachShadow({ mode: 'open' })

  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 21px;
      }

      #panel {
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 21px;
        box-shadow: 0 15px 60px rgba(0,0,0,0.20);
        width: 510px;
        overflow: hidden;
        transition: height 0.2s ease;
      }
      #panel.minimised #body { display: none; }

      #header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 18px 24px 17px;
        background: #1d4ed8;
        color: #fff;
        cursor: pointer;
        user-select: none;
      }
      #header-title { font-size: 23px; font-weight: 700; }
      #header-sub   { font-size: 17px; opacity: 0.75; margin-top: 3px; }
      #minimise-btn {
        background: rgba(255,255,255,0.2);
        border: none;
        color: #fff;
        font-size: 24px;
        line-height: 1;
        width: 39px;
        height: 39px;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      #minimise-btn:hover { background: rgba(255,255,255,0.35); }

      #body { padding: 21px 24px 24px; }

      #summary {
        font-size: 21px;
        color: #374151;
        margin-bottom: 12px;
      }
      #summary strong { color: #1d4ed8; }

      #lines-preview {
        max-height: 210px;
        overflow-y: auto;
        border: 1px solid #f3f4f6;
        border-radius: 9px;
        margin-bottom: 15px;
      }
      .line-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 15px;
        border-bottom: 1px solid #f9fafb;
        font-size: 20px;
      }
      .line-row:last-child { border-bottom: none; }
      .line-name { color: #6b7280; }
      .line-qty  { color: #1d4ed8; font-weight: 700; }

      #status-bar {
        font-size: 18px;
        min-height: 27px;
        margin-bottom: 15px;
        border-radius: 8px;
        padding: 0;
        transition: background 0.15s;
      }
      #status-bar.info    { color: #2563eb; }
      #status-bar.success { color: #16a34a; }
      #status-bar.warn    { color: #d97706; }
      #status-bar.error   { color: #dc2626; }

      .btn {
        display: block;
        width: 100%;
        padding: 14px 18px;
        border-radius: 14px;
        border: none;
        font-size: 20px;
        font-weight: 600;
        cursor: pointer;
        text-align: center;
        transition: opacity 0.15s, background 0.15s;
        margin-bottom: 9px;
      }
      .btn:last-child { margin-bottom: 0; }
      .btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .btn-primary { background: #2563eb; color: #fff; }
      .btn-primary:not(:disabled):hover { background: #1d4ed8; }
      .btn-secondary { background: #f3f4f6; color: #374151; }
      .btn-secondary:not(:disabled):hover { background: #e5e7eb; }
      .btn-sm {
        padding: 8px 15px;
        font-size: 18px;
        border-radius: 8px;
        border: 1px solid #e5e7eb;
        background: #fff;
        color: #6b7280;
        cursor: pointer;
        margin-top: 9px;
        width: auto;
        display: inline-block;
      }
      .btn-sm:hover { background: #f9fafb; color: #374151; }

      #reminder {
        display: none;
        margin-top: 15px;
        padding: 14px 17px;
        background: #fffbeb;
        border: 1px solid #fcd34d;
        border-radius: 11px;
        font-size: 18px;
        color: #92400e;
        font-weight: 500;
        line-height: 1.4;
      }
      #reminder.success {
        background: #f0fdf4;
        border-color: #86efac;
        color: #166534;
      }
    </style>

    <div id="panel">
      <div id="header">
        <div>
          <div id="header-title">🥛 Milk Manager</div>
          <div id="header-sub">Quick Order</div>
        </div>
        <button id="minimise-btn" title="Minimise">—</button>
      </div>

      <div id="body">
        <div id="summary">Loading order…</div>
        <div id="lines-preview"></div>
        <div id="status-bar"></div>
        <button class="btn btn-primary" id="fill-api-btn" disabled>
          🚀 Submit to Checkout
        </button>
        <button class="btn btn-secondary" id="fill-paste-btn" disabled>
          ↑ Fill via Paste
        </button>
        <button class="btn btn-secondary" id="fill-csv-btn" disabled>
          ↑ Fill via CSV Upload
        </button>
        <div id="reminder"></div>
        <button class="btn-sm" id="dismiss-btn">✕ Dismiss</button>
      </div>
    </div>`

  // ─── Panel helpers ─────────────────────────────────────────────────────────

  function setStatus(msg, type = 'info') {
    const bar = shadow.getElementById('status-bar')
    bar.textContent = msg
    bar.className = type
  }

  function showReminder(msg, type = '') {
    const r = shadow.getElementById('reminder')
    r.textContent = msg
    r.style.display = 'block'
    r.className = type
  }

  function renderOrder(order) {
    if (!order || !order.lines?.length) {
      shadow.getElementById('summary').innerHTML = '<span style="color:#9ca3af">No pending order found</span>'
      shadow.getElementById('lines-preview').innerHTML = ''
      return
    }

    const activeLines = order.lines.filter((l) => l.qty > 0)
    const dateStr = order.date ? `for ${formatDate(order.date)}` : ''

    // Use DOM API instead of innerHTML to avoid XSS if order data is malformed
    const summaryEl = shadow.getElementById('summary')
    summaryEl.textContent = ''
    const strong = document.createElement('strong')
    strong.textContent = `${activeLines.length} items`
    summaryEl.appendChild(strong)
    summaryEl.appendChild(document.createTextNode(` queued ${dateStr}`))

    const previewEl = shadow.getElementById('lines-preview')
    previewEl.textContent = ''
    for (const l of activeLines) {
      const row = document.createElement('div')
      row.className = 'line-row'
      const nameSpan = document.createElement('span')
      nameSpan.className = 'line-name'
      nameSpan.textContent = `#${l.itemNumber}`
      const qtySpan = document.createElement('span')
      qtySpan.className = 'line-qty'
      qtySpan.textContent = `×${l.qty}`
      row.appendChild(nameSpan)
      row.appendChild(qtySpan)
      previewEl.appendChild(row)
    }

    shadow.getElementById('fill-api-btn').disabled = false
    shadow.getElementById('fill-paste-btn').disabled = false
    shadow.getElementById('fill-csv-btn').disabled = false
    setStatus('Ready — Submit to Checkout sends all items directly', 'info')
  }

  // ─── Event listeners ───────────────────────────────────────────────────────

  // Minimise toggle
  shadow.getElementById('header').addEventListener('click', (e) => {
    if (e.target.id === 'minimise-btn' || e.target.closest('#minimise-btn')) {
      shadow.getElementById('panel').classList.toggle('minimised')
      shadow.getElementById('minimise-btn').textContent =
        shadow.getElementById('panel').classList.contains('minimised') ? '▲' : '—'
    }
  })

  // Dismiss
  shadow.getElementById('dismiss-btn').addEventListener('click', () => {
    createOrderObserver?.disconnect()  // stop watching if panel is dismissed early
    host.remove()
  })

  // Submit via API (primary method)
  shadow.getElementById('fill-api-btn').addEventListener('click', async () => {
    if (!currentOrder) return
    shadow.getElementById('fill-api-btn').disabled = true
    shadow.getElementById('fill-paste-btn').disabled = true
    shadow.getElementById('fill-csv-btn').disabled = true
    setStatus('Submitting to checkout…', 'info')
    panelState = 'filling'

    const result = await fillViaAPI(currentOrder)

    if (!result.ok) {
      setStatus(result.error, 'error')
      panelState = 'error'
      shadow.getElementById('fill-api-btn').disabled = false
      shadow.getElementById('fill-paste-btn').disabled = false
      shadow.getElementById('fill-csv-btn').disabled = false
    } else {
      setStatus('Redirecting to checkout…', 'success')
      panelState = 'filled'
    }
  })

  // Fill via Paste
  shadow.getElementById('fill-paste-btn').addEventListener('click', async () => {
    if (!currentOrder) return
    shadow.getElementById('fill-paste-btn').disabled = true
    shadow.getElementById('fill-csv-btn').disabled = true
    setStatus('Filling…', 'info')
    panelState = 'filling'

    const result = await fillViaPaste(currentOrder)

    if (!result.ok) {
      setStatus(result.error, 'error')
      panelState = 'error'
      shadow.getElementById('fill-paste-btn').disabled = false
      shadow.getElementById('fill-csv-btn').disabled = false
    } else {
      panelState = 'filled'
      watchForCreateOrderButton()
      watchForOrderSuccess()
    }
  })

  // Fill via CSV Upload
  shadow.getElementById('fill-csv-btn').addEventListener('click', async () => {
    if (!currentOrder) return
    shadow.getElementById('fill-paste-btn').disabled = true
    shadow.getElementById('fill-csv-btn').disabled = true
    setStatus('Uploading CSV…', 'info')
    panelState = 'filling'

    const result = await fillViaCsvUpload(currentOrder)

    if (!result.ok) {
      setStatus(result.error, 'error')
      panelState = 'error'
      shadow.getElementById('fill-paste-btn').disabled = false
      shadow.getElementById('fill-csv-btn').disabled = false
    } else {
      panelState = 'filled'
      watchForCreateOrderButton()
      watchForOrderSuccess()
    }
  })

  // ─── Message listener (FILL_ORDER from popup) ─────────────────────────────

  /** Auto-submit a cloud-relayed order (fillViaAPI → fillViaPaste fallback) */
  async function autoSubmitCloudOrder(order) {
    // Clear autoSubmit flag immediately to prevent re-triggering
    chrome.storage.local.set({
      pendingOrder: { ...order, autoSubmit: false },
    })

    setStatus('Auto-submitting cloud order…', 'info')
    panelState = 'filling'

    // Wait for page to fully load (CSRF token, etc.)
    await delay(2000)

    const apiResult = await fillViaAPI(order)
    if (apiResult.ok) {
      setStatus('Cloud order submitted to checkout!', 'success')
      panelState = 'filled'
      chrome.runtime.sendMessage({ type: 'CLOUD_ORDER_SUBMITTED', success: true })
      watchForOrderSuccess()
      return
    }

    // Fallback: try paste method
    const pasteResult = await fillViaPaste(order)
    if (pasteResult.ok) {
      setStatus('Cloud order filled via paste — click Create Order', 'success')
      panelState = 'filled'
      chrome.runtime.sendMessage({ type: 'CLOUD_ORDER_SUBMITTED', success: true })
      watchForCreateOrderButton()
      watchForOrderSuccess()
      return
    }

    setStatus(`Auto-submit failed: ${apiResult.error}`, 'error')
    panelState = 'error'
    chrome.runtime.sendMessage({
      type: 'CLOUD_ORDER_SUBMITTED',
      success: false,
      error: apiResult.error,
    })
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'FILL_ORDER') {
      currentOrder = msg.order
      renderOrder(currentOrder)
      shadow.getElementById('panel').classList.remove('minimised')
      shadow.getElementById('minimise-btn').textContent = '—'
      sendResponse({ ok: true })

      // Auto-submit cloud orders
      if (msg.order?.autoSubmit && msg.order?.cloudOrder) {
        autoSubmitCloudOrder(msg.order)
      }
    }
    if (msg.type === 'GET_PAGE_INFO') {
      // Lets popup query whether CSRF token is available on this page
      const hasCsrf = !!document.querySelector('input[name="oro_product_quick_add[_token]"]')
      sendResponse({ pageType: window.__milkManagerPageType__, hasCsrf })
    }
  })

  // ─── Utility ───────────────────────────────────────────────────────────────

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // ─── Initialise ────────────────────────────────────────────────────────────

  chrome.storage.local.get('pendingOrder', (result) => {
    currentOrder = result.pendingOrder ?? null
    renderOrder(currentOrder)

    // Auto-submit cloud orders on page load
    if (currentOrder?.autoSubmit && currentOrder?.cloudOrder) {
      autoSubmitCloudOrder(currentOrder)
    }
  })

  // Keep current order in sync if updated while page is open
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.pendingOrder) {
      currentOrder = changes.pendingOrder.newValue ?? null
      if (panelState === 'idle') renderOrder(currentOrder)
    }
  })

  console.log('[Milk Manager] Quick Order panel injected')
})()
