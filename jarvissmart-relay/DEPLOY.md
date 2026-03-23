# Deploy to JARVISmart Server

## Context

Deploy three relay files from this directory to the JARVIS server:
1. **lactalis-session.js** — Minimal-login Lactalis session (Playwright per order, cached slots)
2. **lactalis-routes.js** — Lactalis API routes
3. **sync-routes.js** — Two-way cloud sync for PWA data across devices

**Source:** `C:\Users\Admin\OneDrive\Desktop\IGA Milk Order\project\jarvissmart-relay\`
**Target:** `C:\Users\Admin\OneDrive\Desktop\JARVIS\jarvis\`

---

## Steps — Execute in order

### 1. Copy the three JS files

```bash
cp "C:/Users/Admin/OneDrive/Desktop/IGA Milk Order/project/jarvissmart-relay/lactalis-session.js" "C:/Users/Admin/OneDrive/Desktop/JARVIS/jarvis/services/lactalis-session.js"
cp "C:/Users/Admin/OneDrive/Desktop/IGA Milk Order/project/jarvissmart-relay/lactalis-routes.js" "C:/Users/Admin/OneDrive/Desktop/JARVIS/jarvis/routes/lactalis.js"
cp "C:/Users/Admin/OneDrive/Desktop/IGA Milk Order/project/jarvissmart-relay/sync-routes.js" "C:/Users/Admin/OneDrive/Desktop/JARVIS/jarvis/routes/sync.js"
```

### 2. Create the data directory for cookie/slot cache persistence

```bash
mkdir -p "C:/Users/Admin/OneDrive/Desktop/JARVIS/jarvis/services/data"
```

### 3. Mount the sync route in server.js

In `C:\Users\Admin\OneDrive\Desktop\JARVIS\jarvis\server.js`, find the route mounting section (around line 76) and add the sync route **after** the lactalis line:

```js
app.use('/api/sync', apiKeyAuth, require('./routes/sync')(db, broadcast));
```

It should sit near:
```js
app.use('/api/lactalis', apiKeyAuth, require('./routes/lactalis')(db, broadcast));
app.use('/api/sync', apiKeyAuth, require('./routes/sync')(db, broadcast));  // ← ADD THIS
```

### 4. Replace the Lactalis auto-login block in server.js

Find this block (around lines 173-182):

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

### 5. Verify no breaking references

```bash
grep -r "ensureSession\|isSessionValid" "C:/Users/Admin/OneDrive/Desktop/JARVIS/jarvis/" --include="*.js" | grep -v node_modules | grep -v lactalis-session.js
```

Should return no results.

### 6. Restart the server

```bash
cd "C:/Users/Admin/OneDrive/Desktop/JARVIS/jarvis" && node server.js
```

Or if using pm2:
```bash
pm2 restart jarvis
```

### 7. Verify deployment

Test all three endpoints:

```bash
# Lactalis health (instant, no Playwright)
curl http://localhost:3000/api/lactalis/health

# Sync status (should show empty tables)
curl http://localhost:3000/api/sync/status

# POS status (checks SmartRetail connection)
curl http://localhost:3000/api/pos/status
```

Expected sync status response:
```json
{
  "tables": {},
  "totalRecords": 0,
  "lastActivity": null
}
```

---

## Files deployed

| Source file | Destination | Purpose |
|-------------|-------------|---------|
| `lactalis-session.js` | `services/lactalis-session.js` | Playwright session (minimal-login) |
| `lactalis-routes.js` | `routes/lactalis.js` | Lactalis API endpoints |
| `sync-routes.js` | `routes/sync.js` | Cloud sync push/pull/status |

## Sync endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/sync/push` | Receive changed records from PWA |
| GET | `/api/sync/pull?since=<ms>&deviceId=<id>` | Return records changed since timestamp |
| GET | `/api/sync/status` | Record counts and last activity |

All sync endpoints are protected by `apiKeyAuth` (same `JARVIS_API_KEY` used by the PWA).

The sync table (`sync_records`) is auto-created on first request — no manual SQL needed.
