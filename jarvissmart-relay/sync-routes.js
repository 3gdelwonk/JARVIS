// ═══════════════════════════════════════════════
// ROUTES — /api/sync (Cross-device cloud sync)
// ═══════════════════════════════════════════════
// Stores PWA Dexie records in SQLite for two-way sync.
// Auth handled by server.js apiKeyAuth middleware.

const express = require('express');

const PAGE_SIZE = 5000;

module.exports = function (db, broadcast) {
  const router = express.Router();

  // ── Ensure sync_records table exists ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      UNIQUE(table_name, sync_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_by_time
      ON sync_records(table_name, updated_at);
    CREATE INDEX IF NOT EXISTS idx_sync_by_device
      ON sync_records(device_id, updated_at);
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO sync_records (sync_id, table_name, data, updated_at, device_id, received_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(table_name, sync_id) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at,
      device_id = excluded.device_id,
      received_at = excluded.received_at
    WHERE excluded.updated_at >= sync_records.updated_at
  `);

  const pullStmt = db.prepare(`
    SELECT table_name, data FROM sync_records
    WHERE updated_at > ?
    ORDER BY updated_at ASC
    LIMIT ?
  `);

  const countStmt = db.prepare(`
    SELECT table_name, COUNT(*) as cnt FROM sync_records GROUP BY table_name
  `);

  const lastActivityStmt = db.prepare(`
    SELECT MAX(received_at) as last_activity FROM sync_records
  `);

  // POST /api/sync/push — receive changed records from a device
  router.post('/push', (req, res) => {
    try {
      const { deviceId, tables } = req.body;
      if (!deviceId || !tables || typeof tables !== 'object') {
        return res.status(400).json({ error: 'deviceId and tables object required' });
      }

      const now = Date.now();
      let upserted = 0;

      const runUpserts = db.transaction(() => {
        for (const [tableName, records] of Object.entries(tables)) {
          if (!Array.isArray(records)) continue;
          for (const rec of records) {
            if (!rec.syncId || !rec.syncUpdatedAt) continue;
            upsertStmt.run(
              rec.syncId,
              tableName,
              JSON.stringify(rec),
              rec.syncUpdatedAt,
              deviceId,
              now
            );
            upserted++;
          }
        }
      });

      runUpserts();

      if (upserted > 0 && typeof broadcast === 'function') {
        broadcast({ type: 'SYNC_PUSH', deviceId, records: upserted, timestamp: now });
      }

      res.json({ ok: true, upserted, serverTime: now });
    } catch (err) {
      console.error('  [Sync] Push failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/sync/pull — return records changed since timestamp
  router.get('/pull', (req, res) => {
    try {
      const since = parseInt(req.query.since) || 0;
      const rows = pullStmt.all(since, PAGE_SIZE + 1);

      const hasMore = rows.length > PAGE_SIZE;
      const results = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

      // Group by table name
      const tables = {};
      let maxUpdatedAt = since;
      for (const row of results) {
        if (!tables[row.table_name]) tables[row.table_name] = [];
        const parsed = JSON.parse(row.data);
        tables[row.table_name].push(parsed);
        if (parsed.syncUpdatedAt > maxUpdatedAt) {
          maxUpdatedAt = parsed.syncUpdatedAt;
        }
      }

      res.json({
        tables,
        serverTime: maxUpdatedAt,
        hasMore,
        totalReturned: results.length,
      });
    } catch (err) {
      console.error('  [Sync] Pull failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/sync/status — record counts and last activity
  router.get('/status', (req, res) => {
    try {
      const counts = {};
      let total = 0;
      for (const row of countStmt.all()) {
        counts[row.table_name] = row.cnt;
        total += row.cnt;
      }

      const lastRow = lastActivityStmt.get();
      const lastActivity = lastRow?.last_activity || null;

      res.json({
        tables: counts,
        totalRecords: total,
        lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
