import { combine, mergeSeries } from './lib/stats.js';
import { loadHyperliquid } from './lib/hyperliquid.js';
import { loadArcus } from './lib/arcus.js';
import { loadQfex } from './lib/qfex.js';
import { loadRisex } from './lib/risex.js';
import { PROGRAMS, pointsRow } from './lib/points.js';
import { loadPrivate } from './lib/private.js';
import { fileKind, parseCsv, summarizeExports } from './lib/variational.js';

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const VENUES = [
  { id: 'hyperliquid', name: 'Hyperliquid' },
  { id: 'arcus', name: 'Arcus' },
  { id: 'risex', name: 'RISEx' },
  { id: 'qfex', name: 'QFEX' },
  { id: 'variational', name: 'Variational' },
  { id: 'ondo', name: 'Ondo' },
];

const state = {
  address: null,
  venues: {
    hyperliquid: { status: 'idle' },
    arcus: { status: 'idle' },
    risex: { status: 'idle' },
    qfex: { status: 'input' },
    variational: { status: 'input' },
    ondo: { status: 'unsupported' },
  },
  files: [],
  saved: {},
  range: 'd30',
};

const LINE_KEYS = { hyperliquid: 'hl', arcus: 'arcus', risex: 'risex', qfex: 'qfex' };

function readSaved(address) {
  try {
    return JSON.parse(localStorage.getItem(`points:${address}`)) ?? {};
  } catch {
    return {};
  }
}

function writeSaved(address, saved) {
  try {
    localStorage.setItem(`points:${address}`, JSON.stringify(saved));
  } catch {
    // Private windows can refuse storage. The figures still work until the page closes.
  }
}

const usd = (value, { signed = false } = {}) => {
  if (value === null || value === undefined) return '—';
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : 2;
  const text = abs >= 1e9
    ? `$${(abs / 1e9).toLocaleString('en-US', { maximumFractionDigits: 2 })}B`
    : abs >= 1e7
    ? `$${(abs / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })}M`
    : `$${abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  if (value < 0) return `−${text}`;
  return signed && value > 0 ? `+${text}` : text;
};
const atLeast = (value) => `At least ${usd(value)}`;
const pct = (value) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);
const tone = (value) => (value > 0 ? 'gain' : value < 0 ? 'loss' : '');
const date = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const cell = (value, render = usd) =>
  value === null || value === undefined ? '<td class="unknown-cell">Unknown</td>' : `<td>${render(value)}</td>`;
const pnlCell = (value) =>
  value === null || value === undefined
    ? '<td class="unknown-cell">Unknown</td>'
    : `<td class="${tone(value)}">${usd(value, { signed: true })}</td>`;

function renderCoverage() {
  $('coverage').innerHTML = VENUES.map(({ id, name }) => {
    const v = state.venues[id];
    return `<article class="venue ${isCovered(v) ? 'covered' : isUnknown(v) ? 'unknown' : ''}">
      <h3>${name}</h3>
      ${venueBody(id, v)}
    </article>`;
  }).join('');
  const qfexForm = $('qfex-form');
  if (qfexForm) qfexForm.addEventListener('submit', onQfex);
  const file = $('variational-file');
  if (file) file.addEventListener('change', onFiles);
}

const isCovered = (v) => v.status === 'live' || v.status === 'partial';
const isUnknown = (v) => ['blocked', 'unsupported', 'error', 'input', 'idle'].includes(v.status);

function venueBody(id, v) {
  const line = (title, text) => `<p class="state">${esc(title)}</p>${text ? `<p>${esc(text)}</p>` : ''}`;
  if (id === 'ondo') {
    if (v.status === 'loading') return line('Reading…');
    if (isCovered(v)) return line('Your account', v.fillsLoading ? 'Adding up your trade history…' : v.message ?? 'Read with your private API key.');
    if (v.status === 'error') return line('Could not read', v.message);
    return line('Not available', 'Ondo keeps account data behind a wallet sign-in, so an address alone cannot show it.');
  }
  if (id === 'qfex' && v.private) return line('Your account', 'Read with your private API key.');
  if (id === 'qfex') {
    const form = `<form id="qfex-form" aria-label="Find a QFEX trader">
      <input type="text" name="username" aria-label="QFEX username" placeholder="Username" autocomplete="off" maxlength="40">
      <button type="submit">Find</button>
    </form>`;
    if (v.status === 'loading') return line('Searching the top 100…') + form;
    if (v.status === 'partial') return line(`Ranked #${v.rank}`, v.message) + form;
    if (v.status === 'empty' || v.status === 'error') return line(v.status === 'empty' ? 'Not found' : 'Could not read QFEX', v.message) + form;
    return line('Top 100 only', 'QFEX does not link wallets to accounts. Search by username instead.') + form;
  }
  if (id === 'variational') {
    const button = `<label class="file-label">Add CSV files<input id="variational-file" type="file" accept=".csv,text/csv" multiple></label>`;
    if (isCovered(v)) {
      const range = v.exportRange ? `${date(v.exportRange.from)} to ${date(v.exportRange.to)}.` : '';
      return line(`${v.rows.toLocaleString('en-US')} ${v.rows === 1 ? 'row' : 'rows'} read`, [range, v.message].filter(Boolean).join(' ')) + button;
    }
    if (v.status === 'error') return line('Could not read that file', v.message) + button;
    return line('Needs your export', 'Variational has no public wallet data. Download your trades and transfers CSVs from your portfolio page.') + button;
  }
  switch (v.status) {
    case 'idle': return line('Waiting for a wallet');
    case 'loading': return line('Reading…');
    case 'live': return line('Covered', v.trades?.capped ? `Trading record uses the latest ${v.trades.fillCount.toLocaleString('en-US')} fills.` : null);
    case 'partial': return line('Partly covered', v.message);
    case 'empty': return line('No activity', v.message);
    case 'blocked': return line('Unknown', v.message);
    default: return line('Could not read', v.message);
  }
}

