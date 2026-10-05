const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Point format: [lat, lon, gpsAlt|null, timestampMs (0 = untimed), segment, demAlt|null, filled?]
// filled = 1 marks points synthesised to bridge a stretch without GPS.
export const P = { LAT: 0, LON: 1, ALT: 2, T: 3, SEG: 4, DEM: 5, FILL: 6 };

const MOVING_SPEED = 0.3;

const usesDem = (points) => points.length > 0 && points.filter((p) => p[P.DEM] != null).length >= points.length * 0.8;
export const elevationOf = (p, dem) => (dem ? p[P.DEM] ?? p[P.ALT] : p[P.ALT]);

// Transport modes for stretches of a walk. Stored on the walk as ranges of point indices
// {from, to, mode}; a range covers the pairs (from, from+1) … (to-1, to). Uncovered pairs are on foot.
export const MODES = {
  walk: { label: 'A pie', in: 'a pie' },
  bike: { label: 'Bici', in: 'en bici' },
  car: { label: 'Coche', in: 'en coche' },
  bus: { label: 'Autobús', in: 'en autobús' },
  vehicle: { label: 'Vehículo', in: 'en vehículo' },
};

// pm[i] is the mode of the pair (i-1, i); pm[0] mirrors pm[1].
export function pairModes(n, modes = []) {
  const pm = new Array(n).fill('walk');
  for (const r of modes ?? []) {
    for (let i = Math.max(1, r.from + 1); i <= Math.min(n - 1, r.to); i++) pm[i] = r.mode;
  }
  if (n > 1) pm[0] = pm[1];
  return pm;
}

const onFootPoint = (pm, i) => pm[i] === 'walk' || pm[i + 1] === 'walk';

export function computeStats(points, modes = []) {
  const s = { distance: 0, duration: 0, moving: 0, gain: 0, loss: 0, maxAlt: null, minAlt: null, maxGrade: 0, source: 'gps', byMode: {} };
  if (!points.length) return s;
  const dem = usesDem(points);
  s.source = dem ? 'dem' : 'gps';
  // Hysteresis: GPS altitude jitters by metres, DEM interpolation much less.
  const threshold = dem ? 2 : 5;
  const pm = pairModes(points.length, modes);

  // Distance, moving time, pace and climb only count stretches on foot; vehicles go to byMode.
  let ref = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const alt = elevationOf(p, dem);
    if (!onFootPoint(pm, i)) ref = null;
    else if (alt != null) {
      s.maxAlt = s.maxAlt == null ? alt : Math.max(s.maxAlt, alt);
      s.minAlt = s.minAlt == null ? alt : Math.min(s.minAlt, alt);
      if (ref == null) ref = alt;
      else if (alt - ref >= threshold) { s.gain += alt - ref; ref = alt; }
      else if (ref - alt >= threshold) { s.loss += ref - alt; ref = alt; }
    }
    if (i === 0) continue;
    const q = points[i - 1];
    if (p[P.SEG] !== q[P.SEG]) continue;
    const d = haversine(q[P.LAT], q[P.LON], p[P.LAT], p[P.LON]);
    const dt = (p[P.T] - q[P.T]) / 1000;
    if (dt > 0) s.duration += dt;
    if (pm[i] === 'walk') {
      s.distance += d;
      if (dt > 0 && d / dt >= MOVING_SPEED) s.moving += dt;
    } else {
      const m = (s.byMode[pm[i]] ??= { distance: 0, duration: 0 });
      m.distance += d;
      if (dt > 0) m.duration += dt;
    }
  }
  for (const c of gradeChunks(points, 50, modes)) s.maxGrade = Math.max(s.maxGrade, Math.abs(c.grade));
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

// Runs of consecutive points on foot (split at pauses and at vehicle stretches).
export function footRuns(points, modes = []) {
  const pm = pairModes(points.length, modes);
  const runs = [];
  let cur = points.length ? [points[0]] : [];
  for (let i = 1; i < points.length; i++) {
    if (points[i][P.SEG] !== points[i - 1][P.SEG] || pm[i] !== 'walk') {
      if (cur.length > 1) runs.push(cur);
      cur = [points[i]];
    } else cur.push(points[i]);
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}

export function elevationProfile(points, modes = []) {
  const dem = usesDem(points);
  const pm = pairModes(points.length, modes);
  const out = [];
  let dist = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0 && points[i - 1][P.SEG] === p[P.SEG] && pm[i] === 'walk') {
      dist += haversine(points[i - 1][P.LAT], points[i - 1][P.LON], p[P.LAT], p[P.LON]);
    }
    const alt = elevationOf(p, dem);
    if (alt != null && onFootPoint(pm, i)) out.push([dist, alt]);
  }
  return out;
}

