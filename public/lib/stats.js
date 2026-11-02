export const num = (value) => {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

export const DAY_MS = 86_400_000;

// A fill: { time, market, side, notional, fee, netPnl, closing, maker, orderId, liquidation }
export function summarizeFills(fills, { capped = false } = {}) {
  if (fills.length === 0) return null;
  const markets = new Map();
  const closes = new Map();
  let volume = 0;
  let fees = 0;
  let netPnl = 0;
  let makerVolume = 0;
  let liquidations = 0;
  let from = Infinity;
  let to = -Infinity;

  for (const f of fills) {
    volume += f.notional;
    fees += f.fee;
    netPnl += f.netPnl;
    if (f.maker) makerVolume += f.notional;
    if (f.liquidation) liquidations += 1;
    from = Math.min(from, f.time);
    to = Math.max(to, f.time);

    const market = markets.get(f.market) ?? { market: f.market, volume: 0, netPnl: 0, fills: 0 };
    market.volume += f.notional;
    market.netPnl += f.netPnl;
    market.fills += 1;
    markets.set(f.market, market);

    // One order can close across many fills, and it should count as one trade.
    if (f.closing) {
      const key = `${f.market}|${f.orderId}`;
      closes.set(key, (closes.get(key) ?? 0) + f.netPnl);
    }
  }

  const results = [...closes.values()];
  const wins = results.filter((r) => r > 0);
  const losses = results.filter((r) => r < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);

  return {
    fillCount: fills.length,
    capped,
    from,
    to,
    volume,
    fees,
    netPnl,
    closedTrades: results.length,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length + losses.length > 0 ? wins.length / (wins.length + losses.length) : null,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    best: results.length ? Math.max(...results) : null,
    worst: results.length ? Math.min(...results) : null,
    makerShare: volume > 0 && fills.some((f) => f.maker !== null) ? makerVolume / volume : null,
    liquidations,
    markets: [...markets.values()].sort((a, b) => b.volume - a.volume),
  };
}

export const lastValue = (series) => (series?.length ? series[series.length - 1][1] : null);

// Adds cumulative series that were sampled at different times.
export function mergeSeries(list) {
  const active = list.filter((s) => s?.length);
  if (active.length === 0) return [];
  const times = [...new Set(active.flatMap((s) => s.map(([t]) => t)))].sort((a, b) => a - b);
  const cursors = active.map(() => 0);
  return times.map((time) => {
    let total = 0;
    active.forEach((series, i) => {
      while (cursors[i] + 1 < series.length && series[cursors[i] + 1][0] <= time) cursors[i] += 1;
      if (series[cursors[i]][0] <= time) total += series[cursors[i]][1];
    });
    return [time, total];
  });
}

export function sumKnown(values) {
  const known = values.filter((v) => v !== null && v !== undefined);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

export function combine(venues) {
  const live = venues.filter((v) => v.status === 'live' || v.status === 'partial');
  return {
    covered: live.length,
    total: venues.length,
    accountValue: sumKnown(live.map((v) => v.accountValue)),
    unrealizedPnl: sumKnown(live.map((v) => v.unrealizedPnl)),
    pnl: {
      d7: sumKnown(live.map((v) => v.pnl?.d7)),
      d30: sumKnown(live.map((v) => v.pnl?.d30)),
      all: sumKnown(live.map((v) => v.pnl?.all)),
    },
    volume: {
      d30: sumKnown(live.map((v) => v.volume?.d30)),
      all: sumKnown(live.map((v) => v.volume?.all)),
    },
  };
}
