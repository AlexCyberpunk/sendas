// Minimal JPEG EXIF reader: capture time and GPS position, enough to place a photo on a track.
export async function readExif(file) {
  try {
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xffd8) return {};
    let off = 2;
    while (off + 10 < v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xff00) !== 0xff00) break;
      const len = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
      off += 2 + len;
    }
  } catch { /* unreadable or truncated metadata */ }
  return {};
}

function parseTiff(v, start) {
  const le = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(start + o, le);
  const u32 = (o) => v.getUint32(start + o, le);
  const ifd = (o) => {
    const tags = {};
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 };
    }
    return tags;
  };
  const ascii = (t) => {
    const o = t.count > 4 ? u32(t.at) : t.at;
    let s = '';
    for (let i = 0; i < t.count; i++) {
      const c = v.getUint8(start + o + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const rationals = (t) => {
    const o = u32(t.at);
    return Array.from({ length: t.count }, (_, i) => u32(o + i * 8) / (u32(o + i * 8 + 4) || 1));
  };

  const out = {};
  const ifd0 = ifd(u32(4));
  let dateText = null;
  let offset = null;
  if (ifd0[0x8769]) {
    const ex = ifd(u32(ifd0[0x8769].at));
    const dt = ex[0x9003] || ex[0x9004];
    if (dt) dateText = ascii(dt);
    if (ex[0x9011]) offset = ascii(ex[0x9011]);
  }
  if (!dateText && ifd0[0x0132]) dateText = ascii(ifd0[0x0132]);
  const m = dateText?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    // Without an explicit offset the camera wrote local time, which matches the phone's time zone.
    const t = /^[+-]\d{2}:\d{2}$/.test(offset ?? '')
      ? Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`)
      : new Date(+y, mo - 1, +d, +h, +mi, +s).getTime();
    if (Number.isFinite(t)) out.time = t;
  }
  if (ifd0[0x8825]) {
    const g = ifd(u32(ifd0[0x8825].at));
    if (g[2] && g[4]) {
      const deg = ([d, mi, s]) => d + mi / 60 + s / 3600;
      let lat = deg(rationals(g[2]));
      let lon = deg(rationals(g[4]));
      if (g[1] && ascii(g[1]) === 'S') lat = -lat;
      if (g[3] && ascii(g[3]) === 'W') lon = -lon;
      if (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon)) out.gps = { lat, lon };
    }
  }
  return out;
}
