import { LAYERS, tileUrl } from './layers.js';
import { db } from './db.js';

export const MIN_ZOOM = 6;
export const MAX_TILES = 15000;
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

export function estimate(bounds, layerId, maxZ) {
  const b = clip(bounds, layerId);
  if (!b) return { tiles: 0, bytes: 0, outside: true };
  let n = 0;
  for (let z = MIN_ZOOM; z <= maxZ; z++) {
    n += (lon2x(b.east, z) - lon2x(b.west, z) + 1) * (lat2y(b.south, z) - lat2y(b.north, z) + 1);
  }
  return { tiles: n, bytes: n * LAYERS[layerId].avgKB * 1024, outside: false };
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

export async function downloadZone({ name, layerId, bounds, maxZ }, { onProgress, signal }) {
  const b = clip(bounds, layerId);
  const total = estimate(bounds, layerId, maxZ).tiles;
  const zone = {
    id: crypto.randomUUID(),
    name,
    layerId,
    bounds: b,
    minZ: MIN_ZOOM,
    maxZ,
    tiles: total,
    bytes: 0,
    failed: 0,
    created: Date.now(),
  };
  const cacheName = `zone-${zone.id}`;
  const cache = await caches.open(cacheName);
  const iter = tiles(b, MIN_ZOOM, maxZ);
  const internal = new AbortController();
  const stop = AbortSignal.any([signal, internal.signal]);
  let done = 0;

  const worker = async () => {
    for (let next = iter.next(); !next.done && !stop.aborted; next = iter.next()) {
      const url = tileUrl(layerId, ...next.value);
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
  await db.put('zones', zone);
  return zone;
}

export async function deleteZone(id) {
  await caches.delete(`zone-${id}`);
  await db.delete('zones', id);
}
