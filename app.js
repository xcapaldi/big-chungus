'use strict';

const LB_PER_KG = 2.20462;
const DEFAULT_SETTINGS = { units: 'kg', weekStart: 1 }; // weekStart: 0 = Sunday, 1 = Monday

// --- Settings (localStorage) ----------------------------------------------

function getSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('settings')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const saveSettings = settings => localStorage.setItem('settings', JSON.stringify(settings));

// --- IndexedDB -------------------------------------------------------------
// "days" holds one row per date: { date: 'YYYY-MM-DD', weightKg }.

const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open('weigh-in', 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore('days', { keyPath: 'date' });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function tx(mode, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const t = db.transaction('days', mode);
    const result = fn(t.objectStore('days'));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

const getDays = () => tx('readonly', s => s.getAll());
const putDays = days => tx('readwrite', s => days.forEach(day => s.put(day)));
const deleteDay = date => tx('readwrite', s => s.delete(date));
const getDay = date => tx('readonly', s => s.get(date));

// --- Dates -----------------------------------------------------------------
// Dates are plain 'YYYY-MM-DD' strings. Arithmetic is done in UTC so DST never shifts a day.

const DAY_MS = 86400000;
const isoToUtc = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const utcToIso = ms => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso, n) => utcToIso(isoToUtc(iso) + n * DAY_MS);

function weekStartOf(iso, weekStart) {
  const dow = new Date(isoToUtc(iso)).getUTCDay();
  return addDays(iso, -((dow - weekStart + 7) % 7));
}

function todayLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function formatDate(iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  const d = new Date(iso + 'T00:00');
  opts = { ...opts };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = '2-digit';
  return d.toLocaleDateString(undefined, opts);
}

// --- Helpers ---------------------------------------------------------------

const round = (n, places = 1) => Math.round(n * 10 ** places) / 10 ** places;
const num = v => (v === '' || v == null ? null : Number(v));
const toDisplayWeight = (kg, units) => (units === 'lb' ? kg * LB_PER_KG : kg);
const fromDisplayWeight = (w, units) => (units === 'lb' ? w / LB_PER_KG : w);
const fmt = kg => round(toDisplayWeight(kg, settings.units)).toFixed(1);

// Group days into weeks, newest first. Each week: { start, end, days, avgKg, inProgress, deltaKg }.
// A week is in progress until its last day has passed, so its average can still move.
function groupWeeks(days) {
  const today = todayLocal();
  const byStart = new Map();
  for (const day of days) {
    const start = weekStartOf(day.date, settings.weekStart);
    if (!byStart.has(start)) byStart.set(start, []);
    byStart.get(start).push(day);
  }
  const weeks = [...byStart].sort(([a], [b]) => a.localeCompare(b)).map(([start, wdays]) => {
    const end = addDays(start, 6);
    wdays.sort((a, b) => b.date.localeCompare(a.date));
    const avgKg = wdays.reduce((s, d) => s + d.weightKg, 0) / wdays.length;
    return { start, end, days: wdays, avgKg, inProgress: end >= today, deltaKg: null };
  });
  weeks.forEach((w, i) => { if (i > 0) w.deltaKg = w.avgKg - weeks[i - 1].avgKg; });
  return weeks.reverse();
}

// --- UI --------------------------------------------------------------------

const settingsForm = document.getElementById('settings');
const settingsToggle = document.getElementById('settings-toggle');
const entryForm = document.getElementById('entry');
const weeksTable = document.getElementById('weeks');
const emptyMsg = document.getElementById('empty');
const trendEl = document.getElementById('trend');
const trendEmpty = document.getElementById('trend-empty');
const trendLegend = document.getElementById('trend-legend');

let settings = getSettings();

function fillSettingsForm() {
  settingsForm.units.value = settings.units;
  settingsForm.weekStart.value = String(settings.weekStart);
  document.querySelectorAll('.unit').forEach(el => (el.textContent = settings.units));
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function deltaSpan(deltaKg) {
  if (deltaKg == null) return '';
  const d = round(toDisplayWeight(deltaKg, settings.units));
  if (d === 0) return el('span', { className: 'delta', textContent: '±0.0' });
  return el('span', {
    className: `delta ${d < 0 ? 'down' : 'up'}`,
    textContent: `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`,
    title: 'Change from previous logged week',
  });
}

function renderTable(weeks) {
  weeksTable.replaceChildren(...weeks.map(week => {
    const label = el('td', {},
      `Week of ${formatDate(week.start, { month: 'short', day: 'numeric' })}`,
      week.inProgress ? el('span', { className: 'badge', textContent: 'in progress' }) : '',
      el('div', { className: 'meta', textContent: `${week.days.length}/7 days` }),
    );
    const avg = el('td', { className: 'num' }, `avg ${fmt(week.avgKg)}`, deltaSpan(week.deltaKg));
    const rows = [el('tr', { className: 'week' }, label, avg, el('td'))];
    for (const day of week.days) {
      const del = el('button', { type: 'button', textContent: '×', title: `Delete ${day.date}` });
      del.setAttribute('aria-label', `Delete ${day.date}`);
      del.addEventListener('click', async () => {
        if (!confirm(`Delete the weight for ${formatDate(day.date)}?`)) return;
        await deleteDay(day.date);
        render();
      });
      rows.push(el('tr', { className: 'day' },
        el('td', { textContent: formatDate(day.date), title: day.date }),
        el('td', { className: 'num', textContent: fmt(day.weightKg) }),
        el('td', { className: 'actions' }, del),
      ));
    }
    return el('tbody', {}, ...rows);
  }));
  emptyMsg.hidden = weeks.length > 0;
}

// --- Chart (uPlot) ---------------------------------------------------------
// x = local-midnight timestamp of each week's first day (uPlot wants seconds).
// Series 1 is complete weeks; series 2 is a dashed segment joining the last complete week
// to the in-progress week, so it's clear that point will still move.

let chart = null;
let lastWeeks = [];

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function renderChart(weeks) {
  chart?.destroy();
  chart = null;
  const hasData = weeks.length > 0;
  trendEmpty.hidden = hasData;
  trendLegend.hidden = !weeks.some(w => w.inProgress);
  if (!hasData) return;

  const asc = [...weeks].reverse();
  const xs = asc.map(w => new Date(w.start + 'T00:00').getTime() / 1000);
  const ys = asc.map(w => round(toDisplayWeight(w.avgKg, settings.units), 2));
  const complete = asc.map((w, i) => (w.inProgress ? null : ys[i]));
  const current = asc.map((w, i) => {
    if (w.inProgress) return ys[i];
    if (asc[i + 1]?.inProgress) return ys[i]; // anchor the dashed segment to the last complete week
    return null;
  });

  const line = cssVar('--line');
  const fg = cssVar('--muted');
  const grid = cssVar('--grid');
  const card = cssVar('--card');
  const axis = { stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 } };
  const point = { size: 7, stroke: line, fill: card, width: 2 };

  // Single point: pad the x range so it isn't jammed against an edge.
  const range = xs.length === 1 ? [xs[0] - 3 * 86400, xs[0] + 3 * 86400] : undefined;

  chart = new uPlot({
    width: trendEl.clientWidth,
    height: 220,
    legend: { show: false },
    cursor: { y: false, points: { size: 9 } },
    scales: {
      x: { time: true, range: range && (() => range) },
      y: { range: (u, min, max) => { const pad = Math.max(0.5, (max - min) * 0.15); return [min - pad, max + pad]; } },
    },
    axes: [
      { ...axis, values: (u, ticks) => ticks.map(t => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })) },
      { ...axis, size: 48, values: (u, ticks) => ticks.map(t => t.toFixed(1)) },
    ],
    series: [
      {},
      { label: 'Weekly avg', stroke: line, width: 2, points: point, spanGaps: true },
      { label: 'This week', stroke: line, width: 2, dash: [6, 5], points: point },
    ],
  }, [xs, complete, current], trendEl);
}

