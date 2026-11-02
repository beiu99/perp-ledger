// QFEX blocks browser calls from other sites, so this one lookup runs on the server.
const DURATIONS = ['1w', '1m', 'all'];
const TTL_MS = 5 * 60 * 1000;
const cache = new Map();

async function leaderboard(duration, fetchImpl) {
  const hit = cache.get(duration);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const res = await fetchImpl(`https://api.qfex.com/public/leaderboard?duration=${duration}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`QFEX answered ${res.status}`);
  const body = await res.json();
  const data = Array.isArray(body.data) ? body.data : [];
  cache.set(duration, { at: Date.now(), data });
  return data;
}

export function clearCache() {
  cache.clear();
}

export async function lookup(username, fetchImpl = fetch) {
  const wanted = username.toLowerCase();
  const boards = await Promise.all(DURATIONS.map((d) => leaderboard(d, fetchImpl)));
  const entries = {};
  DURATIONS.forEach((d, i) => {
    const e = boards[i].find((row) => row.account?.username?.toLowerCase() === wanted);
    if (e) {
      entries[d] = {
        rank: e.rank,
        pnl: e.pnl,
        returnPercent: e.return_percent,
        startEquity: e.start_equity,
        endEquity: e.end_equity,
      };
    }
  });
  return { found: Object.keys(entries).length > 0, entries };
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://local');
  const username = url.searchParams.get('username') ?? '';
  res.setHeader('Content-Type', 'application/json');
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(username)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Enter a QFEX username using letters, numbers, dots, dashes or underscores.' }));
    return;
  }
  try {
    const result = await lookup(username);
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    res.end(JSON.stringify(result));
  } catch {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: 'QFEX did not respond. Try again in a minute.' }));
  }
}
