import { db } from './db.js';

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

export async function savePhoto(file, { walkId, lat, lon, alt }) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const [blob, thumb] = await Promise.all([resize(bmp, MAX_SIDE, 0.82), resize(bmp, THUMB_SIDE, 0.7)]);
  bmp.close?.();
  const photo = { id: crypto.randomUUID(), walkId, lat, lon, alt, t: Date.now(), blob, thumb };
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
