import { P, haversine } from './geo.js';
import { elevationsAt } from './dem.js';
import { applyMode } from './modes.js';
import { routed } from './planner.js';

// A gap is two consecutive fixes far apart in time and space: the phone stopped delivering GPS
// (app in background, screen locked, no signal). Standing still doesn't count: the tracker only
// stores points after moving a few metres, so a long stop ends with a point close by.
const GAP_MIN_S = 90;
const GAP_MIN_M = 100;
const VEHICLE_SPEED = 4;
const MAX_DETOUR = 3;
const MAX_FOOT_SPEED = 2.5;

export function findGaps(points) {
  const gaps = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a[P.SEG] !== b[P.SEG] || !(a[P.T] > 0) || !(b[P.T] > 0)) continue;
    const dt = (b[P.T] - a[P.T]) / 1000;
    const dist = haversine(a[P.LAT], a[P.LON], b[P.LAT], b[P.LON]);
    if (dt >= GAP_MIN_S && dist >= GAP_MIN_M) gaps.push({ i, dt, dist });
  }
  return gaps;
}

const pathLength = (pts) => pts.reduce((s, p, k) => (k ? s + haversine(pts[k - 1][0], pts[k - 1][1], p[0], p[1]) : 0), 0);

function shift(ranges, at, k) {
  for (const r of ranges ?? []) {
    if (r.from >= at) r.from += k;
    if (r.to >= at) r.to += k;
  }
}

// Bridges every gap: fast ones become vehicle stretches; slow ones are routed along paths
// (BRouter) when the detour and implied speed are plausible, otherwise left as a straight line.
// Processed from the end so inserting points never moves a gap still to be handled.
export async function fillGaps(walk) {
  walk.gaps = (walk.gaps ?? []).filter((g) => g.method === 'route');
  walk.modes = walk.modes ?? [];
  const found = findGaps(walk.points).sort((x, y) => y.i - x.i);
  for (const g of found) {
    const pts = walk.points;
    const a = pts[g.i - 1];
    const b = pts[g.i];
    let method = 'straight';
    let inserted = [];
    if (g.dist / g.dt > VEHICLE_SPEED) method = 'vehicle';
    else {
      try {
        const route = (await routed({ lat: a[P.LAT], lng: a[P.LON] }, { lat: b[P.LAT], lng: b[P.LON] })).slice(1, -1);
        const len = pathLength([[a[P.LAT], a[P.LON]], ...route, [b[P.LAT], b[P.LON]]]);
        if (route.length && len <= g.dist * MAX_DETOUR && len / g.dt <= MAX_FOOT_SPEED) {
          const dem = await elevationsAt(route.map(([lat, lon]) => [lat, lon])).catch(() => []);
          let acc = haversine(a[P.LAT], a[P.LON], route[0][0], route[0][1]);
          inserted = route.map(([lat, lon, ele], k) => {
            if (k) acc += haversine(route[k - 1][0], route[k - 1][1], lat, lon);
            const t = Math.round(a[P.T] + (b[P.T] - a[P.T]) * (acc / len));
            return [lat, lon, null, t, a[P.SEG], dem[k] ?? ele ?? null, 1];
          });
          method = 'route';
        }
      } catch { /* offline or no route: keep the straight line */ }
    }
    if (inserted.length) {
      pts.splice(g.i, 0, ...inserted);
      shift(walk.modes, g.i, inserted.length);
      shift(walk.gaps, g.i, inserted.length);
    }
    const range = { from: g.i - 1, to: g.i + inserted.length, minutes: Math.round(g.dt / 60), method };
    if (method === 'vehicle') walk.modes = applyMode(walk.modes, range.from, range.to, 'vehicle');
    walk.gaps.push(range);
  }
  walk.gaps.sort((x, y) => x.from - y.from);
  walk.gapsChecked = true;
  return found.length;
}

export function gapsSummary(gaps = []) {
  if (!gaps.length) return '';
  const total = gaps.reduce((s, g) => s + g.minutes, 0);
  const by = (m) => gaps.filter((g) => g.method === m).length;
  const parts = [];
  if (by('route')) parts.push(`${by('route')} rellenado(s) por sendero`);
  if (by('vehicle')) parts.push(`${by('vehicle')} en vehículo`);
  if (by('straight')) parts.push(`${by('straight')} en línea recta`);
  return `${gaps.length} hueco(s) sin GPS (${total} min): ${parts.join(', ')}`;
}
