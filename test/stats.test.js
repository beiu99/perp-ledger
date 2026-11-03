import test from 'node:test';
import assert from 'node:assert/strict';
import { combine, mergeSeries, summarizeFills } from '../public/lib/stats.js';
import { normalizeFill as hlFill } from '../public/lib/hyperliquid.js';
import { normalizeFill as arcusFill, loadArcus } from '../public/lib/arcus.js';
import { fileKind, parseCsv, summarizeExports } from '../public/lib/variational.js';
import { clearCache, lookup } from '../api/qfex.js';
import { clearRisexCache, lookupRisex } from '../api/risex.js';
import { fromRaw, normalizeFill as riseFill, normalizePosition as risePosition } from '../public/lib/risex.js';
import { createHmac } from 'node:crypto';
import { isSignedIn, passwordMatches, sessionCookie } from '../api/_auth.js';
import { failureMessage, isMyWallet, loadOndo, loadQfex, ondoHeaders, qfexHeaders, setting } from '../api/private.js';
import { fromOndo, fromQfex, ondoFill, qfexFill, qfexPnlCheck } from '../public/lib/private.js';
import { findAccountRef, fromRaw as fromReal, loadReal, normalizeFill as realFill, normalizePosition as realPosition, pnlSeries } from '../public/lib/real.js';
import { PROGRAMS, pointsRow, seasonStats } from '../public/lib/points.js';

test('Hyperliquid PnL has fees removed and only closes count as trades', () => {
  const open = hlFill({ coin: 'BTC', px: '100', sz: '2', time: 1, dir: 'Open Long', closedPnl: '0', fee: '1', crossed: true, oid: 1 });
  const close = hlFill({ coin: 'BTC', px: '110', sz: '2', time: 2, dir: 'Close Long', closedPnl: '20', fee: '1', crossed: false, oid: 2 });
  const s = summarizeFills([open, close]);
  assert.equal(s.netPnl, 18);
  assert.equal(s.closedTrades, 1);
  assert.equal(s.winRate, 1);
  assert.equal(s.volume, 420);
  assert.ok(Math.abs(s.makerShare - 220 / 420) < 1e-9);
});

test('Arcus opening fills do not count as losing trades', () => {
  const open = arcusFill({ marketDisplayName: 'SOL-USD', price: '100', size: '1', fee: '0.5', closedPnl: '-0.5', role: 'TAKER', positionEffect: 'OPEN_LONG', orderId: 'a', createdAt: 1_000_000 });
  const close = arcusFill({ marketDisplayName: 'SOL-USD', price: '90', size: '1', fee: '0.5', closedPnl: '-10.5', role: 'MAKER', positionEffect: 'CLOSE_LONG', orderId: 'b', createdAt: 2_000_000 });
  const s = summarizeFills([open, close]);
  assert.equal(s.closedTrades, 1);
  assert.equal(s.losses, 1);
  assert.equal(s.netPnl, -11);
  assert.equal(close.time, 2000);
});

test('Arcus fills that add to a position are not closes', () => {
  const add = arcusFill({ marketDisplayName: 'SOL-USD', price: '100', size: '1', fee: '0.5', closedPnl: '-0.5', role: 'MAKER', positionEffect: 'ADD_LONG', orderId: 'c', createdAt: 1_000_000 });
  assert.equal(add.closing, false);
});

test('partial fills of one order count as one trade', () => {
  const part = (pnl) => ({ time: 1, market: 'BTC', notional: 10, fee: 0, netPnl: pnl, closing: true, maker: false, orderId: 7 });
  const s = summarizeFills([part(5), part(-2)]);
  assert.equal(s.closedTrades, 1);
  assert.equal(s.best, 3);
  assert.equal(s.winRate, 1);
});

test('series sampled at different times add up step by step', () => {
  assert.deepEqual(mergeSeries([[[1, 1], [3, 3]], [[2, 10], [4, 20]]]), [[1, 1], [2, 11], [3, 13], [4, 23]]);
});

