import { $, esc, toast } from './ui.js';
import { loadGrid, worldPx, metersPerPx, DEM_Z, DEM_FAR_Z } from './dem.js';
import { peaksAround } from './peaks.js';
import { haversine, bearing, fmt } from './geo.js';

export const PANO_RADIUS = 40000;
const NEAR = 3500;
const EYE = 1.7;
const EARTH_R = 6371000;
const REFRACTION = 0.13;
const AZ_STEP = 0.5;
const N_AZ = 360 / AZ_STEP;
const VISIBLE_TOL = 0.12;
// The 30 m DEM is too coarse right next to the observer; starting closer makes interpolation noise block the view.
const START_M = 120;

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const curvature = (d) => ((d * d) / (2 * EARTH_R)) * (1 - REFRACTION);
const stepFor = (d) => Math.max(15, d * 0.012);

async function gridAround(lat, lon, radius, z) {
  const [x, y] = worldPx(lat, lon, z);
  const r = radius / metersPerPx(lat, z) + 2;
  return loadGrid(z, x - r, y - r, x + r, y + r);
}

export async function buildModel(lat, lon, fallbackAlt) {
  const [near, far, peakData] = await Promise.all([
    gridAround(lat, lon, NEAR + 300, DEM_Z),
    gridAround(lat, lon, PANO_RADIUS, DEM_FAR_Z),
    peaksAround(lat, lon, PANO_RADIUS).catch(() => ({ peaks: [], complete: false })),
  ]);
  if (near.empty && far.empty) throw new Error('Sin datos de relieve para esta zona. Conéctate o descárgala con relieve.');
  const cosLat = Math.cos(rad(lat));
  const ground = near.atLatLon(lat, lon);
  const h0 = (Number.isFinite(ground) ? ground : fallbackAlt ?? 0) + EYE;

  const sample = (d, az) => {
    const la = lat + (d * Math.cos(rad(az))) / 111132;
    const lo = lon + (d * Math.sin(rad(az))) / (111320 * cosLat);
    const e = d < NEAR ? near.atLatLon(la, lo) : NaN;
    return Number.isFinite(e) ? e : far.atLatLon(la, lo);
  };
  const angleAt = (d, e) => deg(Math.atan2(e - h0 - curvature(d), d));
  const maxAngle = (az, until) => {
    let max = -90;
    for (let d = START_M; d < until; d += stepFor(d)) {
      const e = sample(d, az);
      if (Number.isFinite(e)) max = Math.max(max, angleAt(d, e));
    }
    return max;
  };

  const horizon = new Float32Array(N_AZ);
  for (let k = 0; k < N_AZ; k++) horizon[k] = maxAngle(k * AZ_STEP, PANO_RADIUS);

  const peaks = [];
  for (const p of peakData.peaks) {
    const dist = haversine(lat, lon, p.lat, p.lon);
    if (dist < 150) continue;
    const az = bearing(lat, lon, p.lat, p.lon);
    // DEM smooths summits, so take the higher of DEM and the tagged altitude.
    const demEle = dist < NEAR ? near.atLatLon(p.lat, p.lon) : far.atLatLon(p.lat, p.lon);
    const ele = Math.max(Number.isFinite(demEle) ? demEle : -Infinity, p.ele ?? -Infinity);
    if (!Number.isFinite(ele)) continue;
    const angle = angleAt(dist, ele);
    const blocking = maxAngle(az, dist * 0.96);
    peaks.push({ ...p, dist, az, angle, ele: p.ele ?? Math.round(ele), visible: angle >= blocking - VISIBLE_TOL });
  }
  return { lat, lon, h0, horizon, peaks, complete: peakData.complete };
}

// Camera direction from DeviceOrientation (W3C ZXY Euler angles): the back camera looks along device −Z.
function cameraDirection(e) {
  if (e.webkitCompassHeading != null) return { heading: e.webkitCompassHeading, pitch: (e.beta ?? 90) - 90 };
  if (e.alpha == null) return null;
  const [a, b, g] = [rad(e.alpha), rad(e.beta), rad(e.gamma)];
  const vx = -(Math.cos(g) * Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.sin(g));
  const vy = -(Math.sin(a) * Math.sin(g) - Math.cos(a) * Math.cos(g) * Math.sin(b));
  const vz = -(Math.cos(b) * Math.cos(g));
  return { heading: (deg(Math.atan2(vx, vy)) + 360) % 360, pitch: deg(Math.asin(Math.max(-1, Math.min(1, vz)))) };
}

const S = {
  model: null, heading: 0, pitch: 0, offH: 0, offV: 0, fov: 60, sensor: false,
  stream: null, raf: 0, listener: null, eventName: null, lastSensor: 0,
};

