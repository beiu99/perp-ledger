import { num, summarizeFills, lastValue, DAY_MS } from './stats.js';

const URL_INFO = 'https://api.hyperliquid.xyz/info';
const FUNDING_PAGE = 500;
const FUNDING_MAX_PAGES = 6;

async function info(body, fetchImpl) {
  const res = await fetchImpl(URL_INFO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 429) throw new Error('Hyperliquid is limiting requests from this browser. Wait a minute and look up again.');
  if (!res.ok) throw new Error(`Hyperliquid answered ${res.status}.`);
  return res.json();
}

const series = (points) => (points ?? []).map(([t, v]) => [t, num(v)]);

export function normalizeFill(f) {
  const notional = num(f.px) * num(f.sz);
  const fee = num(f.fee);
  return {
    time: f.time,
    market: f.coin,
    notional,
    fee,
    netPnl: num(f.closedPnl) - fee,
    closing: /Close|Liquidat|>/.test(f.dir ?? ''),
    maker: f.crossed === false,
    orderId: f.oid,
    liquidation: Boolean(f.liquidation),
  };
}

// Spot fills use names such as @107 or PURR/USDC and are left out of perp stats.
const isPerpFill = (f) => !f.coin.startsWith('@') && !f.coin.includes('/');

export function normalizePosition({ position: p }) {
  const size = num(p.szi);
  return {
    market: p.coin,
    side: size >= 0 ? 'Long' : 'Short',
    size: Math.abs(size),
    entry: num(p.entryPx),
    notional: num(p.positionValue),
    unrealizedPnl: num(p.unrealizedPnl),
    leverage: p.leverage?.value ?? null,
    liquidation: p.liquidationPx ? num(p.liquidationPx) : null,
  };
}

async function fundingSince(user, startTime, fetchImpl) {
  let total = 0;
  let cursor = startTime;
  for (let page = 0; page < FUNDING_MAX_PAGES; page += 1) {
    const rows = await info({ type: 'userFunding', user, startTime: cursor }, fetchImpl);
    for (const row of rows) total += num(row.delta?.usdc);
    if (rows.length < FUNDING_PAGE) return { value: total, complete: true };
    cursor = rows[rows.length - 1].time + 1;
  }
  return { value: total, complete: false };
}

export async function loadHyperliquid(user, { fetchImpl = fetch, now = Date.now() } = {}) {
  const [portfolio, fills, dexes] = await Promise.all([
    info({ type: 'portfolio', user }, fetchImpl),
    info({ type: 'userFills', user, aggregateByTime: true }, fetchImpl),
    info({ type: 'perpDexs' }, fetchImpl),
  ]);
  const names = ['', ...dexes.filter(Boolean).map((d) => d.name)];
  const states = await Promise.all(
    names.map((dex) => info({ type: 'clearinghouseState', user, dex }, fetchImpl).catch(() => null)),
  );
  const funding = await fundingSince(user, now - 30 * DAY_MS, fetchImpl).catch(() => null);

  const period = (name) => portfolio.find(([key]) => key === name)?.[1];
  const week = period('perpWeek');
  const month = period('perpMonth');
  const allTime = period('perpAllTime');
  const combined = period('allTime');

  const readable = states.filter(Boolean);
  const positions = readable.flatMap((s) => s.assetPositions.map(normalizePosition));
  const perpValue = readable.reduce((sum, s) => sum + num(s.marginSummary?.accountValue), 0);
  const accountValue = perpValue > 0 ? perpValue : lastValue(series(combined?.accountValueHistory)) ?? 0;

  const perpFills = fills.filter(isPerpFill).map(normalizeFill);
  const volumeAll = num(allTime?.vlm);

  if (volumeAll === 0 && perpFills.length === 0 && accountValue === 0) {
    return { status: 'empty', message: 'No Hyperliquid perp activity for this wallet.' };
  }

  const pnlSeries = {
    d7: series(week?.pnlHistory),
    d30: series(month?.pnlHistory),
    all: series(allTime?.pnlHistory),
  };

  return {
    status: states.every(Boolean) ? 'live' : 'partial',
    message: states.every(Boolean) ? null : 'Some builder-deployed markets could not be read.',
    accountValue,
    unrealizedPnl: positions.reduce((sum, p) => sum + p.unrealizedPnl, 0),
    pnl: { d7: lastValue(pnlSeries.d7), d30: lastValue(pnlSeries.d30), all: lastValue(pnlSeries.all) },
    volume: { d30: num(month?.vlm), all: volumeAll },
    fees: null,
    funding30d: funding,
    positions,
    trades: summarizeFills(perpFills, { capped: fills.length >= 2000 }),
    series: pnlSeries,
  };
}
