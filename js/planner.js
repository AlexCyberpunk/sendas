import { haversine, computeStats, mideSeconds } from './geo.js';
import { elevationsAt } from './dem.js';

const BROUTER = 'https://brouter.de/brouter';
const STEP_M = 25;

function straight(a, b) {
  const d = haversine(a.lat, a.lng, b.lat, b.lng);
  const n = Math.max(1, Math.ceil(d / STEP_M));
  const out = [];
  for (let i = 0; i <= n; i++) out.push([a.lat + ((b.lat - a.lat) * i) / n, a.lng + ((b.lng - a.lng) * i) / n, null]);
  return out;
}

export async function routed(a, b) {
  const url = `${BROUTER}?lonlats=${a.lng.toFixed(6)},${a.lat.toFixed(6)}|${b.lng.toFixed(6)},${b.lat.toFixed(6)}&profile=hiking-mountain&alternativeidx=0&format=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BRouter ${res.status}`);
  const gj = await res.json();
  const coords = gj.features?.[0]?.geometry?.coordinates;
  if (!coords?.length) throw new Error('Sin ruta');
  return coords.map(([lon, lat, ele]) => [lat, lon, ele ?? null]);
}

const numberIcon = (n) => L.divIcon({ className: 'plan-pt', html: `<span>${n}</span>`, iconSize: [26, 26] });

export class Planner extends EventTarget {
  active = false;
  snap = true;
  fellBack = false;
  #wps = [];
  #legs = [];
  #ver = [];

  constructor(map) {
    super();
    this.map = map;
    this.layer = L.layerGroup();
    this.line = L.polyline([], { color: '#1565c0', weight: 5, opacity: 0.85 });
    this.onClick = (e) => this.add(e.latlng);
  }

  start() {
    this.active = true;
    this.#wps = [];
    this.#legs = [];
    this.#ver = [];
    this.layer.addTo(this.map);
    this.line.setLatLngs([]).addTo(this.layer);
    this.map.on('click', this.onClick);
    this.map.getContainer().classList.add('planning');
    this.#emit();
  }

  stop() {
    this.active = false;
    this.map.off('click', this.onClick);
    this.layer.clearLayers();
    this.map.removeLayer(this.layer);
    this.map.getContainer().classList.remove('planning');
  }

  add(latlng) {
    const i = this.#wps.length;
    const m = L.marker(latlng, { draggable: true, icon: numberIcon(i + 1) }).addTo(this.layer);
    m.on('dragend', () => {
      const idx = this.#wps.indexOf(m);
      if (idx > 0) this.#compute(idx - 1);
      if (idx < this.#wps.length - 1) this.#compute(idx);
    });
    this.#wps.push(m);
    if (i > 0) this.#compute(i - 1);
    else this.#emit();
  }

  undo() {
    const m = this.#wps.pop();
    if (!m) return;
    this.layer.removeLayer(m);
    this.#legs.length = Math.max(0, this.#wps.length - 1);
    this.#redraw();
  }

  setSnap(on) {
    this.snap = on;
    for (let i = 0; i < this.#wps.length - 1; i++) this.#compute(i);
  }

  async #compute(i) {
    const v = (this.#ver[i] = (this.#ver[i] ?? 0) + 1);
    const a = this.#wps[i].getLatLng();
    const b = this.#wps[i + 1].getLatLng();
    this.#legs[i] = straight(a, b);
    this.#redraw();
    let pts = this.#legs[i];
    if (this.snap) {
      try {
        pts = await routed(a, b);
        this.fellBack = false;
      } catch {
        this.fellBack = true;
      }
    }
    const dem = await elevationsAt(pts.map(([lat, lon]) => [lat, lon]));
    pts = pts.map(([lat, lon, ele], k) => [lat, lon, dem[k] ?? ele]);
    if (this.#ver[i] !== v || !this.#wps[i + 1]) return;
    this.#legs[i] = pts;
    this.#redraw();
  }

  points() {
    const out = [];
    this.#legs.forEach((leg, i) => { if (leg) out.push(...(i === 0 ? leg : leg.slice(1))); });
    return out;
  }

  // Same point format as recorded walks: [lat, lon, gpsAlt, t, seg, dem].
  walkPoints() {
    return this.points().map(([lat, lon, ele]) => [lat, lon, null, 0, 0, ele]);
  }

  stats() {
    const s = computeStats(this.walkPoints());
    return { ...s, mide: mideSeconds(s.distance, s.gain, s.loss), count: this.#wps.length };
  }

  #redraw() {
    this.line.setLatLngs(this.points().map(([a, b]) => [a, b]));
    this.#emit();
  }

  #emit() { this.dispatchEvent(new Event('change')); }
}
