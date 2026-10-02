import { $, esc, store, toast } from './ui.js';
import { P, fmt, segments, elevationProfile, mideSeconds } from './geo.js';
import { photosOf } from './photos.js';
import { nearestBundledPeak } from './peaks.js';

export const FIELDS = [
  { id: 'name', label: 'Nombre' },
  { id: 'date', label: 'Fecha' },
  { id: 'distance', label: 'Distancia' },
  { id: 'moving', label: 'Tiempo en movimiento', timed: true },
  { id: 'total', label: 'Tiempo total', timed: true },
  { id: 'mide', label: 'Tiempo estimado (MIDE)', plan: true },
  { id: 'gain', label: 'Desnivel +' },
  { id: 'loss', label: 'Desnivel −' },
  { id: 'maxAlt', label: 'Altitud máxima' },
  { id: 'pace', label: 'Ritmo medio', timed: true },
  { id: 'maxGrade', label: 'Pendiente máxima' },
  { id: 'summit', label: 'Cumbre' },
  { id: 'track', label: 'Trazado' },
  { id: 'profile', label: 'Perfil de elevación' },
  { id: 'brand', label: 'Marca Sendas' },
];
const DEFAULT_FIELDS = ['name', 'date', 'distance', 'moving', 'mide', 'gain', 'track', 'profile', 'brand'];
const FORMATS = { '4:5': [1080, 1350], '1:1': [1080, 1080], '9:16': [1080, 1920] };

// The last choice is remembered so every share looks consistent.
const prefs = () => ({ fields: DEFAULT_FIELDS, format: '4:5', ...store.get('share') });
const savePrefs = (p) => store.set('share', p);

let state = null;

function statItems(w, fields, summit) {
  const s = w.stats;
  const timed = w.kind !== 'plan' && w.points.some((p) => p[P.T] > 0);
  const total = w.activeMs ? w.activeMs / 1000 : s.duration;
  const all = {
    distance: [fmt.distance(s.distance), 'Distancia'],
    moving: timed && [fmt.duration(s.moving), 'En movimiento'],
    total: timed && [fmt.duration(total), 'Tiempo total'],
    mide: !timed && [fmt.hm(mideSeconds(s.distance, s.gain, s.loss)), 'Tiempo estimado'],
    gain: [`+${Math.round(s.gain)} m`, 'Desnivel +'],
    loss: [`−${Math.round(s.loss)} m`, 'Desnivel −'],
    maxAlt: s.maxAlt != null && [`${Math.round(s.maxAlt)} m`, 'Altitud máx.'],
    pace: timed && [fmt.pace(s.distance, s.moving), 'Ritmo'],
    maxGrade: [`${Math.round(s.maxGrade ?? 0)} %`, 'Pendiente máx.'],
    summit: summit && [summit, 'Cumbre'],
  };
  return FIELDS.map((f) => fields.includes(f.id) && all[f.id]).filter(Boolean);
}

