import { haversine, computeStats, mideSeconds } from './geo.js';
import { elevationsAt } from './dem.js';

// Official route networks published by the IGN ("Naturaleza, Cultura y Ocio"), all of Spain:
// homologated trails (GR, PR, SL, data from FEDME), Vías Verdes and Caminos Naturales (MAPA).
// The app ships a small index (data/routes-es.json); full geometry is fetched when a route is opened.
const NCO = 'https://nco.ign.es/server/rest/services/nco';
export const TYPES = {
  SL: { label: 'SL', name: 'Sendero Local', color: '#2e7d32', service: 'SL' },
  PR: { label: 'PR', name: 'Pequeño Recorrido', color: '#f9a825', service: 'PR' },
  GR: { label: 'GR', name: 'Gran Recorrido', color: '#d32f2f', service: 'GR' },
  VV: { label: 'Vía Verde', name: 'Vía Verde', color: '#00897b', service: 'V%C3%ADasVerdes' },
  CN: { label: 'Camino Natural', name: 'Camino Natural', color: '#6d4c41', service: 'CaminosNaturales' },
};

const KIDS_MAX_KM = 8;
const KIDS_MAX_GAIN = 300;

let index = null;
export function loadIndex() {
  index ??= fetch('data/routes-es.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('index'))))
    .then((rows) => rows.map(([type, oid, name, km, a, m, b, extra]) => ({ type, oid, name, km, pts: [a, m, b], extra })))
    .catch((e) => { index = null; throw e; });
  return index;
}

// Vías Verdes are old railways: flat and car-free. SL are under 10 km by definition.
export const looksKidFriendly = (r) => r.type === 'VV' || r.type === 'SL' || ((r.type === 'PR' || r.type === 'CN') && r.km != null && r.km <= KIDS_MAX_KM);

export async function routesNear(lat, lon, radiusKm, filter = 'all', limit = 80) {
  const all = await loadIndex();
  const maxM = radiusKm * 1000;
  return all
    .filter((r) => filter === 'all' || (filter === 'kids' ? looksKidFriendly(r) : r.type === filter))
    .map((r) => ({ ...r, dist: Math.min(...r.pts.map(([a, b]) => haversine(lat, lon, a, b))) }))
    .filter((r) => r.dist <= maxM)
    .sort((x, y) => x.dist - y.dist)
    .slice(0, limit);
}

const cache = new Map();

export async function fetchRoute(r) {
  const key = `${r.type}:${r.oid}`;
  if (cache.has(key)) return cache.get(key);
  const res = await fetch(`${NCO}/${TYPES[r.type].service}/MapServer/1/query?objectIds=${r.oid}&outFields=*&outSR=4326&f=geojson`);
  if (!res.ok) throw new Error(`IGN ${res.status}`);
  const f = (await res.json()).features?.[0];
  if (!f?.geometry) throw new Error('Ruta sin geometría');
  const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const flat = [];
  parts.forEach((part, seg) => part.forEach(([lon, lat]) => flat.push([lat, lon, seg])));
  const dem = await elevationsAt(flat.map(([lat, lon]) => [lat, lon])).catch(() => []);
  const points = flat.map(([lat, lon, seg], i) => [lat, lon, null, 0, seg, dem[i] ?? null]);
  const props = Object.fromEntries(Object.entries(f.properties).map(([k, v]) => [k.split('.').pop(), typeof v === 'string' ? v.trim() : v]));
  const stats = computeStats(points);
  const out = {
    points,
    stats,
    mide: mideSeconds(stats.distance, stats.gain, stats.loss),
    infoUrl: /^https?:\/\//.test(props.url_info ?? '') ? props.url_info : null,
    recorrido: props.recorrido || '',
  };
  out.kids = r.type === 'VV' || (stats.distance <= KIDS_MAX_KM * 1000 * 1.25 && stats.gain <= KIDS_MAX_GAIN);
  cache.set(key, out);
  return out;
}

export function toWalk(r, data) {
  return {
    id: crypto.randomUUID(),
    kind: 'plan',
    imported: true,
    source: 'IGN',
    name: r.name,
    notes: [`${TYPES[r.type].name} · Fuente: IGN (Naturaleza, Cultura y Ocio)`, data.recorrido, data.infoUrl].filter(Boolean).join('\n'),
    start: Date.now(),
    end: Date.now(),
    points: data.points,
    waypoints: [],
    stats: data.stats,
  };
}