function renderTotals(combined) {
  const noteDex = `Across ${combined.covered} of ${combined.total} DEXs`;
  const total = (label, value, note, signed) => `<div class="total">
      <p class="total-label">${label}</p>
      <p class="total-value ${signed ? tone(value) : ''}">${usd(value, { signed })}</p>
      <p class="total-note">${esc(note)}</p>
    </div>`;
  $('totals').innerHTML = [
    total('Account value', combined.accountValue, noteDex),
    total('PnL, last 30 days', combined.pnl.d30, noteDex, true),
    total('PnL, all time', combined.pnl.all, 'Where each DEX reports it', true),
    total('Volume, all time', combined.volume.all, 'Where each DEX reports it'),
  ].join('');
}

function renderVenueTable(rows) {
  $('venues').innerHTML = `<table>
    <thead><tr><th>DEX</th><th>Account value</th><th>7 days</th><th>30 days</th><th>All time</th><th>30-day volume</th><th>All-time volume</th><th>30-day funding</th></tr></thead>
    <tbody>${rows.map(({ name, v }) => `<tr>
      <td>${name}</td>
      ${cell(v.accountValue)}
      ${pnlCell(v.pnl?.d7)}${pnlCell(v.pnl?.d30)}${pnlCell(v.pnl?.all)}
      ${cell(v.volume?.d30)}${cell(v.volume?.all, v.volumeFloor ? atLeast : usd)}
      ${pnlCell(v.funding30d?.value)}
    </tr>`).join('')}</tbody>
  </table>`;
}

