/**
 * background.js — MV3 service worker for IGA Milk Manager extension
 *
 * Responsibilities:
 *  1. Receive order data relayed from the PWA (via pwa-bridge.js content script)
 *  2. Persist pending order in chrome.storage.local
 *  3. Update action badge to show pending item count
 *  4. Receive schedule data scraped from Lactalis (Session 12)
 *  5. Relay fill commands to the Lactalis content script (Session 13)
 */

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
      sendResponse({ ok: true })
      return true

    // Schedule data scraped from portal (Session 12)
    case 'SCHEDULE_UPDATE':
      chrome.storage.local.set({ schedule: msg.payload }, () => {
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
