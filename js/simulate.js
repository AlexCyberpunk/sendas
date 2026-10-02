import { P, haversine, mideSeconds } from './geo.js';

const FLAT_MS = 4000 / 3600;
const UP_MS = 400 / 3600;
const DOWN_MS = 600 / 3600;

const elevation = (p) => p[P.DEM] ?? p[P.ALT];

// Seconds from the start at which the walker reaches each point.
// Recorded walks replay their real timing (pauses removed); routes use MIDE per stretch,
// scaled so the total matches the MIDE estimate shown elsewhere in the app.
export function buildTimeline(walk) {
  const pts = walk.points;
  const n = pts.length;
  const dist = new Float64Array(n);
  const t = new Float64Array(n);
  const timed = walk.kind !== 'plan' && pts.some((p) => p[P.T] > 0);
  let raw = 0;
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const sameSeg = a[P.SEG] === b[P.SEG];
    const d = sameSeg ? haversine(a[P.LAT], a[P.LON], b[P.LAT], b[P.LON]) : 0;
    dist[i] = dist[i - 1] + d;
    if (timed) {
      t[i] = t[i - 1] + (sameSeg && b[P.T] > a[P.T] ? (b[P.T] - a[P.T]) / 1000 : 0);
    } else {
      const ea = elevation(a);
      const eb = elevation(b);
      const dh = ea != null && eb != null ? eb - ea : 0;
      const th = d / FLAT_MS;
      const tv = dh > 0 ? dh / UP_MS : -dh / DOWN_MS;
      raw += Math.max(th, tv) + Math.min(th, tv) / 2;
      t[i] = raw;
    }
  }
  if (!timed && raw > 0) {
    const s = walk.stats;
    const k = mideSeconds(s.distance, s.gain, s.loss) / raw;
    for (let i = 0; i < n; i++) t[i] *= k;
  }
  return { pts, dist, t, total: t[n - 1] || 0, timed };
}

function indexAt(t, sec) {
  let lo = 0;
  let hi = t.length - 1;
  if (sec <= 0) return 0;
  if (sec >= t[hi]) return hi - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= sec) lo = mid; else hi = mid;
  }
  return lo;
}

export function stateAt(tl, sec) {
  const { pts, dist, t } = tl;
  if (pts.length < 2) return { lat: pts[0][P.LAT], lon: pts[0][P.LON], ele: elevation(pts[0]), dist: 0 };
  const i = indexAt(t, sec);
  const span = t[i + 1] - t[i];
  const f = span > 0 ? Math.max(0, Math.min(1, (sec - t[i]) / span)) : 0;
  const a = pts[i];
  const b = pts[i + 1];
  const ea = elevation(a);
  const eb = elevation(b);
  return {
    lat: a[P.LAT] + (b[P.LAT] - a[P.LAT]) * f,
    lon: a[P.LON] + (b[P.LON] - a[P.LON]) * f,
    ele: ea != null && eb != null ? ea + (eb - ea) * f : ea ?? eb,
    dist: dist[i] + (dist[i + 1] - dist[i]) * f,
  };
}

export class Simulation extends EventTarget {
  sec = 0;
  speed = 60;
  playing = false;
  #raf = 0;
  #last = 0;

  constructor(walk, departure) {
    super();
    this.walk = walk;
    this.tl = buildTimeline(walk);
    this.departure = departure;
  }

  get clock() { return this.departure + this.sec * 1000; }
  get state() { return stateAt(this.tl, this.sec); }

  play() {
    if (this.sec >= this.tl.total) this.sec = 0;
    this.playing = true;
    this.#last = performance.now();
    this.#raf = requestAnimationFrame(this.#tick);
    this.#emit();
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.#raf);
    this.#emit();
  }

  seek(sec) {
    this.sec = Math.max(0, Math.min(this.tl.total, sec));
    this.#emit();
  }

  destroy() { this.pause(); }

  #tick = (now) => {
    if (!this.playing) return;
    this.sec += ((now - this.#last) / 1000) * this.speed;
    this.#last = now;
    if (this.sec >= this.tl.total) {
      this.sec = this.tl.total;
      this.playing = false;
    } else {
      this.#raf = requestAnimationFrame(this.#tick);
    }
    this.#emit();
  };

  #emit() { this.dispatchEvent(new Event('update')); }
}