function renderPositions(rows) {
  const positions = rows.flatMap(({ name, v }) => (v.positions ?? []).map((p) => ({ ...p, venue: name })));
  positions.sort((a, b) => b.notional - a.notional);
  $('positions-panel').hidden = positions.length === 0;
  $('positions').innerHTML = `<table>
    <thead><tr><th>Market</th><th class="text">DEX</th><th class="text">Side</th><th>Value</th><th>Entry</th><th>Leverage</th><th>Liquidation</th><th>Unrealized PnL</th></tr></thead>
    <tbody>${positions.slice(0, 50).map((p) => `<tr>
      <td>${esc(p.market)}</td>
      <td class="text">${p.venue}</td>
      <td class="text">${p.side}</td>
      <td>${usd(p.notional)}</td>
      <td>${p.entry.toLocaleString('en-US', { maximumSignificantDigits: 6 })}</td>
      <td>${p.leverage ? `${p.leverage}×` : '—'}</td>
      <td>${p.liquidation ? p.liquidation.toLocaleString('en-US', { maximumSignificantDigits: 6 }) : '—'}</td>
      <td class="${tone(p.unrealizedPnl)}">${usd(p.unrealizedPnl, { signed: true })}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function renderTrades(rows) {
  const blocks = rows.filter(({ v }) => v.trades || v.tradeMarkets?.length).map(({ name, v }) => {
    const t = v.trades;
    if (!t) {
      return `<div><h3>${name}</h3>
        <p class="scope">From your CSV. It has no per-trade PnL, so win rate is unavailable.</p>
        ${marketTable(v.tradeMarkets)}</div>`;
    }
    const fact = (label, value, cls = '') => `<div><dt>${label}</dt><dd class="${cls}">${value}</dd></div>`;
    const scope = `${t.capped ? 'Latest ' : ''}${t.fillCount.toLocaleString('en-US')} fills, ${date(t.from)} to ${date(t.to)}`;
    return `<div><h3>${name}</h3><p class="scope">${scope}</p>
      <dl class="facts">
        ${fact('Win rate', pct(t.winRate))}
        ${fact('Closed trades', t.closedTrades.toLocaleString('en-US'))}
        ${fact('Average win', usd(t.avgWin, { signed: true }), 'gain')}
        ${fact('Average loss', usd(t.avgLoss, { signed: true }), 'loss')}
        ${fact('Best trade', usd(t.best, { signed: true }), tone(t.best))}
        ${fact('Worst trade', usd(t.worst, { signed: true }), tone(t.worst))}
        ${fact('Profit factor', t.profitFactor === null ? '—' : t.profitFactor.toFixed(2))}
        ${fact('Maker share', pct(t.makerShare))}
        ${fact('Fees', v.fees?.scope === 'lifetime' ? `${usd(v.fees.value)} lifetime` : usd(t.fees))}
        ${fact('Liquidations', t.liquidations)}
      </dl>
      ${marketTable(t.markets)}</div>`;
  });
  $('trades-panel').hidden = blocks.length === 0;
  $('trades').innerHTML = blocks.join('');
}

function marketTable(markets) {
  const showPnl = markets.some((m) => m.netPnl !== null);
  return `<table>
    <thead><tr><th>Top markets</th><th>Volume</th>${showPnl ? '<th>Net PnL</th>' : ''}</tr></thead>
    <tbody>${markets.slice(0, 5).map((m) => `<tr>
      <td>${esc(m.market)}</td><td>${usd(m.volume)}</td>
      ${showPnl ? `<td class="${tone(m.netPnl)}">${usd(m.netPnl, { signed: true })}</td>` : ''}
    </tr>`).join('')}</tbody>
  </table>`;
}

const RANGE_LABELS = { d7: '7 days', d30: '30 days', all: 'All time' };

function chartLines(rows) {
  const lines = rows
    .filter(({ v }) => v.series?.[state.range]?.length > 1)
    .map(({ id, name, v }) => ({ name, key: LINE_KEYS[id], color: `var(--${LINE_KEYS[id]})`, width: 2, points: v.series[state.range] }));
  if (lines.length > 1) {
    lines.unshift({ name: 'Combined', key: 'ink', color: 'var(--ink)', width: 2.5, points: mergeSeries(lines.map((l) => l.points)) });
  }
  return lines;
}

function renderChart(rows) {
  const any = rows.some(({ v }) => v.series?.d30?.length > 1 || v.series?.all?.length > 1);
  $('chart-panel').hidden = !any;
  if (!any) return;
  $('ranges').innerHTML = Object.entries(RANGE_LABELS)
    .map(([key, label]) => `<button type="button" data-range="${key}" aria-pressed="${key === state.range}">${label}</button>`)
    .join('');
  const lines = chartLines(rows);
  $('legend').innerHTML = lines.length > 1
    ? lines.map((l) => `<span><i class="swatch-${l.key}"></i>${l.name}</span>`).join('')
    : (lines[0] ? `<span>${lines[0].name}</span>` : '');
  drawChart($('chart'), lines);
}

function niceTicks(min, max) {
  const span = max - min || Math.abs(max) || 1;
  const step = 10 ** Math.floor(Math.log10(span / 4));
  const unit = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => span / s <= 5);
  const ticks = [];
  for (let t = Math.floor(min / unit) * unit; t <= max + unit * 0.999; t += unit) ticks.push(t);
  return ticks;
}

