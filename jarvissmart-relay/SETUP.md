# Lactalis Relay for JARVISmart

Minimal-login architecture for Lactalis order submission via JARVISmart (port 3100).

## Files

- `lactalis-session.js` → copy to `services/lactalis-session.js`
- `lactalis-routes.js` → copy to `routes/lactalis.js`

## Setup on JARVISmart machine (192.168.20.100)

### 1. Copy files

```bash
cp lactalis-session.js /path/to/jarvissmart/services/
cp lactalis-routes.js  /path/to/jarvissmart/routes/lactalis.js
```

### 2. Install Playwright

```bash
cd /path/to/jarvissmart
npm install playwright
npx playwright install chromium
```

### 3. Add env vars to `.env`

```
LACTALIS_USERNAME=<your username>
LACTALIS_PASSWORD=<your password>
LACTALIS_PORTAL_URL=https://mylactalis.com.au
LACTALIS_SLOT_ID=869
LACTALIS_API_KEY=<generate a random key>
```

### 4. Mount routes in server entry point

Add to the main server file (server.js / index.js):

```js
// Mount Lactalis relay
app.use('/api/lactalis', require('./routes/lactalis')(db, () => {}));
```

No auto-login on startup — the session is created on-demand when an order is submitted or slots are fetched.

### 5. Create data directory

```bash
mkdir -p /path/to/jarvissmart/services/data
```

Cookie and slot cache files are written here automatically.

### 6. Ensure CORS

JARVISmart must allow requests from `https://3gdelwonk.github.io`.
If already configured for POS routes, no change needed.

### 7. Restart JARVISmart

```bash
pm2 restart jarvissmart   # or however it runs
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/lactalis/health` | No | System status (no Playwright) |
| POST | `/api/lactalis/login` | Yes | Force a fresh Playwright login |
| POST | `/api/lactalis/submit-order` | Yes | Full Playwright session → submit |
| GET | `/api/lactalis/delivery-slots` | Yes | Cached slots (24h TTL) |
| GET | `/api/lactalis/refresh-slots` | Yes | Force slot cache refresh |

Auth = requires `X-API-Key` header matching `LACTALIS_API_KEY` env var.

## How it works

### Delivery Slots (Tier 1 — cached)
1. First request launches Playwright, logs in, fetches slots, caches to `data/delivery-slots.json`
2. Subsequent requests served from cache until 24h expires
3. If refresh fails, stale cache is served with `stale: true` flag

### Order Submission (Tier 2 — full Playwright per order)
1. Launches fresh headless Chromium browser
2. Logs into mylactalis.com.au (bypasses Incapsula)
3. Navigates to Quick Order, extracts CSRF token from DOM
4. Submits order via fetch within browser context
5. Closes browser — entire flow takes ~15-25s
6. On session failure mid-order: retries once with fresh browser
7. On order error: does NOT retry (prevents double-submission)

### Safety features
- **Exponential backoff**: Failed logins trigger 15s → 30s → 1m → 2m → 5m → 10m → 30m cooldown
- **Cookie persistence**: Saved to `data/lactalis-cookies.json`, survives restarts
- **Concurrent deduplication**: Only one login or order submission at a time
- **No auto-login**: Playwright only launches when a real request needs it
