const GAMMA = 'https://gamma-api.polymarket.com';

export default async function handler(req, res) {
  try {
    const resp = await fetch(
      `${GAMMA}/events?series_slug=btc-up-or-down-5m&limit=60&order=startDate&ascending=false&closed=true`,
      { headers: { 'Accept': 'application/json' } }
    );

    if (!resp.ok) {
      return res.status(resp.status).json({ error: 'Upstream error', status: resp.status });
    }

    const data = await resp.json();

    // Cache at Vercel edge for 5 minutes, serve stale for 10 min while revalidating
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