test('unknown venues stay out of totals instead of counting as zero', () => {
  const c = combine([
    { status: 'live', accountValue: 100, pnl: { d30: 5, all: null }, volume: { all: 7 } },
    { status: 'blocked', accountValue: 999, pnl: { d30: 999 } },
  ]);
  assert.equal(c.covered, 1);
  assert.equal(c.accountValue, 100);
  assert.equal(c.pnl.d30, 5);
  assert.equal(c.pnl.all, null);
});

const respond = (status, body) => new Response(JSON.stringify(body), { status });

test('an unapproved Arcus wallet reads as unknown', async () => {
  const r = await loadArcus('0x1', { fetchImpl: async () => respond(403, { error: 'address not on access whitelist' }) });
  assert.equal(r.status, 'blocked');
  assert.equal(r.accountValue, undefined);
});

test('a new Arcus wallet reads as no activity', async () => {
  const r = await loadArcus('0x1', { fetchImpl: async () => respond(404, { error: 'this account has no activity yet' }) });
  assert.equal(r.status, 'empty');
});

test('Variational CSVs combine and ignore failed rows and duplicates', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  const trades = parseCsv('id,created_at,side,instrument_type,underlying,price,qty,trade_type,status,liquidation_trigger_price\n1,2026-10-30T00:00:00Z,buy,perpetual_future,BTC,100,2,trade,confirmed,\n2,2026-10-30T00:00:00Z,sell,perpetual_future,BTC,100,5,trade,failed,\n');
  const transfers = parseCsv('id,created_at,qty,asset,transfer_type,status,underlying,instrument_type,fee_type,funding_rate\n1,2026-10-30T00:00:00Z,50,USDC,realized_pnl,confirmed,BTC,perpetual_future,,\n2,2026-10-30T00:00:00Z,-3,USDC,funding,confirmed,BTC,perpetual_future,,0.0001\n3,2026-10-30T00:00:00Z,-1,USDC,fee,confirmed,BTC,perpetual_future,trade,\n4,2026-10-30T00:00:00Z,1000,USDC,deposit,confirmed,,,,\n');
  assert.equal(fileKind(trades), 'trades');
  assert.equal(fileKind(transfers), 'transfers');
  const s = summarizeExports([{ kind: 'trades', rows: trades }, { kind: 'trades', rows: trades }, { kind: 'transfers', rows: transfers }], { now });
  assert.equal(s.volume.all, 200);
  assert.equal(s.pnl.d30, 47);
  assert.equal(s.fees.value, 1);
  assert.equal(s.status, 'live');
});

test('QFEX lookup matches usernames across leaderboards', async () => {
  clearCache();
  const row = { rank: 2, account: { username: 'LastLook' }, pnl: 9, return_percent: 0.1, start_equity: 1, end_equity: 2 };
  const r = await lookup('lastlook', async (url) => respond(200, { data: String(url).includes('=1w') ? [row] : [] }));
  assert.equal(r.found, true);
  assert.equal(r.entries['1w'].rank, 2);
  assert.equal(r.entries['1m'], undefined);
});

const program = (id) => PROGRAMS.find((p) => p.id === id);

test('RISEx fills that trade against the position are closes', () => {
  const close = riseFill({ market_id: '15', side: 'BUY', position_side: 'SELL', price: '0.62991', size: '340', fee: '0.044975574', liquidity_indicator: 'TAKER', time: '1793577889000000000', realized_pnl: '15.58', order_id: 'a' }, { 15: 'AERO/USDC' });
  const open = riseFill({ market_id: '12', side: 'SELL', position_side: 'SELL', price: '3', size: '1', fee: '0.03', liquidity_indicator: 'MAKER', time: '1', realized_pnl: '-0.03', order_id: 'b' });
  assert.equal(close.closing, true);
  assert.equal(close.market, 'AERO');
  assert.equal(close.time, 1793577889000);
  assert.equal(open.closing, false);
  assert.equal(open.maker, true);
});

test('RISEx short positions read as short', () => {
  const p = risePosition({ size: '-23996', market_name: 'AERO/USDC', avg_entry_price: '0.6758', mark_price: '0.618285', leverage: '3', unrealized_pnl: '1382.26', liquidation_price: '0' });
  assert.equal(p.side, 'Short');
  assert.equal(p.liquidation, null);
  assert.ok(Math.abs(p.notional - 14836.4) < 1);
});

