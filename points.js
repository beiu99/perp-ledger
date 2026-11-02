// Only the DEXs with a points program running now. None of them publish a wallet's points.
export const ARCUS_SEASON_START = Date.UTC(2026, 9, 1);

export const PROGRAMS = [
  { id: 'arcus', name: 'Arcus', url: 'https://app.arcus.xyz/rewards', scope: 'Season 1, since 1 Oct 2026', label: 'Your Season 1 points' },
  { id: 'risex', name: 'RISEx', url: 'https://rise.trade/points', scope: 'Lifetime', label: 'Your total points' },
  { id: 'variational', name: 'Variational', url: 'https://omni.variational.io/points', scope: 'Dates in your CSVs', label: 'Your total points' },
  { id: 'ondo', name: 'Ondo', url: 'https://app.ondoperps.xyz/points', scope: 'Your own figures', label: 'Your total points' },
];

export function seasonStats(fills, start, capped) {
  const inSeason = fills.filter((f) => f.time >= start);
  const oldest = fills.length ? Math.min(...fills.map((f) => f.time)) : Infinity;
  return {
    fees: inSeason.reduce((sum, f) => sum + f.fee, 0),
    volume: inSeason.reduce((sum, f) => sum + f.notional, 0),
    pnl: inSeason.reduce((sum, f) => sum + f.netPnl, 0),
    incomplete: capped && oldest > start,
  };
}

function figures(id, venue, manualFees) {
  if (id === 'arcus') return venue.season ?? null;
  if (id === 'risex' && venue.fees) {
    return { fees: venue.fees.value, volume: venue.volume?.all ?? null, pnl: venue.pnl?.all ?? null };
  }
  if (id === 'variational' && (venue.fees || venue.volume)) {
    const fees = venue.fees?.value ?? null;
    const pnl = venue.pnl?.all ?? null;
    return { fees, volume: venue.volume?.all ?? null, pnl: pnl === null || fees === null ? null : pnl - fees };
  }
  if (id === 'ondo' && manualFees !== null) return { fees: manualFees, volume: null, pnl: null };
  return null;
}

export function pointsRow(program, venue, { points = null, fees = null } = {}) {
  const f = figures(program.id, venue, fees);
  const hasPoints = points !== null && points > 0;
  return {
    ...program,
    fees: f?.fees ?? null,
    volume: f?.volume ?? null,
    pnl: f?.pnl ?? null,
    incomplete: Boolean(f?.incomplete),
    points,
    costPerPoint: hasPoints && f?.fees !== null && f?.fees !== undefined ? f.fees / points : null,
    costAfterPnl: hasPoints && f?.pnl !== null && f?.pnl !== undefined ? -f.pnl / points : null,
  };
}
