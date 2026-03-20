/**
 * fill-order.js — One-tap bookmarklet to auto-fill a pending order on the
 * Lactalis Quick Order page.
 *
 * Usage (bookmarklet):
 *   javascript:void(function(){var s=document.createElement('script');
 *   s.src='https://3gdelwonk.github.io/JARVIS/fill-order.js#'
 *   +encodeURIComponent(JSON.stringify({w:'WORKER_URL',k:'SECRET'}));
 *   document.head.appendChild(s)})()
 *
 * What it does:
 *   1. Fetches pending order from Worker
 *   2. Fills the Quick Order paste textarea
 *   3. Clicks Verify
 *   4. Reports result to Worker
 */
;(function () {
  'use strict'

  // ─── Config extraction ──────────────────────────────────────────────────────

  let CONFIG = null
  if (window.__FILL_ORDER_CONFIG__) {
    CONFIG = window.__FILL_ORDER_CONFIG__
  }
  if (!CONFIG) {
    try {
      const current = document.currentScript
      if (current?.src) {
        const hash = new URL(current.src).hash.slice(1)
        if (hash) CONFIG = JSON.parse(decodeURIComponent(hash))
      }
    } catch { /* ignore */ }
  }
  if (!CONFIG) {
    try {
      const scripts = document.querySelectorAll('script[src*="fill-order"]')
      for (const s of scripts) {
        const hash = new URL(s.src).hash.slice(1)
        if (hash) { CONFIG = JSON.parse(decodeURIComponent(hash)); break }
      }
    } catch { /* ignore */ }
  }

  if (!CONFIG || !CONFIG.w || !CONFIG.k) {
    showToast('Fill Order: config not found — re-copy bookmarklet from Settings.', 'error')
    return
  }

  const WORKER_URL = CONFIG.w.replace(/\/+$/, '')
  const SECRET = CONFIG.k

  // ─── Toast helper ─────────────────────────────────────────────────────────

  function showToast(msg, type) {
    const existing = document.getElementById('__milk-fill-toast__')
    if (existing) existing.remove()

    const el = document.createElement('div')
    el.id = '__milk-fill-toast__'
    const bg = type === 'error' ? '#dc2626' : type === 'success' ? '#16a34a' : '#2563eb'
    el.style.cssText = `position:fixed;top:16px;left:50%;transform:translateX(-50%);
      background:${bg};color:#fff;padding:12px 20px;border-radius:10px;font-size:14px;
      font-family:system-ui,sans-serif;font-weight:600;z-index:2147483647;
      box-shadow:0 4px 20px rgba(0,0,0,0.25);max-width:90vw;text-align:center;`
    el.textContent = msg
    document.body.appendChild(el)
    if (type !== 'error') setTimeout(() => el.remove(), 8000)
  }

  // ─── Worker fetch ─────────────────────────────────────────────────────────

  async function workerFetch(path, options = {}) {
    const res = await fetch(WORKER_URL + path, {
      ...options,
      headers: {
        'Authorization': `Bearer ${SECRET}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    })
    if (!res.ok) return null
    return res.json()
  }

  // ─── Quick Order page detection ───────────────────────────────────────────

  const isQuickOrderPage = !!document.querySelector('input[name="oro_product_quick_add[_token]"]')

  if (!isQuickOrderPage) {
    // Redirect to Quick Order page with auto-fill param
    showToast('Redirecting to Quick Order page…', 'info')
    setTimeout(() => {
      window.location.href = '/customer/product/quick-add/?milkAutoFill=1'
    }, 500)
    return
  }

  // ─── Check URL param for auto-fill after redirect ─────────────────────────

  // If we're here from a redirect, the script was injected via bookmarklet before
  // the redirect. The new page load won't have the bookmarklet — so we use
  // a localStorage flag to resume.
  const RESUME_KEY = '__milk-fill-order-resume__'
  const params = new URLSearchParams(window.location.search)

  if (params.has('milkAutoFill')) {
    // Clean up URL param
    const clean = new URL(window.location.href)
    clean.searchParams.delete('milkAutoFill')
    history.replaceState(null, '', clean.toString())
  }

  // ─── Main: fetch and fill ─────────────────────────────────────────────────

  async function run() {
    showToast('Fetching pending order…', 'info')

    const result = await workerFetch('/extension/pending-order')
    if (!result?.order || !result.order.lines?.length) {
      showToast('No pending order found — submit one from the Milk Manager app first.', 'error')
      return
    }

    const order = result.order
    const lines = order.lines.filter(l => l.qty > 0)
    if (!lines.length) {
      showToast('Order has no items with qty > 0.', 'error')
      return
    }

    // Build paste string: itemNumber,qty;itemNumber,qty
    const pasteStr = lines.map(l => `${l.itemNumber},${l.qty}`).join(';')

    // Find the paste textarea
    const textarea = findPasteInput()
    if (!textarea) {
      showToast('Could not find the paste input on this page.', 'error')
      return
    }

    // Fill it
    textarea.focus()
    setInputValue(textarea, pasteStr)

    showToast(`Filled ${lines.length} items — looking for Verify button…`, 'info')
    await delay(500)

    // Click Verify
    const verifyBtn = findVerifyButton()
    if (verifyBtn) {
      verifyBtn.click()
      showToast(`${lines.length} items filled & verified — review then click Create Order`, 'success')
    } else {
      showToast(`${lines.length} items filled — click Verify/Process, then Create Order`, 'success')
    }

    // Report success to Worker
    await workerFetch('/extension/order-result', {
      method: 'POST',
      body: JSON.stringify({
        orderId: order.orderId,
        success: true,
        lactalisRef: null,
      }),
    })
  }

  // ─── DOM helpers (same patterns as quickOrder.js) ─────────────────────────

  function findPasteInput() {
    // Look for textarea or input matching Quick Order paste patterns
    const selectors = [
      'textarea[name*="quick"]', 'textarea[name*="paste"]', 'textarea[name*="order"]',
      'textarea[id*="quick"]', 'textarea[id*="paste"]', 'textarea[id*="order"]',
      'textarea[placeholder*="paste"]', 'textarea[placeholder*="order"]',
      'textarea[placeholder*="item"]', 'textarea[placeholder*="sku"]',
    ]
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      if (el) return el
    }
    // Fallback: first visible textarea
    for (const ta of document.querySelectorAll('textarea')) {
      if (ta.offsetParent !== null) return ta
    }
    return null
  }

  function findVerifyButton() {
    const labels = /verify|process|add items|check items|search|import|load|submit/i
    for (const btn of document.querySelectorAll('button, input[type="submit"], input[type="button"]')) {
      const text = (btn.innerText || btn.value || '').trim()
      if (labels.test(text)) return btn
    }
    return null
  }

  // NOTE: Intentionally duplicated — content scripts cannot share JS modules.
  // Mirror any changes to: quickOrder.js, autoLogin.js, public/fill-order.js
  function setInputValue(el, value) {
    const nativeSet = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement?.prototype || window.HTMLInputElement?.prototype,
      'value'
    )?.set
    if (nativeSet) {
      nativeSet.call(el, value)
    } else {
      el.value = value
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }))
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  // ─── Run ──────────────────────────────────────────────────────────────────

  run().catch(err => {
    showToast(`Error: ${err.message}`, 'error')
  })
})()
