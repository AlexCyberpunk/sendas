import { db } from './db.js';
import { readExif } from './exif.js';
import { P } from './geo.js';

const TIME_SLACK_MS = 15 * 60 * 1000;

// Track point closest in time to t, if t falls within the walk (with some slack for photos at the car park).
function pointAtTime(points, t) {
  const timed = points.filter((p) => p[P.T] > 0);
  if (!timed.length || t < timed[0][P.T] - TIME_SLACK_MS || t > timed[timed.length - 1][P.T] + TIME_SLACK_MS) return null;
  let lo = 0;
  let hi = timed.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (timed[mid][P.T] < t) lo = mid; else hi = mid;
  }
  return Math.abs(timed[lo][P.T] - t) <= Math.abs(timed[hi][P.T] - t) ? timed[lo] : timed[hi];
}

// Adds gallery photos to a finished walk: EXIF GPS first, then EXIF time matched to the track.
// Android's photo picker strips GPS from EXIF, so the time match is what usually places them.
export async function addPhotosToWalk(files, walk) {
  const result = { gps: 0, time: 0, none: 0, failed: 0 };
  for (const file of files) {
    try {
      const exif = await readExif(file);
      let pos = null;
      let placed = null;
      if (exif.gps) { pos = { lat: exif.gps.lat, lon: exif.gps.lon, alt: null }; placed = 'gps'; }
      else if (exif.time) {
        const p = pointAtTime(walk.points, exif.time);
        if (p) { pos = { lat: p[P.LAT], lon: p[P.LON], alt: p[P.DEM] ?? p[P.ALT] }; placed = 'time'; }
      }
      await savePhoto(file, { walkId: walk.id, lat: pos?.lat ?? null, lon: pos?.lon ?? null, alt: pos?.alt ?? null, t: exif.time ?? file.lastModified ?? Date.now(), placed });
      result[placed ?? 'none']++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

export async function setPhotoPosition(photo, lat, lon, alt) {
  Object.assign(photo, { lat, lon, alt, placed: 'manual' });
  await db.put('photos', photo);
}

const MAX_SIDE = 1600;
const THUMB_SIDE = 240;

async function resize(bitmap, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', quality));
}

export async function savePhoto(file, { walkId, lat, lon, alt, t = Date.now(), placed = 'gps' }) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const [blob, thumb] = await Promise.all([resize(bmp, MAX_SIDE, 0.82), resize(bmp, THUMB_SIDE, 0.7)]);
  bmp.close?.();
  const photo = { id: crypto.randomUUID(), walkId, lat, lon, alt, t, placed: lat == null ? null : placed, blob, thumb };
  await db.put('photos', photo);
  return photo;
}

export const photosOf = (walkId) => db.byIndex('photos', 'walkId', walkId).then((ps) => ps.sort((a, b) => a.t - b.t));
export const deletePhotosOf = (walkId) => db.deleteByIndex('photos', 'walkId', walkId);
export const deletePhoto = (id) => db.delete('photos', id);

// Object URLs leak unless revoked, so each map layer owns its URLs.
export class PhotoLayer {
  #urls = [];

  constructor(map, onOpen) {
    this.group = L.layerGroup().addTo(map);
    this.onOpen = onOpen;
  }

  url(blob) {
    const u = URL.createObjectURL(blob);
    this.#urls.push(u);
    return u;
  }

  clear() {
    this.group.clearLayers();
    this.#urls.forEach((u) => URL.revokeObjectURL(u));
    this.#urls = [];
  }

  add(photo) {
    if (photo.lat == null) return;
    const icon = L.divIcon({ className: 'photo-pin', html: `<img src="${this.url(photo.thumb)}" alt="">`, iconSize: [44, 44], iconAnchor: [22, 44] });
    L.marker([photo.lat, photo.lon], { icon }).on('click', () => this.onOpen(photo)).addTo(this.group);
  }

  show(photos) {
    this.clear();
    photos.forEach((p) => this.add(p));
  }
}
