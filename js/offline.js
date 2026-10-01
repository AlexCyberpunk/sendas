import { LAYERS, tileUrl } from './layers.js';
import { db } from './db.js';
import { demUrl, DEM_Z, DEM_FAR_Z } from './dem.js';
import { prefetchPeaks } from './peaks.js';
import { PANO_RADIUS } from './panorama.js';

export const MIN_ZOOM = 6;
export const MAX_TILES = 15000;
const DEM_KB = 95;
const CONCURRENCY = 4;
const RETRIES = 2;

const MAX_LAT = 85.0511;
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z);
};

function clip(bounds, layerId) {
  const lb = LAYERS[layerId].bounds;
  if (!lb) return bounds;
  const b = {
    south: Math.max(bounds.south, lb[0][0]),
    west: Math.max(bounds.west, lb[0][1]),
    north: Math.min(bounds.north, lb[1][0]),
    east: Math.min(bounds.east, lb[1][1]),
  };
  return b.south < b.north && b.west < b.east ? b : null;
}

function expand(b, meters) {
  const dLat = meters / 111132;
  const dLon = meters / (111320 * Math.cos((((b.south + b.north) / 2) * Math.PI) / 180));
  return { south: b.south - dLat, west: b.west - dLon, north: b.north + dLat, east: b.east + dLon };
}

function* tiles(bounds, minZ, maxZ) {
  for (let z = minZ; z <= maxZ; z++) {
    const max = 2 ** z - 1;
    const x0 = Math.max(0, lon2x(bounds.west, z));
    const x1 = Math.min(max, lon2x(bounds.east, z));
    const y0 = Math.max(0, lat2y(bounds.north, z));
    const y1 = Math.min(max, lat2y(bounds.south, z));
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) yield [z, x, y];
  }
}

function count(b, minZ, maxZ) {
  let n = 0;
  for (let z = minZ; z <= maxZ; z++) n += (lon2x(b.east, z) - lon2x(b.west, z) + 1) * (lat2y(b.south, z) - lat2y(b.north, z) + 1);
  return n;
}

// Relief = DEM tiles for the zone itself (slopes, 3D, elevations) plus coarse DEM around it for the peak panorama.
function reliefSpecs(bounds, maxZ) {
  return [
    { bounds, minZ: MIN_ZOOM, maxZ: Math.min(maxZ, DEM_Z), url: demUrl },
    { bounds: expand(bounds, PANO_RADIUS), minZ: DEM_FAR_Z, maxZ: DEM_FAR_Z, url: demUrl },
  ];
}

export function estimate(bounds, layerId, maxZ, withRelief) {
  const b = clip(bounds, layerId);
  if (!b) return { tiles: 0, bytes: 0, outside: true };
  const mapTiles = count(b, MIN_ZOOM, maxZ);
  const demTiles = withRelief ? reliefSpecs(bounds, maxZ).reduce((n, s) => n + count(s.bounds, s.minZ, s.maxZ), 0) : 0;
  return { tiles: mapTiles + demTiles, bytes: mapTiles * LAYERS[layerId].avgKB * 1024 + demTiles * DEM_KB * 1024, outside: false };
}

async function fetchTile(url, signal) {
  let lastErr;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      const res = await fetch(url, { mode: 'cors', signal });
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (signal.aborted) throw e;
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  throw lastErr;
}

export async function downloadZone({ name, layerId, bounds, maxZ, withRelief }, { onProgress, signal }) {
  const b = clip(bounds, layerId);
  const total = estimate(bounds, layerId, maxZ, withRelief).tiles;
  const zone = {
    id: crypto.randomUUID(),
    name,
    layerId,
    bounds: b,
    minZ: MIN_ZOOM,
    maxZ,
    relief: !!withRelief,
    tiles: total,
    bytes: 0,
    failed: 0,
    created: Date.now(),
  };
  const specs = [{ bounds: b, minZ: MIN_ZOOM, maxZ, url: (z, x, y) => tileUrl(layerId, z, x, y) }, ...(withRelief ? reliefSpecs(bounds, maxZ) : [])];
  const urls = (function* () { for (const s of specs) for (const [z, x, y] of tiles(s.bounds, s.minZ, s.maxZ)) yield s.url(z, x, y); })();

  const cacheName = `zone-${zone.id}`;
  const cache = await caches.open(cacheName);
  const internal = new AbortController();
  const stop = AbortSignal.any([signal, internal.signal]);
  let done = 0;

  const worker = async () => {
    for (let next = urls.next(); !next.done && !stop.aborted; next = urls.next()) {
      const url = next.value;
      try {
        const res = await fetchTile(url, stop);
        const blob = await res.blob();
        await cache.put(url, new Response(blob, { headers: { 'Content-Type': res.headers.get('Content-Type') || blob.type } }));
        zone.bytes += blob.size;
      } catch (e) {
        if (stop.aborted) return;
        if (e?.name === 'QuotaExceededError') {
          internal.abort();
          throw new Error('No queda espacio en el dispositivo para esta zona');
        }
        zone.failed++;
      }
      done++;
      onProgress?.(done, total, zone.bytes);
    }
  };

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } catch (e) {
    await caches.delete(cacheName);
    throw e;
  }
  if (signal.aborted || zone.failed === total) {
    await caches.delete(cacheName);
    if (signal.aborted) return null;
    throw new Error('No se pudo descargar ninguna tesela. Revisa la conexión.');
  }
  if (withRelief) {
    const e = expand(bounds, PANO_RADIUS);
    zone.peaks = await prefetchPeaks(e.south, e.west, e.north, e.east).then((r) => r.complete).catch(() => false);
  }
  await db.put('zones', zone);
  return zone;
}

export async function deleteZone(id) {
  await caches.delete(`zone-${id}`);
  await db.delete('zones', id);
}