function coverImage(g, img, W, H) {
  const scale = Math.max(W / img.width, H / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  g.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

function drawTrack(g, points, box) {
  const rings = segments(points).map((s) => s.map((p) => [p[P.LAT], p[P.LON]])).filter((r) => r.length > 1);
  if (!rings.length) return;
  const all = rings.flat();
  const lat0 = all.reduce((a, p) => a + p[0], 0) / all.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = all.map((p) => p[1] * k);
  const ys = all.map((p) => -p[0]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = Math.min(box.w / (x1 - x0 || 1e-9), box.h / (y1 - y0 || 1e-9));
  const ox = box.x + (box.w - (x1 - x0) * scale) / 2;
  const oy = box.y + (box.h - (y1 - y0) * scale) / 2;
  const X = (p) => ox + (p[1] * k - x0) * scale;
  const Y = (p) => oy + (-p[0] - y0) * scale;
  g.save();
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.shadowColor = 'rgba(0,0,0,.55)';
  g.shadowBlur = 18;
  g.strokeStyle = '#ffffff';
  g.lineWidth = 9;
  for (const r of rings) {
    g.beginPath();
    r.forEach((p, i) => (i ? g.lineTo(X(p), Y(p)) : g.moveTo(X(p), Y(p))));
    g.stroke();
  }
  g.shadowBlur = 0;
  const dot = (p, color) => {
    g.beginPath();
    g.arc(X(p), Y(p), 13, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.lineWidth = 5;
    g.strokeStyle = '#fff';
    g.stroke();
  };
  dot(rings[0][0], '#2e9e4f');
  const lastRing = rings[rings.length - 1];
  dot(lastRing[lastRing.length - 1], '#d6302a');
  g.restore();
}

function drawProfile(g, points, box) {
  const prof = elevationProfile(points);
  if (prof.length < 2) return;
  const total = prof[prof.length - 1][0] || 1;
  const alts = prof.map(([, a]) => a);
  const min = Math.min(...alts);
  const max = Math.max(...alts);
  const range = Math.max(30, max - min);
  const X = (d) => box.x + (d / total) * box.w;
  const Y = (a) => box.y + box.h - ((a - min) / range) * box.h;
  g.save();
  g.beginPath();
  g.moveTo(box.x, box.y + box.h);
  prof.forEach(([d, a]) => g.lineTo(X(d), Y(a)));
  g.lineTo(box.x + box.w, box.y + box.h);
  g.closePath();
  g.fillStyle = 'rgba(255,255,255,.28)';
  g.fill();
  g.beginPath();
  prof.forEach(([d, a], i) => (i ? g.lineTo(X(d), Y(a)) : g.moveTo(X(d), Y(a))));
  g.strokeStyle = '#fff';
  g.lineWidth = 4;
  g.stroke();
  g.restore();
}

function fitText(g, text, maxW, size, weight = 700) {
  let s = size;
  do { g.font = `${weight} ${s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`; s -= 2; } while (g.measureText(text).width > maxW && s > 24);
}

export function render(canvas, { walk, photo, fields, format, summit }) {
  const [W, H] = FORMATS[format];
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const pad = 64;
  const has = (id) => fields.includes(id);

  if (photo) coverImage(g, photo, W, H);
  else {
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#3d6b47');
    bg.addColorStop(1, '#16281b');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
  }
  const top = g.createLinearGradient(0, 0, 0, H * 0.3);
  top.addColorStop(0, 'rgba(0,0,0,.55)');
  top.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = top;
  g.fillRect(0, 0, W, H * 0.3);
  const bottom = g.createLinearGradient(0, H * 0.4, 0, H);
  bottom.addColorStop(0, 'rgba(0,0,0,0)');
  bottom.addColorStop(1, 'rgba(0,0,0,.8)');
  g.fillStyle = bottom;
  g.fillRect(0, H * 0.4, W, H * 0.6);

  g.fillStyle = '#fff';
  g.textBaseline = 'alphabetic';
  g.shadowColor = 'rgba(0,0,0,.5)';
  g.shadowBlur = 10;
  let y = pad;
  if (has('name')) {
    fitText(g, walk.name, W - pad * 2, 64);
    y += 58;
    g.fillText(walk.name, pad, y);
  }
  if (has('date')) {
    g.font = '500 34px system-ui, -apple-system, sans-serif';
    y += 50;
    g.globalAlpha = 0.9;
    g.fillText(new Date(walk.start).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), pad, y);
    g.globalAlpha = 1;
  }
  g.shadowBlur = 0;

  // Bottom-up layout: brand, stats grid, profile; the track takes the space left.
  let bottomY = H - pad;
  if (has('brand')) {
    g.font = '700 30px system-ui, -apple-system, sans-serif';
    g.textAlign = 'right';
    g.globalAlpha = 0.85;
    g.fillText('Sendas', W - pad, bottomY);
    g.globalAlpha = 1;
    g.textAlign = 'left';
    bottomY -= 56;
  }
  const items = statItems(walk, fields, summit);
  const cols = items.length <= 4 ? Math.max(1, Math.min(items.length, 2)) : 3;
  const rows = Math.ceil(items.length / cols);
  const rowH = 118;
  const colW = (W - pad * 2) / cols;
  const statsTop = bottomY - rows * rowH + 20;
  items.forEach(([value, label], i) => {
    const cx = pad + (i % cols) * colW;
    const cy = statsTop + Math.floor(i / cols) * rowH;
    g.fillStyle = '#fff';
    fitText(g, value, colW - 16, 58);
    g.fillText(value, cx, cy + 54);
    g.font = '600 24px system-ui, -apple-system, sans-serif';
    g.globalAlpha = 0.8;
    g.fillText(label.toUpperCase(), cx, cy + 90);
    g.globalAlpha = 1;
  });
  let free = statsTop - (items.length ? 30 : 0);
  if (has('profile')) {
    const h = Math.round(H * 0.09);
    drawProfile(g, walk.points, { x: pad, y: free - h, w: W - pad * 2, h });
    free -= h + 40;
  }
  if (has('track')) {
    const boxTop = y + 60;
    const boxH = free - boxTop;
    if (boxH > 120) drawTrack(g, walk.points, { x: pad + 40, y: boxTop, w: W - (pad + 40) * 2, h: boxH });
  }
}

async function bitmapFromBlob(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { return null; }
}

function redraw() {
  if (!state) return;
  render($('#share-canvas'), { walk: state.walk, photo: state.bitmap, fields: state.prefs.fields, format: state.prefs.format, summit: state.summit });
}

function renderControls() {
  const p = state.prefs;
  const timed = state.walk.kind !== 'plan' && state.walk.points.some((x) => x[P.T] > 0);
  $('#share-fields').innerHTML = FIELDS.map((f) => {
    const na = (f.timed && !timed) || (f.plan && timed) || (f.id === 'summit' && !state.summit);
    return `<label class="${na ? 'na' : ''}"><input type="checkbox" value="${f.id}" ${p.fields.includes(f.id) ? 'checked' : ''} ${na ? 'disabled' : ''}> ${esc(f.label)}</label>`;
  }).join('');
  document.querySelectorAll('#share-formats button').forEach((b) => b.classList.toggle('on', b.dataset.format === p.format));
  const strip = $('#share-photos');
  strip.innerHTML = '';
  const add = (label, sel, onClick, thumbUrl) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `share-thumb${sel ? ' on' : ''}`;
    if (thumbUrl) b.style.backgroundImage = `url(${thumbUrl})`;
    else b.textContent = label;
    b.addEventListener('click', onClick);
    strip.appendChild(b);
  };
  add('Sin foto', state.photoId === null, () => choosePhoto(null));
  state.photos.forEach((ph) => add('', state.photoId === ph.id, () => choosePhoto(ph), state.urls.get(ph.id)));
  if (state.extra) add('', state.photoId === 'extra', () => choosePhoto('extra'), state.extra.url);
}

async function choosePhoto(ph) {
  state.bitmap?.close?.();
  if (ph === null) { state.photoId = null; state.bitmap = null; }
  else if (ph === 'extra') { state.photoId = 'extra'; state.bitmap = await bitmapFromBlob(state.extra.file); }
  else { state.photoId = ph.id; state.bitmap = await bitmapFromBlob(ph.blob); }
  renderControls();
  redraw();
}

function updatePrefs(change) {
  state.prefs = { ...state.prefs, ...change };
  savePrefs(state.prefs);
  renderControls();
  redraw();
}

function close() {
  if (!state) return;
  state.bitmap?.close?.();
  state.urls.forEach((u) => URL.revokeObjectURL(u));
  if (state.extra) URL.revokeObjectURL(state.extra.url);
  state = null;
}

export async function openShare(walk) {
  close();
  const photos = await photosOf(walk.id);
  state = { walk, photos, urls: new Map(photos.map((p) => [p.id, URL.createObjectURL(p.thumb)])), prefs: prefs(), photoId: null, bitmap: null, extra: null, summit: null };
  const top = walk.points.reduce((a, p) => ((p[P.DEM] ?? p[P.ALT] ?? -Infinity) > (a[P.DEM] ?? a[P.ALT] ?? -Infinity) ? p : a), walk.points[0]);
  state.summit = (await nearestBundledPeak(top[P.LAT], top[P.LON], 250).catch(() => null))?.name ?? null;
  if (photos.length) await choosePhoto(photos[0]);
  else { renderControls(); redraw(); }
  $('#dlg-share').showModal();
}

async function canvasFile() {
  const blob = await new Promise((r) => $('#share-canvas').toBlob(r, 'image/jpeg', 0.92));
  const slug = state.walk.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'paseo';
  return new File([blob], `${slug}.jpg`, { type: 'image/jpeg' });
}

export function initShare() {
  const dlg = $('#dlg-share');
  dlg.addEventListener('close', close);
  $('#share-fields').addEventListener('change', (e) => {
    const fields = [...document.querySelectorAll('#share-fields input:checked')].map((i) => i.value);
    if (e.target.matches('input')) updatePrefs({ fields });
  });
  $('#share-all').addEventListener('click', () => updatePrefs({ fields: FIELDS.map((f) => f.id) }));
  $('#share-none').addEventListener('click', () => updatePrefs({ fields: [] }));
  $('#share-formats').addEventListener('click', (e) => {
    const f = e.target.closest('[data-format]')?.dataset.format;
    if (f) updatePrefs({ format: f });
  });
  $('#share-photo-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !state) return;
    if (state.extra) URL.revokeObjectURL(state.extra.url);
    state.extra = { file, url: URL.createObjectURL(file) };
    await choosePhoto('extra');
  });
  $('#share-send').addEventListener('click', async () => {
    const file = await canvasFile();
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: state.walk.name }); return; } catch (err) { if (err.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Imagen descargada');
  });
  $('#share-download').addEventListener('click', async () => {
    const file = await canvasFile();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}
