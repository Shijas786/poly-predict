const DA = 'https://data-api.polymarket.com';
export default async function handler(req, res) {
  const { slug, market, limit = 400 } = req.query;
  const target = market || slug;
  const resp = await fetch(`${DA}/trades?market=${target}&limit=${limit}&_=${Date.now()}`);
  const data = await resp.json();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=10');
  return res.status(200).json(data);
}
