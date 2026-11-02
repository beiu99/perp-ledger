import { DAY_MS, lastValue, num, summarizeFills } from './stats.js';

const trimUsd = (market) => (market ?? '').replace(/-USD\.P$/, '').replace(/-USD$/, '');

export function ondoFill(f) {
  const pnl = num(f.pnl);
  const fee = num(f.fee) - num(f.feeRebate);
  return {
    time: Date.parse(f.time),
    market: trimUsd(f.market),
    notional: Math.abs(num(f.filledCost)),
    fee,
    netPnl: pnl - fee,
    closing: /^(close|flip)/.test(f.direction ?? ''),
    maker: Boolean(f.isMaker),
    orderId: f.orderId,
    liquidation: false,
  };
}

export function ondoPosition(p) {
  return {
    market: trimUsd(p.market),
    side: p.direction === 'short' ? 'Short' : 'Long',
    size: Math.abs(num(p.netQuantity)),
    entry: num(p.averageEntryPrice),
    notional: Math.abs(num(p.notionalValue)),
    unrealizedPnl: num(p.unrealizedPnl),
    leverage: num(p.leverage) || null,
    liquidation: num(p.liquidationPrice) || null,
  };
}

function windowed(fills, days, now) {
  const since = now - days * DAY_MS;
  const inWindow = fills.filter((f) => f.time >= since);
  return {
    pnl: inWindow.reduce((sum, f) => sum + f.netPnl, 0),
    volume: inWindow.reduce((sum, f) => sum + f.notional, 0),
  };
}

const known = (value) => (value === undefined || value === null || value === '' ? null : num(value));

// The balance arrives first, so fees and lifetime PnL show while the fills are still loading.
export function fromOndo({ balance, positions = [], fills: rawFills = null, capped = false }, { now = Date.now() } = {}) {
  const fills = rawFills?.map(ondoFill) ?? null;
  const b = balance ?? {};
  const fees = known(b.totalTradingFees);
  return {
    status: 'live',
    message: null,
    private: true,
    fillsLoading: fills === null,
    accountValue: known(b.marginBalance),
    unrealizedPnl: known(b.unrealizedPnl),
    // totalPnL already includes open positions, fees and funding.
    pnl: {
      d7: fills ? windowed(fills, 7, now).pnl : null,
      d30: fills ? windowed(fills, 30, now).pnl : null,
      all: known(b.totalPnL),
    },
    volume: fills
      ? { d30: windowed(fills, 30, now).volume, all: fills.reduce((sum, f) => sum + f.notional, 0) }
      : null,
    volumeFloor: capped,
    fees: fees === null ? null : { value: fees, scope: 'lifetime' },
    funding30d: null,
    positions: positions.filter((p) => p.direction !== 'neutral').map(ondoPosition),
    trades: fills ? summarizeFills(fills, { capped }) : null,
    series: null,
  };
}

const toMs = (value) => {
  const n = num(value);
  if (n > 1e17) return Math.floor(n / 1e6);
  if (n > 1e14) return Math.floor(n / 1e3);
  if (n > 1e11) return n;
  return n * 1000;
};

export function qfexFill(t) {
  const fee = num(t.fee);
  const realised = num(t.realised_pnl_change);
  return {
    time: toMs(t.order_timestamp),
    market: trimUsd(t.symbol),
    notional: Math.abs(num(t.price) * num(t.quantity)),
    fee,
    netPnl: realised - fee,
    closing: realised !== 0,
    maker: null,
    orderId: t.order_id,
    liquidation: Boolean(t.liquidation) && t.liquidation.toLowerCase() !== 'false' && t.liquidation.toLowerCase() !== 'none',
  };
}

export function qfexPosition(p) {
  const size = num(p.position);
  const entry = num(p.average_price);
  return {
    market: trimUsd(p.symbol),
    side: size < 0 ? 'Short' : 'Long',
    size: Math.abs(size),
    entry,
    notional: Math.abs(size * entry),
    unrealizedPnl: num(p.unrealised_pnl),
    leverage: num(p.leverage) || null,
    liquidation: null,
  };
}

const series = (body) => (body?.data ?? []).map((p) => [Date.parse(p.window_start), num(p.value)]);

// QFEX sends PnL as one change per period, like the daily bars in its app, so the total is a running sum.
export function runningTotal(points) {
  let total = 0;
  return points.map(([time, value]) => {
    total += value;
    return [time, total];
  });
}

// Temporary: QFEX's docs don't say how its PnL points add up, so this shows each reading.
export function qfexPnlCheck(raw) {
  const row = (label, body) => {
    const values = series(body).map(([, v]) => v);
    if (values.length === 0) return { label, latest: null, sum: null, change: null, count: 0 };
    return {
      label,
      latest: values[values.length - 1],
      sum: values.reduce((a, b) => a + b, 0),
      change: values[values.length - 1] - values[0],
      count: values.length,
    };
  };
  return [row('7 days', raw.pnl?.d7), row('30 days', raw.pnl?.d30), row('All time', raw.pnl?.all)];
}

export function fromQfex(raw) {
  const fills = raw.trades.map(qfexFill);
  const positions = (raw.positions?.positions ?? []).filter((p) => num(p.position) !== 0).map(qfexPosition);
  const balance = raw.positions?.balance ?? {};
  const pnlSeries = {
    d7: runningTotal(series(raw.pnl?.d7)),
    d30: runningTotal(series(raw.pnl?.d30)),
    all: runningTotal(series(raw.pnl?.all)),
  };
  const equity = lastValue(series(raw.equity));
  const fees = fills.reduce((sum, f) => sum + f.fee, 0);
  return {
    status: 'live',
    message: null,
    private: true,
    pnlCheck: qfexPnlCheck(raw),
    realisedTotal: raw.positions?.balance?.realised_pnl ?? null,
    accountValue: equity ?? num(balance.deposit) + num(balance.realised_pnl) + num(balance.unrealised_pnl) + num(balance.net_funding),
    unrealizedPnl: num(balance.unrealised_pnl),
    pnl: { d7: lastValue(pnlSeries.d7), d30: lastValue(pnlSeries.d30), all: lastValue(pnlSeries.all) },
    volume: { d30: raw.volume?.d30?.total_volume ?? null, all: raw.volume?.all?.total_volume ?? null },
    fees: raw.capped ? null : { value: fees, scope: 'lifetime' },
    funding30d: null,
    positions,
    trades: summarizeFills(fills, { capped: raw.capped }),
    series: pnlSeries,
  };
}

async function request(params, fetchImpl) {
  const res = await fetchImpl(`/api/private?${params}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? 'This DEX could not be read.');
  return body;
}

export async function loadPrivate(dex, address, { fetchImpl = fetch, onUpdate = () => {} } = {}) {
  if (dex === 'qfex') {
    const body = await request(`dex=qfex&address=${address}`, fetchImpl);
    return body.available ? fromQfex(body.data) : null;
  }
  const summary = await request(`dex=ondo&part=summary&address=${address}`, fetchImpl);
  if (!summary.available) return null;
  onUpdate(fromOndo(summary.data));
  try {
    const fills = await request(`dex=ondo&address=${address}`, fetchImpl);
    return fromOndo({ ...summary.data, ...fills.data });
  } catch (error) {
    return { ...fromOndo(summary.data), fillsLoading: false, status: 'partial', message: `Trade history could not be read. ${error.message}` };
  }
}
