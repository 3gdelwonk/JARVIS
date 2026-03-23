# Deploy Lactalis Relay Update to JARVISmart

## Context

This deploys the minimal-login Lactalis session architecture to the JARVIS server.
The source files are in this directory (`jarvissmart-relay/`).
The target is the JARVIS server at `C:\Users\Admin\OneDrive\Desktop\JARVIS\jarvis`.

## Steps — Execute in order

### 1. Copy the two JS files (overwrite existing)

```bash
cp "C:/Users/Admin/OneDrive/Desktop/IGA Milk Order/project/jarvissmart-relay/lactalis-session.js" "C:/Users/Admin/OneDrive/Desktop/JARVIS/jarvis/services/lactalis-session.js"
cp "C:/Users/Admin/OneDrive/Desktop/IGA Milk Order/project/jarvissmart-relay/lactalis-routes.js" "C:/Users/Admin/OneDrive/Desktop/JARVIS/jarvis/routes/lactalis.js"
```

### 2. Create the data directory for cookie/slot cache persistence

```bash
mkdir -p "C:/Users/Admin/OneDrive/Desktop/JARVIS/jarvis/services/data"
```

### 3. Remove the auto-login block from server.js

In `C:\Users\Admin\OneDrive\Desktop\JARVIS\jarvis\server.js`, find and **delete** this block (around lines 173-182):

```js
  // ── Lactalis session ──
  if (process.env.LACTALIS_USERNAME) {
    const lactalisSession = require('./services/lactalis-session');
    lactalisSession.login().then(() => {
      console.log('  [Lactalis] ✓ Session ready — relay accepting orders');
    }).catch(err => {
      console.error('  [Lactalis] ✗ Login failed:', err.message);
      console.error('  [Lactalis]   Relay will retry on first request');
    });
  }
```

Replace it with:

```js
  // ── Lactalis session ──
  // No auto-login — Playwright launches on-demand when orders are submitted
  if (process.env.LACTALIS_USERNAME) {
    console.log('  [Lactalis] ✓ Relay configured — sessions created on-demand');
  }
```

### 4. Verify no breaking changes

The new `lactalis-session.js` exports: `login`, `submitOrder`, `getDeliverySlots`, `checkConnection`, `PORTAL_URL`.

Removed exports (no longer needed): `ensureSession`, `isSessionValid`.

Check that nothing else in the server imports those removed functions:

```bash
grep -r "ensureSession\|isSessionValid" "C:/Users/Admin/OneDrive/Desktop/JARVIS/jarvis/" --include="*.js" | grep -v node_modules | grep -v lactalis-session.js
```

This should return no results. If it does, those references need updating.

### 5. Restart the server

If running via pm2:
```bash
pm2 restart jarvis
```

If running directly:
```bash
# Stop the current process, then:
cd "C:/Users/Admin/OneDrive/Desktop/JARVIS/jarvis"
node server.js
```

### 6. Verify deployment

Test the health endpoint (should respond instantly, no Playwright):
```bash
curl http://localhost:3000/api/lactalis/health
```

Expected response:
```json
{
  "configured": true,
  "cookiesOnDisk": false,
  "cookieAge": null,
  "slotCacheAge": null,
  "backoffActive": false,
  "backoffFailures": 0,
  "nextRetryIn": null
}
```

`cookiesOnDisk: false` is expected on first run — cookies are saved after the first order or slot fetch.

## What changed

| Before | After |
|--------|-------|
| Auto-login on startup | No login until needed |
| Cookies in memory only | Cookies persisted to `services/data/lactalis-cookies.json` |
| Delivery slots fetched live every time | Cached to `services/data/delivery-slots.json` (24h TTL) |
| No failure backoff | Exponential backoff: 15s → 30m cap |
| Cookie replay for orders | Full Playwright session per order (~15-25s) |
| ~10-30 logins/week | ~4-10 logins/week at 3 orders/week |
