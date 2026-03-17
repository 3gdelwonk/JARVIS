/**
 * background.js — MV3 service worker for IGA Milk Manager extension
 *
 * Responsibilities:
 *  1. Receive order data relayed from the PWA (via pwa-bridge.js content script)
 *  2. Persist pending order in chrome.storage.local
 *  3. Update action badge to show pending item count
 *  4. Receive schedule data scraped from Lactalis (Session 12)
 *  5. Relay fill commands to the Lactalis content script (Session 13)
 *  6. Cloud sync via Cloudflare Worker KV (push schedule, poll orders, push cookies)
 */

// ─── Cloud sync helpers ──────────────────────────────────────────────────────

async function getCloudConfig() {
  const r = await chrome.storage.local.get(['workerUrl', 'extensionSecret'])
  if (r.workerUrl && r.extensionSecret) return r
  return null
}

async function cloudFetch(path, options = {}) {
  const config = await getCloudConfig()
  if (!config) return null

  const url = config.workerUrl.replace(/\/+$/, '') + path
  const headers = {
    'Authorization': `Bearer ${config.extensionSecret}`,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  }

  try {
    const res = await fetch(url, { ...options, headers })
    if (!res.ok) {
      console.warn(`[Cloud] ${path} returned ${res.status}`)
      return null
    }
    return res.json()
  } catch (err) {
    console.warn(`[Cloud] ${path} failed:`, err.message)
    return null
  }
}

// ─── Cloud: push schedule to KV ──────────────────────────────────────────────

async function cloudPushSchedule(scheduleData) {
  const config = await getCloudConfig()
  if (!config) return
  await cloudFetch('/extension/schedule', {
    method: 'POST',
    body: JSON.stringify(scheduleData),
  })
}

// ─── Cloud: poll for pending orders ──────────────────────────────────────────

async function cloudPollPendingOrders() {
  const config = await getCloudConfig()
  if (!config) return

  const result = await cloudFetch('/extension/pending-order')
  if (!result?.order || result.order.status !== 'pending') return

  const order = result.order
  // Convert to the format expected by quickOrder.js
  const pendingOrder = {
    orderId: order.orderId,
    date: null,
    approvedAt: new Date(order.queuedAt).toISOString(),
    lines: order.lines,
    cloudOrder: true, // Flag so we know to push result back
  }

  // Store as pending order and try to fill
  chrome.storage.local.set({ pendingOrder }, () => {
    updateBadge(pendingOrder)

    // Try to send to an existing Lactalis tab
    chrome.storage.local.get('lactalisTab', (r) => {
      const quickOrderUrl = 'https://my.lactalis.com.au/customer/product/quick-add/'
      if (r.lactalisTab?.tabId && r.lactalisTab.pageType === 'quick_order') {
        chrome.tabs.sendMessage(
          r.lactalisTab.tabId,
          { type: 'FILL_ORDER', order: pendingOrder },
          () => {
            if (chrome.runtime.lastError) {
              chrome.tabs.create({ url: quickOrderUrl })
            }
          }
        )
      } else {
        chrome.tabs.create({ url: quickOrderUrl })
      }
    })
  })
}

// ─── Cloud: push order result to KV ─────────────────────────────────────────

async function cloudPushOrderResult(submission) {
  const config = await getCloudConfig()
  if (!config) return

  // Check if this was a cloud order
  const storage = await chrome.storage.local.get('pendingOrder')
  if (!storage.pendingOrder?.cloudOrder) return

  await cloudFetch('/extension/order-result', {
    method: 'POST',
    body: JSON.stringify({
      orderId: storage.pendingOrder.orderId,
      success: !!submission.lactalisRef,
      lactalisRef: submission.lactalisRef || null,
    }),
  })
}

// ─── Cloud: push order history to KV ─────────────────────────────────────

async function cloudPushOrderHistory(orderHistory) {
  await cloudFetch('/extension/order-history', {
    method: 'POST',
    body: JSON.stringify(orderHistory),
  })
}

// ─── Cloud: push cookies to KV ───────────────────────────────────────────────

async function cloudPushCookies() {
  const config = await getCloudConfig()
  if (!config) return

  try {
    const cookies = await chrome.cookies.getAll({ domain: 'mylactalis.com.au' })
    if (cookies.length === 0) return
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    await cloudFetch('/extension/cookies', {
      method: 'POST',
      body: JSON.stringify({ cookies: cookieStr }),
    })
  } catch (err) {
    console.warn('[Cloud] Cookie push failed:', err.message)
  }
}

// ─── Alarms: safety net ──────────────────────────────────────────────────────

// Clear any stale alarms from prior versions on service worker startup
chrome.alarms.clearAll()

