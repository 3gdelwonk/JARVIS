/**
 * popup.js — IGA Milk Manager extension popup
 *
 * chrome.storage.local keys consumed:
 *   pendingOrder   { orderId, date, approvedAt, lines: [{itemNumber, qty}] }
 *   schedule       { nextDelivery, upcomingDeliveries, scrapedAt, source }
 *   lactalisTab    { tabId, pageType, url, detectedAt }
 *
 * Actions:
 *   Fill Quick Order  → sends FILL_ORDER to Lactalis content script (Session 13)
 *   Clear             → removes pendingOrder
 *   Refresh           → sends SCRAPE_SCHEDULE to Lactalis content script
 */

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const statusDot      = document.getElementById('status-dot')
const statusText     = document.getElementById('status-text')
const deliveryContent = document.getElementById('delivery-content')
const orderContent   = document.getElementById('order-content')
const fillBtn        = document.getElementById('fill-btn')
const clearBtn       = document.getElementById('clear-btn')
const refreshBtn     = document.getElementById('refresh-btn')
const toast          = document.getElementById('toast')

// ─── Toast helper ─────────────────────────────────────────────────────────────

let toastTimer = null
function showToast(msg) {
  toast.textContent = msg
  toast.classList.add('show')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2400)
}

// ─── Date / time helpers ──────────────────────────────────────────────────────

function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatDate(dateStr) {
  if (!dateStr) return '—'
  try {
    const d = parseLocalDate(dateStr)
    return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })
  } catch {
    return dateStr
  }
}

function formatDateShort(dateStr) {
  if (!dateStr) return '—'
  try {
    const d = parseLocalDate(dateStr)
    return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })
  } catch {
    return dateStr
  }
}

/** Returns minutes until a cutoff datetime, or null if unparseable. */
function minutesUntilCutoff(cutoffDate, cutoffTime) {
  if (!cutoffDate || !cutoffTime) return null
  const dt = new Date(`${cutoffDate}T${cutoffTime}:00`)
  if (isNaN(dt.getTime())) return null
  return Math.round((dt.getTime() - Date.now()) / 60_000)
}

function formatCountdown(minutes) {
  if (minutes === null) return null
  if (minutes <= 0)  return { label: 'Cutoff passed', cls: 'passed' }
  if (minutes < 60)  return { label: `${minutes}m to cutoff`, cls: 'urgent' }
  const h = Math.floor(minutes / 60)
  if (h <= 4)        return { label: `${h}h to cutoff`, cls: 'urgent' }
  if (h <= 24)       return { label: `${h}h to cutoff`, cls: '' }
  const d = Math.floor(h / 24)
  return { label: `${d}d ${h % 24}h to cutoff`, cls: 'ok' }
}

function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.floor(mins / 60)
  if (h < 24)    return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ─── Render: connection status ────────────────────────────────────────────────

function renderStatus(lactalisTab) {
  // A tab detection older than 60s is considered stale (tab may have closed)
  const stale = lactalisTab && (Date.now() - lactalisTab.detectedAt) > 60_000
  const connected = lactalisTab && !stale

  if (connected) {
    statusDot.classList.add('connected')
    const labels = {
      quick_order:       'Quick Order page',
      manage_deliveries: 'Deliveries page',
      login:             'Login page',
      other:             'portal',
    }
    statusText.textContent = `Connected — ${labels[lactalisTab.pageType] ?? 'Lactalis'}`
    refreshBtn.disabled = false
  } else {
    statusDot.classList.remove('connected')
    statusText.textContent = 'Lactalis not open'
    refreshBtn.disabled = true
  }

  return connected
}

// ─── Render: delivery schedule ────────────────────────────────────────────────

function renderDelivery(schedule) {
  if (!schedule || !schedule.nextDelivery) {
    deliveryContent.innerHTML = `
      <div class="delivery-date" style="color:#9ca3af">—</div>
      <div class="delivery-sub">Open the Lactalis portal to scrape schedule</div>`
    return
  }

  const next = schedule.nextDelivery
  const mins = minutesUntilCutoff(next.orderCutoffDate, next.orderCutoffTime)
  const countdown = formatCountdown(mins)

  let html = `
    <div class="delivery-date">${formatDate(next.deliveryDate)}</div>
    <div class="delivery-sub">
      Cutoff: ${formatDate(next.orderCutoffDate)}
      ${next.orderCutoffTime ? ` at ${next.orderCutoffTime}` : ''}
    </div>`

  if (countdown) {
    html += `<div class="cutoff-badge ${countdown.cls}">${countdown.label}</div>`
  }

  // Upcoming deliveries (skip the one already shown as "next")
  const upcoming = (schedule.upcomingDeliveries ?? []).slice(1, 4)
  if (upcoming.length > 0) {
    html += `<div class="upcoming-list">`
    for (const slot of upcoming) {
      const slotMins = minutesUntilCutoff(slot.orderCutoffDate, slot.orderCutoffTime)
      const slotCount = formatCountdown(slotMins)
      html += `
        <div class="upcoming-item">
          <span class="upcoming-item-date">${formatDateShort(slot.deliveryDate)}</span>
          <span class="upcoming-item-cutoff">${slotCount?.label ?? `cutoff ${formatDateShort(slot.orderCutoffDate)}`}</span>
        </div>`
    }
    html += `</div>`
  }

  if (schedule.scrapedAt) {
    html += `<div class="scraped-at">Scraped ${timeAgo(schedule.scrapedAt)} via ${schedule.source ?? '?'}</div>`
  }

  deliveryContent.innerHTML = html
}