test('a RISEx wallet that never traded reads as no activity', () => {
  assert.equal(fromRaw({ summary: { total_account_value: '0' }, totalVolume: '0', trades: [] }).status, 'empty');
});

test('the RISEx lookup stops paging on the last page and drops flat positions', async () => {
  clearRisexCache();
  let tradePages = 0;
  const data = (url) => {
    if (url.includes('/portfolio/details')) return { summary: { total_account_value: '5' }, positions: [{ size: '0' }, { size: '1' }] };
    if (url.includes('/portfolio/header')) return { d30: { volume: '10' }, all_time: { volume: '20' } };
    if (url.includes('/user-trading')) return { total_fee: '2', total_volume: '20' };
    if (url.includes('/chart')) return { data: [] };
    if (url.includes('/markets')) return { markets: [{ market_id: '1', display_name: 'BTC/USDC' }] };
    tradePages += 1;
    return { trades: [{ market_id: '1' }], has_next_page: tradePages < 2 };
  };
  const r = await lookupRisex('0xabc', async (url) => respond(200, { data: data(url) }));
  assert.equal(tradePages, 2);
  assert.equal(r.trades.length, 2);
  assert.equal(r.capped, false);
  assert.equal(r.positions.length, 1);
  assert.equal(r.markets['1'], 'BTC/USDC');
});

test('a loss after fees is the cost per point', () => {
  const r = pointsRow(program('risex'), { fees: { value: 100 }, volume: { all: 1000 }, pnl: { all: -400 } }, { points: 50 });
  assert.equal(r.costPerPoint, 8);
  assert.equal(r.feesOnly, false);
});

test('a profit makes the cost per point negative', () => {
  const r = pointsRow(program('risex'), { fees: { value: 100 }, pnl: { all: 400 } }, { points: 50 });
  assert.equal(r.costPerPoint, -8);
});

test('cost per point stays empty until points are entered', () => {
  assert.equal(pointsRow(program('risex'), { fees: { value: 100 } }, {}).costPerPoint, null);
  assert.equal(pointsRow(program('risex'), { fees: { value: 100 } }, { points: 0 }).costPerPoint, null);
});

test('Arcus points only count fills from Season 1', () => {
  const fill = (time, fee) => ({ time, fee, notional: 10, netPnl: -1 });
  const s = seasonStats([fill(100, 5), fill(50, 9)], 80, false);
  assert.equal(s.fees, 5);
  assert.equal(s.volume, 10);
  assert.equal(s.incomplete, false);
  assert.equal(seasonStats([fill(100, 5)], 80, true).incomplete, true);
});

test('Variational PnL has fees taken out before the cost per point', () => {
  const r = pointsRow(program('variational'), { fees: { value: 10 }, volume: { all: 100 }, pnl: { all: 30 } }, { points: 10 });
  assert.equal(r.pnl, 20);
  assert.equal(r.costPerPoint, -2);
});

test('Ondo uses PnL when typed in and falls back to fees only', () => {
  const withPnl = pointsRow(program('ondo'), { status: 'unsupported' }, { points: 200, fees: 50, pnl: -100 });
  assert.equal(withPnl.costPerPoint, 0.5);
  assert.equal(withPnl.feesOnly, false);
  const feesOnly = pointsRow(program('ondo'), { status: 'unsupported' }, { points: 200, fees: 50 });
  assert.equal(feesOnly.costPerPoint, 0.25);
  assert.equal(feesOnly.feesOnly, true);
});

const hmac = (secret, text) => createHmac('sha256', secret).update(text).digest('hex');

test('the password check and session cookie work together', () => {
  assert.equal(passwordMatches('secret', 'secret'), true);
  assert.equal(passwordMatches('wrong', 'secret'), false);
  assert.equal(passwordMatches('anything', undefined), false);
  const cookie = sessionCookie('secret', 1000).split(';')[0];
  assert.equal(isSignedIn({ headers: { cookie } }, 'secret', 2000), true);
  assert.equal(isSignedIn({ headers: { cookie } }, 'other', 2000), false);
  assert.equal(isSignedIn({ headers: { cookie } }, 'secret', 1000 + 31 * 86_400_000), false);
  assert.equal(isSignedIn({ headers: {} }, 'secret', 2000), false);
  assert.equal(isSignedIn({ headers: { cookie } }, undefined, 2000), false);
});

