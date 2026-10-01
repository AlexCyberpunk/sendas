const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Point format: [lat, lon, alt|null, timestampMs, segment]
export const P = { LAT: 0, LON: 1, ALT: 2, T: 3, SEG: 4 };

const ELEVATION_THRESHOLD = 5;
const MOVING_SPEED = 0.3;

export function computeStats(points) {
  const s = { distance: 0, duration: 0, moving: 0, gain: 0, loss: 0, maxAlt: null, minAlt: null };
  if (!points.length) return s;

  let ref = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const alt = p[P.ALT];
    if (alt != null) {
      s.maxAlt = s.maxAlt == null ? alt : Math.max(s.maxAlt, alt);
      s.minAlt = s.minAlt == null ? alt : Math.min(s.minAlt, alt);
      // Hysteresis filter: GPS altitude jitters by several metres, so only count sustained changes.
      if (ref == null) ref = alt;
      else if (alt - ref >= ELEVATION_THRESHOLD) { s.gain += alt - ref; ref = alt; }
      else if (ref - alt >= ELEVATION_THRESHOLD) { s.loss += ref - alt; ref = alt; }
    }
    if (i === 0) continue;
    const q = points[i - 1];
    const dt = (p[P.T] - q[P.T]) / 1000;
    if (p[P.SEG] !== q[P.SEG]) continue;
    const d = haversine(q[P.LAT], q[P.LON], p[P.LAT], p[P.LON]);
    s.distance += d;
    s.duration += dt;
    if (dt > 0 && d / dt >= MOVING_SPEED) s.moving += dt;
  }
  return s;
}

export function segments(points) {
  const segs = [];
  let cur = null;
  let curSeg = null;
  for (const p of points) {
    if (p[P.SEG] !== curSeg) { cur = []; segs.push(cur); curSeg = p[P.SEG]; }
    cur.push(p);
  }
  return segs;
}

export function elevationProfile(points) {
  const out = [];
  let dist = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0 && points[i - 1][P.SEG] === p[P.SEG]) {
      dist += haversine(points[i - 1][P.LAT], points[i - 1][P.LON], p[P.LAT], p[P.LON]);
    }
    if (p[P.ALT] != null) out.push([dist, p[P.ALT]]);
  }
  return out;
}

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

export function toGPX(walk) {
  const iso = (t) => new Date(t).toISOString();
  const wpts = (walk.waypoints || [])
    .map((w) => `  <wpt lat="${w.lat}" lon="${w.lon}">${w.alt != null ? `<ele>${w.alt.toFixed(1)}</ele>` : ''}<time>${iso(w.t)}</time><name>${esc(w.note || 'Punto')}</name></wpt>`)
    .join('\n');
  const trksegs = segments(walk.points)
    .map((seg) => '    <trkseg>\n' + seg
      .map((p) => `      <trkpt lat="${p[P.LAT].toFixed(7)}" lon="${p[P.LON].toFixed(7)}">${p[P.ALT] != null ? `<ele>${p[P.ALT].toFixed(1)}</ele>` : ''}<time>${iso(p[P.T])}</time></trkpt>`)
      .join('\n') + '\n    </trkseg>')
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Sendas" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(walk.name)}</name><time>${iso(walk.start)}</time>${walk.notes ? `<desc>${esc(walk.notes)}</desc>` : ''}</metadata>
${wpts}
  <trk><name>${esc(walk.name)}</name>
${trksegs}
  </trk>
</gpx>
`;
}

export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('El archivo no es un GPX válido');
  const num = (el, sel) => {
    const n = el.getElementsByTagName(sel)[0];
    return n ? parseFloat(n.textContent) : null;
  };
  const time = (el) => {
    const n = el.getElementsByTagName('time')[0];
    return n ? Date.parse(n.textContent) : null;
  };

  const points = [];
  let seg = 0;
  const base = Date.now();
  const segEls = [...doc.getElementsByTagName('trkseg')];
  const groups = segEls.length ? segEls.map((s) => [...s.getElementsByTagName('trkpt')]) : [[...doc.getElementsByTagName('rtept')]];
  for (const pts of groups) {
    if (!pts.length) continue;
    for (const el of pts) {
      const t = time(el) ?? base + points.length * 1000;
      points.push([parseFloat(el.getAttribute('lat')), parseFloat(el.getAttribute('lon')), num(el, 'ele'), t, seg]);
    }
    seg++;
  }
  if (!points.length) throw new Error('El GPX no contiene ningún track');

  const waypoints = [...doc.getElementsByTagName('wpt')].map((el) => ({
    lat: parseFloat(el.getAttribute('lat')),
    lon: parseFloat(el.getAttribute('lon')),
    alt: num(el, 'ele'),
    t: time(el) ?? points[0][P.T],
    note: el.getElementsByTagName('name')[0]?.textContent || '',
  }));
  const name = doc.querySelector('trk > name')?.textContent || doc.querySelector('metadata > name')?.textContent || 'Ruta importada';
  return { name, points, waypoints };
}

export const fmt = {
  distance: (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`),
  duration: (sec) => {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  },
  alt: (m) => (m == null ? '—' : `${Math.round(m)} m`),
  pace: (distance, sec) => {
    if (distance < 50 || !sec) return '—';
    const perKm = sec / (distance / 1000);
    return `${Math.floor(perKm / 60)}:${String(Math.round(perKm % 60)).padStart(2, '0')} /km`;
  },
  date: (t) => new Date(t).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }),
  datetime: (t) => new Date(t).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  bytes: (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`),
};
