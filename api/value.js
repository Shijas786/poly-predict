export default async function handler(req, res) {
  const { user } = req.query;
  const resp = await fetch(`https://data-api.polymarket.com/value?user=${user}`);
  const data = await resp.json();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60');
  return res.status(200).json(data);
}
