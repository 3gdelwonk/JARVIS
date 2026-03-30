// ═══════════════════════════════════════════════════════════════
// LACTALIS SESSION — Minimal-login architecture
// ═══════════════════════════════════════════════════════════════
// Two-tier approach:
//   Tier 1: Delivery slots — cached to disk, refreshed every 24h
//   Tier 2: Order submission — full Playwright session per order
//
// Design goals:
//   - Minimize Playwright logins (~4-10/week at 3 orders/week)
//   - Exponential backoff on login failure (15s → 30m cap)
//   - Cookie persistence across restarts
//   - No auto-login on startup
//   - Concurrent request deduplication

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PORTAL_URL = process.env.LACTALIS_PORTAL_URL || 'https://mylactalis.com.au';
const USERNAME = process.env.LACTALIS_USERNAME || '';
const PASSWORD = process.env.LACTALIS_PASSWORD || '';
const SLOT_CONFIG_ID = process.env.LACTALIS_SLOT_ID || '869';

// ── Data directory ──

const DATA_DIR = path.join(__dirname, 'data');
const COOKIE_FILE = path.join(DATA_DIR, 'lactalis-cookies.json');
const SLOTS_FILE = path.join(DATA_DIR, 'delivery-slots.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── Cookie persistence ──

let cachedCookies = [];
let cookieSavedAt = null;

function loadCookiesFromDisk() {
  try {
    if (!fs.existsSync(COOKIE_FILE)) return false;
    const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    if (!raw.cookies || !raw.savedAt) return false;
    // Cookies older than 2 hours are stale
    const age = Date.now() - new Date(raw.savedAt).getTime();
    if (age > 2 * 60 * 60 * 1000) return false;
    cachedCookies = raw.cookies;
    cookieSavedAt = raw.savedAt;
    console.log(`  [Lactalis] Loaded ${cachedCookies.length} cookies from disk (age: ${Math.round(age / 60000)}min)`);
    return true;
  } catch {
    return false;
  }
}

function saveCookiesToDisk(cookies) {
  ensureDataDir();
  cachedCookies = cookies;
  cookieSavedAt = new Date().toISOString();
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({
    cookies,
    savedAt: cookieSavedAt,
  }, null, 2));
}

function clearCookies() {
  cachedCookies = [];
  cookieSavedAt = null;
  try { fs.unlinkSync(COOKIE_FILE); } catch {}
}

// ── Exponential backoff ──

let consecutiveFailures = 0;
let nextRetryAt = 0;

const BACKOFF_STEPS_MS = [
  15_000,   // 15s
  30_000,   // 30s
  60_000,   // 1m
  120_000,  // 2m
  300_000,  // 5m
  600_000,  // 10m
  1_800_000 // 30m cap
];

function getBackoffMs() {
  const idx = Math.min(consecutiveFailures - 1, BACKOFF_STEPS_MS.length - 1);
  return BACKOFF_STEPS_MS[Math.max(0, idx)];
}

function checkBackoff() {
  if (consecutiveFailures === 0) return;
  const remaining = nextRetryAt - Date.now();
  if (remaining > 0) {
    const sec = Math.ceil(remaining / 1000);
    throw new Error(`Login cooling down — retry in ${sec}s (${consecutiveFailures} consecutive failures)`);
  }
}

function recordLoginFailure() {
  consecutiveFailures++;
  nextRetryAt = Date.now() + getBackoffMs();
  console.log(`  [Lactalis] Login failure #${consecutiveFailures} — backoff ${Math.round(getBackoffMs() / 1000)}s`);
}

function recordLoginSuccess() {
  if (consecutiveFailures > 0) {
    console.log(`  [Lactalis] Login succeeded — resetting backoff (was ${consecutiveFailures} failures)`);
  }
  consecutiveFailures = 0;
  nextRetryAt = 0;
}

// ── Login deduplication ──

let _loginPromise = null;

// ── Playwright login ──
// Returns cookies array on success, throws on failure.