const compact = (v) => {
  const abs = Math.abs(v);
  const text = abs >= 1e6 ? `${+(abs / 1e6).toFixed(2)}M` : abs >= 1e3 ? `${+(abs / 1e3).toFixed(1)}k` : `${+abs.toFixed(0)}`;
  return `${v < 0 ? '−' : ''}$${text}`;
};

function drawChart(host, lines) {
  host.innerHTML = '';
  if (lines.length === 0) {
    host.innerHTML = '<p class="loading">No PnL history for this range.</p>';
    return;
  }
  const width = host.clientWidth || 800;
  const height = width < 520 ? 240 : 300;
  const pad = { top: 12, right: 12, bottom: 24, left: 56 };
  const all = lines.flatMap((l) => l.points);
  const times = all.map(([t]) => t);
  const values = all.map(([, v]) => v);
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const v0 = ticks[0];
  const v1 = ticks[ticks.length - 1];
  const x = (t) => pad.left + ((t - t0) / (t1 - t0 || 1)) * (width - pad.left - pad.right);
  const y = (v) => height - pad.bottom - ((v - v0) / (v1 - v0 || 1)) * (height - pad.top - pad.bottom);
  const label = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  const grid = ticks.map((t) => `
    <line class="${t === 0 ? 'zero' : 'grid'}" x1="${pad.left}" x2="${width - pad.right}" y1="${y(t)}" y2="${y(t)}"/>
    <text x="${pad.left - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`).join('');
  const dates = [t0, (t0 + t1) / 2, t1].map((t, i) =>
    `<text x="${x(t)}" y="${height - 6}" text-anchor="${['start', 'middle', 'end'][i]}">${label(t)}</text>`).join('');
  const paths = [...lines].reverse().map((l) =>
    `<path d="${l.points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`).join('')}" fill="none" stroke="${l.color}" stroke-width="${l.width}" stroke-linejoin="round" stroke-linecap="round"/>`).join('');

  const summary = lines.map((l) => `${l.name} ended at ${usd(l.points[l.points.length - 1][1], { signed: true })}`).join(', ');
  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Perp PnL, ${RANGE_LABELS[state.range]}. ${esc(summary)}.">
    ${grid}${dates}${paths}<line class="crosshair" y1="${pad.top}" y2="${height - pad.bottom}" visibility="hidden"/>
  </svg><div class="tooltip" hidden></div>`;

  const svg = host.querySelector('svg');
  const cross = host.querySelector('.crosshair');
  const tip = host.querySelector('.tooltip');
  const at = (points, t) => {
    let found = null;
    for (const point of points) {
      if (point[0] > t) break;
      found = point;
    }
    return found;
  };
  svg.addEventListener('pointermove', (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const t = t0 + ((px - pad.left) / (width - pad.left - pad.right || 1)) * (t1 - t0);
    if (t < t0 || t > t1) return;
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    cross.setAttribute('visibility', 'visible');
    const rows = lines.map((l) => {
      const hit = at(l.points, t);
      return `<div><span>${l.name}</span><strong>${hit ? usd(hit[1], { signed: true }) : '—'}</strong></div>`;
    }).join('');
    tip.innerHTML = `<span class="when">${label(t)}</span>${rows}`;
    tip.hidden = false;
    const left = (px / width) * box.width;
    tip.style.left = left > box.width / 2 ? `${left - tip.offsetWidth - 12}px` : `${left + 12}px`;
  });
  svg.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
}

const perPoint = (value) => {
  if (value === null) return '—';
  const abs = Math.abs(value);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  const text = `$${abs.toFixed(digits)}`;
  return value < 0 ? `−${text}` : text;
};

function renderPoints() {
  const saved = state.saved;
  const rows = PROGRAMS.map((p) => pointsRow(p, state.venues[p.id], saved[p.id] ?? {}));
  const manualOndo = state.venues.ondo.status === 'unsupported';
  const number = (key, id, value, label) =>
    `<input class="points-input" type="number" ${key === 'pnl' ? '' : 'min="0"'} step="any" inputmode="decimal" data-key="${key}" data-program="${id}" aria-label="${esc(label)}" value="${value ?? ''}" placeholder="Enter">`;
  $('points').innerHTML = `<table>
    <thead><tr><th>DEX</th><th>Fees spent</th><th>Volume</th><th>PnL after fees</th><th>Points</th><th>Cost per point</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${r.name}<span class="sub"><a href="${r.url}" target="_blank" rel="noopener">${r.scope}</a></span></td>
      ${manualOndo ? (r.id === 'ondo' ? `<td>${number('fees', r.id, r.fees, 'Your Ondo fees in dollars')}</td>` : cell(r.fees)) : cell(r.fees)}
      ${cell(r.volume, r.volumeFloor ? atLeast : usd)}
      ${manualOndo && r.id === 'ondo' ? `<td>${number('pnl', r.id, r.pnl, 'Your Ondo PnL after fees in dollars, negative for a loss')}</td>` : pnlCell(r.pnl)}
      <td>${number('points', r.id, r.points, r.label)}</td>
      <td class="key-figure ${r.costPerPoint === null ? '' : tone(-r.costPerPoint)}">${perPoint(r.costPerPoint)}${r.feesOnly ? '<span class="sub">Fees only</span>' : ''}</td>
    </tr>`).join('')}</tbody>
  </table>`;
  const notes = [
    'Cost per point is your loss after fees divided by your points. A negative figure means you earned the points at a profit.',
    "Hyperliquid has no live points program and QFEX's docs don't mention one, so they're left out.",
  ];
  if (rows.some((r) => r.incomplete)) {
    notes.push('Arcus figures cover your latest 5,000 fills, which don\'t reach the start of Season 1.');
  }
  $('points-note').textContent = notes.join(' ');
}

