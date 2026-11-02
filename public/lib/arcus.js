import { num, summarizeFills, lastValue, DAY_MS } from './stats.js';
import { ARCUS_SEASON_START, seasonStats } from './points.js';

const BASE = 'https://api.arcus.xyz';
const QUANTUM = 1e9;
const PAGE = 1000;
const FILL_MAX_PAGES = 5;
const FUNDING_MAX_PAGES = 3;
// Arcus rejects small values for `from`, and it defaults to 30 days without one.
const EARLIEST_MICROS = 1_000_000_000_000_000;

class ArcusError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function get(path, params, fetchImpl) {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (res.status === 429) throw new ArcusError(429, 'Arcus is limiting requests from this browser. Wait a minute and look up again.');
  if (!res.ok) throw new ArcusError(res.status, `Arcus answered ${res.status}.`);
  return res.json();
}

const series = (points) => (points ?? []).map(([t, v]) => [Math.floor(t / 1000), num(v)]);

export function normalizeFill(f) {
  const liquidation = Boolean(f.liquidation);
  return {
    time: Math.floor(f.createdAt / 1000),
    market: f.marketDisplayName,
    notional: num(f.price) * num(f.size),
    fee: num(f.fee),
    // Arcus already takes the fee out of closedPnl, except the penalty on liquidations.
    netPnl: num(f.closedPnl),
    closing: !/^(OPEN|ADD)/.test(f.positionEffect ?? ''),
    maker: f.role === 'MAKER',
    orderId: f.orderId,
    liquidation,
  };
}

export function normalizePosition(p) {
  const size = num(p.size);
  const entry = num(p.averageEntryPrice);
  return {
    market: p.marketDisplayName,
    side: (p.side ?? '').toUpperCase() === 'SHORT' || size < 0 ? 'Short' : 'Long',
    size: Math.abs(size),
    entry,
    notional: Math.abs(num(p.positionValueNotional)) || Math.abs(size * num(p.markPx || entry)),
    unrealizedPnl: num(p.unrealizedPnl),
    leverage: p.leverage ? num(p.leverage) : null,
    liquidation: null,
  };
}

async function allFills(address, fetchImpl) {
  const seen = new Map();
  let to;
  for (let page = 0; page < FILL_MAX_PAGES; page += 1) {
    const params = { address, limit: PAGE, from: EARLIEST_MICROS };
    if (to) params.to = to;
    const { fills = [] } = await get('/v1/fills', params, fetchImpl);
    for (const fill of fills) seen.set(fill.tradeId, fill);
    if (fills.length < PAGE) return { fills: [...seen.values()], capped: false };
    to = Math.min(...fills.map((f) => f.createdAt));
  }
  return { fills: [...seen.values()], capped: true };
}

async function fundingSince(address, fromMs, fetchImpl) {
  const seen = new Map();
  let to;
  for (let page = 0; page < FUNDING_MAX_PAGES; page += 1) {
    const params = { address, limit: PAGE, from: fromMs * 1000 };
    if (to) params.to = to;
    const { fundingPayments = [] } = await get('/v1/funding', params, fetchImpl);
    for (const row of fundingPayments) seen.set(`${row.marketId}|${row.time}`, num(row.payment));
    if (fundingPayments.length < PAGE) {
      return { value: [...seen.values()].reduce((a, b) => a + b, 0), complete: true };
    }
    to = Math.min(...fundingPayments.map((row) => row.time));
  }
  return { value: [...seen.values()].reduce((a, b) => a + b, 0), complete: false };
}

export async function loadArcus(address, { fetchImpl = fetch, now = Date.now() } = {}) {
  let account;
  try {
    account = await get('/v1/account', { address }, fetchImpl);
  } catch (error) {
    if (error.status === 404) return { status: 'empty', message: 'No Arcus activity for this wallet.' };
    if (error.status === 403) {
      return {
        status: 'blocked',
        message: 'Arcus only shares data for wallets it has approved. This wallet is not approved, so its Arcus stats are unknown.',
      };
    }
    throw error;
  }

  const [stats, portfolio, fillResult, funding] = await Promise.all([
    get('/v1/account/stats', { address }, fetchImpl).catch(() => null),
    get('/v1/portfolio', { address }, fetchImpl).catch(() => null),
    allFills(address, fetchImpl).catch(() => null),
    fundingSince(address, now - 30 * DAY_MS, fetchImpl).catch(() => null),
  ]);

  const period = (name) => portfolio?.data?.find(([key]) => key === name)?.[1];
  const pnlSeries = {
    d7: series(period('perpWeek')?.pnlHistory),
    d30: series(period('perpMonth')?.pnlHistory),
    all: series(period('perpAll')?.pnlHistory),
  };
  const positions = Object.values(account.positions ?? {}).map(normalizePosition);
  const missing = !stats || !portfolio || !fillResult;
  const fills = fillResult?.fills.map(normalizeFill) ?? null;

  return {
    status: missing ? 'partial' : 'live',
    message: missing ? 'Some Arcus figures could not be read.' : null,
    accountValue: num(account.equity),
    unrealizedPnl: positions.reduce((sum, p) => sum + p.unrealizedPnl, 0),
    pnl: {
      d7: lastValue(pnlSeries.d7),
      d30: lastValue(pnlSeries.d30),
      all: lastValue(pnlSeries.all),
    },
    volume: {
      d30: stats ? num(stats.rollingVolume) / QUANTUM : null,
      all: stats ? num(stats.lifetimeVolume) / QUANTUM : null,
    },
    fees: stats ? { value: num(stats.lifetimeFeesPaid) / QUANTUM, scope: 'lifetime' } : null,
    funding30d: funding,
    positions,
    trades: fills ? summarizeFills(fills, { capped: fillResult.capped }) : null,
    season: fills ? seasonStats(fills, ARCUS_SEASON_START, fillResult.capped) : null,
    series: pnlSeries,
  };
}
