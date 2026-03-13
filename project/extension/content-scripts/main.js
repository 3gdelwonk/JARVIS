/**
 * main.js — Content script for Lactalis portal pages
 *
 * Session 11: Scaffold — detects page type, notifies background
 * Session 12: Sets __milkManagerPageType__ for scheduleScraper.js to read
 * Session 13: quickOrder.js loads alongside this file and self-activates
 *
 * Load order in manifest: [main.js, scheduleScraper.js]
 * main.js sets window.__milkManagerPageType__ synchronously.
 * scheduleScraper.js reads it inside setTimeout(fn, 800), which runs after
 * both scripts have finished their synchronous setup.
 */

// ─── Page detection ───────────────────────────────────────────────────────────

function detectPageType() {
  const url   = location.href.toLowerCase()
  const title = document.title.toLowerCase()

  if (
    url.includes('quickorder') ||
    url.includes('quick-order') ||
    url.includes('quick_order') ||
    title.includes('quick order')
  ) return 'quick_order'

  if (
    url.includes('managedeliveries') ||
    url.includes('manage-deliveries') ||
    url.includes('manage_deliveries') ||
    (title.includes('manage') && title.includes('deliver'))
  ) return 'manage_deliveries'

  if (url.includes('login') || url.includes('signin')) return 'login'

  return 'other'
}

// ─── Initialise ───────────────────────────────────────────────────────────────

const pageType = detectPageType()

// Expose to scheduleScraper.js (loaded in the same injection batch, before us)
window.__milkManagerPageType__ = pageType

// Notify background so popup can show "connected" status and tab info
chrome.runtime.sendMessage({
  type: 'LACTALIS_PAGE_DETECTED',
  pageType,
  url: location.href,
})

console.log(`[Milk Manager] Page type: ${pageType}`)

// quickOrder.js is loaded after this file (see manifest.json) and
// self-activates by reading window.__milkManagerPageType__