async function login() {
  // Deduplicate concurrent calls
  if (_loginPromise) return _loginPromise;

  _loginPromise = (async () => {
    if (!USERNAME || !PASSWORD) {
      throw new Error('LACTALIS_USERNAME and LACTALIS_PASSWORD must be set in .env');
    }

    checkBackoff();

    console.log('  [Lactalis] Launching browser for login...');
    const browser = await chromium.launch({ headless: true });

    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();

      // Navigate to login — Incapsula JS challenge runs in real Chromium
      await page.goto(`${PORTAL_URL}/customer/user/login`, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });

      // Detect Incapsula CAPTCHA challenge
      const challengeEl = await page.$('iframe[src*="_Incapsula"], #recaptcha, .g-recaptcha, [class*="captcha"]');
      if (challengeEl) {
        throw new Error('Portal bot detection triggered (CAPTCHA) — place order manually');
      }

      // Wait for login form
      let usernameInput;
      try {
        usernameInput = await page.waitForSelector(
          'input[name="_username"], input[name="username"], input[name="email"]',
          { timeout: 15000 }
        );
      } catch {
        throw new Error('Login form not found — portal may have changed');
      }

      let passwordInput;
      try {
        passwordInput = await page.waitForSelector(
          'input[name="_password"], input[name="password"]',
          { timeout: 5000 }
        );
      } catch {
        throw new Error('Password field not found — portal may have changed');
      }

      // Fill credentials
      await usernameInput.fill(USERNAME);
      await passwordInput.fill(PASSWORD);

      // Submit
      const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
      if (submitBtn) {
        await submitBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }

      // Wait for navigation away from login page
      try {
        await page.waitForURL(url => !url.toString().includes('/login'), {
          timeout: 20000,
        });
      } catch {
        // Still on login page = wrong credentials or form error
        throw new Error('Login failed — check credentials (page did not navigate away from login)');
      }

      // Extract cookies
      const cookies = await context.cookies();
      saveCookiesToDisk(cookies);
      recordLoginSuccess();

      console.log(`  [Lactalis] ✓ Login successful — ${cookies.length} cookies captured and saved`);
      return cookies;
    } catch (err) {
      // Only record backoff for actual login attempts (not backoff rejections)
      if (!err.message.includes('cooling down')) {
        recordLoginFailure();
      }
      throw err;
    } finally {
      await browser.close();
      console.log('  [Lactalis] Browser closed');
    }
  })();

  try {
    return await _loginPromise;
  } finally {
    _loginPromise = null;
  }
}

// ═══════════════════════════════════════════════════════════════
// TIER 2: Order Submission — Full Playwright session per order
// ═══════════════════════════════════════════════════════════════

let _orderPromise = null;

async function submitOrder(lines) {
  // Prevent concurrent order submissions
  if (_orderPromise) {
    throw new Error('Another order is currently being submitted — please wait');
  }

  const products = lines
    .filter(l => l.qty > 0)
    .map((l, index) => ({
      sku: String(l.itemNumber),
      unit: 'item',
      quantity: l.qty,
      index,
    }));

  if (!products.length) throw new Error('No items with qty > 0');

  _orderPromise = _submitOrderPlaywright(products);

  try {
    return await _orderPromise;
  } finally {
    _orderPromise = null;
  }
}

