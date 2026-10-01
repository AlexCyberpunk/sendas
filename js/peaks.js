import { db } from './db.js';
import { haversine } from './geo.js';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const CELL = 0.25;
const MAX_AGE = 90 * 24 * 3600e3;

const cellId = (i, j) => `${i}_${j}`;

function cellsIn(s, w, n, e) {
  const out = [];
  for (let i = Math.floor(s / CELL); i <= Math.floor(n / CELL); i++) {
    for (let j = Math.floor(w / CELL); j <= Math.floor(e / CELL); j++) out.push([i, j]);
  }
  return out;
}

async function query(s, w, n, e) {
  const q = `[out:json][timeout:60];node["natural"~"^(peak|volcano)$"]["name"](${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)});out body;`;
  const post = () => fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: q }) });
  // Under load the public instance answers 429/504, often without CORS headers, so the
  // browser reports a network error instead of a status. One delayed retry usually succeeds.
  let res = await post().catch(() => null);
  if (!res || res.status === 429 || res.status >= 500) {
    await new Promise((r) => setTimeout(r, 3000));
    res = await post();
  }
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const json = await res.json();
  return json.elements.map((el) => ({
    id: el.id,
    name: el.tags.name,
    lat: el.lat,
    lon: el.lon,
    ele: Number.parseFloat(String(el.tags.ele ?? '').replace(',', '.')) || null,
  }));
}

// Peaks are cached per 0.25° cell in IndexedDB so the panorama works offline once fetched.
async function peaksInBBox(s, w, n, e) {
  const cells = cellsIn(s, w, n, e);
  const cached = await Promise.all(cells.map(([i, j]) => db.get('peaks', cellId(i, j))));
  const missing = cells.filter((_, k) => !cached[k] || Date.now() - cached[k].t > MAX_AGE);
  let complete = true;
  const fresh = new Map();
  if (missing.length) {
    const ms = Math.min(...missing.map(([i]) => i)) * CELL;
    const mn = (Math.max(...missing.map(([i]) => i)) + 1) * CELL;
    const mw = Math.min(...missing.map(([, j]) => j)) * CELL;
    const me = (Math.max(...missing.map(([, j]) => j)) + 1) * CELL;
    try {
      const peaks = await query(ms, mw, mn, me);
      for (const [i, j] of missing) fresh.set(cellId(i, j), []);
      for (const p of peaks) fresh.get(cellId(Math.floor(p.lat / CELL), Math.floor(p.lon / CELL)))?.push(p);
      await Promise.all([...fresh].map(([id, list]) => db.put('peaks', { t: Date.now(), peaks: list }, id)));
    } catch {
      complete = cached.every(Boolean);
    }
  }
  const all = new Map();
  cells.forEach(([i, j], k) => {
    const list = fresh.get(cellId(i, j)) ?? cached[k]?.peaks ?? [];
    list.forEach((p) => all.set(p.id, p));
  });
  return { peaks: [...all.values()], complete };
}

export function bboxAround(lat, lon, radiusM) {
  const dLat = radiusM / 111132;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

export async function peaksAround(lat, lon, radiusM) {
  const { peaks, complete } = await peaksInBBox(...bboxAround(lat, lon, radiusM));
  return { complete, peaks: peaks.filter((p) => haversine(lat, lon, p.lat, p.lon) <= radiusM) };
}

export const prefetchPeaks = (s, w, n, e) => peaksInBBox(s, w, n, e);
