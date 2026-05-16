const express = require('express');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3001;
const GAMMA = 'https://gamma-api.polymarket.com';

// ── In-memory cache ──────────────────────────────────────────────────────────
let cache = {
  data: [],
  lastFetched: null,
  fetchCount: 0,
  status: 'initializing',
};

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Fetch from Polymarket ─────────────────────────────────────────────────────
async function fetchRounds() {
  try {
    console.log(`[${new Date().toISOString()}] Fetching rounds from Polymarket…`);
    const resp = await fetch(
      `${GAMMA}/events?series_slug=btc-up-or-down-5m&limit=500&order=startDate&ascending=false`
    );
    if (!resp.ok) throw new Error(`Upstream ${resp.status}`);
    const data = await resp.json();
    cache.data = data;
    cache.lastFetched = new Date().toISOString();
    cache.fetchCount++;
    cache.status = 'ok';
    console.log(`[${cache.lastFetched}] ✅ Cached ${data.length} events (#${cache.fetchCount})`);
  } catch (err) {
    cache.status = 'error';
    console.error(`[${new Date().toISOString()}] ❌ Fetch failed:`, err.message);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────
// Main data endpoint — used by Vercel dashboard
app.get('/rounds', (req, res) => {
  if (!cache.lastFetched) {
    return res.status(503).json({ error: 'Cache warming up, try again in 10 seconds' });
  }
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(cache.data);
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: cache.status,
    lastFetched: cache.lastFetched,
    fetchCount: cache.fetchCount,
    cachedEvents: cache.data.length,
    uptime: Math.round(process.uptime()) + 's',
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Polymarket Pulse · Data API',
    endpoints: {
      '/rounds': 'GET — cached BTC 5m round events (limit 500)',
      '/health': 'GET — service health & cache status',
    },
    cache: {
      lastFetched: cache.lastFetched,
      events: cache.data.length,
      refreshInterval: 'every 5 minutes',
    },
  });
});

// ── Cron: every 5 minutes ─────────────────────────────────────────────────────
cron.schedule('*/5 * * * *', fetchRounds);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 Polymarket Pulse API running on port ${PORT}`);
  // Fetch immediately on startup
  await fetchRounds();
});