function render() {
  renderCoverage();
  const list = VENUES.map(({ id, name }) => ({ id, name, v: state.venues[id] }));
  const rows = list.filter(({ v }) => isCovered(v));
  const hasWallet = state.address !== null;
  $('report').hidden = !hasWallet;
  if (!hasWallet) return;
  renderPoints();
  const hasReport = rows.length > 0;
  for (const id of ['totals', 'venues-panel']) $(id).hidden = !hasReport;
  if (!hasReport) {
    for (const id of ['chart-panel', 'positions-panel', 'trades-panel']) $(id).hidden = true;
    return;
  }
  renderTotals(combine(list.map(({ v }) => v)));
  renderChart(rows);
  renderVenueTable(rows);
  renderPositions(rows);
  renderTrades(rows);
}

async function load(address) {
  const button = document.querySelector('#lookup button');
  button.disabled = true;
  state.address = address;
  state.saved = readSaved(address);
  state.venues.hyperliquid = { status: 'loading' };
  state.venues.arcus = { status: 'loading' };
  state.venues.risex = { status: 'loading' };
  render();
  const loadOptional = async (dex) => {
    const result = await loadPrivate(dex, address, {
      onUpdate: (partial) => {
        state.venues[dex] = partial;
        render();
      },
    });
    if (result) return result;
    return dex === 'ondo' ? { status: 'unsupported' } : { status: 'input' };
  };
  state.venues.ondo = { status: 'loading' };
  state.venues.qfex = { status: 'input' };
  const run = async (id, loader) => {
    try {
      state.venues[id] = await loader(address);
    } catch (error) {
      state.venues[id] = { status: 'error', message: error.message };
    }
    render();
  };
  await Promise.all([run('hyperliquid', loadHyperliquid), run('arcus', loadArcus), run('risex', loadRisex), run('ondo', () => loadOptional('ondo')), run('qfex', () => loadOptional('qfex'))]);
  button.disabled = false;
}

