/**
 * pwa-bridge.js — Content script injected into the PWA (localhost)
 *
 * Bridges the gap between the PWA's localStorage and the extension's
 * chrome.storage.local. Runs on http://localhost:5173/* and :4173/*
 *
 * Forward sync (PWA → Extension):
 *  1. On load: read 'milk-manager-pending-order' from localStorage and sync
 *  2. On storage event: re-sync when PWA updates the key (cross-tab)
 *  3. On custom event: re-sync when PWA sends order in the same tab
 *
 * Reverse sync (Extension → PWA):
 *  4. On load and on chrome.storage changes: read statusUpdates + schedule
 *     from chrome.storage.local and write to localStorage, then dispatch
 *     custom events so the PWA can react without polling.
 */

// ─── Forward sync keys ───────────────────────────────────────────────────────

const ORDER_KEY = 'milk-manager-pending-order'

function syncOrderToExtension() {
  const raw = localStorage.getItem(ORDER_KEY)
  if (!raw) return

  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    console.warn('[Milk Manager Bridge] Could not parse pending order from localStorage')
    return
  }

  chrome.runtime.sendMessage({ type: 'PWA_ORDER_SYNC', payload }, (response) => {
    if (chrome.runtime.lastError) return  // extension reloaded — ignore
    if (response?.ok) {
      console.log(`[Milk Manager Bridge] Synced order (${payload.lines?.length ?? 0} items) to extension`)
    }
  })
}

// Sync on page load
syncOrderToExtension()

// Sync when another tab updates localStorage
window.addEventListener('storage', (e) => {
  if (e.key === ORDER_KEY) syncOrderToExtension()
})

// Sync when the same-tab PWA dispatches the custom event after sendToExtension()
window.addEventListener('milk-manager-order-sent', syncOrderToExtension)

// ─── Reverse sync keys ───────────────────────────────────────────────────────

const STATUS_KEY        = 'milk-manager-status-updates'
const SCHEDULE_KEY      = 'milk-manager-schedule-from-extension'
const ORDER_HISTORY_KEY = 'milk-manager-order-history'

/**
 * Reads statusUpdates + schedule from chrome.storage.local and mirrors them
 * into localStorage so the PWA's extensionSync.ts can apply them.
 * Clears statusUpdates in chrome.storage.local once mirrored (consumed once).
 */
function syncFromExtension() {
  chrome.storage.local.get(['statusUpdates', 'schedule', 'orderHistory'], (result) => {
    if (chrome.runtime.lastError) return

    const updates = result.statusUpdates
    if (Array.isArray(updates) && updates.length > 0) {
      localStorage.setItem(STATUS_KEY, JSON.stringify(updates))
      // Clear from extension storage — PWA is now responsible for applying them
      chrome.storage.local.remove('statusUpdates')
      window.dispatchEvent(new CustomEvent('milk-manager-status-update'))
      console.log(`[Milk Manager Bridge] Pushed ${updates.length} status update(s) to PWA`)
    }

    const schedule = result.schedule
    if (schedule) {
      localStorage.setItem(SCHEDULE_KEY, JSON.stringify(schedule))
      window.dispatchEvent(new CustomEvent('milk-manager-schedule-update'))
    }

    const orderHistory = result.orderHistory
    if (orderHistory) {
      localStorage.setItem(ORDER_HISTORY_KEY, JSON.stringify(orderHistory))
      window.dispatchEvent(new CustomEvent('milk-manager-order-history-update'))
    }
  })
}

// Reverse sync on page load
syncFromExtension()

// Reverse sync whenever relevant chrome.storage keys change
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if ('statusUpdates' in changes || 'schedule' in changes || 'orderHistory' in changes) {
    syncFromExtension()
  }
})

// ─── Extension status ping / pong ────────────────────────────────────────────

window.addEventListener('milk-manager-ping', () => {
  chrome.storage.local.get('lactalisTab', (result) => {
    if (chrome.runtime.lastError) return
    const loggedIn = !!result.lactalisTab &&
      (Date.now() - (result.lactalisTab.detectedAt ?? 0)) < 30 * 60_000
    window.dispatchEvent(new CustomEvent('milk-manager-pong', { detail: { loggedIn } }))
  })
})

// ─── Schedule refresh trigger ────────────────────────────────────────────────

window.addEventListener('milk-manager-refresh-schedule', () => {
  chrome.runtime.sendMessage({ type: 'TRIGGER_SCHEDULE_REFRESH' }, (response) => {
    if (chrome.runtime.lastError) return
    console.log('[Milk Manager Bridge] Schedule refresh triggered:', response?.ok)
  })
})

// ─── Order history refresh trigger ────────────────────────────────────────────

window.addEventListener('milk-manager-refresh-orders', () => {
  chrome.runtime.sendMessage({ type: 'TRIGGER_ORDER_HISTORY_REFRESH' }, (response) => {
    if (chrome.runtime.lastError) return
    console.log('[Milk Manager Bridge] Order history refresh triggered:', response?.ok)
  })
})

// ─── Order submit trigger ─────────────────────────────────────────────────────

window.addEventListener('milk-manager-submit-order', () => {
  chrome.runtime.sendMessage({ type: 'TRIGGER_ORDER_SUBMIT' }, (response) => {
    if (chrome.runtime.lastError) return
    console.log('[Milk Manager Bridge] Order submit triggered:', response?.ok)
  })
})