test('private data only opens for your own wallets', () => {
  assert.equal(isMyWallet('0xABC', '0xabc, 0xdef'), true);
  assert.equal(isMyWallet('0x123', '0xabc'), false);
  assert.equal(isMyWallet('0x123', ''), false);
});

test('Ondo requests are signed as its docs describe', () => {
  const h = ondoHeaders('/v1/perps/fills?limit=1000', 'ondoKeyId_a', 'ondoApiSecret_b', 1700000000000);
  assert.equal(h['ONDO-KEY-ID'], 'ondoKeyId_a');
  assert.equal(h['ONDO-TIMESTAMP'], '1700000000000');
  assert.equal(h['ONDO-SIGN'], hmac('ondoApiSecret_b', '1700000000000GET/v1/perps/fills?limit=1000'));
});

test('QFEX requests are signed as its docs describe', () => {
  const h = qfexHeaders('pub', 'sec', 1700000000999, 'abcd');
  assert.equal(h['x-qfex-timestamp'], '1700000000');
  assert.equal(h['x-qfex-nonce'], 'abcd');
  assert.equal(h['x-qfex-hmac-signature'], hmac('sec', 'abcd:1700000000'));
});

test('Ondo fills follow the cursor and PnL uses the account total', async () => {
  const pages = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith('/v1/perps/balance')) return respond(200, { result: { marginBalance: '1500', unrealizedPnl: '-5', totalPnL: '477', totalTradingFees: '123' } });
    if (u.endsWith('/v1/perps/positions')) return respond(200, { result: [{ direction: 'neutral' }, { market: 'AAPL-USD.P', direction: 'short', netQuantity: '2', averageEntryPrice: '200', notionalValue: '400', unrealizedPnl: '-5', leverage: '5', liquidationPrice: '300' }] });
    pages.push(u);
    return pages.length === 1
      ? respond(200, { result: [{ orderId: 'a', market: 'AAPL-USD.P', time: '2026-11-01T00:00:00Z', filledCost: '100', fee: '1', pnl: '10', direction: 'closeLong', isMaker: true }], pageInfo: { nextCursor: 'NEXT' } })
      : respond(200, { result: [{ orderId: 'b', market: 'AAPL-USD.P', time: '2026-11-01T01:00:00Z', filledCost: '50', fee: '1', direction: 'openLong', isMaker: false }], pageInfo: {} });
  };
  const summary = await loadOndo({ ONDO_KEY_ID: 'k', ONDO_API_SECRET: 's' }, { part: 'summary', fetchImpl });
  const raw = { ...summary, ...(await loadOndo({ ONDO_KEY_ID: 'k', ONDO_API_SECRET: 's' }, { fetchImpl })) };
  assert.equal(pages.length, 2);
  assert.ok(pages[1].includes('cursor=NEXT'));
  const v = fromOndo(raw, { now: Date.parse('2026-11-02T00:00:00Z') });
  assert.equal(v.accountValue, 1500);
  assert.equal(v.pnl.all, 477);
  assert.equal(v.pnl.d30, 8);
  assert.equal(v.fees.value, 123);
  assert.equal(v.volume.all, 150);
  assert.equal(v.positions.length, 1);
  assert.equal(v.positions[0].market, 'AAPL');
  assert.equal(v.trades.closedTrades, 1);
});

test('Ondo fee rebates reduce the fee', () => {
  const f = ondoFill({ fee: '1', feeRebate: '0.25', pnl: '0', filledCost: '10', time: '2026-11-01T00:00:00Z' });
  assert.equal(f.fee, 0.75);
});