function draw() {
  S.raf = 0;
  const cv = $('#pano-canvas');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const m = S.model;
  if (!m) return;
  const camera = !!S.stream;
  const hc = (S.heading + S.offH + 360) % 360;
  const pc = S.pitch + S.offV;
  const ppd = W / S.fov;
  const X = (az) => W / 2 + wrap180(az - hc) * ppd;
  const Y = (ang) => H / 2 - (ang - pc) * ppd;

  if (!camera) {
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#6fa8dc');
    sky.addColorStop(1, '#dbe9f4');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
  }
  g.beginPath();
  const half = S.fov / 2 + 2;
  for (let a = -half; a <= half; a += AZ_STEP / 2) {
    const az = (hc + a + 360) % 360;
    const k = Math.round(az / AZ_STEP) % N_AZ;
    const x = W / 2 + a * ppd;
    const y = Y(m.horizon[k]);
    if (a === -half) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.lineWidth = 2;
  g.strokeStyle = camera ? 'rgba(255,255,255,.9)' : '#2f4a33';
  if (!camera) {
    g.save();
    g.lineTo(W + 10, H + 10);
    g.lineTo(-10, H + 10);
    g.closePath();
    const land = g.createLinearGradient(0, H / 2 - 100, 0, H);
    land.addColorStop(0, '#6d8f6a');
    land.addColorStop(1, '#2f4a33');
    g.fillStyle = land;
    g.fill();
    g.restore();
  } else {
    g.shadowColor = 'rgba(0,0,0,.6)';
    g.shadowBlur = 4;
    g.stroke();
    g.shadowBlur = 0;
  }

  // Labels: highest peaks first, stacked in rows so they don't overlap.
  const shown = m.peaks
    .filter((p) => p.visible && Math.abs(wrap180(p.az - hc)) <= S.fov / 2)
    .sort((a, b) => b.ele - a.ele);
  const rows = [];
  const placed = [];
  g.font = '600 13px system-ui, sans-serif';
  for (const p of shown) {
    const x = X(p.az);
    const label = p.name;
    const sub = `${Math.round(p.ele)} m · ${(p.dist / 1000).toFixed(1)} km`;
    const w = Math.max(g.measureText(label).width, g.measureText(sub).width * 0.85) + 12;
    const lx = Math.max(w / 2 + 4, Math.min(W - w / 2 - 4, x));
    let row = rows.findIndex((r) => r.every(([l, rr]) => lx + w / 2 < l || lx - w / 2 > rr));
    if (row === -1) { if (rows.length >= 5) continue; rows.push([]); row = rows.length - 1; }
    rows[row].push([lx - w / 2, lx + w / 2]);
    // The DEM rounds summits off, so anchor on the drawn skyline rather than above it.
    const sky = m.horizon[Math.round(((p.az % 360) + 360) % 360 / AZ_STEP) % N_AZ];
    placed.push({ x, lx, y: Y(Math.min(p.angle, sky)), row, w, label, sub });
  }
  const top = 70;
  for (const { x, lx, y, row, w, label, sub } of placed) {
    const ly = top + row * 40;
    g.strokeStyle = camera ? 'rgba(255,255,255,.85)' : 'rgba(31,42,34,.7)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(lx, ly + 32);
    g.lineTo(x, y);
    g.stroke();
    g.fillStyle = camera ? '#fff' : '#1f2a22';
    g.beginPath();
    g.arc(x, y, 3, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,.92)';
    g.beginPath();
    g.roundRect(lx - w / 2, ly, w, 32, 6);
    g.fill();
    g.fillStyle = '#1f2a22';
    g.textAlign = 'center';
    g.font = '600 13px system-ui, sans-serif';
    g.fillText(label, lx, ly + 14);
    g.font = '11px system-ui, sans-serif';
    g.fillStyle = '#5d6b61';
    g.fillText(sub, lx, ly + 27);
  }

  // Compass tape.
  g.fillStyle = 'rgba(0,0,0,.45)';
  g.fillRect(0, H - 34, W, 34);
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.textAlign = 'center';
  g.font = '12px system-ui, sans-serif';
  const first = Math.ceil((hc - half) / 10) * 10;
  for (let a = first; a <= hc + half; a += 10) {
    const x = X(a);
    const major = ((a % 45) + 360) % 45 === 0;
    g.beginPath();
    g.moveTo(x, H - 34);
    g.lineTo(x, H - (major ? 22 : 28));
    g.stroke();
    if (major) g.fillText(fmt.compass((a + 360) % 360), x, H - 8);
    else if (a % 30 === 0) g.fillText(String((a + 360) % 360), x, H - 8);
  }
  g.fillStyle = '#ffcc00';
  g.fillRect(W / 2 - 1, H - 34, 2, 34);
  $('#pano-heading').textContent = `${Math.round(hc)}° ${fmt.compass(hc)}${S.sensor ? '' : ' · manual'}`;
}

const requestDraw = () => { if (!S.raf) S.raf = requestAnimationFrame(draw); };

function onOrientation(e) {
  const dir = cameraDirection(e);
  if (!dir) return;
  S.sensor = true;
  S.lastSensor = Date.now();
  const k = 0.2;
  S.heading = (S.heading + wrap180(dir.heading - S.heading) * k + 360) % 360;
  S.pitch += (Math.max(-45, Math.min(45, dir.pitch)) - S.pitch) * k;
  requestDraw();
}

async function startSensors() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return;
    }
  } catch { return; }
  S.eventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  S.listener = onOrientation;
  window.addEventListener(S.eventName, S.listener);
}