async function render() {
  const days = await getDays();
  lastWeeks = groupWeeks(days.filter(d => d.weightKg != null));
  renderTable(lastWeeks);
  renderChart(lastWeeks);
}

new ResizeObserver(() => chart?.setSize({ width: trendEl.clientWidth, height: 220 })).observe(trendEl);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderChart(lastWeeks));

// --- CSV -------------------------------------------------------------------
// Columns: date, weight_kg or weight_lb (current units).

async function exportCsv() {
  const days = (await getDays()).sort((a, b) => a.date.localeCompare(b.date));
  const lines = [`date,weight_${settings.units}`];
  for (const day of days) lines.push(`${day.date},${round(toDisplayWeight(day.weightKg, settings.units), 2)}`);
  const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `weigh-in-${todayLocal()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function parseCsv(text) {
  const [header, ...rows] = text.replace(/^﻿/, '').trim().split(/\r?\n/).map(line => line.split(',').map(c => c.trim()));
  const col = name => header.indexOf(name);
  const dateCol = col('date');
  const weightUnits = col('weight_kg') >= 0 ? 'kg' : 'lb';
  const weightCol = col(`weight_${weightUnits}`);
  if (dateCol < 0) throw new Error('Missing "date" column');
  if (weightCol < 0) throw new Error('Missing "weight_kg" or "weight_lb" column');

  return rows.filter(r => r.some(Boolean)).flatMap((r, i) => {
    const date = r[dateCol];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Row ${i + 2}: bad date "${date}"`);
    const weight = num(r[weightCol]);
    if (weight == null) return [];
    if (Number.isNaN(weight) || weight <= 0) throw new Error(`Row ${i + 2}: bad weight "${r[weightCol]}"`);
    return [{ date, weightKg: fromDisplayWeight(weight, weightUnits) }];
  });
}

document.getElementById('export').addEventListener('click', exportCsv);

document.getElementById('import').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const days = parseCsv(await file.text());
    if (!confirm(`Import ${days.length} day(s)? Existing days with the same date are replaced.`)) return;
    await putDays(days);
    render();
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
});

// --- Forms -----------------------------------------------------------------

settingsToggle.addEventListener('click', () => {
  settingsForm.hidden = !settingsForm.hidden;
  settingsToggle.setAttribute('aria-expanded', String(!settingsForm.hidden));
});

settingsForm.addEventListener('submit', e => {
  e.preventDefault();
  settings = { units: settingsForm.units.value, weekStart: Number(settingsForm.weekStart.value) };
  saveSettings(settings);
  fillSettingsForm();
  settingsForm.hidden = true;
  settingsToggle.setAttribute('aria-expanded', 'false');
  render();
});

entryForm.addEventListener('submit', async e => {
  e.preventDefault();
  const weight = num(entryForm.weight.value);
  if (weight == null || !(weight > 0)) return;
  const date = entryForm.date.value;
  const existing = await getDay(date);
  if (existing && !confirm(`${formatDate(date)} already has ${fmt(existing.weightKg)} ${settings.units}. Replace it with ${round(weight).toFixed(1)} ${settings.units}?`)) return;
  entryForm.weight.value = '';
  await putDays([{ date, weightKg: fromDisplayWeight(weight, settings.units) }]);
  render();
});

entryForm.date.value = todayLocal();
fillSettingsForm();
render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}
