// RISEx does not allow browser calls from other sites, so its wallet data is read here.
const BASE = 'https://api.rise.trade/api';
const TTL_MS = 60 * 1000;
const FILL_PAGES = 5;
const cache = new Map();

export function clearRisexCache() {
  cache.clear();
}

async function get(path, fetchImpl) {
  const res = await fetchImpl(`${BASE}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`RISEx answered ${res.status}`);
  const body = await res.json();
  return body.data;
}

const trimTrade = (t) => ({
  market_id: t.market_id,
  order_id: t.order_id,
  side: t.side,
  position_side: t.position_side,
  price: t.price,
  size: t.size,
  fee: t.fee,
  liquidity_indicator: t.liquidity_indicator,
  time: t.time,
  is_liquidation: t.is_liquidation,
  realized_pnl: t.realized_pnl,
});

async function fills(address, fetchImpl) {
  const trades = [];
  for (let page = 1; page <= FILL_PAGES; page += 1) {
    const data = await get(`/v1/trade-history?account=${address}&limit=1000&page=${page}`, fetchImpl);
    trades.push(...(data.trades ?? []).map(trimTrade));
    if (!data.has_next_page) return { trades, capped: false };
  }
  return { trades, capped: true };
}

export async function lookupRisex(address, fetchImpl = fetch) {
  const hit = cache.get(address);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const [details, header, trading, week, month, all, markets, history] = await Promise.all([
    get(`/v1/portfolio/details?account=${address}`, fetchImpl),
    get(`/v1/portfolio/header?account=${address}`, fetchImpl),
    get(`/v1/stats/user-trading?address=${address}`, fetchImpl),
    get(`/v1/portfolio/chart?account=${address}&period=1W`, fetchImpl),
    get(`/v1/portfolio/chart?account=${address}&period=1M`, fetchImpl),
    get(`/v1/portfolio/chart?account=${address}&period=ALL`, fetchImpl),
    get('/v1/markets', fetchImpl),
    fills(address, fetchImpl),
  ]);
  const data = {
    summary: details.summary,
    positions: (details.positions ?? []).filter((p) => Number(p.size) !== 0),
    volume: { d30: header.d30?.volume, all: header.all_time?.volume },
    totalFee: trading.total_fee,
    totalVolume: trading.total_volume,
    charts: { d7: week.data ?? [], d30: month.data ?? [], all: all.data ?? [] },
    markets: Object.fromEntries((markets.markets ?? []).map((m) => [m.market_id, m.display_name])),
    ...history,
  };
  cache.set(address, { at: Date.now(), data });
  return data;
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://local');
  const address = (url.searchParams.get('address') ?? '').toLowerCase();
  res.setHeader('Content-Type', 'application/json');
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Enter an EVM wallet address.' }));
    return;
  }
  try {
    const data = await lookupRisex(address);
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    res.end(JSON.stringify(data));
  } catch {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: 'RISEx did not respond. Try again in a minute.' }));
  }
}
