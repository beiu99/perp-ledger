import test from 'node:test';
import assert from 'node:assert/strict';
import { combine, mergeSeries, summarizeFills } from '../public/lib/stats.js';
import { normalizeFill as hlFill } from '../public/lib/hyperliquid.js';
import { normalizeFill as arcusFill, loadArcus } from '../public/lib/arcus.js';
import { fileKind, parseCsv, summarizeExports } from '../public/lib/variational.js';
import { clearCache, lookup } from '../api/qfex.js';
import { clearRisexCache, lookupRisex } from '../api/risex.js';
import { fromRaw, normalizeFill as riseFill, normalizePosition as risePosition } from '../public/lib/risex.js';
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

test('cost per point divides fees by points, and profit shows as negative cost', () => {
  const r = pointsRow(program('risex'), { fees: { value: 100 }, volume: { all: 1000 }, pnl: { all: 400 } }, { points: 50 });
  assert.equal(r.costPerPoint, 2);
  assert.equal(r.costAfterPnl, -8);
});

test('cost per point stays empty until points are entered', () => {
  const r = pointsRow(program('risex'), { fees: { value: 100 } }, {});
  assert.equal(r.costPerPoint, null);
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

test('Variational PnL has fees taken out for the after-PnL figure', () => {
  const r = pointsRow(program('variational'), { fees: { value: 10 }, volume: { all: 100 }, pnl: { all: 30 } }, { points: 10 });
  assert.equal(r.pnl, 20);
  assert.equal(r.costPerPoint, 1);
  assert.equal(r.costAfterPnl, -2);
});

test('Ondo uses the fees a visitor enters', () => {
  const r = pointsRow(program('ondo'), { status: 'unsupported' }, { points: 200, fees: 50 });
  assert.equal(r.costPerPoint, 0.25);
  assert.equal(r.pnl, null);
});