async function _submitOrderPlaywright(products, isRetry = false) {
  if (!USERNAME || !PASSWORD) {
    throw new Error('LACTALIS_USERNAME and LACTALIS_PASSWORD must be set in .env');
  }

  checkBackoff();

  console.log(`  [Lactalis] Launching browser for order submission (${products.length} items)...`);
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // ── Step 1: Login ──
    await page.goto(`${PORTAL_URL}/customer/user/login`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Check if already logged in (redirected away from login)
    const currentUrl = page.url();
    if (currentUrl.includes('/login')) {
      // Detect Incapsula/bot protection — check multiple signals
      const blocked = await page.evaluate(() => {
        const html = document.documentElement.innerHTML.toLowerCase();
        // Incapsula block page markers
        if (html.includes('_incapsula') || html.includes('incap_ses') || html.includes('visid_incap')) return 'incapsula_cookie';
        if (html.includes('request unsuccessful') || html.includes('incident id')) return 'incapsula_block';
        if (document.querySelector('iframe[src*="_Incapsula"], iframe[src*="captcha"]')) return 'incapsula_iframe';
        if (document.querySelector('#recaptcha, .g-recaptcha, [class*="captcha"]')) return 'captcha';
        // JS challenge — page has almost no real content
        if (!document.querySelector('form') && html.length < 5000) return 'js_challenge';
        return null;
      });
      if (blocked) {
        throw new Error(`Portal bot detection triggered (${blocked}) — place order manually`);
      }

      const usernameInput = await page.waitForSelector(
        'input[name="_username"], input[name="username"], input[name="email"]',
        { timeout: 15000 }
      ).catch(() => { throw new Error('Login form not found — portal may have changed'); });

      const passwordInput = await page.waitForSelector(
        'input[name="_password"], input[name="password"]',
        { timeout: 5000 }
      ).catch(() => { throw new Error('Password field not found — portal may have changed'); });

      await usernameInput.fill(USERNAME);
      await passwordInput.fill(PASSWORD);

      const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
      if (submitBtn) await submitBtn.click();
      else await page.keyboard.press('Enter');

      try {
        await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 20000 });
      } catch {
        throw new Error('Login failed during order submission — check credentials');
      }

      recordLoginSuccess();
      // Save cookies for health endpoint reporting
      const cookies = await context.cookies();
      saveCookiesToDisk(cookies);
    }

    console.log('  [Lactalis] Logged in — navigating to Quick Order...');

    // ── Step 2: Navigate to Quick Order page ──
    await page.goto(`${PORTAL_URL}/customer/product/quick-add/`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Check we're not redirected back to login
    if (page.url().includes('/login')) {
      if (!isRetry) {
        console.log('  [Lactalis] Redirected to login during order — retrying with fresh session...');
        await browser.close();
        return _submitOrderPlaywright(products, true);
      }
      throw new Error('Session lost during order — redirected to login after retry');
    }

    // Check if quick-add page is actually an Incapsula block
    const quickAddBlocked = await page.evaluate(() => {
      const html = document.documentElement.innerHTML.toLowerCase();
      if (html.includes('_incapsula') || html.includes('request unsuccessful') || html.includes('incident id')) return true;
      if (!document.querySelector('form') && html.length < 5000) return true;
      return false;
    });
    if (quickAddBlocked) {
      throw new Error('Quick Order page blocked by Incapsula — place order manually');
    }

    // ── Step 3: Extract CSRF token from page DOM ──
    const csrfToken = await page.evaluate(() => {
      const input = document.querySelector('input[name="oro_product_quick_add[_token]"]');
      return input ? input.value : null;
    });

    if (!csrfToken) {
      // Capture what we actually got for debugging
      const pageTitle = await page.title().catch(() => '(unknown)');
      const pageUrl = page.url();
      console.error(`  [Lactalis] CSRF missing — page title: "${pageTitle}", URL: ${pageUrl}`);
      throw new Error(`CSRF token not found on Quick Order page (got: "${pageTitle}" at ${pageUrl})`);
    }

    console.log('  [Lactalis] CSRF token extracted — submitting order...');

    // ── Step 4: Submit order via fetch within browser context (with 30s timeout) ──
    const result = await page.evaluate(async ({ products, csrfToken, portalUrl }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);

      try {
        const form = new FormData();
        form.append('oro_product_quick_add[component]', 'oro_shopping_list_to_checkout_quick_add_processor');
        form.append('oro_product_quick_add[additional]', '');
        form.append('oro_product_quick_add[transition]', 'start_from_quickorderform');
        form.append('oro_product_quick_add[_token]', csrfToken);
        form.append('oro_product_quick_add[products]', JSON.stringify(products));

        const res = await fetch(`${portalUrl}/customer/product/quick-add/`, {
          method: 'POST',
          body: form,
          redirect: 'manual',
          signal: controller.signal,
        });

        if (res.status === 302 || res.status === 301) {
          return { success: true, redirectUrl: res.headers.get('location') };
        }

        if (res.type === 'opaqueredirect') {
          // redirect: 'manual' returns opaque redirect in browser context
          return { success: true, redirectUrl: null };
        }

        if (res.ok) {
          const text = await res.text();
          // Check if we got an Incapsula block page instead of a real response
          if (text.includes('_Incapsula') || text.includes('Request unsuccessful') || text.includes('incident ID')) {
            return { success: false, error: 'Order POST blocked by Incapsula — place order manually' };
          }
          try {
            const json = JSON.parse(text);
            return { success: true, redirectUrl: json.redirectUrl || json.url || null };
          } catch {
            // HTML response (not JSON) — NOT success.
            // Success = 302 redirect. A 200 with HTML = form re-rendered with errors.
            try {
              const doc = new DOMParser().parseFromString(text, 'text/html');
              const selectors = [
                '.alert-error', '.alert-danger',
                '.flash-messages-holder .alert',
                '.notification-flash--error',
                '.validation-failed', '.form-error-message',
                '[data-role="flash-message"]', '.message-error',
              ];
              const msgs = [];
              for (const sel of selectors) {
                doc.querySelectorAll(sel).forEach(el => {
                  const t = el.textContent?.trim();
                  if (t && t.length > 0 && t.length < 500) msgs.push(t);
                });
              }
              if (msgs.length > 0) {
                return { success: false, error: 'Lactalis rejected the order: ' + msgs.join(' | '), htmlLength: text.length };
              }
              // No known error selectors matched — return page context
              const title = doc.querySelector('title')?.textContent?.trim() || '';
              const h1 = doc.querySelector('h1')?.textContent?.trim() || '';
              const snippet = doc.body?.textContent?.trim().slice(0, 300) || '';
              return {
                success: false,
                error: `Lactalis returned an unexpected page: "${title}" ${h1 ? '— ' + h1 : ''} — ${snippet}`,
                htmlLength: text.length,
                htmlSnippet: text.slice(0, 2000),
              };
            } catch {
              return { success: false, error: 'Lactalis returned non-JSON HTML (' + text.length + ' bytes): ' + text.slice(0, 300) };
            }
          }
        }

        return { success: false, error: `Lactalis returned ${res.status}` };
      } catch (err) {
        if (err.name === 'AbortError') {
          return { success: false, error: 'Order POST to Lactalis timed out after 30s' };
        }
        return { success: false, error: err.message || 'Fetch failed inside browser' };
      } finally {
        clearTimeout(timer);
      }
    }, { products, csrfToken, portalUrl: PORTAL_URL });

    if (!result.success) {
      console.error(`  [Lactalis] Order rejected: ${result.error}`);
      if (result.htmlSnippet) {
        console.error(`  [Lactalis] HTML snippet:\n${result.htmlSnippet}`);
      }
      // Do NOT retry on order errors (avoid double-submission)
      throw new Error(result.error || 'Order submission failed');
    }

    console.log(`  [Lactalis] ✓ Order submitted successfully`);
    return result;

  } catch (err) {
    if (!err.message.includes('cooling down')) {
      // Only record login failures for actual auth problems
      if (err.message.includes('Login failed') || err.message.includes('credentials')) {
        recordLoginFailure();
      }
    }

    // Retry once on session-related failures (not order errors)
    if (!isRetry && (
      err.message.includes('Session lost') ||
      err.message.includes('navigation') ||
      err.message.includes('timeout')
    )) {
      console.log('  [Lactalis] Session failure during order — retrying with fresh browser...');
      await browser.close();
      return _submitOrderPlaywright(products, true);
    }

    throw err;
  } finally {
    await browser.close().catch(() => {});
    console.log('  [Lactalis] Order browser closed');
  }
}