function stopSensors() {
  if (S.listener) window.removeEventListener(S.eventName, S.listener);
  S.listener = null;
}

async function toggleCamera() {
  const video = $('#pano-video');
  if (S.stream) {
    S.stream.getTracks().forEach((t) => t.stop());
    S.stream = null;
    video.srcObject = null;
    video.hidden = true;
    $('#pano-cam').classList.remove('on');
  } else {
    try {
      S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      video.srcObject = S.stream;
      video.hidden = false;
      $('#pano-cam').classList.add('on');
      S.fov = 50;
      $('#pano-fov').value = 50;
    } catch {
      toast('No se pudo abrir la cámara');
    }
  }
  requestDraw();
}

function renderList() {
  const m = S.model;
  const vis = m.peaks.filter((p) => p.visible).sort((a, b) => a.dist - b.dist);
  const hidden = m.peaks.length - vis.length;
  $('#pano-list').innerHTML = `
    <p class="hint">${vis.length} picos visibles${hidden ? ` · ${hidden} tapados por el relieve` : ''}${m.complete ? '' : ' · lista incompleta (sin conexión)'}</p>
    <ul>${vis.map((p) => `<li><b>${esc(p.name)}</b> <span>${Math.round(p.ele)} m · ${(p.dist / 1000).toFixed(1)} km · ${fmt.compass(p.az)} ${Math.round(p.az)}°</span></li>`).join('') || '<li>No hay picos con nombre a la vista.</li>'}</ul>`;
}

export function closePanorama() {
  stopSensors();
  if (S.stream) toggleCamera();
  cancelAnimationFrame(S.raf);
  S.raf = 0;
  S.model = null;
  $('#panorama').hidden = true;
}

// Must be called from a user gesture: iOS only grants motion permission there.
export async function openPanorama(resolvePlace) {
  const sensors = startSensors();
  Object.assign(S, { heading: 0, pitch: 0, offH: 0, offV: 0, fov: 60, sensor: false, model: null });
  $('#pano-fov').value = 60;
  $('#pano-list').hidden = true;
  $('#panorama').hidden = false;
  $('#pano-info').textContent = 'Buscando tu posición…';
  $('#pano-heading').textContent = '';
  await sensors;
  const { lat, lon, alt = null, fromMap = false } = await resolvePlace();
  if ($('#panorama').hidden) return;
  $('#pano-info').textContent = 'Calculando el horizonte…';
  try {
    S.model = await buildModel(lat, lon, alt);
  } catch (e) {
    toast(e.message);
    closePanorama();
    return;
  }
  if ($('#panorama').hidden) return;
  const vis = S.model.peaks.filter((p) => p.visible).length;
  $('#pano-info').textContent = `${fromMap ? 'Desde el centro del mapa · ' : ''}${Math.round(S.model.h0)} m · ${vis} picos visibles${S.model.complete ? '' : ' (lista incompleta)'}`;
  renderList();
  setTimeout(() => {
    if (!S.sensor && !$('#panorama').hidden) toast('Sin brújula: arrastra para girar la vista', 4500);
  }, 1500);
  requestDraw();
}

export function initPanorama() {
  const cv = $('#pano-canvas');
  let drag = null;
  cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const ppd = cv.clientWidth / S.fov;
    S.offH -= (e.clientX - drag.x) / ppd;
    S.offV += (e.clientY - drag.y) / ppd;
    drag = { x: e.clientX, y: e.clientY };
    requestDraw();
  });
  cv.addEventListener('pointerup', () => { drag = null; });
  cv.addEventListener('pointercancel', () => { drag = null; });
  $('#pano-fov').addEventListener('input', (e) => { S.fov = +e.target.value; requestDraw(); });
  $('#pano-close').addEventListener('click', closePanorama);
  $('#pano-cam').addEventListener('click', toggleCamera);
  $('#pano-list-btn').addEventListener('click', () => { $('#pano-list').hidden = !$('#pano-list').hidden; });
  $('#pano-reset').addEventListener('click', () => { S.offH = 0; S.offV = 0; requestDraw(); });
  window.addEventListener('resize', requestDraw);
}