test('QFEX reads positions, PnL, volume and fees, and leaves maker share unknown', async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/user/positions')) return respond(200, { balance: { unrealised_pnl: 5 }, positions: [{ symbol: 'AAPL-USD', position: -2, average_price: 200, unrealised_pnl: 5, leverage: 5 }, { symbol: 'X', position: 0 }] });
    if (u.includes('account-equity')) return respond(200, { data: [{ window_start: '2026-11-01T00:00:00Z', value: 1000 }] });
    if (u.includes('historic-pnl')) return respond(200, { data: [{ window_start: '2026-11-01T00:00:00Z', value: 40 }] });
    if (u.includes('/user/volume')) return respond(200, { total_volume: 900 });
    return respond(200, { data: [{ id: '1', order_timestamp: 1793000000, symbol: 'AAPL-USD', price: 10, quantity: 2, fee: 1, order_id: 'a', realised_pnl_change: 0, liquidation: '' }, { id: '2', order_timestamp: 1793000100, symbol: 'AAPL-USD', price: 12, quantity: 2, fee: 1, order_id: 'b', realised_pnl_change: 4, liquidation: '' }] });
  };
  const v = fromQfex(await loadQfex({ QFEX_PUBLIC_KEY: 'p', QFEX_SECRET_KEY: 's' }, fetchImpl));
  assert.equal(v.accountValue, 1000);
  assert.equal(v.pnl.d30, 40);
  assert.equal(v.volume.all, 900);
  assert.equal(v.fees.value, 2);
  assert.equal(v.positions.length, 1);
  assert.equal(v.trades.closedTrades, 1);
  assert.equal(v.trades.makerShare, null);
  assert.equal(v.trades.from, 1793000000000);
});

test('a rejected QFEX key is reported, not hidden as missing data', async () => {
  await assert.rejects(loadQfex({ QFEX_PUBLIC_KEY: 'p', QFEX_SECRET_KEY: 's' }, async () => respond(401, {})), /401/);
});

test('QFEX timestamps work in seconds, milliseconds or nanoseconds', () => {
  const at = (order_timestamp) => qfexFill({ order_timestamp, price: 1, quantity: 1, fee: 0, realised_pnl_change: 0 }).time;
  assert.equal(at(1793000000), 1793000000000);
  assert.equal(at(1793000000000), 1793000000000);
  assert.equal(at(1793000000000000000), 1793000000000);
});

test('Ondo points use the private account figures when available', () => {
  const r = pointsRow(program('ondo'), { fees: { value: 100 }, volume: { all: 900 }, pnl: { all: -50 } }, { points: 100 });
  assert.equal(r.fees, 100);
  assert.equal(r.costPerPoint, 0.5);
});

test('pasted keys ignore stray spaces and line breaks', () => {
  assert.equal(setting({ KEY: '  abc\n' }, 'KEY'), 'abc');
  assert.equal(setting({}, 'KEY'), '');
});

test('a rejected request shows the DEX code but never its message', async () => {
  const fetchImpl = async () => respond(401, { error: 'IP addr 1.2.3.4 is not allowed for key ondoKeyId_secret', error_code: 'api_key_not_found' });
  const error = await loadOndo({ ONDO_KEY_ID: 'k', ONDO_API_SECRET: 's' }, { fetchImpl }).catch((e) => e);
  const message = failureMessage('Ondo', error);
  assert.equal(message, 'Ondo rejected the request (status 401, api_key_not_found).');
  assert.equal(failureMessage('QFEX', new Error('timeout')), 'QFEX did not respond. Try again in a minute.');
});

const ondoFetch = (pages) => {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      const u = String(url);
      calls.push(u);
      return respond(200, pages(calls.length));
    },
  };
};
const fill = { filledCost: '10', fee: '0', time: '2026-11-01T00:00:00Z' };
const keys = { ONDO_KEY_ID: 'k', ONDO_API_SECRET: 's' };

test('Ondo volume counts every page, even past the old 10,000 fill limit', async () => {
  const { fetchImpl, calls } = ondoFetch((n) => ({ result: [fill], pageInfo: n < 15 ? { nextCursor: `c${n}` } : {} }));
  const raw = await loadOndo(keys, { fetchImpl });
  assert.equal(calls.length, 15);
  assert.equal(raw.capped, false);
  assert.equal(fromOndo(raw).volume.all, 150);
});