// ─── Render: pending order ────────────────────────────────────────────────────

function renderOrder(order) {
  if (!order || !Array.isArray(order.lines) || order.lines.length === 0) {
    orderContent.innerHTML = `<div class="order-empty">No order queued — approve one in the PWA</div>`
    fillBtn.disabled = true
    clearBtn.disabled = true
    return
  }

  const activeLines = order.lines.filter((l) => l.qty > 0)
  const dateLabel = order.date ? formatDate(order.date) : '—'
  const approvedLabel = order.approvedAt
    ? new Date(order.approvedAt).toLocaleString('en-AU', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    : null

  orderContent.innerHTML = `
    <div class="order-summary">
      <div class="order-count">${activeLines.length}</div>
      <div>
        <div class="order-meta">items for <span class="order-date">${dateLabel}</span></div>
        ${approvedLabel ? `<div class="order-meta">approved ${approvedLabel}</div>` : ''}
      </div>
    </div>
    <div class="order-lines">
      ${activeLines.map((l) => `
        <div class="order-line">
          <span class="order-line-name">#${l.itemNumber}</span>
          <span class="order-line-qty">×${l.qty}</span>
        </div>`).join('')}
    </div>`

  fillBtn.disabled = false
  clearBtn.disabled = false
  fillBtn.textContent = `↑ Fill Quick Order (${activeLines.length} items)`
}

// ─── Button: Fill Quick Order ─────────────────────────────────────────────────

fillBtn.addEventListener('click', async () => {
  const storage = await chrome.storage.local.get(['lactalisTab', 'pendingOrder'])
  const tab = storage.lactalisTab
  const order = storage.pendingOrder

  if (!tab || tab.pageType !== 'quick_order') {
    showToast('Open the Lactalis Quick Order page first')
    return
  }
  if (!order || !order.lines?.length) {
    showToast('No pending order to fill')
    return
  }

  try {
    await chrome.tabs.sendMessage(tab.tabId, { type: 'FILL_ORDER', order })
    showToast('Fill command sent!')
  } catch {
    showToast('Could not reach the Lactalis tab — reload the page')
  }
})

// ─── Button: Clear ───────────────────────────────────────────────────────────

clearBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove('pendingOrder')
  renderOrder(null)
  // Update badge via background
  chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_ORDER' })
  showToast('Order cleared')
})

// ─── Button: Refresh schedule ─────────────────────────────────────────────────

refreshBtn.addEventListener('click', async () => {
  const storage = await chrome.storage.local.get('lactalisTab')
  const tab = storage.lactalisTab
  if (!tab) {
    showToast('Open Lactalis first, then refresh')
    return
  }

  refreshBtn.disabled = true
  refreshBtn.textContent = '↻ Scanning…'

  try {
    const response = await chrome.tabs.sendMessage(tab.tabId, { type: 'SCRAPE_SCHEDULE' })
    showToast(response?.found ? 'Schedule updated!' : 'No schedule found on this page')
  } catch {
    showToast('Could not reach the Lactalis tab — reload the portal page')
  } finally {
    refreshBtn.disabled = false
    refreshBtn.textContent = '↻ Refresh'
  }
})

// ─── Manual paste load (orders approved on iPhone) ───────────────────────────

const pasteToggle  = document.getElementById('paste-toggle')
const pasteBody    = document.getElementById('paste-body')
const pasteInput   = document.getElementById('paste-input')
const pasteLoadBtn = document.getElementById('paste-load-btn')

pasteToggle.addEventListener('click', () => {
  const open = pasteBody.style.display !== 'none'
  pasteBody.style.display = open ? 'none' : 'block'
  pasteToggle.textContent = open ? '▼ Paste order' : '▲ Hide'
})

pasteLoadBtn.addEventListener('click', () => {
  const raw = pasteInput.value.trim()
  if (!raw) { showToast('Paste a string first'); return }

  // Format: "19100,18;40248,10;801,3" (semicolon-separated item,qty pairs)
  const PASTE_RE = /^(\d+,\d+)(;\d+,\d+)*$/
  if (!PASTE_RE.test(raw)) {
    showToast('Invalid format — expected: 19100,18;40248,10')
    return
  }

  const lines = raw.split(';').map((pair) => {
    const [itemNumber, qty] = pair.split(',')
    return { itemNumber, qty: parseInt(qty, 10) }
  })

  const order = {
    orderId: null,
    date: null,
    approvedAt: new Date().toISOString(),
    lines,
  }

  chrome.storage.local.set({ pendingOrder: order }, () => {
    chrome.runtime.sendMessage({ type: 'PWA_ORDER_SYNC', payload: order })
    pasteInput.value = ''
    pasteBody.style.display = 'none'
    pasteToggle.textContent = '▼ Paste order'
    showToast(`Loaded ${lines.length} items`)
  })
})

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const storage = await chrome.storage.local.get(['pendingOrder', 'schedule', 'lactalisTab'])
  renderStatus(storage.lactalisTab)
  renderDelivery(storage.schedule)
  renderOrder(storage.pendingOrder)
}

init()

// Re-render live while popup is open
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') init()
})
