// WGS84 → UTM (ETRS89 is equivalent at the metre level for emergency purposes).
export function toUTM(lat, lon) {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const zone = Math.floor((lon + 180) / 6) + 1;
  const lon0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const N = a / Math.sqrt(1 - e2 * sin * sin);
  const T = tan * tan;
  const C = ep2 * cos * cos;
  const A = cos * ((lon * Math.PI) / 180 - lon0);
  const M = a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi
    - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi)
    - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const easting = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  let northing = k0 * (M + N * tan * ((A * A) / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) northing += 10000000;
  const band = 'CDEFGHJKLMNPQRSTUVWXX'[Math.max(0, Math.min(20, Math.floor((lat + 80) / 8)))];
  return { zone, band, easting: Math.round(easting), northing: Math.round(northing) };
}

export function toDMS(deg, pos, neg) {
  const h = deg >= 0 ? pos : neg;
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const mFloat = (a - d) * 60;
  const m = Math.floor(mFloat);
  const s = ((mFloat - m) * 60).toFixed(1);
  return `${d}° ${String(m).padStart(2, '0')}′ ${s.padStart(4, '0')}″ ${h}`;
}

export function locationText({ lat, lon, accuracy, alt, time }) {
  const u = toUTM(lat, lon);
  const t = new Date(time).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  return [
    `Mi ubicación (${t}):`,
    `${lat.toFixed(5)}, ${lon.toFixed(5)}${accuracy ? ` (±${Math.round(accuracy)} m)` : ''}`,
    `UTM ${u.zone}${u.band} ${u.easting} ${u.northing} (ETRS89)`,
    alt != null ? `Altitud ${Math.round(alt)} m` : '',
    `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=16/${lat.toFixed(5)}/${lon.toFixed(5)}`,
  ].filter(Boolean).join('\n');
}
