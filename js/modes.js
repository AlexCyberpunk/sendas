import { P, haversine, MODES, fmt } from './geo.js';

const HALF_WINDOW_S = 30;
const FAST = 3.6;
const VEHICLE = 6;
const STOP_MAX_S = 240;
const MIN_VEHICLE_S = 60;
const MIN_VEHICLE_M = 400;
const MIN_BIKE_S = 180;
const BIKE_MEDIAN = 4;

const WALK = 0;
const QUICK = 1;
const CAR = 2;
const BIKE = 3;

// Classifies a recorded track by speed. Speeds come from a ±30 s window so GPS jitter and
// single bad fixes don't flip the class. Rules, in order:
//  - fast stretches touching a vehicle stretch are its acceleration/braking → vehicle;
//  - slow stretches under 4 min between two vehicle stretches are stops (bus stop, light) → vehicle;
//  - vehicle stretches under 1 min or 400 m are GPS glitches → on foot;
//  - remaining fast stretches of 3+ min with a median ≥ 14 km/h → bike, otherwise on foot (jogging).
// Car and bus can't be told apart by speed, so detection says "vehicle"; the user can refine it.
export function detectModes(points) {
  const n = points.length;
  if (n < 3 || !points.some((p) => p[P.T] > 0)) return [];
  const t = points.map((p) => p[P.T] / 1000);
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a = points[i - 1];
    const b = points[i];
    cum[i] = cum[i - 1] + (a[P.SEG] === b[P.SEG] ? haversine(a[P.LAT], a[P.LON], b[P.LAT], b[P.LON]) : 0);
  }
  const v = new Float64Array(n);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    while (lo < i && (t[lo] < t[i] - HALF_WINDOW_S || points[lo][P.SEG] !== points[i][P.SEG])) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < n && t[hi + 1] <= t[i] + HALF_WINDOW_S && points[hi + 1][P.SEG] === points[i][P.SEG]) hi++;
    const dt = t[hi] - t[lo];
    v[i] = dt >= 5 ? (cum[hi] - cum[lo]) / dt : i ? v[i - 1] : 0;
  }

  let runs = [];
  for (let i = 0; i < n; i++) {
    const cls = v[i] >= VEHICLE ? CAR : v[i] >= FAST ? QUICK : WALK;
    const last = runs[runs.length - 1];
    if (last && last.cls === cls) last.to = i;
    else runs.push({ cls, from: i, to: i });
  }
  const compact = () => {
    const out = [];
    for (const r of runs) {
      const last = out[out.length - 1];
      if (last && last.cls === r.cls) last.to = r.to;
      else out.push({ ...r });
    }
    runs = out;
  };
  const dur = (r) => t[r.to] - t[r.from];
  const dist = (r) => cum[r.to] - cum[r.from];

  for (let changed = true; changed;) {
    changed = false;
    runs.forEach((r, k) => {
      if (r.cls === QUICK && (runs[k - 1]?.cls === CAR || runs[k + 1]?.cls === CAR)) { r.cls = CAR; changed = true; }
    });
    compact();
  }
  runs.forEach((r, k) => {
    if (r.cls === WALK && runs[k - 1]?.cls === CAR && runs[k + 1]?.cls === CAR && dur(r) < STOP_MAX_S) r.cls = CAR;
  });
  compact();
  runs.forEach((r) => { if (r.cls === CAR && (dur(r) < MIN_VEHICLE_S || dist(r) < MIN_VEHICLE_M)) r.cls = WALK; });
  compact();
  runs.forEach((r) => {
    if (r.cls !== QUICK) return;
    const speeds = Array.from(v.slice(r.from, r.to + 1)).sort((a, b) => a - b);
    const median = speeds[Math.floor(speeds.length / 2)];
    r.cls = dur(r) >= MIN_BIKE_S && median >= BIKE_MEDIAN ? BIKE : WALK;
  });
  compact();
  return runs
    .filter((r) => (r.cls === CAR || r.cls === BIKE) && r.to > r.from)
    .map((r) => ({ from: r.from, to: r.to, mode: r.cls === CAR ? 'vehicle' : 'bike', auto: true }));
}

// Sets [from, to] to a mode, splitting or trimming whatever ranges overlap it.
export function applyMode(modes, from, to, mode) {
  if (from > to) [from, to] = [to, from];
  const out = [];
  for (const r of modes ?? []) {
    if (r.to <= from || r.from >= to) { out.push(r); continue; }
    if (r.from < from) out.push({ ...r, to: from });
    if (r.to > to) out.push({ ...r, from: to });
  }
  if (mode !== 'walk' && to > from) out.push({ from, to, mode, auto: false });
  out.sort((a, b) => a.from - b.from);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && last.mode === r.mode && last.to >= r.from) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.to > r.from);
}

export function rangeInfo(points, r) {
  let d = 0;
  for (let i = r.from + 1; i <= r.to; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a[P.SEG] === b[P.SEG]) d += haversine(a[P.LAT], a[P.LON], b[P.LAT], b[P.LON]);
  }
  const t0 = points[r.from][P.T];
  const t1 = points[r.to][P.T];
  const secs = t0 > 0 && t1 > t0 ? (t1 - t0) / 1000 : 0;
  return { distance: d, seconds: secs, speedKmh: secs ? (d / secs) * 3.6 : null, start: t0, end: t1 };
}

// "8.21 km a pie · 23.4 km en autobús (42 min)"
export function modesSummary(stats) {
  const parts = Object.entries(stats.byMode ?? {})
    .filter(([, m]) => m.distance > 0)
    .map(([mode, m]) => `${fmt.distance(m.distance)} ${MODES[mode]?.in ?? mode}${m.duration ? ` (${fmt.hm(m.duration)})` : ''}`);
  return parts.length ? [`${fmt.distance(stats.distance)} a pie`, ...parts].join(' · ') : '';
}
