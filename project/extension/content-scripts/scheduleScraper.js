/**
 * scheduleScraper.js — Lactalis portal delivery schedule extractor
 *
 * Loaded as a content script on all https://*.lactalis.com.au/* pages.
 * Runs automatically on page load, and also on-demand via SCRAPE_SCHEDULE
 * messages from the popup.
 *
 * Storage format (chrome.storage.local key: 'schedule'):
 * {
 *   nextDelivery: { deliveryDate, orderCutoffDate, orderCutoffTime } | null,
 *   upcomingDeliveries: [{ deliveryDate, orderCutoffDate, orderCutoffTime }],
 *   scrapedAt: number,          // Date.now()
 *   source: string,             // which strategy found the data
 * }
 */

;(function () {
  'use strict'

  const DEBUG = false

  // ─── Date / time parsing ────────────────────────────────────────────────────

  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  }

  function parseMonthName(s) {
    return MONTHS[s.slice(0, 3).toLowerCase()] ?? null
  }

  function toISODate(day, month, year) {
    const d = Number(day)
    const m = typeof month === 'string' ? parseMonthName(month) : Number(month)
    const y = String(year).length === 2 ? 2000 + Number(year) : Number(year)
    if (!d || !m || !y || d > 31 || m > 12 || y < 2020 || y > 2040) return null
    // Validate day-of-month (e.g. rejects "31 Feb 2026" — Date constructor overflows)
    const check = new Date(y, m - 1, d)
    if (check.getMonth() !== m - 1) return null
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }

  /**
   * parseDate — extract first parseable date from a text fragment.
   * Returns 'YYYY-MM-DD' or null.
   * Supports:
   *   "17 March 2026"  "Mon 17 Mar 2026"  "Monday, 17 March 26"
   *   "17/03/2026"     "17-03-2026"       "17.03.2026"
   */
  function parseDate(text) {
    // Named month: "17 March 2026" or "Mon 17 Mar 26" (weekday prefix optional)
    const m1 = text.match(
      /(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*[,.\s]+)?(\d{1,2})[,.\s]+([A-Za-z]+)[,.\s]+(\d{2,4})/i,
    )
    if (m1) {
      const iso = toISODate(m1[1], m1[2], m1[3])
      if (iso) return iso
    }

    // Numeric: DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY (AU format, not US)
    const m2 = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/)
    if (m2) {
      const iso = toISODate(m2[1], Number(m2[2]), m2[3])
      if (iso) return iso
    }

    return null
  }

  /**
   * parseTime — extract first parseable time from a text fragment.
   * Returns 'HH:MM' (24-hour) or null.
   * Supports: "5:00 PM"  "5pm"  "17:00"  "5:30pm"
   */
  function parseTime(text) {
    // HH:MM AM/PM
    const m1 = text.match(/\b(\d{1,2}):(\d{2})\s*([ap]m)\b/i)
    if (m1) {
      let h = Number(m1[1])
      const ampm = m1[3].toLowerCase()
      if (ampm === 'pm' && h < 12) h += 12
      if (ampm === 'am' && h === 12) h = 0
      return `${String(h).padStart(2, '0')}:${m1[2]}`
    }

    // H AM/PM (no minutes)
    const m2 = text.match(/\b(\d{1,2})\s*([ap]m)\b/i)
    if (m2) {
      let h = Number(m2[1])
      const ampm = m2[2].toLowerCase()
      if (ampm === 'pm' && h < 12) h += 12
      if (ampm === 'am' && h === 12) h = 0
      return `${String(h).padStart(2, '0')}:00`
    }

    // 24-hour HH:MM
    const m3 = text.match(/\b([01]\d|2[0-3]):([0-5]\d)\b/)
    if (m3) return `${m3[1]}:${m3[2]}`

    return null
  }

  // ─── Strategy 1: header / banner element search ─────────────────────────────

  /**
   * Finds elements that are likely to contain schedule info based on:
   * - semantic roles (banner, complementary, navigation)
   * - common class/id patterns
   * - text proximity to delivery keywords
   */
  function scrapeHeaderBanner() {
    // Selectors likely to hold a delivery notice across different portal versions
    const CANDIDATE_SELECTORS = [
      '[class*="deliver"]',
      '[class*="schedule"]',
      '[class*="cutoff"]',
      '[class*="order-by"]',
      '[class*="next-order"]',
      '[class*="banner"]',
      '[class*="notice"]',
      '[class*="alert"]',
      '[id*="deliver"]',
      '[id*="schedule"]',
      '[id*="cutoff"]',
      'header',
      '[role="banner"]',
      '[role="complementary"]',
      'aside',
      'nav',
      '.navbar',
      '.header',
      '.top-bar',
      '.info-bar',
    ]

    const seen = new Set()
    const candidates = []

    for (const sel of CANDIDATE_SELECTORS) {
      try {
        document.querySelectorAll(sel).forEach((el) => {
          if (!seen.has(el)) {
            seen.add(el)
            candidates.push(el)
          }
        })
      } catch {
        // Ignore invalid selectors
      }
    }

    // Check each candidate's text for delivery/cutoff mentions
    for (const el of candidates) {
      const text = el.innerText ?? el.textContent ?? ''
      if (!text) continue
      const lower = text.toLowerCase()
      if (
        lower.includes('deliver') ||
        lower.includes('cutoff') ||
        lower.includes('cut-off') ||
        lower.includes('order by') ||
        lower.includes('order close') ||
        lower.includes('closes at')
      ) {
        const slot = parseDeliverySlotFromText(text)
        if (slot) {
          if (DEBUG) console.log('[Milk Manager Scraper] Found schedule in banner element:', sel)
          return { slot, source: `banner:${el.tagName.toLowerCase()}` }
        }
      }
    }

    return null
  }

  // ─── Strategy 2: full-page text scan ────────────────────────────────────────

  /**
   * Splits the full page text into windows around delivery-related keywords
   * and tries to extract date+time from each window.
   */
  function scrapeFullPageText() {
    const body = document.body
    if (!body) return null

    const fullText = body.innerText ?? body.textContent ?? ''
    if (!fullText) return null

    // Split on natural line/sentence boundaries
    const lines = fullText
      .split(/[\n\r]+/)
      .map((l) => l.trim())
      .filter(Boolean)

    // Find lines containing delivery-related keywords
    const DELIVERY_KEYWORDS = /\b(?:deliver(?:y|ies)|next\s+order|order\s+(?:cutoff|cut-off|by|close)|cut-?off|close[sd]?\s+at)\b/i
    const CUTOFF_KEYWORDS   = /\b(?:cutoff|cut-?off|order\s+by|close[sd]?\s+at|order\s+close|must\s+(?:be\s+)?order)\b/i

    let deliveryDate = null
    let orderCutoffDate = null
    let orderCutoffTime = null

    for (let i = 0; i < lines.length; i++) {
      const window = lines.slice(Math.max(0, i - 1), i + 3).join(' ')

      if (!DELIVERY_KEYWORDS.test(window)) continue

      // Try to find a delivery date
      const date = parseDate(window)
      if (!date) continue

      // Look for cutoff info in the same window or nearby lines
      const cutoffWindow = lines.slice(i, Math.min(lines.length, i + 5)).join(' ')
      if (CUTOFF_KEYWORDS.test(cutoffWindow)) {
        // Find cutoff date (may be the line after the delivery date)
        const cutoffLine = lines.slice(i, Math.min(lines.length, i + 5)).find((l) =>
          CUTOFF_KEYWORDS.test(l),
        )
        if (cutoffLine) {
          orderCutoffDate = parseDate(cutoffLine) ?? date  // fallback: same day as delivery
          orderCutoffTime = parseTime(cutoffLine)
        }
      }

      deliveryDate = date

      // If we found a delivery date, that's enough for now
      if (deliveryDate) break
    }

    if (!deliveryDate) return null

    if (DEBUG) console.log('[Milk Manager Scraper] Found schedule via full-page text scan')
    return {
      slot: {
        deliveryDate,
        orderCutoffDate: orderCutoffDate ?? prevBusinessDay(deliveryDate),
        orderCutoffTime: orderCutoffTime ?? '17:00',  // sensible default
      },
      source: 'full_page_text',
    }
  }

  // ─── Strategy 3: Manage Deliveries table scraper ────────────────────────────

  /**
   * Parses a table of upcoming delivery slots.
   * Called when pageType === 'manage_deliveries'.
   * Returns an array of slots (empty array if nothing found).
   */
  function scrapeManageDeliveriesPage() {
    const slots = []
    const tables = document.querySelectorAll('table')

    for (const table of tables) {
      const headers = [...table.querySelectorAll('th, thead td')].map(
        (th) => (th.innerText ?? th.textContent ?? '').toLowerCase().trim(),
      )

      // Look for a table with delivery-related headers
      const hasDelivery = headers.some((h) => h.includes('deliver'))
      const hasCutoff   = headers.some((h) => h.includes('cutoff') || h.includes('cut-off') || h.includes('order'))
      if (!hasDelivery && !hasCutoff) continue

      // Map column indices
      const deliveryIdx = headers.findIndex((h) => h.includes('deliver'))
      const cutoffDateIdx = headers.findIndex((h) => h.includes('cutoff') || h.includes('cut-off') || h.includes('order'))
      const cutoffTimeIdx = headers.findIndex((h) => h.includes('time') || h.includes('close'))

      const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)')
      for (const row of rows) {
        const cells = [...row.querySelectorAll('td, th')].map(
          (c) => (c.innerText ?? c.textContent ?? '').trim(),
        )
        if (cells.length < 2) continue

        const deliveryDate = deliveryIdx >= 0 ? parseDate(cells[deliveryIdx] ?? '') : null
        const cutoffDate   = cutoffDateIdx >= 0 ? parseDate(cells[cutoffDateIdx] ?? '') : null
        const cutoffTime   = cutoffTimeIdx >= 0
          ? parseTime(cells[cutoffTimeIdx] ?? '')
          : cutoffDateIdx >= 0
            ? parseTime(cells[cutoffDateIdx] ?? '')
            : null

        if (deliveryDate) {
          slots.push({
            deliveryDate,
            orderCutoffDate: cutoffDate ?? prevBusinessDay(deliveryDate),
            orderCutoffTime: cutoffTime ?? '17:00',
          })
        }
      }

      if (slots.length > 0) {
        if (DEBUG) console.log(`[Milk Manager Scraper] Found ${slots.length} slots in table`)
        break
      }
    }

    // Also try definition lists, card grids, list items
    if (slots.length === 0) {
      slots.push(...scrapeScheduleCards())
    }

    return slots
  }

  /**
   * Fallback card/list scraper for non-table schedule pages.
   * Looks for repeated elements (li, article, .card, .slot) containing date text.
   */
  function scrapeScheduleCards() {
    const slots = []
    const candidates = [
      ...document.querySelectorAll('li, article, [class*="card"], [class*="slot"], [class*="item"]'),
    ]

    for (const el of candidates) {
      const text = el.innerText ?? el.textContent ?? ''
      if (!text || text.length > 500) continue  // skip huge containers
      const lower = text.toLowerCase()
      if (!lower.includes('deliver') && !lower.includes('cutoff') && !lower.includes('order by')) continue

      const slot = parseDeliverySlotFromText(text)
      if (slot) slots.push(slot)
      if (slots.length >= 5) break  // at most 5 upcoming deliveries
    }

    return slots
  }

  // ─── Shared text-to-slot parser ─────────────────────────────────────────────

  /**
   * Given a multi-line text block describing one delivery slot,
   * extract { deliveryDate, orderCutoffDate, orderCutoffTime }.
   */
  function parseDeliverySlotFromText(text) {
    const lower = text.toLowerCase()

    // Find all dates in the text
    const dateMatches = []
    const dateRe = /(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*[,.\s]+)?(\d{1,2})[,.\s]+([A-Za-z]+)[,.\s]+(\d{2,4})|(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/gi
    let m
    while ((m = dateRe.exec(text)) !== null) {
      const iso = m[1]
        ? toISODate(m[1], m[2], m[3])
        : toISODate(m[4], Number(m[5]), m[6])
      if (iso) dateMatches.push({ iso, index: m.index, raw: m[0] })
    }

    if (dateMatches.length === 0) return null

    // Find all times in the text
    const timeMatches = []
    const timeRe = /(\d{1,2}):(\d{2})\s*([ap]m)\b|(\d{1,2})\s*([ap]m)\b|([01]\d|2[0-3]):([0-5]\d)/gi
    while ((m = timeRe.exec(text)) !== null) {
      const t = parseTime(m[0])
      if (t) timeMatches.push({ t, index: m.index })
    }

    // Heuristic: if there's one date + one time, that's the delivery date + cutoff
    // If two dates, first = delivery, second = cutoff; time belongs to cutoff
    let deliveryDate = dateMatches[0].iso
    let orderCutoffDate = dateMatches.length >= 2 ? dateMatches[1].iso : null
    let orderCutoffTime = timeMatches.length > 0 ? timeMatches[0].t : null

    // If the text says "cutoff" or "order by" near a date, treat that date as cutoff
    const cutoffRe = /(?:cutoff|cut-?off|order\s+by|close[sd]?\s+(?:at|on)|must\s+order)/i
    if (cutoffRe.test(lower) && dateMatches.length >= 1) {
      const cutoffIdx = lower.search(cutoffRe)
      // Find the date closest to the cutoff keyword
      const nearest = dateMatches.reduce((best, d) =>
        Math.abs(d.index - cutoffIdx) < Math.abs(best.index - cutoffIdx) ? d : best,
      )
      orderCutoffDate = nearest.iso

      // Delivery date = the other date (or one before cutoff)
      const others = dateMatches.filter((d) => d.iso !== orderCutoffDate)
      if (others.length > 0) deliveryDate = others[0].iso
    }

    return {
      deliveryDate,
      orderCutoffDate: orderCutoffDate ?? prevBusinessDay(deliveryDate),
      orderCutoffTime: orderCutoffTime ?? '17:00',
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * prevBusinessDay — returns the business day before a YYYY-MM-DD date.
   * Used as a fallback cutoff date when we know the delivery date but not cutoff.
   */
  function prevBusinessDay(dateStr) {
    const [y, mo, d] = dateStr.split('-').map(Number)
    const dt = new Date(y, mo - 1, d)
    dt.setDate(dt.getDate() - 1)
    // Skip back over weekends (Sat→Fri, Sun→Fri)
    if (dt.getDay() === 0) dt.setDate(dt.getDate() - 2)
    if (dt.getDay() === 6) dt.setDate(dt.getDate() - 1)
    return dt.toISOString().slice(0, 10)
  }

  /**
   * dedupeAndSort — remove duplicate delivery dates and sort ascending.
   */
  function dedupeAndSort(slots) {
    const seen = new Set()
    return slots
      .filter((s) => {
        if (!s.deliveryDate || seen.has(s.deliveryDate)) return false
        seen.add(s.deliveryDate)
        return true
      })
      .sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate))
  }

  /**
   * filterFuture — keep only slots on or after today.
   */
  function filterFuture(slots) {
    const today = new Date()
    const todayStr = today.toISOString().slice(0, 10)
    return slots.filter((s) => s.deliveryDate >= todayStr)
  }

  // ─── Main orchestrator ───────────────────────────────────────────────────────

  async function scrapeAndStore() {
    const pageType = window.__milkManagerPageType__ ?? 'other'

    let slots = []
    let source = 'none'

    // Strategy A: manage_deliveries page — richest source of slots
    if (pageType === 'manage_deliveries') {
      const tableSlots = scrapeManageDeliveriesPage()
      if (tableSlots.length > 0) {
        slots = tableSlots
        source = 'manage_deliveries_page'
      }
    }

    // Strategy B: header/banner — any Lactalis page
    if (slots.length === 0) {
      const bannerResult = scrapeHeaderBanner()
      if (bannerResult) {
        slots = [bannerResult.slot]
        source = bannerResult.source
      }
    }

    // Strategy C: full-page text scan — last resort
    if (slots.length === 0) {
      const textResult = scrapeFullPageText()
      if (textResult) {
        slots = [textResult.slot]
        source = textResult.source
      }
    }

    if (slots.length === 0) {
      if (DEBUG) console.log('[Milk Manager Scraper] No schedule data found on this page')
      return null
    }

    const futureSlots = filterFuture(dedupeAndSort(slots))
    if (futureSlots.length === 0) {
      if (DEBUG) console.log('[Milk Manager Scraper] All scraped dates are in the past')
      return null
    }

    const schedule = {
      nextDelivery: futureSlots[0],
      upcomingDeliveries: futureSlots.slice(0, 5),
      scrapedAt: Date.now(),
      source,
    }

    // Persist
    chrome.storage.local.set({ schedule }, () => {
      if (DEBUG) console.log(`[Milk Manager Scraper] Saved schedule from "${source}":`, schedule.nextDelivery)
    })

    // Also forward to background so it can notify any open popups
    chrome.runtime.sendMessage({ type: 'SCHEDULE_UPDATE', payload: schedule })

    return schedule
  }

  // ─── Run ─────────────────────────────────────────────────────────────────────

  // main.js sets this before scheduleScraper.js runs (both in the same injection)
  // so page type detection is shared rather than duplicated.
  // Delay slightly to allow SPA frameworks to finish initial render.
  setTimeout(scrapeAndStore, 800)

  // Re-run if the page mutates significantly (SPA navigation within the portal)
  let mutationDebounce = null
  const observer = new MutationObserver(() => {
    clearTimeout(mutationDebounce)
    mutationDebounce = setTimeout(scrapeAndStore, 1500)
  })
  observer.observe(document.body, { childList: true, subtree: false })

  // On-demand refresh from popup
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SCRAPE_SCHEDULE') {
      scrapeAndStore().then((result) => sendResponse({ ok: true, found: !!result }))
      return true  // async
    }
  })
})()
