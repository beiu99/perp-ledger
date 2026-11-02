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

export function fromOndo(raw, { now = Date.now() } = {}) {
  const fills = raw.fills.map(ondoFill);
  const positions = raw.positions.filter((p) => p.direction !== 'neutral').map(ondoPosition);
  const b = raw.balance ?? {};
  return {
    status: 'live',
    message: null,
    private: true,
    accountValue: num(b.marginBalance),
    unrealizedPnl: num(b.unrealizedPnl),
    // totalPnL already includes open positions, fees and funding.
    pnl: { d7: windowed(fills, 7, now).pnl, d30: windowed(fills, 30, now).pnl, all: num(b.totalPnL) },
    volume: {
      d30: windowed(fills, 30, now).volume,
      all: raw.capped ? null : fills.reduce((sum, f) => sum + f.notional, 0),
    },
    fees: { value: num(b.totalTradingFees), scope: 'lifetime' },
    funding30d: null,
    positions,
    trades: summarizeFills(fills, { capped: raw.capped }),
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

export function fromQfex(raw) {
  const fills = raw.trades.map(qfexFill);
  const positions = (raw.positions?.positions ?? []).filter((p) => num(p.position) !== 0).map(qfexPosition);
  const balance = raw.positions?.balance ?? {};
  const pnlSeries = { d7: series(raw.pnl?.d7), d30: series(raw.pnl?.d30), all: series(raw.pnl?.all) };
  const equity = lastValue(series(raw.equity));
  const fees = fills.reduce((sum, f) => sum + f.fee, 0);
  return {
    status: 'live',
    message: null,
    private: true,
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

export async function loadPrivate(dex, address, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`/api/private?dex=${dex}&address=${address}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${dex} could not be read.`);
  if (!body.available) return null;
  return dex === 'ondo' ? fromOndo(body.data) : fromQfex(body.data);
}
