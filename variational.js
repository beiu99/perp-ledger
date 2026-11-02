import { num, DAY_MS } from './stats.js';

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += c;
    }
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export function fileKind(rows) {
  const first = rows[0];
  if (!first) return null;
  if ('transfer_type' in first) return 'transfers';
  if ('trade_type' in first && 'qty' in first && 'price' in first) return 'trades';
  return null;
}

const time = (row) => Date.parse(row.created_at);

function total(rows, type, since = -Infinity) {
  return rows
    .filter((r) => r.transfer_type === type && time(r) >= since)
    .reduce((sum, r) => sum + num(r.qty), 0);
}

export function summarizeExports(files, { now = Date.now() } = {}) {
  const trades = files
    .filter((f) => f.kind === 'trades')
    .flatMap((f) => f.rows)
    .filter((r) => r.status === 'confirmed');
  const transfers = files
    .filter((f) => f.kind === 'transfers')
    .flatMap((f) => f.rows)
    .filter((r) => r.status === 'confirmed');

  const uniqueTrades = [...new Map(trades.map((r) => [r.id, r])).values()];
  const uniqueTransfers = [...new Map(transfers.map((r) => [r.id, r])).values()];
  const notional = (r) => Math.abs(num(r.price) * num(r.qty));
  const volumeSince = (since) =>
    uniqueTrades.filter((r) => time(r) >= since).reduce((sum, r) => sum + notional(r), 0);

  const hasTrades = uniqueTrades.length > 0;
  const hasTransfers = uniqueTransfers.length > 0;
  const times = [...uniqueTrades, ...uniqueTransfers].map(time).filter(Number.isFinite);
  const markets = new Map();
  for (const r of uniqueTrades) {
    const m = markets.get(r.underlying) ?? { market: r.underlying, volume: 0, netPnl: null, fills: 0 };
    m.volume += notional(r);
    m.fills += 1;
    markets.set(r.underlying, m);
  }

  const d7 = now - 7 * DAY_MS;
  const d30 = now - 30 * DAY_MS;
  const fundingValue = total(uniqueTransfers, 'funding', d30);
  const pnlPlusFunding = (since) => total(uniqueTransfers, 'realized_pnl', since) + total(uniqueTransfers, 'funding', since);

  return {
    status: hasTrades && hasTransfers ? 'live' : 'partial',
    message: hasTrades && hasTransfers ? null : `Add your ${hasTrades ? 'transfers' : 'trades'} CSV to complete Variational.`,
    accountValue: null,
    unrealizedPnl: null,
    pnl: hasTransfers ? { d7: pnlPlusFunding(d7), d30: pnlPlusFunding(d30), all: pnlPlusFunding(-Infinity) } : null,
    volume: hasTrades ? { d30: volumeSince(d30), all: volumeSince(-Infinity) } : null,
    fees: hasTransfers ? { value: Math.abs(total(uniqueTransfers, 'fee')), scope: 'export' } : null,
    funding30d: hasTransfers ? { value: fundingValue, complete: true } : null,
    positions: [],
    trades: null,
    tradeMarkets: [...markets.values()].sort((a, b) => b.volume - a.volume),
    series: null,
    exportRange: times.length ? { from: Math.min(...times), to: Math.max(...times) } : null,
    rows: uniqueTrades.length + uniqueTransfers.length,
  };
}
