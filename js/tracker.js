import { db } from './db.js';
import { haversine, computeStats, P } from './geo.js';

const MAX_ACCURACY = 35;
const MIN_STEP = 4;
const MAX_SPEED = 30;
const PERSIST_EVERY_MS = 5000;

export class Locator extends EventTarget {
  watchId = null;
  last = null;
  error = null;

  get active() { return this.watchId != null; }

  start() {
    if (this.active) return;
    if (!('geolocation' in navigator)) {
      this.#fail('Este navegador no tiene geolocalización');
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.error = null;
        this.last = pos;
        this.dispatchEvent(new CustomEvent('fix', { detail: pos }));
      },
      (err) => {
        const msg = err.code === 1 ? 'Permiso de ubicación denegado' : err.code === 3 ? 'Sin señal GPS (tiempo agotado)' : 'No se pudo obtener la ubicación';
        if (err.code === 1) this.stop();
        this.#fail(msg);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  }

  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  #fail(msg) {
    this.error = msg;
    this.dispatchEvent(new CustomEvent('error', { detail: msg }));
  }
}

export class Tracker extends EventTarget {
  state = 'idle';
  id = null;
  points = [];
  waypoints = [];
  seg = 0;
  startedAt = null;
  activeMs = 0;
  resumedAt = null;
  #lastPersist = 0;

  constructor(locator) {
    super();
    this.locator = locator;
    locator.addEventListener('fix', (e) => this.#onFix(e.detail));
  }

  get elapsedMs() {
    return this.activeMs + (this.state === 'recording' ? Date.now() - this.resumedAt : 0);
  }

  get stats() { return computeStats(this.points); }

  async restore() {
    const cur = await db.get('state', 'current');
    if (!cur) return false;
    Object.assign(this, cur, { state: 'paused', resumedAt: null, id: cur.id ?? crypto.randomUUID() });
    this.seg++;
    this.#emit();
    return true;
  }

  start() {
    Object.assign(this, { id: crypto.randomUUID(), points: [], waypoints: [], seg: 0, startedAt: Date.now(), activeMs: 0 });
    this.resume();
  }

  pause() {
    if (this.state !== 'recording') return;
    this.activeMs += Date.now() - this.resumedAt;
    this.state = 'paused';
    this.seg++;
    this.persist();
    this.#emit();
  }

  resume() {
    this.state = 'recording';
    this.resumedAt = Date.now();
    this.locator.start();
    const fix = this.locator.last;
    if (fix && Date.now() - fix.timestamp < 10000) this.#onFix(fix);
    this.persist();
    this.#emit();
  }

  finish() {
    this.pause();
    const walk = {
      id: this.id,
      start: this.startedAt,
      end: Date.now(),
      activeMs: this.activeMs,
      points: this.points,
      waypoints: this.waypoints,
      stats: computeStats(this.points),
    };
    return walk;
  }

  async reset() {
    Object.assign(this, { state: 'idle', id: null, points: [], waypoints: [], seg: 0, startedAt: null, activeMs: 0, resumedAt: null });
    await db.delete('state', 'current');
    this.#emit();
  }

  addWaypoint(note) {
    const fix = this.locator.last;
    if (!fix) return null;
    const c = fix.coords;
    const wp = { lat: c.latitude, lon: c.longitude, alt: c.altitude, t: Date.now(), note };
    this.waypoints.push(wp);
    this.persist();
    this.#emit();
    return wp;
  }

  async persist() {
    if (this.state === 'idle') return;
    this.#lastPersist = Date.now();
    const { id, points, waypoints, seg, startedAt } = this;
    const activeMs = this.elapsedMs;
    await db.put('state', { id, points, waypoints, seg, startedAt, activeMs }, 'current');
  }

  #onFix(pos) {
    if (this.state !== 'recording') return;
    const c = pos.coords;
    if (c.accuracy > MAX_ACCURACY) return;
    const pt = [c.latitude, c.longitude, c.altitude, pos.timestamp, this.seg, null];
    const prev = this.points[this.points.length - 1];
    if (prev && prev[P.SEG] === this.seg) {
      const d = haversine(prev[P.LAT], prev[P.LON], pt[P.LAT], pt[P.LON]);
      const dt = (pt[P.T] - prev[P.T]) / 1000;
      if (d < Math.max(MIN_STEP, c.accuracy / 2)) return;
      if (dt > 0 && d / dt > MAX_SPEED) return;
    }
    this.points.push(pt);
    if (Date.now() - this.#lastPersist > PERSIST_EVERY_MS) this.persist();
    this.#emit(pt);
  }

  #emit(point = null) {
    this.dispatchEvent(new CustomEvent('change', { detail: { point } }));
  }
}
