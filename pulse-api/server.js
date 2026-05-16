const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { Pool } = require('pg');

const app = express();
app.use(cors()); // Moved to top
app.use(express.json());

const PORT = process.env.PORT || 8080;
const GAMMA = 'https://gamma-api.polymarket.com';

// ── Postgres ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rounds (
      slug         TEXT PRIMARY KEY,
      outcome      TEXT NOT NULL,
      up_price     REAL NOT NULL,
      round_ts     BIGINT NOT NULL,
      round_date   TIMESTAMP NOT NULL,
      inserted_at  TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rounds_date ON rounds (round_date DESC);
  `);
  console.log('✅ DB ready');
}

// ── In-memory cache for fast responses ───────────────────────────────────────
let cache = { data: [], lastFetched: null, fetchCount: 0, status: 'initializing' };

// ── Manual CORS (Backup) ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Fetch + persist new rounds ────────────────────────────────────────────────
async function fetchAndStore() {
  try {
    console.log(`[${new Date().toISOString()}] Fetching from: ${GAMMA}/events?series_slug=btc-updown-5m&closed=true&limit=100`);
    const resp = await fetch(
      `${GAMMA}/events?series_slug=btc-updown-5m&closed=true&limit=100&order=endDate&ascending=false`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!resp.ok) throw new Error(`Upstream ${resp.status}`);
    const events = await resp.json();
    console.log(`[DEBUG] Received ${events.length} events from Polymarket`);

    // Filter only resolved rounds (one side must be > 0.9 or < 0.1)
    const resolved = events.filter(ev => {
      try {
        const m = ev.markets?.[0];
        if (!m || !m.closed) return false;
        const prices = JSON.parse(m.outcomePrices || '[]');
        return parseFloat(prices[0]) > 0.9 || parseFloat(prices[1]) > 0.9;
      } catch { return false; }
    });

    let newCount = 0;

    for (const ev of resolved) {
      const prices = JSON.parse(ev.markets?.[0]?.outcomePrices || '[]');
      const upPrice = parseFloat(prices[0]) || 0.5;
      const outcome = parseFloat(prices[0]) > 0.9 ? 'UP' : 'DOWN';
      const slug = ev.slug || '';
      const roundTs = parseInt(slug.split('-').pop()) || 0;
      const roundDate = roundTs ? new Date(roundTs * 1000) : new Date(ev.startDate || Date.now());

      const result = await pool.query(
        `INSERT INTO rounds (slug, outcome, up_price, round_ts, round_date)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slug) DO NOTHING`,
        [slug, outcome, upPrice, roundTs, roundDate]
      );
      if (result.rowCount > 0) newCount++;
    }

    // Update in-memory cache from DB (all historical rounds)
    const dbRows = await pool.query(
      `SELECT slug, outcome, up_price AS "upP", round_ts AS ts, round_date AS date
       FROM rounds ORDER BY round_ts ASC`
    );
    cache.data = dbRows.rows;
    cache.lastFetched = new Date().toISOString();
    cache.fetchCount++;
    cache.status = 'ok';

    console.log(`[${cache.lastFetched}] ✅ +${newCount} new | ${cache.data.length} total rounds in DB`);
  } catch (err) {
    cache.status = 'error';
    console.error(`[${new Date().toISOString()}] ❌ Error:`, err.message);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// All historical rounds from DB — used by calendar
app.get('/rounds', async (req, res) => {
  try {
    // Optional ?days=30 filter
    const days = parseInt(req.query.days) || null;
    let rows;
    if (days) {
      rows = await pool.query(
        `SELECT slug, outcome, up_price AS "upP", round_ts AS ts,
                round_date AS date
         FROM rounds
         WHERE round_date >= NOW() - INTERVAL '${days} days'
         ORDER BY round_ts ASC`
      );
    } else {
      rows = await pool.query(
        `SELECT slug, outcome, up_price AS "upP", round_ts AS ts,
                round_date AS date
         FROM rounds ORDER BY round_ts ASC`
      );
    }
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(rows.rows);
  } catch (err) {
    // Fall back to in-memory cache
    res.json(cache.data);
  }
});

// Stats endpoint
app.get('/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE outcome='UP') AS up_wins,
        COUNT(*) FILTER (WHERE outcome='DOWN') AS down_wins,
        MIN(round_date) AS oldest,
        MAX(round_date) AS newest,
        COUNT(DISTINCT DATE(round_date)) AS days_covered
      FROM rounds
    `);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: cache.status,
    lastFetched: cache.lastFetched,
    fetchCount: cache.fetchCount,
    cachedRounds: cache.data.length,
    uptime: Math.round(process.uptime()) + 's',
    db: !!process.env.DATABASE_URL ? 'connected' : 'missing',
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Polymarket Pulse · Data API',
    endpoints: {
      '/rounds': 'GET — all historical rounds from DB',
      '/rounds?days=30': 'GET — filter last N days',
      '/stats': 'GET — aggregate stats',
      '/health': 'GET — service health',
    },
    cache: { lastFetched: cache.lastFetched, rounds: cache.data.length },
  });
});

// ── Cron: every 5 minutes ─────────────────────────────────────────────────────
cron.schedule('*/5 * * * *', fetchAndStore);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 Polymarket Pulse API on port ${PORT}`);
  await initDB();
  await fetchAndStore(); // seed DB immediately on startup
});