test('a leftover Ondo cursor on the last page does not mark the data incomplete', async () => {
  const empty = ondoFetch((n) => (n === 1 ? { result: [fill], pageInfo: { nextCursor: 'a' } } : { result: [], pageInfo: { nextCursor: 'b' } }));
  assert.equal((await loadOndo(keys, { fetchImpl: empty.fetchImpl })).capped, false);
  const repeat = ondoFetch(() => ({ result: [fill], pageInfo: { nextCursor: 'same' } }));
  const raw = await loadOndo(keys, { fetchImpl: repeat.fetchImpl });
  assert.equal(raw.capped, false);
  assert.equal(repeat.calls.length, 2);
});

test('when time runs out Ondo volume stays visible as a minimum', async () => {
  let clock = 0;
  const { fetchImpl } = ondoFetch((n) => ({ result: [fill], pageInfo: { nextCursor: `c${n}` } }));
  const raw = await loadOndo(keys, { fetchImpl, now: () => (clock += 20_000) });
  assert.equal(raw.capped, true);
  const v = fromOndo(raw);
  assert.ok(v.volume.all > 0);
  assert.equal(v.volumeFloor, true);
});

test('Ondo fees and PnL fill in from the balance before fills finish', () => {
  const v = fromOndo({ balance: { marginBalance: '100', totalTradingFees: '12.5', totalPnL: '-40' }, positions: [] });
  assert.equal(v.fillsLoading, true);
  assert.equal(v.status, 'live');
  const r = pointsRow(program('ondo'), v, { points: 100 });
  assert.equal(r.fees, 12.5);
  assert.equal(r.pnl, -40);
  assert.equal(r.costPerPoint, 0.4);
});

test('missing Ondo balance fields stay unknown instead of showing zero', () => {
  const v = fromOndo({ balance: {}, positions: [] });
  assert.equal(v.fees, null);
  assert.equal(v.pnl.all, null);
});

test('the QFEX check shows each way of reading the PnL points', () => {
  const point = (value) => ({ window_start: '2026-11-01T00:00:00Z', value });
  const [week, , all] = qfexPnlCheck({ pnl: { d7: { data: [point(10), point(-4), point(30)] } } });
  assert.equal(week.latest, 30);
  assert.equal(week.sum, 36);
  assert.equal(week.change, 20);
  assert.equal(all.count, 0);
  assert.equal(all.latest, null);
});

test('QFEX PnL adds up its daily changes', () => {
  const day = (d, value) => ({ window_start: `2026-11-0${d}T00:00:00Z`, value });
  const v = fromQfex({
    trades: [],
    pnl: { d7: { data: [day(1, 500), day(2, -100), day(3, 190.08)] } },
  });
  assert.ok(Math.abs(v.pnl.d7 - 590.08) < 1e-9);
  assert.equal(v.series.d7[1][1], 400);
});

const realAccount = { id: '0xa', equity: '111.525219', unrealised_pnl: '0', realised_pnl: '31.484938' };
const realClose = { market_id: 'm', price: '76797.9', filled_value: '1320.92388', volume: '0.0172', is_taker: true, created_at_ms: 1793662485600, realised_pnl: '0.523025', realised_pnl_attribution: { trade_pnl: '0.774000', trade_fee: '-0.250975' }, fill_type: 'Normal', trade_context: 'CloseLong', order_id: '1' };

test('Real Markets fills read fees as positive costs and spot closes', () => {
  const f = realFill(realClose, { m: 'BTC-USDT' });
  assert.equal(f.market, 'BTC');
  assert.equal(f.fee, 0.250975);
  assert.equal(f.notional, 1320.92388);
  assert.equal(f.closing, true);
  assert.equal(f.maker, false);
  assert.equal(realFill({ ...realClose, trade_context: 'OpenLong' }).closing, false);
});

test('Real Markets positions show leverage from the margin rate', () => {
  const p = realPosition({ direction: 'Short', size: '-2', average_entry_price: '100', current_imr: '0.08333333333333333', market_id: 'm', live_values: { notional_value: '190', unrealised_pnl: '10', estimated_liquidation_price: '180' } }, { m: 'SOL-USDT' });
  assert.equal(p.side, 'Short');
  assert.equal(p.leverage, 12);
  assert.equal(p.notional, 190);
});