function onLookup(event) {
  event.preventDefault();
  const address = $('address').value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    $('address-error').textContent = 'Enter an EVM wallet address: 0x followed by 40 letters and numbers.';
    return;
  }
  $('address-error').textContent = '';
  const url = new URL(window.location);
  url.searchParams.set('address', address);
  window.history.replaceState(null, '', url);
  document.title = `${short(address)} on Perp Ledger`;
  load(address.toLowerCase());
}

async function onQfex(event) {
  event.preventDefault();
  const username = new FormData(event.target).get('username').trim();
  if (!username) return;
  state.venues.qfex = { status: 'loading' };
  render();
  try {
    state.venues.qfex = await loadQfex(username);
  } catch (error) {
    state.venues.qfex = { status: 'error', message: error.message };
  }
  render();
}

async function onFiles(event) {
  const added = await Promise.all([...event.target.files].map(async (file) => {
    const rows = parseCsv(await file.text());
    return { name: file.name, rows, kind: fileKind(rows) };
  }));
  const bad = added.find((f) => !f.kind);
  if (bad) {
    state.venues.variational = { status: 'error', message: `${bad.name} is not a Variational trades or transfers CSV.` };
  } else {
    state.files.push(...added);
    state.venues.variational = summarizeExports(state.files);
  }
  render();
}

$('lookup').addEventListener('submit', onLookup);
$('points').addEventListener('change', (event) => {
  const { program, key } = event.target.dataset ?? {};
  if (!program) return;
  const value = Number.parseFloat(event.target.value);
  const valid = Number.isFinite(value) && (key === 'pnl' || value >= 0);
  const entry = { ...state.saved[program], [key]: valid ? value : null };
  state.saved = { ...state.saved, [program]: entry };
  writeSaved(state.address, state.saved);
  renderPoints();
});
$('ranges').addEventListener('click', (event) => {
  const key = event.target.dataset?.range;
  if (!key) return;
  state.range = key;
  render();
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!$('report').hidden) render();
  }, 150);
});

function openApp() {
  $('gate').hidden = true;
  $('app').hidden = false;
  render();
  const initial = new URLSearchParams(window.location.search).get('address');
  if (initial) {
    $('address').value = initial;
    $('lookup').requestSubmit();
  }
}

$('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('password').value }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    $('password').value = '';
    openApp();
  } else {
    $('login-error').textContent = body.error ?? 'Could not sign in. Try again.';
  }
});

async function start() {
  const res = await fetch('/api/login').catch(() => null);
  const body = res ? await res.json().catch(() => ({})) : {};
  if (body.signedIn) {
    openApp();
    return;
  }
  $('gate').hidden = false;
  if (body.error) $('login-error').textContent = body.error;
}

start();
