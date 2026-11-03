import { averageOi, DAY_MS, num, summarizeFills } from './stats.js';

const BASE = 'https://indexer.api.real.xyz/api/v1';
const MAX_PAGES = 10;
const MAX_POINTS = 400;

const query = (params) =>
  Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

async function getPage(path, params, fetchImpl) {
  const res = await fetchImpl(`${BASE}${path}?${query(params)}`);
  if (res.status === 429) throw new Error('Real Markets is limiting requests from this browser. Wait a minute and look up again.');
  if (!res.ok) throw new Error(`Real Markets answered ${res.status}.`);
  return res.json();
}

async function getAll(path, params, fetchImpl) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await getPage(path, { ...params, 'p[s]': 1000, ...(cursor ? { 'p[c]': cursor } : {}) }, fetchImpl);
    rows.push(...(body.data ?? []));
    cursor = body.pagination?.next_cursor;
    if (!cursor) return { rows, capped: false };
  }
  return { rows, capped: true };
}

const shortName = (symbol) => (symbol ?? '').replace(/-USDT?$/, '');

export function normalizeFill(f, markets = {}) {
  return {
    time: f.created_at_ms,
    market: shortName(markets[f.market_id]) || 'Unknown',
    price: num(f.price),
    size: (f.direction === 'Short' ? -1 : 1) * num(f.volume),
    notional: num(f.filled_value) || num(f.price) * num(f.volume),
    // Real Markets records fees as negative numbers, and realised_pnl already includes them.
    fee: -num(f.realised_pnl_attribution?.trade_fee),
    netPnl: num(f.realised_pnl),
    closing: !/^Open/.test(f.trade_context ?? ''),
    maker: !f.is_taker,
    orderId: f.order_id,
    liquidation: /liquid/i.test(f.fill_type ?? ''),
  };
}

export function normalizePosition(p, markets = {}) {
  const live = p.live_values ?? {};
  const imr = num(p.current_imr);
  return {
    market: shortName(markets[p.market_id]) || 'Unknown',
    side: p.direction === 'Short' ? 'Short' : 'Long',
    size: Math.abs(num(p.size)),
    entry: num(p.average_entry_price),
    notional: Math.abs(num(live.notional_value)),
    unrealizedPnl: num(live.unrealised_pnl),
    leverage: imr > 0 ? Math.round(1 / imr) : null,
    liquidation: num(live.estimated_liquidation_price) || null,
  };
}

// Builds running PnL from fills and funding, so the chart ends on the account's realised PnL.
export function pnlSeries(events, since = -Infinity) {
  const inWindow = events.filter(([time]) => time >= since).sort((a, b) => a[0] - b[0]);
  if (inWindow.length === 0) return [];
  let total = 0;
  const points = [[inWindow[0][0] - 1, 0]];
  for (const [time, value] of inWindow) {
    total += value;
    points.push([time, total]);
  }
  if (points.length <= MAX_POINTS) return points;
  const step = Math.ceil(points.length / MAX_POINTS);
  return points.filter((_, i) => i % step === 0 || i === points.length - 1);
}

export function fromRaw({ accounts, positions, fills, funding, markets, capped }, { now = Date.now() } = {}) {
  const normalizedFills = fills.map((f) => normalizeFill(f, markets));
  const events = [
    ...normalizedFills.map((f) => [f.time, f.netPnl]),
    ...funding.map((p) => [p.updated_at_ms, num(p.payment)]),
  ];
  const windowPnl = (days) => {
    const since = now - days * DAY_MS;
    return events.filter(([time]) => time >= since).reduce((sum, [, value]) => sum + value, 0);
  };
  const since30 = now - 30 * DAY_MS;
  const open = positions.filter((p) => num(p.size) !== 0).map((p) => normalizePosition(p, markets));
  return {
    status: 'live',
    message: null,
    accountValue: accounts.reduce((sum, a) => sum + num(a.equity), 0),
    unrealizedPnl: accounts.reduce((sum, a) => sum + num(a.unrealised_pnl), 0),
    pnl: {
      d7: capped ? null : windowPnl(7),
      d30: capped ? null : windowPnl(30),
      // Realised PnL here already includes fees and funding.
      all: accounts.reduce((sum, a) => sum + num(a.realised_pnl), 0),
    },
    volume: {
      d30: capped ? null : normalizedFills.filter((f) => f.time >= since30).reduce((sum, f) => sum + f.notional, 0),
      all: positions.reduce((sum, p) => sum + num(p.traded_turnover), 0),
    },
    fees: { value: -positions.reduce((sum, p) => sum + num(p.realised_pnl_attribution?.trade_fee), 0), scope: 'lifetime' },
    funding30d: capped ? null : {
      value: funding.filter((p) => p.updated_at_ms >= since30).reduce((sum, p) => sum + num(p.payment), 0),
      complete: true,
    },
    positions: open,
    trades: summarizeFills(normalizedFills, { capped }),
    oi: averageOi(normalizedFills, open, { capped, now }),
    series: capped ? null : { d7: pnlSeries(events, now - 7 * DAY_MS), d30: pnlSeries(events, since30), all: pnlSeries(events) },
  };
}

// Accepts an account ID, an IOTA address or a whole profile link from the Real Markets app.
export const findAccountRef = (value) => (value ?? '').match(/0x[0-9a-fA-F]{64}/)?.[0].toLowerCase() ?? null;

async function findAccounts(ref, fetchImpl) {
  const { rows } = await getAll('/accounts', { 'f[address]': ref }, fetchImpl);
  if (rows.length > 0) return rows;
  const res = await fetchImpl(`${BASE}/accounts/${ref}`);
  if (res.status === 404 || res.status === 400) return [];
  if (!res.ok) throw new Error(`Real Markets answered ${res.status}.`);
  const body = await res.json();
  return body.data?.id ? [body.data] : [];
}

export async function loadReal(ref, { fetchImpl = fetch, now = Date.now() } = {}) {
  const accounts = await findAccounts(ref.toLowerCase(), fetchImpl);
  if (accounts.length === 0) return { status: 'empty', message: 'No Real Markets account matches this ID.' };
  const ids = accounts.map((a) => a.id).join(',');
  const [historic, live, funding, marketList, ...fillLists] = await Promise.all([
    getAll('/positions/historic', { 'f[account_ids]': ids }, fetchImpl),
    getAll('/positions/live', { 'f[account_ids]': ids }, fetchImpl),
    getAll('/funding-payments', { 'f[account_ids]': ids }, fetchImpl),
    getAll('/markets', {}, fetchImpl),
    ...accounts.map((a) => getAll(`/accounts/${a.id}/fills`, {}, fetchImpl)),
  ]);
  return fromRaw({
    accounts,
    positions: [...historic.rows, ...live.rows],
    fills: fillLists.flatMap((list) => list.rows),
    funding: funding.rows,
    markets: Object.fromEntries(marketList.rows.map((m) => [m.id, m.symbol])),
    capped: funding.capped || fillLists.some((list) => list.capped),
  }, { now });
}