test('Real Markets totals use lifetime position figures and leave pending positions out', () => {
  const now = 1793700000000;
  const v = fromReal({
    accounts: [realAccount],
    positions: [
      { size: '0', traded_turnover: '2641.07', realised_pnl_attribution: { trade_fee: '-0.25' } },
      { size: '1', direction: 'Long', traded_turnover: '100', realised_pnl_attribution: { trade_fee: '-0.75' }, live_values: {} },
    ],
    fills: [realClose],
    funding: [{ updated_at_ms: now - 1000, payment: '0.5' }],
    markets: { m: 'BTC-USDT' },
    capped: false,
  }, { now });
  assert.equal(v.pnl.all, 31.484938);
  assert.equal(v.fees.value, 1);
  assert.ok(Math.abs(v.volume.all - 2741.07) < 1e-9);
  assert.equal(v.positions.length, 1);
  assert.ok(Math.abs(v.pnl.d30 - 1.023025) < 1e-9);
  assert.equal(v.funding30d.value, 0.5);
  assert.ok(Math.abs(v.series.all.at(-1)[1] - 1.023025) < 1e-9);
});

test('Real Markets hides window figures rather than understate them when history is cut off', () => {
  const v = fromReal({ accounts: [realAccount], positions: [], fills: [realClose], funding: [], markets: {}, capped: true });
  assert.equal(v.pnl.d30, null);
  assert.equal(v.volume.d30, null);
  assert.equal(v.series, null);
  assert.equal(v.pnl.all, 31.484938);
});

test('long PnL histories are thinned but keep the final total', () => {
  const events = Array.from({ length: 2000 }, (_, i) => [i + 1, 1]);
  const s = pnlSeries(events);
  assert.ok(s.length <= 402);
  assert.equal(s.at(-1)[1], 2000);
  assert.equal(pnlSeries([]).length, 0);
});

test('Real Markets paging follows the cursor and an unknown address reads as no activity', async () => {
  assert.equal((await loadReal('0xb', { fetchImpl: async () => respond(200, { data: [], pagination: {} }) })).status, 'empty');
  const urls = [];
  const fetchImpl = async (url) => {
    const u = decodeURIComponent(String(url));
    urls.push(u);
    if (u.includes('/accounts?')) return respond(200, { data: [realAccount], pagination: {} });
    if (u.includes('/fills') && !u.includes('p[c]')) return respond(200, { data: [realClose], pagination: { next_cursor: 'NEXT' } });
    if (u.includes('/fills')) return respond(200, { data: [{ ...realClose, order_id: '2' }], pagination: {} });
    return respond(200, { data: [], pagination: {} });
  };
  const v = await loadReal('0xb', { fetchImpl });
  assert.equal(v.trades.fillCount, 2);
  assert.ok(urls.some((u) => u.includes('f[account_ids]=0xa')));
});

test('Real Markets accepts an account ID, an address or a profile link', () => {
  const id = `0x${'A'.repeat(64)}`;
  assert.equal(findAccountRef(id), id.toLowerCase());
  assert.equal(findAccountRef(`https://app.real.xyz/en/profile/${id}?tab=x`), id.toLowerCase());
  assert.equal(findAccountRef(`0x${'a'.repeat(40)}`), null);
  assert.equal(findAccountRef(null), null);
});

test('Real Markets falls back from wallet address to account ID', async () => {
  const fetchImpl = async (url) => {
    const u = decodeURIComponent(String(url));
    if (u.includes('f[address]')) return respond(200, { data: [], pagination: {} });
    if (/\/accounts\/0xa$/.test(u)) return respond(200, { data: realAccount });
    return respond(200, { data: [], pagination: {} });
  };
  const v = await loadReal('0xA', { fetchImpl });
  assert.equal(v.accountValue, 111.525219);
});

test('an unknown Real Markets ID reads as no activity', async () => {
  const fetchImpl = async (url) => (String(url).includes('p%5Bs%5D') ? respond(200, { data: [], pagination: {} }) : respond(404, {}));
  assert.equal((await loadReal('0xb', { fetchImpl })).status, 'empty');
});
