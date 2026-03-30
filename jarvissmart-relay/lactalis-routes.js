// ═══════════════════════════════════════════════
// ROUTES — /api/lactalis (Lactalis Portal Relay)
// ═══════════════════════════════════════════════
// Relays order submission and delivery slot queries
// to mylactalis.com.au via Playwright sessions.
//
// Auth handled by server.js apiKeyAuth middleware (JARVIS_API_KEY).

const crypto = require('crypto');
const express = require('express');
const lactalis = require('../services/lactalis-session');

module.exports = function (db, broadcast) {
  const router = express.Router();

  // ── Async order jobs ──
  const orderJobs = new Map(); // jobId → { status, result?, error?, startedAt }

  // Cleanup jobs older than 15 minutes every 60s
  setInterval(() => {
    const cutoff = Date.now() - 15 * 60_000;
    for (const [id, job] of orderJobs) {
      if (job.startedAt < cutoff) orderJobs.delete(id);
    }
  }, 60_000);

  // GET /api/lactalis/health — session & system status (no Playwright)
  router.get('/health', (req, res) => {
    try {
      const status = lactalis.checkConnection();
      res.json(status);
    } catch (err) {
      res.json({ configured: false, error: err.message });
    }
  });

  // POST /api/lactalis/login — force a fresh Playwright login
  router.post('/login', async (req, res) => {
    try {
      await lactalis.login();
      res.json({ success: true, message: 'Logged in to Lactalis portal' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/lactalis/submit-order — full Playwright session to submit
  // Body: { lines: [{ itemNumber: "801", qty: 3 }, ...] }
  router.post('/submit-order', async (req, res) => {
    const startTime = Date.now();
    const itemCount = req.body?.lines?.length || 0;
    console.log(`  [Lactalis] ▶ Order request received (${itemCount} lines)`);

    try {
      const { lines } = req.body;
      if (!Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({ success: false, error: 'lines array is required' });
      }

      for (const line of lines) {
        if (!line.itemNumber || typeof line.qty !== 'number' || line.qty < 0) {
          return res.status(400).json({
            success: false,
            error: `Invalid line: ${JSON.stringify(line)} — need itemNumber (string) and qty (number)`,
          });
        }
      }

      const result = await lactalis.submitOrder(lines);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  [Lactalis] ✓ Order response sent (${elapsed}s, success: ${result.success})`);

      if (typeof broadcast === 'function') {
        broadcast({
          type: 'LACTALIS_ORDER_SUBMITTED',
          items: lines.filter(l => l.qty > 0).length,
          timestamp: Date.now(),
        });
      }

      res.json(result);
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`  [Lactalis] ✗ Order failed after ${elapsed}s:`, err.message);
      res.status(502).json({ success: false, error: err.message });
    }
  });

  // POST /api/lactalis/submit-order-async — returns jobId immediately, poll for result
  router.post('/submit-order-async', (req, res) => {
    const { lines } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ success: false, error: 'lines array is required' });
    }
    for (const line of lines) {
      if (!line.itemNumber || typeof line.qty !== 'number' || line.qty < 0) {
        return res.status(400).json({
          success: false,
          error: `Invalid line: ${JSON.stringify(line)} — need itemNumber (string) and qty (number)`,
        });
      }
    }

    const jobId = crypto.randomUUID();
    const itemCount = lines.length;
    console.log(`  [Lactalis] ▶ Async order ${jobId.slice(0, 8)} received (${itemCount} lines)`);
    orderJobs.set(jobId, { status: 'processing', startedAt: Date.now() });

    // Fire and forget — client polls /order-status/:jobId
    lactalis.submitOrder(lines)
      .then(result => {
        const elapsed = ((Date.now() - orderJobs.get(jobId)?.startedAt) / 1000).toFixed(1);
        console.log(`  [Lactalis] ✓ Async order ${jobId.slice(0, 8)} done (${elapsed}s, success: ${result.success})`);
        orderJobs.set(jobId, { status: 'done', result, startedAt: orderJobs.get(jobId)?.startedAt || Date.now() });
        if (typeof broadcast === 'function') {
          broadcast({
            type: 'LACTALIS_ORDER_SUBMITTED',
            items: lines.filter(l => l.qty > 0).length,
            timestamp: Date.now(),
          });
        }
      })
      .catch(err => {
        const elapsed = ((Date.now() - orderJobs.get(jobId)?.startedAt) / 1000).toFixed(1);
        console.error(`  [Lactalis] ✗ Async order ${jobId.slice(0, 8)} failed (${elapsed}s): ${err.message}`);
        orderJobs.set(jobId, { status: 'failed', error: err.message, startedAt: orderJobs.get(jobId)?.startedAt || Date.now() });
      });

    res.json({ jobId });
  });

  // GET /api/lactalis/order-status/:jobId — poll for async order result
  router.get('/order-status/:jobId', (req, res) => {
    const job = orderJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found or expired' });

    const elapsed = Math.round((Date.now() - job.startedAt) / 1000);

    if (job.status === 'processing') {
      return res.json({ status: 'processing', elapsed });
    }
    if (job.status === 'done') {
      return res.json({ status: 'done', success: true, ...job.result });
    }
    // failed
    return res.json({ status: 'failed', success: false, error: job.error, elapsed });
  });

  // POST /api/lactalis/reset-backoff — manually clear login backoff counter
  router.post('/reset-backoff', (req, res) => {
    if (lactalis.resetBackoff) {
      lactalis.resetBackoff();
      res.json({ success: true, message: 'Login backoff counter reset' });
    } else {
      res.json({ success: true, message: 'No resetBackoff function available' });
    }
  });

  // GET /api/lactalis/delivery-slots — cached, refreshed every 24h
  router.get('/delivery-slots', async (req, res) => {
    try {
      const data = await lactalis.getDeliverySlots();
      const nextAvailable = data.slots.find(s => s.status === 1) || null;

      res.json({
        slots: data.slots,
        nextDelivery: nextAvailable,
        count: data.slots.length,
        cachedAt: data.cachedAt,
        stale: data.stale || false,
      });
    } catch (err) {
      console.error('  [Lactalis] Delivery slots fetch failed:', err.message);
      res.status(502).json({ error: 'Could not fetch delivery slots', detail: err.message });
    }
  });

  // GET /api/lactalis/refresh-slots — force slot cache refresh
  router.get('/refresh-slots', async (req, res) => {
    try {
      const data = await lactalis.getDeliverySlots(true);
      const nextAvailable = data.slots.find(s => s.status === 1) || null;

      res.json({
        slots: data.slots,
        nextDelivery: nextAvailable,
        count: data.slots.length,
        cachedAt: data.cachedAt,
        stale: false,
        message: 'Slot cache refreshed',
      });
    } catch (err) {
      console.error('  [Lactalis] Slot refresh failed:', err.message);
      res.status(502).json({ error: 'Could not refresh delivery slots', detail: err.message });
    }
  });

  return router;
};
