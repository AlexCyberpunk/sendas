import { P } from './geo.js';

const OFF_ROUTE_M = 40;
const STRIKES = 2;
const M_PER_DEG_LAT = 110574;

// Planar projection around a reference latitude is accurate enough for the few km near the walker.
function project(lat, lon, lat0) {
  return [lon * 111320 * Math.cos((lat0 * Math.PI) / 180), lat * M_PER_DEG_LAT];
}

export class RouteFollower extends EventTarget {
  route = null;
  info = null;
  #strikes = 0;
  #offRoute = false;

  get active() { return !!this.route; }

  start(walk, reversed = false) {
    let pts = walk.points.map((p) => [p[P.LAT], p[P.LON]]);
    if (reversed) pts = pts.reverse();
    const lat0 = pts[0][0];
    const xy = pts.map(([a, b]) => project(a, b, lat0));
    const cum = [0];
    for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    this.route = { id: walk.id, name: walk.name, walk, reversed, pts, xy, cum, lat0, total: cum[cum.length - 1] };
    this.info = null;
    this.#strikes = 0;
    this.#offRoute = false;
    this.dispatchEvent(new Event('change'));
  }

  reverse() {
    if (this.route) this.start(this.route.walk, !this.route.reversed);
  }

  stop() {
    this.route = null;
    this.info = null;
    this.dispatchEvent(new Event('change'));
  }

  #nearest(x, y) {
    const { xy, cum } = this.route;
    const lastAlong = this.info?.along;
    const cands = [];
    let best = Infinity;
    for (let i = 0; i < xy.length - 1; i++) {
      const [ax, ay] = xy[i];
      const dx = xy[i + 1][0] - ax;
      const dy = xy[i + 1][1] - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
      const along = cum[i] + t * Math.sqrt(l2);
      if (d < best) best = d;
      cands.push([d, along]);
    }
    // Out-and-back routes pass the same spot twice; prefer the pass closest to where we were.
    const close = cands.filter(([d]) => d <= best + 15);
    if (lastAlong == null || close.length === 1) return close.reduce((a, b) => (b[0] < a[0] ? b : a));
    return close.reduce((a, b) => (Math.abs(b[1] - lastAlong) < Math.abs(a[1] - lastAlong) ? b : a));
  }

  update(lat, lon, accuracy = 10) {
    if (!this.route) return null;
    const [x, y] = project(lat, lon, this.route.lat0);
    const [dist, along] = this.#nearest(x, y);
    const effective = dist - accuracy / 2;
    if (effective > OFF_ROUTE_M) this.#strikes++;
    else this.#strikes = 0;
    const wasOff = this.#offRoute;
    this.#offRoute = this.#strikes >= STRIKES || (this.#offRoute && effective > OFF_ROUTE_M * 0.6);
    this.info = { dist, along, remaining: Math.max(0, this.route.total - along), offRoute: this.#offRoute, total: this.route.total };
    if (this.#offRoute && !wasOff) this.dispatchEvent(new CustomEvent('offroute', { detail: this.info }));
    if (!this.#offRoute && wasOff) this.dispatchEvent(new CustomEvent('onroute', { detail: this.info }));
    this.dispatchEvent(new CustomEvent('update', { detail: this.info }));
    return this.info;
  }
}
