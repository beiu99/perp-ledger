// Reads your own QFEX and Ondo accounts. The keys stay in environment variables on the server.
import { createHmac, randomBytes } from 'node:crypto';
import { requireSession } from './_auth.js';

const MAX_PAGES = 10;
const ONDO_MAX_PAGES = 200;
const ONDO_BUDGET_MS = 45_000;
const timeout = () => AbortSignal.timeout(8000);

export function ondoHeaders(path, keyId, secret, now = Date.now()) {
  const timestamp = String(now);
  return {
    Accept: 'application/json',
    'ONDO-KEY-ID': keyId,
    'ONDO-TIMESTAMP': timestamp,
    'ONDO-SIGN': createHmac('sha256', secret).update(`${timestamp}GET${path}`).digest('hex'),
  };
}

export function qfexHeaders(publicKey, secret, now = Date.now(), nonce = randomBytes(16).toString('hex')) {
  const timestamp = String(Math.floor(now / 1000));
  return {
    Accept: 'application/json',
    'x-qfex-public-key': publicKey,
    'x-qfex-hmac-signature': createHmac('sha256', secret).update(`${nonce}:${timestamp}`).digest('hex'),
    'x-qfex-nonce': nonce,
    'x-qfex-timestamp': timestamp,
  };
}

class DexError extends Error {
  constructor(status, code) {
    super(`DEX answered ${status}`);
    this.status = status;
    this.code = code;
  }
}

async function failure(res) {
  const body = await res.json().catch(() => ({}));
  // Only the short code is passed on, because full error messages can quote the key ID.
  const code = typeof body.error_code === 'string' && /^[a-z0-9_]{1,60}$/i.test(body.error_code) ? body.error_code : null;
  return new DexError(res.status, code);
}

export const setting = (env, name) => (env[name] ?? '').trim();

export function failureMessage(name, error) {
  if (error.status === undefined) return `${name} did not respond. Try again in a minute.`;
  const detail = [`status ${error.status}`, error.code].filter(Boolean).join(', ');
  return `${name} rejected the request (${detail}).`;
}

export async function loadOndo(env, { part = 'fills', fetchImpl = fetch, now = Date.now } = {}) {
  const get = async (path) => {
    const res = await fetchImpl(`https://api.ondoperps.xyz${path}`, {
      headers: ondoHeaders(path, setting(env, 'ONDO_KEY_ID'), setting(env, 'ONDO_API_SECRET')),
      signal: timeout(),
    });
    if (!res.ok) throw await failure(res);
    return res.json();
  };
  if (part === 'summary') {
    const [balance, positions] = await Promise.all([get('/v1/perps/balance'), get('/v1/perps/positions')]);
    return { balance: balance.result, positions: positions.result ?? [] };
  }
  const fills = [];
  const seen = new Set();
  const deadline = now() + ONDO_BUDGET_MS;
  let cursor = null;
  let capped = false;
  for (;;) {
    if (seen.size >= ONDO_MAX_PAGES || now() > deadline) {
      capped = true;
      break;
    }
    const path = `/v1/perps/fills?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const body = await get(path);
    const page = body.result ?? [];
    fills.push(...page);
    seen.add(cursor);
    cursor = body.pageInfo?.nextCursor;
    // Ondo can hand back a cursor on the last page, so an empty page or repeat also ends the list.
    if (!cursor || page.length === 0 || seen.has(cursor)) break;
  }
  return { fills, capped };
}

export async function loadQfex(env, fetchImpl = fetch) {
  const get = async (path) => {
    const res = await fetchImpl(`https://api.qfex.com${path}`, {
      headers: qfexHeaders(setting(env, 'QFEX_PUBLIC_KEY'), setting(env, 'QFEX_SECRET_KEY')),
      signal: timeout(),
    });
    if (!res.ok) throw await failure(res);
    return res.json();
  };
  const optional = (path) => get(path).catch((error) => {
    if (error.status === 401 || error.status === 403) throw error;
    return null;
  });
  const [positions, equity, pnlWeek, pnlMonth, pnlAll, volumeMonth, volumeAll] = await Promise.all([
    get('/user/positions'),
    optional('/user/account-equity?duration=1w'),
    optional('/user/historic-pnl?duration=1w&unit=number'),
    optional('/user/historic-pnl?duration=1m&unit=number'),
    optional('/user/historic-pnl?duration=all&unit=number'),
    optional('/user/volume?range=1m'),
    optional('/user/volume?range=all'),
  ]);
  const trades = [];
  let capped = true;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await get(`/user/trade?limit=1000&offset=${page * 1000}`);
    const data = body.data ?? [];
    trades.push(...data);
    if (data.length < 1000) {
      capped = false;
      break;
    }
  }
  return { positions, equity, pnl: { d7: pnlWeek, d30: pnlMonth, all: pnlAll }, volume: { d30: volumeMonth, all: volumeAll }, trades, capped };
}

const DEXES = {
  ondo: { name: 'Ondo', load: (env, part) => loadOndo(env, { part }), keys: ['ONDO_KEY_ID', 'ONDO_API_SECRET'] },
  qfex: { name: 'QFEX', load: (env) => loadQfex(env), keys: ['QFEX_PUBLIC_KEY', 'QFEX_SECRET_KEY'] },
};

export const isMyWallet = (address, list = process.env.MY_WALLETS ?? '') =>
  list.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean).includes(address.toLowerCase());

export default async function handler(req, res) {
  if (!requireSession(req, res)) return;
  const url = new URL(req.url, 'http://local');
  const dex = DEXES[url.searchParams.get('dex')];
  const address = url.searchParams.get('address') ?? '';
  const part = url.searchParams.get('part') === 'summary' ? 'summary' : 'fills';
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  if (!dex) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Unknown DEX.' }));
    return;
  }
  if (!isMyWallet(address) || dex.keys.some((key) => !process.env[key])) {
    res.end(JSON.stringify({ available: false }));
    return;
  }
  try {
    res.end(JSON.stringify({ available: true, data: await dex.load(process.env, part) }));
  } catch (error) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: failureMessage(dex.name, error) }));
  }
}