// ═══════════════════════════════════════════════════════════════
// TIER 1: Delivery Slots — Cached, refreshed daily
// ═══════════════════════════════════════════════════════════════

const SLOTS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function loadSlotsCache() {
  try {
    if (!fs.existsSync(SLOTS_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8'));
    if (!raw.slots || !raw.cachedAt) return null;
    return raw;
  } catch {
    return null;
  }
}

function saveSlotsCache(slots) {
  ensureDataDir();
  const data = { slots, cachedAt: new Date().toISOString() };
  fs.writeFileSync(SLOTS_FILE, JSON.stringify(data, null, 2));
  return data;
}

async function _fetchSlotsPlaywright() {
  if (!USERNAME || !PASSWORD) {
    throw new Error('LACTALIS_USERNAME and LACTALIS_PASSWORD must be set in .env');
  }

  checkBackoff();

  console.log('  [Lactalis] Launching browser for delivery slots...');
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // Login
    await page.goto(`${PORTAL_URL}/customer/user/login`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    if (page.url().includes('/login')) {
      const usernameInput = await page.waitForSelector(
        'input[name="_username"], input[name="username"], input[name="email"]',
        { timeout: 15000 }
      ).catch(() => { throw new Error('Login form not found'); });

      const passwordInput = await page.waitForSelector(
        'input[name="_password"], input[name="password"]',
        { timeout: 5000 }
      ).catch(() => { throw new Error('Password field not found'); });

      await usernameInput.fill(USERNAME);
      await passwordInput.fill(PASSWORD);

      const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
      if (submitBtn) await submitBtn.click();
      else await page.keyboard.press('Enter');

      await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 20000 })
        .catch(() => { throw new Error('Login failed — check credentials'); });

      recordLoginSuccess();
      const cookies = await context.cookies();
      saveCookiesToDisk(cookies);
    }

    // Fetch slots via API call within browser context (cookies already set)
    const data = await page.evaluate(async ({ portalUrl, slotConfigId }) => {
      const res = await fetch(
        `${portalUrl}/delivery-slots/get-slots/${slotConfigId}?preselectCurrentSlot=1`,
        { headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } }
      );
      if (!res.ok) throw new Error(`Delivery slots returned ${res.status}`);
      return res.json();
    }, { portalUrl: PORTAL_URL, slotConfigId: SLOT_CONFIG_ID });

    if (!Array.isArray(data)) throw new Error('Unexpected delivery slots format');

    // Parse slots
    const slots = [];
    for (const day of data) {
      const ts = day.time_slots?.find(t => t.status === 1 || t.status === 2);
      if (!ts) continue;

      let orderCutoffDate = day.date;
      let orderCutoffTime = '23:59';

      if (ts.cutoff) {
        const d = new Date(ts.cutoff);
        orderCutoffDate = d.toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
        orderCutoffTime = d.toLocaleTimeString('en-GB', {
          timeZone: 'Australia/Melbourne',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
      }

      slots.push({
        deliveryDate: day.date,
        orderCutoffDate,
        orderCutoffTime,
        status: ts.status,
      });
    }

    console.log(`  [Lactalis] ✓ ${slots.length} delivery slots fetched`);
    return slots;

  } finally {
    await browser.close();
    console.log('  [Lactalis] Slots browser closed');
  }
}

async function getDeliverySlots(forceRefresh = false) {
  const cache = loadSlotsCache();

  if (cache && !forceRefresh) {
    const age = Date.now() - new Date(cache.cachedAt).getTime();
    if (age < SLOTS_TTL_MS) {
      return { slots: cache.slots, cachedAt: cache.cachedAt, stale: false };
    }
    // Cache expired — try to refresh, fall back to stale
    console.log('  [Lactalis] Slot cache expired — refreshing...');
  }

  try {
    const slots = await _fetchSlotsPlaywright();
    const saved = saveSlotsCache(slots);
    return { slots: saved.slots, cachedAt: saved.cachedAt, stale: false };
  } catch (err) {
    console.error('  [Lactalis] Slot fetch failed:', err.message);
    // Serve stale cache if available
    if (cache) {
      console.log('  [Lactalis] Serving stale slot cache');
      return { slots: cache.slots, cachedAt: cache.cachedAt, stale: true, error: err.message };
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════
// Health check — no Playwright, reads files and state only
// ═══════════════════════════════════════════════════════════════

function checkConnection() {
  const hasCreds = !!(USERNAME && PASSWORD);

  // Cookie state
  let cookiesOnDisk = false;
  let cookieAge = null;
  if (cachedCookies.length > 0 && cookieSavedAt) {
    cookiesOnDisk = true;
    cookieAge = Math.round((Date.now() - new Date(cookieSavedAt).getTime()) / 60000) + ' min';
  } else {
    // Try loading from disk
    if (loadCookiesFromDisk()) {
      cookiesOnDisk = true;
      cookieAge = Math.round((Date.now() - new Date(cookieSavedAt).getTime()) / 60000) + ' min';
    }
  }

  // Slot cache state
  let cacheAge = null;
  const slotCache = loadSlotsCache();
  if (slotCache) {
    cacheAge = Math.round((Date.now() - new Date(slotCache.cachedAt).getTime()) / 60000) + ' min';
  }

  // Backoff state
  const backoffActive = consecutiveFailures > 0 && (nextRetryAt - Date.now()) > 0;
  let nextRetryIn = null;
  if (backoffActive) {
    nextRetryIn = Math.ceil((nextRetryAt - Date.now()) / 1000) + 's';
  }

  return {
    configured: hasCreds,
    cookiesOnDisk,
    cookieAge,
    slotCacheAge: cacheAge,
    backoffActive,
    backoffFailures: consecutiveFailures,
    nextRetryIn,
  };
}

// ── Load cookies from disk on module init (no Playwright) ──
loadCookiesFromDisk();

module.exports = {
  login,
  submitOrder,
  getDeliverySlots,
  checkConnection,
  PORTAL_URL,
};
