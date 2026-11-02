import { num, summarizeFills, lastValue } from './stats.js';

const series = (points) => (points ?? []).map((p) => [Math.floor(num(p.timestamp) / 1e6), num(p.value)]);

export function normalizeFill(t, markets = {}) {
  return {
    time: Math.floor(num(t.time) / 1e6),
    market: (markets[t.market_id] ?? `Market ${t.market_id}`).replace('/USDC', ''),
    notional: num(t.price) * num(t.size),
    fee: num(t.fee),
    // realized_pnl already has the fee taken out. A fill closes when it trades against its position.
    netPnl: num(t.realized_pnl),
    closing: t.side !== t.position_side,
    maker: t.liquidity_indicator === 'MAKER',
    orderId: t.order_id,
    liquidation: Boolean(t.is_liquidation),
  };
}

export function normalizePosition(p) {
  const size = num(p.size);
  const entry = num(p.avg_entry_price);
  return {
    market: (p.market_name ?? '').replace('/USDC', ''),
    side: size < 0 ? 'Short' : 'Long',
    size: Math.abs(size),
    entry,
    notional: Math.abs(size * num(p.mark_price || entry)),
    unrealizedPnl: num(p.unrealized_pnl),
    leverage: num(p.leverage) || null,
    liquidation: num(p.liquidation_price) || null,
  };
}

export function fromRaw(raw) {
  const fills = (raw.trades ?? []).map((t) => normalizeFill(t, raw.markets));
  const accountValue = num(raw.summary?.total_account_value);
  const volumeAll = num(raw.totalVolume);
  if (accountValue === 0 && volumeAll === 0 && fills.length === 0) {
    return { status: 'empty', message: 'No RISEx activity for this wallet.' };
  }
  const pnlSeries = { d7: series(raw.charts?.d7), d30: series(raw.charts?.d30), all: series(raw.charts?.all) };
  return {
    status: 'live',
    message: null,
    accountValue,
    unrealizedPnl: num(raw.summary?.total_unrealized_pnl),
    pnl: { d7: lastValue(pnlSeries.d7), d30: lastValue(pnlSeries.d30), all: lastValue(pnlSeries.all) },
    volume: { d30: num(raw.volume?.d30), all: volumeAll },
    fees: { value: num(raw.totalFee), scope: 'lifetime' },
    funding30d: null,
    positions: (raw.positions ?? []).map(normalizePosition),
    trades: summarizeFills(fills, { capped: Boolean(raw.capped) }),
    series: pnlSeries,
  };
}

export async function loadRisex(address, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`/api/risex?address=${address}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? 'RISEx could not be read.');
  return fromRaw(body);
}
