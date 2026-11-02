export async function loadQfex(username, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`/api/qfex?username=${encodeURIComponent(username)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? 'QFEX could not be read.');
  if (!body.found) {
    return { status: 'empty', message: `${username} is not in any QFEX top 100 right now.` };
  }
  const { entries } = body;
  const latest = entries.all ?? entries['1m'] ?? entries['1w'];
  return {
    status: 'partial',
    message: 'QFEX only publishes its top 100, so this shows leaderboard figures.',
    accountValue: latest.endEquity,
    unrealizedPnl: null,
    pnl: { d7: entries['1w']?.pnl ?? null, d30: entries['1m']?.pnl ?? null, all: entries.all?.pnl ?? null },
    volume: null,
    fees: null,
    funding30d: null,
    positions: [],
    trades: null,
    series: null,
    rank: entries.all?.rank ?? entries['1m']?.rank ?? entries['1w']?.rank,
  };
}