// Splits the parts on foot into chunks of at least minLen metres with their mean grade in %.
export function gradeChunks(points, minLen = 50, modes = []) {
  const dem = usesDem(points);
  const chunks = [];
  for (const seg of footRuns(points, modes)) {
    let start = 0;
    let len = 0;
    for (let i = 1; i < seg.length; i++) {
      len += haversine(seg[i - 1][P.LAT], seg[i - 1][P.LON], seg[i][P.LAT], seg[i][P.LON]);
      if (len >= minLen || i === seg.length - 1) {
        const a = elevationOf(seg[start], dem);
        const b = elevationOf(seg[i], dem);
        const grade = a != null && b != null && len > 0 ? ((b - a) / len) * 100 : 0;
        chunks.push({ latlngs: seg.slice(start, i + 1).map((p) => [p[P.LAT], p[P.LON]]), grade, len });
        start = i;
        len = 0;
      }
    }
  }
  return chunks;
}

export const GRADE_CLASSES = [
  { max: 5, color: '#2e9e4f', label: '< 5 %' },
  { max: 10, color: '#c9b800', label: '5–10 %' },
  { max: 20, color: '#f08a00', label: '10–20 %' },
  { max: 30, color: '#d6302a', label: '20–30 %' },
  { max: Infinity, color: '#7b1fa2', label: '> 30 %' },
];
export const gradeColor = (g) => GRADE_CLASSES.find((c) => Math.abs(g) < c.max).color;

// MIDE method (Spanish standard for hiking times): 4 km/h on paths, 400 m/h up, 600 m/h down.
export function mideSeconds(distance, gain, loss) {
  const th = distance / 1000 / 4;
  const tv = gain / 400 + loss / 600;
  return (Math.max(th, tv) + Math.min(th, tv) / 2) * 3600;
}

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

export function toGPX(walk) {
  const iso = (t) => new Date(t).toISOString();
  const dem = usesDem(walk.points);
  const ele = (v) => (v != null ? `<ele>${v.toFixed(1)}</ele>` : '');
  const time = (t) => (t ? `<time>${iso(t)}</time>` : '');
  const wpts = (walk.waypoints || [])
    .map((w) => `  <wpt lat="${w.lat}" lon="${w.lon}">${ele(w.alt)}${time(w.t)}<name>${esc(w.note || 'Punto')}</name></wpt>`)
    .join('\n');
  const trksegs = segments(walk.points)
    .map((seg) => '    <trkseg>\n' + seg
      .map((p) => `      <trkpt lat="${p[P.LAT].toFixed(7)}" lon="${p[P.LON].toFixed(7)}">${ele(elevationOf(p, dem))}${time(p[P.T])}</trkpt>`)
      .join('\n') + '\n    </trkseg>')
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Sendas" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(walk.name)}</name>${time(walk.start)}${walk.notes ? `<desc>${esc(walk.notes)}</desc>` : ''}</metadata>
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
    const t = n ? Date.parse(n.textContent) : NaN;
    return Number.isFinite(t) ? t : 0;
  };

  const points = [];
  let seg = 0;
  const segEls = [...doc.getElementsByTagName('trkseg')];
  const groups = segEls.length ? segEls.map((s) => [...s.getElementsByTagName('trkpt')]) : [[...doc.getElementsByTagName('rtept')]];
  for (const pts of groups) {
    if (!pts.length) continue;
    for (const el of pts) {
      points.push([parseFloat(el.getAttribute('lat')), parseFloat(el.getAttribute('lon')), num(el, 'ele'), time(el), seg, null]);
    }
    seg++;
  }
  if (!points.length) throw new Error('El GPX no contiene ningún track');

  const waypoints = [...doc.getElementsByTagName('wpt')].map((el) => ({
    lat: parseFloat(el.getAttribute('lat')),
    lon: parseFloat(el.getAttribute('lon')),
    alt: num(el, 'ele'),
    t: time(el),
    note: el.getElementsByTagName('name')[0]?.textContent || '',
  }));
  const name = doc.querySelector('trk > name')?.textContent || doc.querySelector('metadata > name')?.textContent || '';
  return { name, points, waypoints, timed: points.some((p) => p[P.T] > 0) };
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
  hm: (sec) => {
    const m = Math.round(sec / 60);
    return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
  },
  alt: (m) => (m == null ? '—' : `${Math.round(m)} m`),
  pace: (distance, sec) => {
    if (distance < 50 || !sec) return '—';
    const perKm = sec / (distance / 1000);
    return `${Math.floor(perKm / 60)}:${String(Math.round(perKm % 60)).padStart(2, '0')} /km`;
  },
  time: (t) => new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
  date: (t) => new Date(t).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }),
  datetime: (t) => new Date(t).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  bytes: (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`),
  compass: (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(deg / 45) % 8],
};