chrome.alarms.onAlarm.addListener(() => {
  // No-op safety net — no alarms are currently used
})

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    // PWA bridge relays localStorage order → chrome.storage.local
    case 'PWA_ORDER_SYNC':
      chrome.storage.local.set({ pendingOrder: msg.payload }, () => {
        updateBadge(msg.payload)
        sendResponse({ ok: true })
      })
      return true  // keep message channel open for async response

    // Content script clears order after successful submission
    case 'CLEAR_PENDING_ORDER':
      chrome.storage.local.remove('pendingOrder', () => {
        chrome.action.setBadgeText({ text: '' })
        sendResponse({ ok: true })
      })
      return true

    // Popup asks for current order
    case 'GET_PENDING_ORDER':
      chrome.storage.local.get('pendingOrder', (result) => {
        sendResponse({ order: result.pendingOrder ?? null })
      })
      return true

    // Content script reports which Lactalis page is active
    case 'LACTALIS_PAGE_DETECTED':
      chrome.storage.local.set({
        lactalisTab: {
          tabId: _sender.tab?.id,
          pageType: msg.pageType,
          url: msg.url,
          detectedAt: Date.now(),
        },
      })
      // Cloud: push cookies when we detect a Lactalis page
      cloudPushCookies()
      sendResponse({ ok: true })
      return true

    // Order history scraped from portal
    case 'ORDER_HISTORY_UPDATE':
      chrome.storage.local.set({ orderHistory: msg.payload }, () => {
        cloudPushOrderHistory(msg.payload)
        sendResponse({ ok: true })
      })
      return true

    // Schedule data scraped from portal (Session 12)
    case 'SCHEDULE_UPDATE':
      chrome.storage.local.set({ schedule: msg.payload }, () => {
        // Cloud: also push schedule to Worker KV
        cloudPushSchedule(msg.payload)
        sendResponse({ ok: true })
      })
      return true

    // PWA requests a live schedule re-scrape
    case 'TRIGGER_SCHEDULE_REFRESH':
      chrome.storage.local.get('lactalisTab', (result) => {
        if (result.lactalisTab?.tabId) {
          chrome.tabs.sendMessage(result.lactalisTab.tabId, { type: 'SCRAPE_SCHEDULE' }, () => {
            if (chrome.runtime.lastError) {
              // Tab gone — open portal so scheduleScraper auto-runs on load
              chrome.tabs.create({ url: 'https://my.lactalis.com.au/customer/product/quick-add/' })
            }
          })
        } else {
          chrome.tabs.create({ url: 'https://my.lactalis.com.au/customer/product/quick-add/' })
        }
        sendResponse({ ok: true })
      })
      return true

    // PWA requests auto-submission of the pending order to Lactalis
    case 'TRIGGER_ORDER_SUBMIT':
      chrome.storage.local.get(['pendingOrder', 'lactalisTab'], (result) => {
        const quickOrderUrl = 'https://my.lactalis.com.au/customer/product/quick-add/'
        if (result.lactalisTab?.tabId && result.lactalisTab.pageType === 'quick_order') {
          chrome.tabs.sendMessage(
            result.lactalisTab.tabId,
            { type: 'FILL_ORDER', order: result.pendingOrder },
            () => {
              if (chrome.runtime.lastError) {
                chrome.tabs.create({ url: quickOrderUrl })
              }
            }
          )
        } else {
          // quickOrder.js auto-detects pendingOrder on page load
          chrome.tabs.create({ url: quickOrderUrl })
        }
        sendResponse({ ok: true })
      })
      return true

    // PWA requests a live order history re-scrape
    case 'TRIGGER_ORDER_HISTORY_REFRESH':
      chrome.storage.local.get('lactalisTab', (result) => {
        if (result.lactalisTab?.tabId) {
          chrome.tabs.sendMessage(result.lactalisTab.tabId, { type: 'SCRAPE_ORDER_HISTORY' }, () => {
            if (chrome.runtime.lastError) {
              // Tab gone — open portal so orderHistoryScraper auto-runs on load
              chrome.tabs.create({ url: 'https://my.lactalis.com.au/customer/order/' })
            }
          })
        } else {
          chrome.tabs.create({ url: 'https://my.lactalis.com.au/customer/order/' })
        }
        sendResponse({ ok: true })
      })
      return true

    default:
      sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` })
  }
})

// ─── Badge helpers ────────────────────────────────────────────────────────────

function updateBadge(order) {
  if (!order || !Array.isArray(order.lines) || order.lines.length === 0) {
    chrome.action.setBadgeText({ text: '' })
    return
  }
  const count = order.lines.filter((l) => l.qty > 0).length
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) })
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' })
  } else {
    chrome.action.setBadgeText({ text: '' })
  }
}

// Re-apply badge on service worker restart (storage persists, badge does not)
chrome.storage.local.get('pendingOrder', (result) => {
  updateBadge(result.pendingOrder ?? null)
})

// ─── Tab listener — clear stale lactalisTab when tab closes ──────────────────

chrome.tabs.onRemoved.addListener((_tabId) => {
  chrome.storage.local.get('lactalisTab', (result) => {
    if (result.lactalisTab?.tabId === _tabId) {
      chrome.storage.local.remove('lactalisTab')
    }
  })
})

// ─── Submission watcher — relay lastSubmission → statusUpdates for PWA ───────
//
// quickOrder.js sets { lastSubmission: { orderId, lactalisRef, submittedAt } }
// when it detects a successful order reference on the portal page.
// We append it to the statusUpdates array so pwa-bridge.js can mirror it to
// the PWA's localStorage for extensionSync.ts to apply.

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (!changes.lastSubmission?.newValue) return

  const submission = changes.lastSubmission.newValue

  // Cloud: push order result to Worker KV
  cloudPushOrderResult(submission)

  chrome.storage.local.get('statusUpdates', (result) => {
    const existing = Array.isArray(result.statusUpdates) ? result.statusUpdates : []
    // Avoid duplicates: skip if an entry for this orderId already exists
    const alreadyQueued = existing.some((u) => u.orderId === submission.orderId)
    if (!alreadyQueued) {
      // Clear lastSubmission in the same write to prevent the onChanged listener
      // from refiring and double-queuing the same submission (atomic read-modify-write)
      chrome.storage.local.set({
        statusUpdates: [...existing, submission],
        lastSubmission: null,
      })
    }
  })
})
