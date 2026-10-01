// Terrarium-encoded elevation tiles (Mapzen/AWS open data, global, ~30 m source resolution).
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const DEM_Z = 12;
export const DEM_FAR_Z = 10;
export const demUrl = (z, x, y) => TERRARIUM.replace('{z}', z).replace('{x}', x).replace('{y}', y);
export const DEM_ATTR = 'Relieve: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Mapzen/AWS Terrain Tiles</a>';

const EARTH_CIRC = 40075016.686;
const MAX_TILES = 200;
const tiles = new Map();

let canvas;
function scratch() {
  if (!canvas) {
    canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  }
  return canvas.getContext('2d', { willReadFrequently: true });
}

async function decode(blob) {
  // colorSpaceConversion:'none' keeps the RGB bytes intact; any colour management would corrupt elevations.
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const g = scratch();
  g.clearRect(0, 0, 256, 256);
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  const d = g.getImageData(0, 0, 256, 256).data;
  const out = new Float32Array(65536);
  for (let i = 0, j = 0; i < 65536; i++, j += 4) out[i] = d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768;
  return out;
}

export function getTile(z, x, y) {
  const n = 2 ** z;
  if (y < 0 || y >= n) return Promise.resolve(null);
  x = ((x % n) + n) % n;
  const key = `${z}/${x}/${y}`;
  let p = tiles.get(key);
  if (p) {
    tiles.delete(key);
    tiles.set(key, p);
    return p;
  }
  p = fetch(demUrl(z, x, y))
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => (b ? decode(b) : null))
    .catch(() => null)
    .then((t) => { if (!t) tiles.delete(key); return t; });
  tiles.set(key, p);
  if (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
  return p;
}

export function worldPx(lat, lon, z) {
  const s = 256 * 2 ** z;
  const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return [((lon + 180) / 360) * s, ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * s];
}

export function pxToLat(gy, z) {
  const n = Math.PI - (2 * Math.PI * gy) / (256 * 2 ** z);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

export const metersPerPx = (lat, z) => (EARTH_CIRC * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** z);

// A grid is a synchronous bilinear sampler over a set of preloaded tiles at one zoom.
export async function loadGrid(z, gx0, gy0, gx1, gy1) {
  const tx0 = Math.floor(Math.min(gx0, gx1) / 256);
  const tx1 = Math.floor(Math.max(gx0, gx1) / 256);
  const ty0 = Math.floor(Math.min(gy0, gy1) / 256);
  const ty1 = Math.floor(Math.max(gy0, gy1) / 256);
  const loaded = new Map();
  const jobs = [];
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) jobs.push(getTile(z, tx, ty).then((t) => { if (t) loaded.set(`${tx}/${ty}`, t); }));
  }
  await Promise.all(jobs);
  return makeGrid(z, loaded);
}

function makeGrid(z, loaded) {
  const raw = (ix, iy) => {
    const tx = Math.floor(ix / 256);
    const ty = Math.floor(iy / 256);
    const t = loaded.get(`${tx}/${ty}`);
    return t ? t[(iy - ty * 256) * 256 + (ix - tx * 256)] : NaN;
  };
  const at = (gx, gy) => {
    const x = gx - 0.5;
    const y = gy - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const a = raw(x0, y0);
    const b = raw(x0 + 1, y0);
    const c = raw(x0, y0 + 1);
    const d = raw(x0 + 1, y0 + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
  return { z, at, empty: loaded.size === 0, atLatLon: (lat, lon) => at(...worldPx(lat, lon, z)) };
}

export async function gridFor(latlons, z = DEM_Z, marginPx = 2) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [lat, lon] of latlons) {
    const [x, y] = worldPx(lat, lon, z);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return loadGrid(z, x0 - marginPx, y0 - marginPx, x1 + marginPx, y1 + marginPx);
}

export async function elevationsAt(latlons, z = DEM_Z) {
  if (!latlons.length) return [];
  // Long routes can span many tiles; sample in chunks so each grid stays small.
  const out = [];
  for (let i = 0; i < latlons.length; i += 400) {
    const chunk = latlons.slice(i, i + 400);
    const grid = await gridFor(chunk, z);
    for (const [lat, lon] of chunk) {
      const e = grid.atLatLon(lat, lon);
      out.push(Number.isFinite(e) ? Math.round(e * 10) / 10 : null);
    }
  }
  return out;
}

export async function elevationAt(lat, lon) {
  return (await elevationsAt([[lat, lon]]))[0];
}

// Avalanche-style slope classes (degrees).
export const SLOPE_CLASSES = [
  { min: 25, color: [255, 221, 0], label: '25–30°' },
  { min: 30, color: [255, 136, 0], label: '30–35°' },
  { min: 35, color: [226, 28, 28], label: '35–40°' },
  { min: 40, color: [150, 30, 160], label: '≥ 40°' },
];

export async function slopeImage(z, x, y) {
  const zd = Math.min(z, DEM_Z);
  const s = 2 ** (zd - z);
  const gx0 = x * 256 * s;
  const gy0 = y * 256 * s;
  const span = 256 * s;
  const grid = await loadGrid(zd, gx0 - 2, gy0 - 2, gx0 + span + 2, gy0 + span + 2);
  const img = new ImageData(256, 256);
  if (grid.empty) return img;
  const d = img.data;
  for (let py = 0; py < 256; py++) {
    const gy = gy0 + (py + 0.5) * s;
    const mpp = metersPerPx(pxToLat(gy, zd), zd);
    for (let px = 0; px < 256; px++) {
      const gx = gx0 + (px + 0.5) * s;
      const dzdx = (grid.at(gx + 1, gy) - grid.at(gx - 1, gy)) / (2 * mpp);
      const dzdy = (grid.at(gx, gy + 1) - grid.at(gx, gy - 1)) / (2 * mpp);
      const deg = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
      if (!(deg >= SLOPE_CLASSES[0].min)) continue;
      let cls = SLOPE_CLASSES[0];
      for (const c of SLOPE_CLASSES) if (deg >= c.min) cls = c;
      const i = (py * 256 + px) * 4;
      d[i] = cls.color[0]; d[i + 1] = cls.color[1]; d[i + 2] = cls.color[2]; d[i + 3] = 150;
    }
  }
  return img;
}
