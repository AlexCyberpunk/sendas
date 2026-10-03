import { db } from './db.js';
import { $, esc, store, toast, ask, alertUser } from './ui.js';
import { LAYERS, OVERLAYS } from './layers.js';
import { Locator, Tracker } from './tracker.js';
import { elevationProfile, segments, computeStats, toGPX, parseGPX, fmt, P, gradeChunks, gradeColor, GRADE_CLASSES, mideSeconds, MODES } from './geo.js';
import { estimate, downloadZone, deleteZone, MAX_TILES, MIN_ZOOM } from './offline.js';
import { elevationsAt, elevationAt } from './dem.js';
import { SlopeLayer, slopeLegendHTML } from './slope.js';
import { RouteFollower } from './routefollow.js';
import { daylightCheck, sunTimes } from './sun.js';
import { toUTM, toDMS, locationText } from './sos.js';
import { Planner } from './planner.js';
import { showWeather } from './weather.js';
import { savePhoto, photosOf, deletePhotosOf, deletePhoto, PhotoLayer, addPhotosToWalk, setPhotoPosition } from './photos.js';
import { VoiceRecorder, saveVoice, voicesOf, deleteVoice, deleteVoicesOf } from './voice.js';
import { Simulation } from './simulate.js';
import { LockScreen } from './lock.js';
import { detectModes, applyMode, rangeInfo, modesSummary } from './modes.js';
import { fillGaps, gapsSummary } from './gaps.js';
import { allProfiles, activeId, activeProfile, setActive, editActive, saveAs, remove as removeProfile, cssFilter, TRACK_COLORS } from './prefs.js';
import { tileUrl } from './layers.js';
import { TYPES as ROUTE_TYPES, routesNear, fetchRoute, toWalk, looksKidFriendly } from './catalog.js';
import { open3D, init3D } from './view3d.js';
import { openPanorama, initPanorama } from './panorama.js';
import { openShare, initShare } from './shareimg.js';

const TRACK_COLOR = '#d6452f';
const SPAIN_BOUNDS = L.latLngBounds(LAYERS.mtn.bounds);
const FIX_FRESH_MS = 120000;
const isDesktop = () => window.matchMedia('(min-width: 760px)').matches;

// ---------- Map & layers ----------
const view = store.get('view');
const map = L.map('map', {
  center: view?.center ?? [40.2, -3.7],
  zoom: view?.zoom ?? 6,
  maxZoom: 19,
  zoomControl: false,
});
L.control.zoom({ position: 'topleft' }).addTo(map);
L.control.scale({ imperial: false, position: 'topleft' }).addTo(map);

const baseLayers = {};
const layerById = {};
for (const [id, def] of Object.entries(LAYERS)) {
  const layer = L.tileLayer(def.url, {
    maxNativeZoom: def.maxNativeZoom,
    maxZoom: 19,
    bounds: def.bounds,
    subdomains: def.subdomains ?? 'abc',
    attribution: def.attribution,
    crossOrigin: true,
    className: 'base-layer',
  });
  layer.layerId = id;
  baseLayers[def.name] = layer;
  layerById[id] = layer;
}
let currentLayerId = LAYERS[store.get('layer')] ? store.get('layer') : 'mtn';
let userChoseLayer = !!store.get('layer');
layerById[currentLayerId].addTo(map);

const overlayLayers = {};
const overlayById = {};
for (const [id, def] of Object.entries(OVERLAYS)) {
  const opts = { maxZoom: 19, opacity: def.opacity, attribution: def.attribution };
  const layer = def.kind === 'wms'
    ? L.tileLayer.wms(def.url, { ...opts, layers: def.layers, format: 'image/png', transparent: true })
    : L.tileLayer(def.url, { ...opts, maxNativeZoom: def.maxNativeZoom });
  layer.overlayId = id;
  overlayLayers[def.name] = layer;
  overlayById[id] = layer;
}
const slopeLayer = new SlopeLayer();
slopeLayer.overlayId = 'slope';
overlayLayers['Pendientes del terreno (≥ 25°)'] = slopeLayer;
overlayById.slope = slopeLayer;
(store.get('overlays') ?? []).forEach((id) => overlayById[id]?.addTo(map));
L.control.layers(baseLayers, overlayLayers, { position: 'topright' }).addTo(map);

function setBaseLayer(id) {
  if (id === currentLayerId) return;
  map.removeLayer(layerById[currentLayerId]);
  layerById[id].addTo(map);
  currentLayerId = id;
  map.fire('baselayerchange', { layer: layerById[id], silent: true });
}
map.on('baselayerchange', (e) => {
  currentLayerId = e.layer.layerId;
  if (!e.silent) { userChoseLayer = true; store.set('layer', currentLayerId); }
});

function updateLegend() {
  const el = $('#map-legend');
  const on = map.hasLayer(slopeLayer) && $('#sheet').hidden;
  el.hidden = !on;
  if (on) el.innerHTML = slopeLegendHTML() + (map.getZoom() < 11 ? '<span>Acerca el mapa para verla</span>' : '');
}
map.on('overlayadd overlayremove', () => {
  store.set('overlays', Object.values(overlayById).filter((l) => map.hasLayer(l)).map((l) => l.overlayId));
  updateLegend();
});
map.on('moveend', () => {
  store.set('view', { center: map.getCenter(), zoom: map.getZoom() });
  updateLegend();
});

const viewLayer = L.featureGroup().addTo(map);
const zoneLayer = L.featureGroup().addTo(map);
const followLine = L.polyline([], { color: '#1565c0', weight: 8, opacity: 0.45, interactive: false }).addTo(map);
const liveLine = L.polyline([], { color: TRACK_COLOR, weight: 5, opacity: 0.9, interactive: false }).addTo(map);
const filterStyle = document.head.appendChild(document.createElement('style'));
function applyProfile() {
  const p = activeProfile();
  filterStyle.textContent = `.base-layer { filter: ${cssFilter(p)}; }`;
  liveLine.setStyle({ color: p.track, weight: p.width });
}
applyProfile();
const liveWaypoints = L.layerGroup().addTo(map);
const posMarker = L.marker([0, 0], { icon: L.divIcon({ className: 'pos-dot', iconSize: [18, 18] }), interactive: false, keyboard: false, zIndexOffset: 1000 });
const accCircle = L.circle([0, 0], { radius: 1, color: '#1a73e8', weight: 1, fillOpacity: 0.08, interactive: false });

const wpIcon = L.divIcon({ className: 'wp-icon', iconSize: [18, 18], iconAnchor: [9, 18] });
const dotIcon = (color) => L.divIcon({ className: 'end-icon', iconSize: [16, 16], html: `<div style="width:100%;height:100%;border-radius:50%;background:${color}"></div>` });

function waypointMarker(wp) {
  const m = L.marker([wp.lat, wp.lon], { icon: wpIcon });
  m.bindPopup(`<strong>${esc(wp.note || 'Punto')}</strong>${wp.t ? `<br>${fmt.time(wp.t)}` : ''}${wp.alt != null ? ` · ${Math.round(wp.alt)} m` : ''}`);
  return m;
}

function sheetPadding() {
  const sheet = $('#sheet');
  if (sheet.hidden) {
    const card = ['#recorder', '#planner', '#simulator'].map((sel) => $(sel)).find((el) => !el.hidden);
    return { paddingTopLeft: [30, 30], paddingBottomRight: [30, (card?.offsetHeight ?? 0) + 40] };
  }
  return isDesktop()
    ? { paddingTopLeft: [30, 30], paddingBottomRight: [sheet.offsetWidth + 40, 30] }
    : { paddingTopLeft: [30, 30], paddingBottomRight: [30, sheet.offsetHeight + 20] };
}

// ---------- Photos ----------
let openPhotoRef = null;
let photoUrl = null;
function openPhoto(photo) {
  openPhotoRef = photo;
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = URL.createObjectURL(photo.blob);
  $('#photo-full').src = photoUrl;
  const how = { gps: 'posición de la foto', time: 'situada por la hora', manual: 'colocada a mano' }[photo.placed] ?? '';
  $('#photo-meta').textContent = `${fmt.datetime(photo.t)}${photo.lat != null ? ` · ${photo.lat.toFixed(5)}, ${photo.lon.toFixed(5)}${how ? ` (${how})` : ''}` : ' · sin ubicar'}${photo.alt != null ? ` · ${Math.round(photo.alt)} m` : ''}`;
  $('#photo-place').textContent = photo.lat != null ? 'Mover en el mapa' : 'Colocar en el mapa';
  $('#dlg-photo').showModal();
}
const livePhotos = new PhotoLayer(map, openPhoto);
const viewPhotos = new PhotoLayer(map, openPhoto);

const MIC_SVG = '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1a7 7 0 0 0 6-6.9z"/></svg>';
class VoiceLayer {
  #urls = [];
  constructor() { this.group = L.layerGroup().addTo(map); }
  clear() { this.group.clearLayers(); this.#urls.forEach((u) => URL.revokeObjectURL(u)); this.#urls = []; }
  url(blob) { const u = URL.createObjectURL(blob); this.#urls.push(u); return u; }
  add(note) {
    if (note.lat == null) return;
    const icon = L.divIcon({ className: 'voice-pin', html: MIC_SVG, iconSize: [26, 26] });
    L.marker([note.lat, note.lon], { icon })
      .bindPopup(`<b>Nota de voz</b> · ${fmt.time(note.t)} · ${fmt.duration(note.duration / 1000)}<br><audio controls preload="none" src="${this.url(note.blob)}" style="width:220px;margin-top:6px"></audio>`)
      .addTo(this.group);
  }
  show(notes) { this.clear(); notes.forEach((n) => this.add(n)); }
}
const liveVoices = new VoiceLayer();
const viewVoices = new VoiceLayer();

const voiceRec = new VoiceRecorder();
async function recordVoice(walkId, pos = {}) {
  try {
    await voiceRec.start();
  } catch (e) {
    toast(e?.name === 'NotAllowedError' ? 'Permiso de micrófono denegado' : e?.message || 'No se pudo grabar audio');
    return null;
  }
  const dlg = $('#dlg-voice');
  $('#voice-time').textContent = '0:00';
  dlg.showModal();
  const timer = setInterval(() => { $('#voice-time').textContent = fmt.duration((Date.now() - voiceRec.startedAt) / 1000); }, 250);
  return new Promise((resolve) => {
    let finished = false;
    const finish = async (save, reason) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      $('#voice-stop').removeEventListener('click', onStop);
      $('#voice-cancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onEsc);
      voiceRec.removeEventListener('limit', onLimit);
      if (dlg.open) dlg.close();
      if (!save) { voiceRec.cancel(); resolve(null); return; }
      const rec = await voiceRec.stop();
      const note = await saveVoice({ walkId, ...rec, lat: pos.lat ?? null, lon: pos.lon ?? null });
      toast(reason ?? 'Nota de voz guardada');
      resolve(note);
    };
    const onStop = () => finish(true);
    const onCancel = () => finish(false);
    const onEsc = (e) => { e.preventDefault(); finish(false); };
    const onLimit = () => finish(true, 'Nota guardada: has llegado al máximo de 5 minutos');
    $('#voice-stop').addEventListener('click', onStop);
    $('#voice-cancel').addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onEsc);
    voiceRec.addEventListener('limit', onLimit);
  });
}

$('#dlg-photo').addEventListener('close', () => {
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null;
});
async function refreshPhotos(walkId) {
  if (walkId === tracker.id) livePhotos.show(await photosOf(walkId));
  else if ($('#sheet-detail').dataset.id === walkId) openWalk(walkId, { keepView: true });
}

$('#photo-place').addEventListener('click', () => {
  const p = openPhotoRef;
  if (!p) return;
  $('#dlg-photo').close();
  toast('Toca el mapa donde hiciste la foto', 6000);
  map.getContainer().classList.add('planning');
  map.once('click', async (e) => {
    map.getContainer().classList.remove('planning');
    await setPhotoPosition(p, e.latlng.lat, e.latlng.lng, await elevationAt(e.latlng.lat, e.latlng.lng).catch(() => null));
    toast('Foto colocada');
    refreshPhotos(p.walkId);
  });
});

$('#photo-delete').addEventListener('click', async () => {
  const p = openPhotoRef;
  if (!p || !confirm('¿Borrar esta foto?')) return;
  await deletePhoto(p.id);
  $('#dlg-photo').close();
  refreshPhotos(p.walkId);
  toast('Foto borrada');
});

// ---------- Location ----------
const locator = new Locator();
const tracker = new Tracker(locator);
const follower = new RouteFollower();
let follow = false;
let firstFix = true;
let lastAltLookup = 0;

const freshFix = () => (locator.last && Date.now() - locator.last.timestamp < FIX_FRESH_MS ? locator.last : null);

function setFollow(on) {
  follow = on;
  $('#btn-locate').classList.toggle('on', on);
}

map.on('dragstart', () => setFollow(false));

$('#btn-locate').addEventListener('click', () => {
  locator.start();
  setFollow(true);
  const fix = locator.last;
  if (fix) map.setView([fix.coords.latitude, fix.coords.longitude], Math.max(map.getZoom(), 15));
  else updateGpsStatus('Buscando señal GPS…');
});

locator.addEventListener('fix', (e) => {
  const c = e.detail.coords;
  const ll = [c.latitude, c.longitude];
  posMarker.setLatLng(ll);
  accCircle.setLatLng(ll).setRadius(c.accuracy);
  if (!map.hasLayer(posMarker)) { accCircle.addTo(map); posMarker.addTo(map); }

  if (firstFix) {
    firstFix = false;
    if (!userChoseLayer && LAYERS[currentLayerId].bounds && !SPAIN_BOUNDS.contains(ll)) {
      setBaseLayer('otm');
      toast('Fuera de España: cambiado a OpenTopoMap');
    }
    if (follow) map.setView(ll, Math.max(map.getZoom(), 15));
  } else if (follow) {
    map.panTo(ll, { animate: true });
  }

  if (tracker.state === 'recording' && Date.now() - lastAltLookup > 4000) {
    lastAltLookup = Date.now();
    elevationAt(c.latitude, c.longitude).then((dem) => { $('#st-alt').textContent = fmt.alt(dem ?? c.altitude); });
  }
  if (follower.active) follower.update(c.latitude, c.longitude, c.accuracy);
  if (c.accuracy > 35) updateGpsStatus(`Señal GPS débil (±${Math.round(c.accuracy)} m), esperando más precisión`, true);
  else updateGpsStatus(tracker.state !== 'idle' ? `GPS ±${Math.round(c.accuracy)} m` : '');
  if ($('#dlg-sos').open) renderSos();
});

locator.addEventListener('error', (e) => updateGpsStatus(e.detail, true));

function updateGpsStatus(text, warn = false) {
  const el = $('#gps-status');
  el.textContent = text;
  el.classList.toggle('warn', warn);
}

// ---------- Recording ----------
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* wake lock refused (e.g. battery saver) */ }
}

let hiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && tracker.state === 'recording') {
    keepAwake(true);
    const away = hiddenAt ? (Date.now() - hiddenAt) / 60000 : 0;
    if (away >= 1.5) toast(`La app estuvo ${Math.round(away)} min en segundo plano sin GPS. Al guardar, ese tramo se rellenará por el sendero.`, 7000);
  }
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); tracker.persist(); } else hiddenAt = null;
});
window.addEventListener('pagehide', () => tracker.persist());

function drawLiveTrack() {
  liveLine.setLatLngs(segments(tracker.points).map((s) => s.map((p) => [p[P.LAT], p[P.LON]])));
  liveWaypoints.clearLayers();
  tracker.waypoints.forEach((wp) => waypointMarker(wp).addTo(liveWaypoints));
}

function renderStats() {
  const s = tracker.stats;
  $('#st-dist').textContent = fmt.distance(s.distance);
  $('#st-time').textContent = fmt.duration(tracker.elapsedMs / 1000);
  $('#st-gain').textContent = `${Math.round(s.gain)} m`;
  const last = tracker.points[tracker.points.length - 1];
  if (last && $('#st-alt').textContent === '—') $('#st-alt').textContent = fmt.alt(last[P.DEM] ?? last[P.ALT]);
}

function renderRecorder() {
  const st = tracker.state;
  $('#stats').hidden = st === 'idle';
  $('#btn-start').hidden = st !== 'idle';
  $('#btn-pause').hidden = st !== 'recording';
  $('#btn-resume').hidden = st !== 'paused';
  $('#btn-add').hidden = st === 'idle';
  $('#btn-lock').hidden = st === 'idle';
  $('#btn-finish').hidden = st === 'idle';
  $('#sun-status').hidden = st === 'idle';
  document.querySelector('[data-tab=map]').classList.toggle('rec', st === 'recording');
  if (st === 'idle') updateGpsStatus(locator.error ?? '', !!locator.error);
  if (st === 'paused') updateGpsStatus('En pausa');
  renderStats();
  checkDaylight();
}

tracker.addEventListener('change', (e) => {
  const pt = e.detail.point;
  if (pt) {
    const rings = liveLine.getLatLngs();
    const multi = rings.length && Array.isArray(rings[0]);
    const lastSeg = tracker.points.length > 1 && tracker.points[tracker.points.length - 2][P.SEG] === pt[P.SEG];
    if (multi && lastSeg) liveLine.addLatLng([pt[P.LAT], pt[P.LON]], rings[rings.length - 1]);
    else drawLiveTrack();
    updateLiveModes();
    // DEM altitude per point: far less noisy than GPS altitude for the climb total.
    elevationAt(pt[P.LAT], pt[P.LON]).then((ele) => {
      if (ele == null) return;
      pt[P.DEM] = ele;
      renderStats();
    });
  } else {
    drawLiveTrack();
  }
  renderRecorder();
});

setInterval(() => { if (tracker.state === 'recording') $('#st-time').textContent = fmt.duration(tracker.elapsedMs / 1000); }, 1000);

$('#btn-start').addEventListener('click', () => {
  viewLayer.clearLayers();
  viewPhotos.clear();
  navigator.storage?.persist?.();
  tracker.start();
  livePhotos.clear();
  setFollow(true);
  keepAwake(true);
  showTab('map');
  if (!locator.last) updateGpsStatus('Buscando señal GPS…');
});

$('#btn-pause').addEventListener('click', () => { tracker.pause(); keepAwake(false); });
$('#btn-resume').addEventListener('click', () => { tracker.resume(); setFollow(true); keepAwake(true); });

$('#btn-add').addEventListener('click', () => $('#dlg-add').showModal());

$('#add-voice').addEventListener('click', async () => {
  $('#dlg-add').close();
  const c = locator.last?.coords;
  const note = await recordVoice(tracker.id, c ? { lat: c.latitude, lon: c.longitude } : {});
  if (note) liveVoices.add(note);
});

$('#add-waypoint').addEventListener('click', async () => {
  $('#dlg-add').close();
  if (!locator.last) { toast('Esperando señal GPS…'); return; }
  const { action, data } = await ask($('#dlg-waypoint'));
  if (action !== 'ok') return;
  const wp = tracker.addWaypoint(data.note.trim());
  if (wp) elevationAt(wp.lat, wp.lon).then((e) => { if (e != null) { wp.alt = e; tracker.persist(); } });
  toast('Punto marcado');
});

$('#photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if ($('#dlg-add').open) $('#dlg-add').close();
  if (!file) return;
  const c = locator.last?.coords;
  try {
    const photo = await savePhoto(file, { walkId: tracker.id, lat: c?.latitude ?? null, lon: c?.longitude ?? null, alt: c ? await elevationAt(c.latitude, c.longitude) ?? c.altitude : null });
    livePhotos.add(photo);
    toast(c ? 'Foto guardada' : 'Foto guardada sin posición (sin señal GPS)');
  } catch {
    toast('No se pudo guardar la foto');
  }
});

async function enrichWithDem(w) {
  if (w.points.every((p) => p[P.DEM] != null)) return false;
  const elev = await elevationsAt(w.points.map((p) => [p[P.LAT], p[P.LON]]));
  if (elev.filter((e) => e != null).length < w.points.length * 0.8) return false;
  w.points.forEach((p, i) => {
    while (p.length <= P.DEM) p.push(null);
    p[P.DEM] = elev[i];
  });
  w.stats = computeStats(w.points, w.modes);
  return true;
}

$('#btn-finish').addEventListener('click', async () => {
  const wasRecording = tracker.state === 'recording';
  updateLiveModes(true);
  const walk = tracker.finish();
  keepAwake(false);
  if (walk.points.length < 2) {
    if (confirm('No se ha registrado ningún recorrido. ¿Descartar el paseo?')) {
      await deletePhotosOf(walk.id);
      await deleteVoicesOf(walk.id);
      livePhotos.clear();
      liveVoices.clear();
      await tracker.reset();
    } else if (wasRecording) { tracker.resume(); keepAwake(true); }
    return;
  }
  $('#dlg-save-title').textContent = 'Guardar paseo';
  $('#dlg-save-discard').hidden = false;
  const { action, data } = await ask($('#dlg-save'), { name: `Paseo ${fmt.datetime(walk.start)}`, notes: '' });
  if (action === 'save') {
    walk.name = data.name.trim() || 'Paseo';
    walk.modes = detectModes(walk.points);
    if (walk.points.some((p, i) => i && p[P.T] - walk.points[i - 1][P.T] > 90000)) toast('Rellenando tramos sin GPS…');
    await fillGaps(walk).catch(() => 0);
    walk.stats = computeStats(walk.points, walk.modes);
    walk.notes = data.notes.trim();
    await enrichWithDem(walk).catch(() => false);
    walk.stats = computeStats(walk.points, walk.modes);
    await db.put('walks', walk);
    await tracker.reset();
    livePhotos.clear();
    liveVoices.clear();
    liveModesLayer.clearLayers();
    $('#mode-status').hidden = true;
    toast('Paseo guardado');
    openWalk(walk.id);
  } else if (action === 'discard') {
    if (confirm('¿Seguro? El paseo y sus fotos se borrarán.')) {
      await deletePhotosOf(walk.id);
      await deleteVoicesOf(walk.id);
      livePhotos.clear();
      liveVoices.clear();
      await tracker.reset();
    }
  } else if (wasRecording) {
    tracker.resume();
    keepAwake(true);
  }
});

// ---------- Daylight ----------
let sunLevel = 'ok';
function checkDaylight() {
  const el = $('#sun-status');
  if (tracker.state === 'idle' || !window.SunCalc) return;
  const fix = locator.last?.coords;
  const last = tracker.points[tracker.points.length - 1];
  const lat = fix?.latitude ?? last?.[P.LAT];
  const lon = fix?.longitude ?? last?.[P.LON];
  if (lat == null) { el.textContent = ''; return; }
  const r = daylightCheck({ lat, lon, stats: tracker.stats, follow: follower.active ? follower.info : null });
  el.innerHTML = `${esc(r.text)}${r.warning ? `<div class="sun-warn">${esc(r.warning)}</div>` : ''}`;
  const rank = { ok: 0, tight: 1, dark: 2, night: 2 };
  if (tracker.state === 'recording' && rank[r.level] > rank[sunLevel] && r.warning) {
    alertUser();
    toast(r.warning, 7000);
  }
  sunLevel = r.level;
}
setInterval(checkDaylight, 30000);

// ---------- Follow route ----------
function renderFollow() {
  const bar = $('#follow-bar');
  bar.hidden = !follower.active;
  document.body.classList.toggle('following', follower.active);
  if (!follower.active) { followLine.setLatLngs([]); return; }
  const info = follower.info;
  $('#follow-name').textContent = `Siguiendo: ${follower.route.name}`;
  bar.classList.toggle('off', !!info?.offRoute);
  $('#follow-meta').textContent = !info
    ? 'Esperando señal GPS…'
    : info.offRoute
      ? `Fuera de ruta (${Math.round(info.dist)} m) · quedan ${fmt.distance(info.remaining)}`
      : `${fmt.distance(info.remaining)} restantes de ${fmt.distance(info.total)}`;
}

follower.addEventListener('change', () => {
  followLine.setLatLngs(follower.active ? follower.route.pts : []);
  store.set('follow', follower.active ? { id: follower.route.id, reversed: follower.route.reversed } : null);
  renderFollow();
});
follower.addEventListener('update', renderFollow);
follower.addEventListener('offroute', (e) => {
  alertUser([400, 150, 400, 150, 400]);
  toast(`Te has salido de la ruta (${Math.round(e.detail.dist)} m)`, 6000);
});
follower.addEventListener('onroute', () => toast('De vuelta en la ruta'));

$('#follow-stop').addEventListener('click', () => follower.stop());
$('#follow-reverse').addEventListener('click', () => {
  follower.reverse();
  const fix = locator.last;
  if (fix) follower.update(fix.coords.latitude, fix.coords.longitude, fix.coords.accuracy);
  toast('Sentido invertido');
});

function startFollowing(w, reversed = false) {
  follower.start(w, reversed);
  locator.start();
  const fix = freshFix();
  if (fix) follower.update(fix.coords.latitude, fix.coords.longitude, fix.coords.accuracy);
}

// ---------- SOS ----------
async function renderSos() {
  const fix = locator.last;
  if (!fix) return;
  const c = fix.coords;
  const alt = (await elevationAt(c.latitude, c.longitude).catch(() => null)) ?? c.altitude;
  const u = toUTM(c.latitude, c.longitude);
  const age = Math.round((Date.now() - fix.timestamp) / 1000);
  $('#sos-body').innerHTML = `
    <div class="sos-coords">
      <div><b>Lat, Lon</b> ${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}</div>
      <div><b>GMS</b> ${toDMS(c.latitude, 'N', 'S')} · ${toDMS(c.longitude, 'E', 'O')}</div>
      <div><b>UTM</b> ${u.zone}${u.band} ${u.easting} E ${u.northing} N</div>
      <div><b>Altitud</b> ${alt != null ? `${Math.round(alt)} m` : '—'} · <b>Precisión</b> ±${Math.round(c.accuracy)} m</div>
      <div class="hint">Posición de hace ${age < 60 ? `${age} s` : `${Math.round(age / 60)} min`}</div>
    </div>`;
  const msg = `Necesito ayuda. ${locationText({ lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, alt, time: fix.timestamp })}`;
  $('#sos-sms').href = `sms:?&body=${encodeURIComponent(msg)}`;
  $('#sos-wa').href = `https://wa.me/?text=${encodeURIComponent(msg)}`;
  $('#dlg-sos').dataset.msg = msg;
}

$('#btn-sos').addEventListener('click', () => {
  locator.start();
  $('#sos-body').innerHTML = '<p class="hint">Obteniendo tu posición…</p>';
  $('#dlg-sos').dataset.msg = '';
  $('#dlg-sos').showModal();
  renderSos();
});
$('#sos-share').addEventListener('click', async () => {
  const text = $('#dlg-sos').dataset.msg;
  if (!text) { toast('Aún no hay posición'); return; }
  if (navigator.share) {
    try { await navigator.share({ text }); } catch { /* cancelled */ }
  } else {
    toast('Tu navegador no permite compartir; usa Copiar');
  }
});
$('#sos-copy').addEventListener('click', async () => {
  const text = $('#dlg-sos').dataset.msg;
  if (!text) { toast('Aún no hay posición'); return; }
  try { await navigator.clipboard.writeText(text); toast('Ubicación copiada'); } catch { toast('No se pudo copiar'); }
});

// ---------- Weather, 3D, peaks ----------
const here = () => {
  const fix = freshFix();
  return fix ? { lat: fix.coords.latitude, lon: fix.coords.longitude, alt: fix.coords.altitude, fromMap: false } : { lat: map.getCenter().lat, lon: map.getCenter().lng, alt: null, fromMap: true };
};

$('#btn-weather').addEventListener('click', () => {
  const h = here();
  showWeather(h.lat, h.lon);
});

let viewedWalk = null;
$('#btn-3d').addEventListener('click', () => {
  const tracks = [];
  if (viewedWalk && !$('#sheet').hidden) tracks.push(...segments(viewedWalk.points).map((s) => s.map((p) => [p[P.LAT], p[P.LON]])));
  if (tracker.points.length) tracks.push(...segments(tracker.points).map((s) => s.map((p) => [p[P.LAT], p[P.LON]])));
  if (follower.active) tracks.push(follower.route.pts);
  if (planner.active) tracks.push(planner.points().map(([a, b]) => [a, b]));
  const fix = freshFix();
  open3D({
    profile: activeProfile(),
    layerId: currentLayerId,
    center: map.getCenter(),
    zoom: map.getZoom(),
    tracks,
    position: fix ? { lat: fix.coords.latitude, lng: fix.coords.longitude } : null,
  });
});

// Waits briefly for a GPS fix so the panorama is computed from where the walker stands.
function waitForPlace(ms = 5000) {
  if (freshFix()) return Promise.resolve(here());
  locator.start();
  return new Promise((resolve) => {
    const done = () => { locator.removeEventListener('fix', done); clearTimeout(timer); resolve(here()); };
    const timer = setTimeout(done, ms);
    locator.addEventListener('fix', done);
  });
}

$('#btn-peaks').addEventListener('click', () => openPanorama(() => waitForPlace()));

// ---------- Tabs & sheet ----------
let activeTab = 'map';
let planning = false;
let simulating = false;

function showPane(name) {
  for (const p of ['walks', 'detail', 'zones', 'options', 'catalog']) $(`#sheet-${p}`).hidden = p !== name;
  $('#sheet').classList.toggle('compact', name === 'detail');
  $('#sheet').scrollTop = 0;
}

function showTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#sheet').hidden = tab === 'map';
  $('#recorder').hidden = tab !== 'map' || planning || simulating;
  $('#planner').hidden = tab !== 'map' || !planning;
  $('#simulator').hidden = tab !== 'map' || !simulating;
  if (tab !== 'zones') zoneLayer.clearLayers();
  catalogLayer.clearLayers();
  if (tab === 'walks') { viewLayer.clearLayers(); viewPhotos.clear(); viewedWalk = null; showPane('walks'); renderWalks(); }
  if (tab === 'zones') { showPane('zones'); renderZones(); }
  if (tab === 'options') { showPane('options'); renderOptions(); }
  updateLegend();
}
document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- Walks ----------
const chevron = '<svg viewBox="0 0 24 24" style="opacity:.5"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const isPlan = (w) => w.kind === 'plan';
const isTimed = (w) => !isPlan(w) && w.points.some((p) => p[P.T] > 0);

async function renderWalks() {
  const walks = (await db.all('walks')).sort((a, b) => b.start - a.start);
  $('#walk-list').innerHTML = walks.length
    ? walks.map((w) => {
      const time = isTimed(w) ? fmt.duration(w.activeMs ? w.activeMs / 1000 : w.stats.duration) : `~${fmt.hm(mideSeconds(w.stats.distance, w.stats.gain, w.stats.loss))}`;
      return `
      <li class="clickable" data-id="${esc(w.id)}">
        <div class="main">
          <div class="title">${esc(w.name)}${isPlan(w) ? '<span class="tag">Planificada</span>' : ''}</div>
          <div class="meta">${fmt.date(w.start)} · ${fmt.distance(w.stats.distance)}${Object.entries(w.stats.byMode ?? {}).map(([m, v]) => ` + ${fmt.distance(v.distance)} ${MODES[m]?.in ?? ''}`).join('')} · ${time} · +${Math.round(w.stats.gain)} m</div>
        </div>${chevron}
      </li>`;
    }).join('')
    : '<li class="empty">Aún no hay paseos. Pulsa «Iniciar paseo» en el mapa, planifica una ruta o importa un GPX.</li>';
}

$('#walk-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openWalk(li.dataset.id);
});

function profileSVG(points, modes) {
  const prof = elevationProfile(points, modes);
  if (prof.length < 2) return '';
  const total = prof[prof.length - 1][0] || 1;
  let min = Infinity;
  let max = -Infinity;
  for (const [, a] of prof) { min = Math.min(min, a); max = Math.max(max, a); }
  const pad = Math.max(10, (max - min) * 0.1);
  const lo = min - pad;
  const hi = max + pad;
  const W = 300;
  const H = 100;
  const step = Math.max(1, Math.floor(prof.length / 600));
  const xy = prof.filter((_, i) => i % step === 0 || i === prof.length - 1)
    .map(([d, a]) => `${((d / total) * W).toFixed(1)},${(H - ((a - lo) / (hi - lo)) * H).toFixed(1)}`);
  return `
    <div class="profile">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Perfil de elevación">
        <path class="area" d="M0,${H}L${xy.join('L')}L${W},${H}Z"/>
        <path class="line" d="M${xy.join('L')}"/>
      </svg>
      <div class="labels"><span>Mín ${Math.round(min)} m</span><span>Máx ${Math.round(max)} m</span><span>${fmt.distance(total)}</span></div>
    </div>`;
}

function showWalkOnMap(w, fit = true) {
  viewLayer.clearLayers();
  const rings = segments(w.points).map((s) => s.map((p) => [p[P.LAT], p[P.LON]]));
  const prof = activeProfile();
  L.polyline(rings, { color: '#ffffff', weight: prof.width + 3, opacity: 0.9, interactive: false }).addTo(viewLayer);
  for (const c of gradeChunks(w.points, 50, w.modes)) {
    L.polyline(c.latlngs, { color: prof.byGrade ? gradeColor(c.grade) : prof.track, weight: prof.width, opacity: 0.95 })
      .bindTooltip(`Pendiente ${c.grade >= 0 ? '+' : ''}${Math.round(c.grade)} %`, { sticky: true })
      .addTo(viewLayer);
  }
  for (const r of w.modes ?? []) drawModeRange(viewLayer, w.points, r, () => editRange(w, r));
  for (const g of w.gaps ?? []) drawGap(viewLayer, w.points, g);
  const first = w.points[0];
  const last = w.points[w.points.length - 1];
  L.marker([first[P.LAT], first[P.LON]], { icon: dotIcon('#2e9e4f'), title: 'Inicio' }).addTo(viewLayer);
  L.marker([last[P.LAT], last[P.LON]], { icon: dotIcon('#c0392b'), title: 'Final' }).addTo(viewLayer);
  (w.waypoints || []).forEach((wp) => waypointMarker(wp).addTo(viewLayer));
  if (fit) {
    setFollow(false);
    map.fitBounds(viewLayer.getBounds(), { ...sheetPadding(), maxZoom: 16 });
  }
}

const gradeLegend = () => `<div class="grade-legend">${GRADE_CLASSES.map((c) => `<span><i style="background:${c.color}"></i>${c.label}</span>`).join('')}</div>`;

async function openWalk(id, { keepView = false } = {}) {
  const w = await db.get('walks', id);
  if (!w) return;
  if (activeTab !== 'walks') {
    activeTab = 'walks';
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'walks'));
    $('#sheet').hidden = false;
    $('#recorder').hidden = true;
    $('#planner').hidden = true;
    $('#simulator').hidden = true;
    updateLegend();
  }
  if (w.modes === undefined && isTimed(w)) {
    w.modes = detectModes(w.points);
    w.stats = computeStats(w.points, w.modes);
    await db.put('walks', w);
    if (w.modes.length) toast(`Detectados ${w.modes.length} tramo(s) en vehículo o bici. Puedes corregirlos en «Tramos».`, 6000);
  }
  viewedWalk = w;
  renderDetail(w);
  showPane('detail');
  showWalkOnMap(w, !keepView);
  if (!w.gapsChecked && isTimed(w)) {
    fillGaps(w).then(async (n) => {
      w.stats = computeStats(w.points, w.modes);
      await db.put('walks', w);
      if (n && $('#sheet-detail').dataset.id === id) {
        toast(gapsSummary(w.gaps), 6000);
        openWalk(id, { keepView: true });
      }
    }).catch(() => {});
  }
  const [photos, notes] = await Promise.all([photosOf(id), voicesOf(id)]);
  viewPhotos.show(photos);
  renderGallery(photos);
  viewVoices.show(notes);
  renderVoices(notes);
  // Walks saved offline or imported get DEM altitudes as soon as tiles are reachable.
  if (await enrichWithDem(w).catch(() => false)) {
    await db.put('walks', w);
    if ($('#sheet-detail').dataset.id === id) {
      renderDetail(w);
      renderGallery(photos);
      renderVoices(notes);
      showWalkOnMap(w, false);
    }
  }
}

function renderDetail(w) {
  const s = w.stats;
  const timed = isTimed(w);
  const total = w.activeMs ? w.activeMs / 1000 : s.duration;
  const mide = mideSeconds(s.distance, s.gain, s.loss);
  const hasModes = Object.keys(s.byMode ?? {}).length > 0;
  const cells = timed
    ? [
      [fmt.distance(s.distance), hasModes ? 'A pie' : 'Distancia'], [fmt.duration(s.moving), hasModes ? 'Andando' : 'En movimiento'], [fmt.duration(total), 'Tiempo total'],
      [`+${Math.round(s.gain)} m`, 'Subida'], [`−${Math.round(s.loss)} m`, 'Bajada'], [fmt.pace(s.distance, s.moving), 'Ritmo medio'],
    ]
    : [
      [fmt.distance(s.distance), 'Distancia'], [`~${fmt.hm(mide)}`, 'Tiempo MIDE'], [`+${Math.round(s.gain)} m`, 'Subida'],
      [`−${Math.round(s.loss)} m`, 'Bajada'], [fmt.alt(s.maxAlt), 'Altitud máx.'], [`${Math.round(s.maxGrade ?? 0)} %`, 'Pendiente máx.'],
    ];
  if (timed) cells.push([fmt.alt(s.maxAlt), 'Altitud máx.'], [fmt.alt(s.minAlt), 'Altitud mín.'], [`${Math.round(s.maxGrade ?? 0)} %`, 'Pendiente máx.']);
  let sunNote = '';
  if (!timed && window.SunCalc) {
    const first = w.points[0];
    const sun = sunTimes(first[P.LAT], first[P.LON]);
    const arrival = Date.now() + mide * 1000;
    sunNote = sun.sunset > Date.now()
      ? `<p class="hint">Si sales ahora llegarías hacia las ${fmt.time(arrival)}${arrival > sun.sunset ? ' — <strong>después del ocaso</strong>' : ''} (ocaso ${fmt.time(sun.sunset)}).</p>`
      : '';
  }
  $('#sheet-detail').innerHTML = `
    <header class="pane-head">
      <button class="back" data-act="back">‹ Paseos</button>
    </header>
    <h2 style="margin:0 0 2px;font-size:20px">${esc(w.name)}${isPlan(w) ? '<span class="tag">Planificada</span>' : ''}</h2>
    <p class="hint">${fmt.datetime(w.start)}${w.imported ? ' · importado' : ''} · Altitud: ${s.source === 'dem' ? 'modelo del terreno' : 'GPS'}</p>
    ${w.gaps?.length ? `<p class="modes-line gaps-line">${esc(gapsSummary(w.gaps))}. Los tramos sin GPS salen en naranja discontinuo.${w.gaps.some((g) => g.method === 'straight') ? ' <button class="btn small" data-act="refill">Reintentar relleno</button>' : ''}</p>` : ''}
    ${hasModes ? `<p class="modes-line">${esc(modesSummary(s))}. Ritmo, desnivel y tiempo andando cuentan solo lo hecho a pie.</p>` : ''}
    <div class="detail-stats">${cells.map(([v, l]) => `<div><span>${v}</span><small>${l}</small></div>`).join('')}</div>
    ${sunNote}
    ${gradeLegend()}
    ${profileSVG(w.points, w.modes)}
    <div id="gallery" class="gallery" hidden></div>
    <p id="gallery-hint" class="hint" hidden></p>
    <ul id="voice-list" class="voice-list" hidden></ul>
    ${w.notes ? `<p class="notes">${esc(w.notes)}</p>` : ''}
    ${w.waypoints?.length ? `<p class="hint">${w.waypoints.length} punto(s) marcado(s): tócalos en el mapa.</p>` : ''}
    <div class="actions">
      <button class="btn small primary" data-act="follow">Seguir ruta</button>
      <button class="btn small" data-act="fit">Ver en mapa</button>
      <button class="btn small primary" data-act="share">Compartir imagen</button>
      <button class="btn small" data-act="simulate">Simular</button>
      ${timed ? '<button class="btn small" data-act="modes">Tramos</button>' : ''}
      <label class="btn small">Añadir fotos<input id="addphotos-input" type="file" accept="image/*" multiple hidden></label>
      <button class="btn small" data-act="voice">Nota de voz</button>
      <button class="btn small" data-act="3d">Ver en 3D</button>
      <button class="btn small" data-act="gpx">Exportar GPX</button>
      <button class="btn small" data-act="edit">Editar</button>
      <button class="btn small danger" data-act="delete">Borrar</button>
    </div>`;
  $('#sheet-detail').dataset.id = w.id;
}

function renderGallery(photos) {
  const el = $('#gallery');
  if (!el) return;
  el.hidden = !photos.length;
  el.innerHTML = '';
  const unplaced = photos.filter((p) => p.lat == null).length;
  const hint = $('#gallery-hint');
  if (hint) {
    hint.hidden = !unplaced;
    hint.textContent = `${unplaced} foto(s) sin ubicar (marco discontinuo): ábrelas y pulsa «Colocar en el mapa».`;
  }
  photos.forEach((p) => {
    const img = document.createElement('img');
    img.src = viewPhotos.url(p.thumb);
    img.alt = 'Foto del paseo';
    if (p.lat == null) img.style.outline = '3px dashed #e8a21a';
    img.addEventListener('click', () => openPhoto(p));
    el.appendChild(img);
  });
}

function renderVoices(notes) {
  const el = $('#voice-list');
  if (!el) return;
  el.hidden = !notes.length;
  el.innerHTML = '';
  notes.forEach((n) => {
    const li = document.createElement('li');
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = viewVoices.url(n.blob);
    const meta = document.createElement('small');
    meta.textContent = `${fmt.time(n.t)} · ${fmt.duration(n.duration / 1000)}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.title = 'Borrar nota';
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      if (!confirm('¿Borrar esta nota de voz?')) return;
      await deleteVoice(n.id);
      openWalk(n.walkId, { keepView: true });
    });
    li.append(audio, meta, del);
    el.appendChild(li);
  });
}

$('#sheet-detail').addEventListener('change', async (e) => {
  if (e.target.id !== 'addphotos-input') return;
  const files = [...e.target.files];
  e.target.value = '';
  const w = viewedWalk;
  if (!files.length || !w) return;
  toast(`Procesando ${files.length} foto(s)…`);
  const r = await addPhotosToWalk(files, w);
  const parts = [];
  if (r.gps) parts.push(`${r.gps} por GPS`);
  if (r.time) parts.push(`${r.time} por la hora`);
  if (r.none) parts.push(`${r.none} sin ubicar`);
  if (r.failed) parts.push(`${r.failed} no se pudieron leer`);
  toast(`Fotos añadidas: ${parts.join(', ')}`, 6000);
  openWalk(w.id, { keepView: true });
});

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'paseo';

async function exportGPX(w) {
  const name = `${slug(w.name)}.gpx`;
  const file = new File([toGPX(w)], name, { type: 'application/gpx+xml' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: w.name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('#sheet-detail').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const id = $('#sheet-detail').dataset.id;
  if (act === 'back') { showTab('walks'); return; }
  const w = await db.get('walks', id);
  if (!w) return;
  if (act === 'fit') showWalkOnMap(w);
  if (act === 'gpx') exportGPX(w);
  if (act === 'follow') {
    startFollowing(w);
    showTab('map');
    viewLayer.clearLayers();
    viewPhotos.clear();
    map.fitBounds(L.latLngBounds(follower.route.pts), sheetPadding());
    toast('Siguiendo la ruta. Te avisaré si te sales.');
  }
  if (act === 'share') openShare(w);
  if (act === 'simulate') startSimulation(w);
  if (act === 'modes') startModeEdit(w);
  if (act === 'refill') {
    if (!navigator.onLine) { toast('Necesitas conexión para rellenar por sendero'); return; }
    toast('Rellenando huecos…');
    await fillGaps(w);
    w.stats = computeStats(w.points, w.modes);
    await db.put('walks', w);
    toast(gapsSummary(w.gaps) || 'Sin huecos');
    openWalk(w.id, { keepView: true });
  }
  if (act === 'voice') {
    const note = await recordVoice(w.id);
    if (note) openWalk(w.id, { keepView: true });
  }
  if (act === '3d') {
    open3D({ profile: activeProfile(), layerId: currentLayerId, center: map.getCenter(), zoom: map.getZoom(), tracks: segments(w.points).map((s) => s.map((p) => [p[P.LAT], p[P.LON]])) });
  }
  if (act === 'edit') {
    $('#dlg-save-title').textContent = isPlan(w) ? 'Editar ruta' : 'Editar paseo';
    $('#dlg-save-discard').hidden = true;
    const { action, data } = await ask($('#dlg-save'), { name: w.name, notes: w.notes ?? '' });
    if (action !== 'save') return;
    w.name = data.name.trim() || w.name;
    w.notes = data.notes.trim();
    await db.put('walks', w);
    openWalk(id, { keepView: true });
  }
  if (act === 'delete' && confirm(`¿Borrar «${w.name}»? No se puede deshacer.`)) {
    await db.delete('walks', id);
    await deletePhotosOf(id);
    await deleteVoicesOf(id);
    if (follower.route?.id === id) follower.stop();
    toast('Borrado');
    showTab('walks');
  }
});

$('#gpx-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { name, points, waypoints, timed } = parseGPX(await file.text());
    const modes = timed ? detectModes(points) : [];
    const walk = {
      id: crypto.randomUUID(),
      name,
      notes: '',
      start: timed ? points.find((p) => p[P.T] > 0)[P.T] : Date.now(),
      end: timed ? points[points.length - 1][P.T] : Date.now(),
      points,
      waypoints,
      modes,
      stats: computeStats(points, modes),
      imported: true,
      ...(timed ? {} : { kind: 'plan' }),
    };
    await enrichWithDem(walk).catch(() => false);
    await db.put('walks', walk);
    toast(`Importado: ${name}`);
    openWalk(walk.id);
  } catch (err) {
    toast(err.message || 'No se pudo importar el archivo');
  }
});

// ---------- Planner ----------
const planner = new Planner(map);

function renderPlanner() {
  const s = planner.stats();
  $('#pl-dist').textContent = fmt.distance(s.distance);
  $('#pl-gain').textContent = `${Math.round(s.gain)} m`;
  $('#pl-loss').textContent = `${Math.round(s.loss)} m`;
  $('#pl-time').textContent = s.distance ? fmt.hm(s.mide) : '—';
  $('#pl-snap').classList.toggle('on', planner.snap);
  const hint = $('#pl-hint');
  hint.classList.toggle('warn', planner.fellBack);
  if (s.count < 2) hint.textContent = 'Toca el mapa para añadir puntos. Arrástralos para corregir.';
  else if (planner.fellBack) hint.textContent = 'Sin conexión con el servicio de rutas: tramos en línea recta.';
  else if (window.SunCalc) {
    const c = map.getCenter();
    const sun = sunTimes(c.lat, c.lng);
    const arrival = Date.now() + s.mide * 1000;
    hint.textContent = `Saliendo ahora, llegada ~${fmt.time(arrival)}${sun.sunset > Date.now() ? ` (ocaso ${fmt.time(sun.sunset)})` : ''}`;
  }
}
planner.addEventListener('change', renderPlanner);

function stopPlanning() {
  planner.stop();
  planning = false;
  showTab('map');
}

$('#btn-plan').addEventListener('click', () => {
  if (tracker.state !== 'idle') { toast('Termina el paseo en curso antes de planificar'); return; }
  planning = true;
  viewLayer.clearLayers();
  viewPhotos.clear();
  viewedWalk = null;
  planner.start();
  showTab('map');
  setFollow(false);
});
$('#pl-undo').addEventListener('click', () => planner.undo());
$('#pl-snap').addEventListener('click', () => planner.setSnap(!planner.snap));
$('#pl-cancel').addEventListener('click', () => {
  if (planner.stats().count > 1 && !confirm('¿Descartar la ruta planificada?')) return;
  stopPlanning();
});
$('#pl-save').addEventListener('click', async () => {
  const points = planner.walkPoints();
  if (points.length < 2) { toast('Añade al menos dos puntos'); return; }
  $('#dlg-save-title').textContent = 'Guardar ruta';
  $('#dlg-save-discard').hidden = true;
  const { action, data } = await ask($('#dlg-save'), { name: `Ruta ${fmt.date(Date.now())}`, notes: '' });
  if (action !== 'save') return;
  const walk = {
    id: crypto.randomUUID(),
    kind: 'plan',
    name: data.name.trim() || 'Ruta',
    notes: data.notes.trim(),
    start: Date.now(),
    end: Date.now(),
    points,
    waypoints: [],
    stats: computeStats(points),
  };
  await db.put('walks', walk);
  stopPlanning();
  toast('Ruta guardada');
  openWalk(walk.id);
});

// ---------- Gaps without GPS ----------
const GAP_TEXT = {
  route: 'Relleno por el sendero más probable: no es la traza real.',
  vehicle: 'Ibas demasiado rápido para andar: se cuenta como vehículo.',
  straight: 'Unido en línea recta (no había conexión para buscar el sendero).',
};
function drawGap(layer, points, g) {
  const latlngs = points.slice(g.from, g.to + 1).map((p) => [p[P.LAT], p[P.LON]]);
  if (latlngs.length < 2) return;
  L.polyline(latlngs, { color: '#ff9800', weight: activeProfile().width, dashArray: '3 9', opacity: 1, interactive: false }).addTo(layer);
  const mid = latlngs[Math.floor(latlngs.length / 2)];
  L.marker(mid, { icon: L.divIcon({ className: 'mode-label', html: `<span style="border-color:#ff9800">Sin GPS · ${g.minutes} min</span>`, iconSize: null }), keyboard: false })
    .bindPopup(`<b>${g.minutes} min sin GPS</b><br>${GAP_TEXT[g.method] ?? ''}`)
    .addTo(layer);
}

// ---------- Transport modes ----------
const MODE_STYLE = {
  bike: { color: '#1e88e5', dashArray: '2 9', weight: 6 },
  car: { color: '#455a64', dashArray: '10 8', weight: 5 },
  bus: { color: '#6d4c41', dashArray: '10 8', weight: 5 },
  vehicle: { color: '#546e7a', dashArray: '10 8', weight: 5 },
};

function drawModeRange(layer, points, r, onClick) {
  const latlngs = points.slice(r.from, r.to + 1).map((p) => [p[P.LAT], p[P.LON]]);
  if (latlngs.length < 2) return;
  const st = MODE_STYLE[r.mode] ?? MODE_STYLE.vehicle;
  const line = L.polyline(latlngs, { ...st, opacity: 0.95, lineCap: 'butt' }).addTo(layer);
  const info = rangeInfo(points, r);
  const mid = latlngs[Math.floor(latlngs.length / 2)];
  const label = `${MODES[r.mode]?.label ?? r.mode} · ${fmt.distance(info.distance)}`;
  const marker = L.marker(mid, { icon: L.divIcon({ className: 'mode-label', html: `<span style="border-color:${st.color}">${esc(label)}</span>`, iconSize: null }), keyboard: false }).addTo(layer);
  if (onClick) {
    const h = (e) => { L.DomEvent.stop(e); onClick(); };
    line.on('click', h);
    marker.on('click', h);
  }
}

function chooseMode(title, info, current) {
  $('#mode-title').textContent = title;
  $('#mode-info').textContent = info;
  document.querySelectorAll('#dlg-mode [data-mode]').forEach((b) => b.classList.toggle('on', b.value === current));
  return ask($('#dlg-mode')).then(({ action }) => action || null);
}

async function saveModes(w, modes) {
  w.modes = modes;
  w.stats = computeStats(w.points, modes);
  await db.put('walks', w);
  openWalk(w.id, { keepView: true });
}

const rangeText = (points, r) => {
  const i = rangeInfo(points, r);
  return `${fmt.distance(i.distance)}${i.start ? ` · ${fmt.time(i.start)}–${fmt.time(i.end)}` : ''}${i.speedKmh != null ? ` · media ${Math.round(i.speedKmh)} km/h` : ''}`;
};

async function editRange(w, r) {
  const choice = await chooseMode(`Tramo ${(MODES[r.mode]?.in ?? '').replace(/^en /, 'en ')}`, rangeText(w.points, r), r.mode);
  if (!choice) return;
  if (choice === 'redetect') return saveModes(w, detectModes(w.points));
  saveModes(w, applyMode(w.modes, r.from, r.to, choice));
}

let modeEdit = null;
function nearestIndex(points, latlng, maxPx = 40) {
  const target = map.latLngToContainerPoint(latlng);
  let best = -1;
  let bestD = Infinity;
  points.forEach((p, i) => {
    const d = map.latLngToContainerPoint([p[P.LAT], p[P.LON]]).distanceTo(target);
    if (d < bestD) { bestD = d; best = i; }
  });
  return bestD <= maxPx ? best : -1;
}

function stopModeEdit() {
  if (!modeEdit) return;
  map.off('click', onModeEditClick);
  modeEdit.marker?.remove();
  map.getContainer().classList.remove('planning');
  $('#mode-bar').hidden = true;
  modeEdit = null;
}

async function onModeEditClick(e) {
  const { w } = modeEdit;
  const idx = nearestIndex(w.points, e.latlng);
  if (idx < 0) { toast('Toca más cerca del trazado'); return; }
  if (modeEdit.start == null) {
    modeEdit.start = idx;
    modeEdit.marker = L.circleMarker([w.points[idx][P.LAT], w.points[idx][P.LON]], { radius: 9, color: '#fff', weight: 3, fillColor: '#ff6f00', fillOpacity: 1 }).addTo(map);
    $('#mode-bar-text').textContent = 'Ahora toca el final del tramo';
    return;
  }
  const from = Math.min(modeEdit.start, idx);
  const to = Math.max(modeEdit.start, idx);
  stopModeEdit();
  if (to - from < 1) { toast('El tramo es demasiado corto'); return; }
  const choice = await chooseMode('Marcar tramo como…', rangeText(w.points, { from, to }), null);
  if (!choice) return;
  if (choice === 'redetect') return saveModes(w, detectModes(w.points));
  saveModes(w, applyMode(w.modes, from, to, choice));
}

function startModeEdit(w) {
  stopModeEdit();
  modeEdit = { w, start: null, marker: null };
  $('#mode-bar-text').textContent = 'Toca en el trazado el inicio del tramo';
  $('#mode-bar').hidden = false;
  map.getContainer().classList.add('planning');
  map.on('click', onModeEditClick);
  toast('Marca inicio y final en el mapa. Para cambiar un tramo ya marcado, tócalo.', 5000);
}
$('#mode-bar-cancel').addEventListener('click', stopModeEdit);
$('#mode-bar-redetect').addEventListener('click', async () => {
  const w = modeEdit?.w;
  stopModeEdit();
  if (w) { await saveModes(w, detectModes(w.points)); toast('Tramos detectados de nuevo'); }
});

// Live: re-run detection every 15 s while recording so the totals on foot stay clean.
const liveModesLayer = L.layerGroup().addTo(map);
let liveMode = 'walk';
let lastModeCheck = 0;
function updateLiveModes(force = false) {
  if (!force && Date.now() - lastModeCheck < 15000) return;
  lastModeCheck = Date.now();
  const pts = tracker.points;
  tracker.modes = detectModes(pts);
  liveModesLayer.clearLayers();
  tracker.modes.forEach((r) => drawModeRange(liveModesLayer, pts, r, null));
  const tail = tracker.modes.find((r) => r.to >= pts.length - 3);
  const now = tail?.mode ?? 'walk';
  const el = $('#mode-status');
  if (now !== 'walk') {
    const info = rangeInfo(pts, tail);
    el.textContent = `${MODES[now].label} detectado (${Math.round(info.speedKmh ?? 0)} km/h): ${fmt.distance(info.distance)} que no cuentan como a pie`;
  } else {
    const other = Object.entries(tracker.stats.byMode ?? {}).map(([m, v]) => `${fmt.distance(v.distance)} ${MODES[m]?.in ?? ''}`).join(' · ');
    el.textContent = other ? `Fuera del total a pie: ${other}` : '';
  }
  el.hidden = !el.textContent;
  if (now !== liveMode && tracker.state === 'recording') {
    toast(now === 'walk' ? 'De nuevo a pie' : `Parece que vas ${MODES[now].in}: esos km no cuentan como andados`, 5000);
  }
  liveMode = now;
  renderStats();
}

// ---------- Simulation ----------
let sim = null;
let simWalkId = null;
const simMarker = L.marker([0, 0], { icon: L.divIcon({ className: 'sim-marker', iconSize: [22, 22] }), interactive: false, keyboard: false, zIndexOffset: 900 });
const pad2 = (n) => String(n).padStart(2, '0');

function departureFromInput() {
  const [h, m] = ($('#sim-departure').value || '09:00').split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function renderSim() {
  if (!sim) return;
  const st = sim.state;
  const total = sim.tl.total;
  simMarker.setLatLng([st.lat, st.lon]);
  if (sim.playing) map.panInside([st.lat, st.lon], { padding: [40, 40] });
  const clock = sim.clock;
  const arrival = sim.departure + total * 1000;
  $('#sim-clock').textContent = fmt.time(clock);
  $('#sim-elapsed').textContent = `+${fmt.hm(sim.sec)} desde la salida · ${sim.tl.timed ? 'ritmo real del paseo' : 'tiempo MIDE'}`;
  let sunPart = '';
  if (window.SunCalc) {
    const sun = sunTimes(st.lat, st.lon, new Date(clock));
    const night = clock > sun.sunset || clock < sun.sunrise;
    sunPart = night
      ? ` · <span class="sim-night">De noche (ocaso ${fmt.time(sun.sunset)})</span>`
      : arrival > sun.sunset ? ` · <span class="sim-night">Llegada tras el ocaso (${fmt.time(sun.sunset)})</span>` : ` · ocaso ${fmt.time(sun.sunset)}`;
  }
  $('#sim-info').innerHTML = `${fmt.distance(st.dist)} de ${fmt.distance(sim.tl.dist[sim.tl.dist.length - 1])} · ${fmt.alt(st.ele)} · llegada ${fmt.time(arrival)}${sunPart}`;
  $('#sim-seek').value = total ? Math.round((sim.sec / total) * 1000) : 0;
  $('#sim-play').textContent = sim.playing ? 'Pausa' : sim.sec >= total ? 'Repetir' : 'Reproducir';
}

function startSimulation(w) {
  if (tracker.state !== 'idle') { toast('Termina el paseo en curso antes de simular'); return; }
  if (w.points.length < 2) return;
  sim?.destroy();
  const saved = store.get('simDeparture');
  if (saved) $('#sim-departure').value = saved;
  else {
    const d = new Date(Date.now() + 15 * 60000);
    $('#sim-departure').value = `${pad2(d.getHours())}:${pad2(Math.floor(d.getMinutes() / 15) * 15)}`;
  }
  sim = new Simulation(w, departureFromInput());
  sim.speed = +$('#sim-speed').value;
  sim.addEventListener('update', renderSim);
  simWalkId = w.id;
  simulating = true;
  showTab('map');
  showWalkOnMap(w);
  viewedWalk = w;
  simMarker.addTo(map);
  renderSim();
}

function stopSimulation() {
  sim?.destroy();
  sim = null;
  simulating = false;
  map.removeLayer(simMarker);
  if (simWalkId) openWalk(simWalkId, { keepView: true });
  simWalkId = null;
}

$('#sim-play').addEventListener('click', () => { if (sim) (sim.playing ? sim.pause() : sim.play()); });
$('#sim-seek').addEventListener('input', (e) => { if (sim) sim.seek((+e.target.value / 1000) * sim.tl.total); });
$('#sim-speed').addEventListener('change', (e) => { if (sim) sim.speed = +e.target.value; });
$('#sim-departure').addEventListener('change', (e) => {
  store.set('simDeparture', e.target.value);
  if (sim) { sim.departure = departureFromInput(); renderSim(); }
});
$('#sim-close').addEventListener('click', stopSimulation);

// ---------- Lock screen ----------
const lockScreen = new LockScreen();
let battery = null;
navigator.getBattery?.().then((b) => { battery = b; }).catch(() => {});

function renderLock() {
  const now = Date.now();
  $('#lock-clock').textContent = fmt.time(now);
  const s = tracker.stats;
  $('#lock-time').textContent = fmt.duration(tracker.elapsedMs / 1000);
  $('#lock-dist').textContent = fmt.distance(s.distance);
  $('#lock-gain').textContent = `${Math.round(s.gain)} m`;
  const last = tracker.points[tracker.points.length - 1];
  const c = locator.last?.coords;
  $('#lock-alt').textContent = fmt.alt(last?.[P.DEM] ?? c?.altitude ?? last?.[P.ALT]);
  const lat = c?.latitude ?? last?.[P.LAT];
  const lon = c?.longitude ?? last?.[P.LON];
  const sunEl = $('#lock-sun');
  if (lat != null && window.SunCalc) {
    const today = sunTimes(lat, lon, new Date(now));
    let text;
    let warn = false;
    if (now < today.sunrise) text = `Amanecer en ${fmt.hm((today.sunrise - now) / 1000)} (${fmt.time(today.sunrise)})`;
    else if (now < today.sunset) {
      text = `Atardecer en ${fmt.hm((today.sunset - now) / 1000)} (${fmt.time(today.sunset)})`;
      warn = today.sunset - now < 3600e3;
    } else {
      const next = sunTimes(lat, lon, new Date(now + 864e5));
      text = `Amanecer en ${fmt.hm((next.sunrise - now) / 1000)} (${fmt.time(next.sunrise)})`;
    }
    sunEl.textContent = text;
    sunEl.classList.toggle('warn', warn);
  } else sunEl.textContent = '';
  const fEl = $('#lock-follow');
  const info = follower.active ? follower.info : null;
  fEl.textContent = info ? (info.offRoute ? `Fuera de ruta (${Math.round(info.dist)} m)` : `Ruta: quedan ${fmt.distance(info.remaining)}`) : '';
  fEl.classList.toggle('warn', !!info?.offRoute);
  $('#lock-battery').textContent = battery ? `Batería ${Math.round(battery.level * 100)} %${battery.charging ? ' · cargando' : ''}` : '';
}

$('#btn-lock').addEventListener('click', () => {
  lockScreen.lock();
  keepAwake(true);
  renderLock();
});
setInterval(() => { if (lockScreen.locked) renderLock(); }, 1000);

// ---------- Options: display profiles ----------
const PREVIEW_TILE = tileUrl('mtn', 14, 8006, 6150);
let previewImg = null;
const loadPreview = () => (previewImg ??= new Promise((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = () => { previewImg = null; reject(new Error('preview')); };
  img.src = PREVIEW_TILE;
}));

// Previews are rendered into canvases: CSS filters on images inside the scrolling sheet
// broke compositing (parts of the sheet turned transparent) on some GPUs.
async function drawPreview(canvas, p) {
  const img = await loadPreview().catch(() => null);
  if (!img) return;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 64, 256, 128, 0, 0, canvas.width, canvas.height);
  const data = g.getImageData(0, 0, canvas.width, canvas.height);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i]; let gr = d[i + 1]; let b = d[i + 2];
    let lum = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
    r = lum + (r - lum) * p.sat; gr = lum + (gr - lum) * p.sat; b = lum + (b - lum) * p.sat;
    r *= p.bright; gr *= p.bright; b *= p.bright;
    r = (r - 128) * p.contrast + 128; gr = (gr - 128) * p.contrast + 128; b = (b - 128) * p.contrast + 128;
    lum = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
    d[i] = r + (lum - r) * p.gray; d[i + 1] = gr + (lum - gr) * p.gray; d[i + 2] = b + (lum - b) * p.gray;
  }
  g.putImageData(data, 0, 0);
}

function profileChanged() {
  applyProfile();
  if (viewedWalk && !$('#sheet').hidden && !$('#sheet-detail').hidden) showWalkOnMap(viewedWalk, false);
}

function renderProfileList() {
  const id = activeId();
  $('#profile-list').innerHTML = Object.entries(allProfiles()).map(([pid, p]) => `
    <div class="profile-card${pid === id ? ' on' : ''}" data-id="${esc(pid)}" role="button" tabindex="0">
      <div class="profile-preview">
        <canvas width="200" height="100" data-preview="${esc(pid)}"></canvas>
        <svg viewBox="0 0 100 60" preserveAspectRatio="none"><path d="M5 50 C 30 10, 55 55, 95 12" fill="none" stroke="#fff" stroke-width="${p.width + 3}" stroke-linecap="round"/><path d="M5 50 C 30 10, 55 55, 95 12" fill="none" stroke="${p.byGrade ? '#f08a00' : p.track}" stroke-width="${p.width}" stroke-linecap="round"/></svg>
      </div>
      <span>${esc(p.name)}</span>
      ${p.preset ? '' : `<button class="del" data-del="${esc(pid)}" title="Borrar perfil" aria-label="Borrar perfil">✕</button>`}
    </div>`).join('');
  const profiles = allProfiles();
  document.querySelectorAll('#profile-list canvas[data-preview]').forEach((c) => drawPreview(c, profiles[c.dataset.preview]));
}

function renderOptions() {
  renderProfileList();
  const p = activeProfile();
  const f = $('#profile-form').elements;
  f.sat.value = Math.round(p.sat * 100);
  f.bright.value = Math.round(p.bright * 100);
  f.contrast.value = Math.round(p.contrast * 100);
  f.gray.value = Math.round(p.gray * 100);
  f.width.value = p.width;
  f.byGrade.checked = p.byGrade;
  $('#track-colors').innerHTML = TRACK_COLORS.map(([c, n]) => `<button type="button" data-color="${c}" title="${n}" aria-label="Recorrido ${n.toLowerCase()}" class="${c === p.track ? 'on' : ''}" style="background:${c}"></button>`).join('');
  $('#profile-active-name').textContent = p.name;
}

$('#profile-list').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]')?.dataset.del;
  if (del) {
    if (confirm('¿Borrar este perfil?')) { removeProfile(del); profileChanged(); renderOptions(); }
    return;
  }
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (id) { setActive(id); profileChanged(); renderOptions(); }
});
$('#profile-form').addEventListener('input', (e) => {
  const f = $('#profile-form').elements;
  const change = {
    sat: f.sat.value / 100, bright: f.bright.value / 100, contrast: f.contrast.value / 100, gray: f.gray.value / 100,
    width: +f.width.value, byGrade: f.byGrade.checked,
  };
  editActive(change);
  profileChanged();
  renderProfileList();
  $('#profile-active-name').textContent = activeProfile().name;
  if (e.target.name === 'byGrade') renderOptions();
});
$('#track-colors').addEventListener('click', (e) => {
  const c = e.target.closest('[data-color]')?.dataset.color;
  if (!c) return;
  editActive({ track: c, byGrade: false });
  profileChanged();
  renderOptions();
});
$('#profile-save-as').addEventListener('click', () => {
  const name = prompt('Nombre del perfil', `Mi perfil ${Object.keys(allProfiles()).length - 3}`);
  if (!name?.trim()) return;
  saveAs(name.trim().slice(0, 40));
  renderOptions();
  toast('Perfil guardado');
});

// ---------- Official routes catalogue ----------
const catalogLayer = L.layerGroup().addTo(map);
let catalogFilter = store.get('catalogFilter') ?? 'all';
let catalogItems = [];
let catalogCurrent = null;

function openCatalog() {
  showTab('walks');
  viewedWalk = null;
  showPane('catalog');
  $('#catalog-preview').hidden = true;
  renderCatalog();
}

async function renderCatalog() {
  const h = here();
  const radius = +$('#catalog-radius').value;
  $('#catalog-where').textContent = h.fromMap ? 'Alrededor del centro del mapa (mueve el mapa para buscar en otra zona).' : 'Alrededor de tu posición.';
  document.querySelectorAll('#catalog-filters [data-filter]').forEach((b) => b.classList.toggle('on', b.dataset.filter === catalogFilter));
  const list = $('#catalog-list');
  list.innerHTML = '<li class="empty">Buscando rutas…</li>';
  try {
    catalogItems = await routesNear(h.lat, h.lon, radius, catalogFilter);
  } catch {
    list.innerHTML = '<li class="empty">No se pudo cargar el índice de rutas.</li>';
    return;
  }
  catalogLayer.clearLayers();
  catalogItems.forEach((r, k) => {
    L.circleMarker(r.pts[1], { radius: 7, color: '#fff', weight: 2, fillColor: ROUTE_TYPES[r.type].color, fillOpacity: 1 })
      .bindTooltip(r.name)
      .on('click', () => previewRoute(k))
      .addTo(catalogLayer);
  });
  list.innerHTML = catalogItems.length
    ? catalogItems.map((r, k) => `
      <li class="clickable" data-k="${k}">
        <span class="route-badge" style="background:${ROUTE_TYPES[r.type].color}">${esc(ROUTE_TYPES[r.type].label)}</span>
        <div class="main">
          <div class="title">${esc(r.name)}</div>
          <div class="meta">${r.km != null ? `${r.km} km · ` : ''}a ${fmt.distance(r.dist)}${r.extra ? ` · ${esc(r.extra.replace(/\|/g, ' · '))}` : ''}${looksKidFriendly(r) ? ' · apta para niños' : ''}</div>
        </div>${chevron}
      </li>`).join('')
    : `<li class="empty">No hay rutas oficiales de este tipo a menos de ${radius} km. Amplía el radio o mueve el mapa.</li>`;
}

async function previewRoute(k) {
  const r = catalogItems[k];
  if (!r) return;
  const box = $('#catalog-preview');
  box.hidden = false;
  box.innerHTML = `<p class="hint">Descargando «${esc(r.name)}»…</p>`;
  $('#sheet').scrollTop = 0;
  let data;
  try {
    data = await fetchRoute(r);
  } catch {
    box.innerHTML = '<p class="hint">No se pudo descargar el trazado (¿sin conexión?).</p>';
    return;
  }
  catalogCurrent = { r, data };
  viewLayer.clearLayers();
  const latlngs = data.points.map((p) => [p[P.LAT], p[P.LON]]);
  L.polyline(latlngs, { color: '#fff', weight: 8, opacity: 0.9, interactive: false }).addTo(viewLayer);
  L.polyline(latlngs, { color: ROUTE_TYPES[r.type].color, weight: 5 }).addTo(viewLayer);
  L.marker(latlngs[0], { icon: dotIcon('#2e9e4f'), title: 'Inicio' }).addTo(viewLayer);
  map.fitBounds(viewLayer.getBounds(), { ...sheetPadding(), maxZoom: 15 });
  const s = data.stats;
  box.innerHTML = `
    <div class="cat-head"><span class="route-badge" style="background:${ROUTE_TYPES[r.type].color}">${esc(ROUTE_TYPES[r.type].label)}</span><b>${esc(r.name)}</b></div>
    ${data.recorrido ? `<p class="hint">${esc(data.recorrido)}</p>` : ''}
    <div class="detail-stats">
      <div><span>${fmt.distance(s.distance)}</span><small>Distancia</small></div>
      <div><span>+${Math.round(s.gain)} m</span><small>Subida</small></div>
      <div><span>~${fmt.hm(data.mide)}</span><small>Tiempo MIDE</small></div>
    </div>
    <p class="kids-line ${data.kids ? 'ok' : 'hard'}">${data.kids
      ? (r.type === 'VV' ? 'Apta para niños: vía verde, llana y sin coches.' : `Apta para niños: corta y con poco desnivel (+${Math.round(s.gain)} m).`)
      : `Exigente para niños: ${fmt.distance(s.distance)} y +${Math.round(s.gain)} m de subida.`}</p>
    <div class="actions">
      <button class="btn small primary" data-cat="save">Guardar en mis rutas</button>
      <button class="btn small" data-cat="follow">Seguir ahora</button>
      ${data.infoUrl ? '<button class="btn small" data-cat="info">Ficha oficial</button>' : ''}
      <button class="btn small" data-cat="close">Cerrar</button>
    </div>`;
}

$('#btn-catalog').addEventListener('click', openCatalog);
$('#catalog-back').addEventListener('click', () => showTab('walks'));
$('#catalog-radius').addEventListener('change', renderCatalog);
$('#catalog-filters').addEventListener('click', (e) => {
  const f = e.target.closest('[data-filter]')?.dataset.filter;
  if (!f) return;
  catalogFilter = f;
  store.set('catalogFilter', f);
  $('#catalog-preview').hidden = true;
  viewLayer.clearLayers();
  renderCatalog();
});
$('#catalog-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-k]');
  if (li) previewRoute(+li.dataset.k);
});
$('#catalog-preview').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-cat]')?.dataset.cat;
  if (!act || !catalogCurrent) return;
  const { r, data } = catalogCurrent;
  if (act === 'close') { $('#catalog-preview').hidden = true; viewLayer.clearLayers(); return; }
  if (act === 'info') { window.open(data.infoUrl, '_blank', 'noopener'); return; }
  const walk = toWalk(r, data);
  await db.put('walks', walk);
  if (act === 'save') { toast('Ruta guardada en tus paseos'); openWalk(walk.id); }
  if (act === 'follow') {
    startFollowing(walk);
    showTab('map');
    map.fitBounds(L.latLngBounds(follower.route.pts), sheetPadding());
    toast('Siguiendo la ruta. Te avisaré si te sales.');
  }
});

// ---------- Offline zones ----------
const OFFLINE_LAYERS = Object.entries(LAYERS).filter(([, d]) => d.offline);

async function renderZones() {
  const zones = (await db.all('zones')).sort((a, b) => b.created - a.created);
  zoneLayer.clearLayers();
  zones.forEach((z) => L.rectangle([[z.bounds.south, z.bounds.west], [z.bounds.north, z.bounds.east]], { color: '#2f5d3a', weight: 2, fillOpacity: 0.06, dashArray: '6 4', interactive: false }).addTo(zoneLayer));
  $('#zone-list').innerHTML = zones.length
    ? zones.map((z) => `
      <li data-id="${esc(z.id)}">
        <div class="main">
          <div class="title">${esc(z.name)}</div>
          <div class="meta">${esc(LAYERS[z.layerId]?.name ?? z.layerId)} · zoom ${z.minZ}–${z.maxZ}${z.relief ? ' · con relieve' : ''} · ${fmt.bytes(z.bytes)}${z.failed ? ` · ${z.failed} teselas fallidas` : ''}</div>
        </div>
        <button class="btn small" data-act="show">Ver</button>
        <button class="btn small danger" data-act="delete" aria-label="Borrar zona">Borrar</button>
      </li>`).join('')
    : '<li class="empty">No hay zonas descargadas.</li>';

  const info = await navigator.storage?.estimate?.();
  const peaksReady = !!(await caches.match('data/peaks-es.json').catch(() => null));
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  $('#storage-info').textContent = [
    info ? `Espacio usado por la app: ${fmt.bytes(info.usage)} de ${fmt.bytes(info.quota)} disponibles.` : '',
    peaksReady ? 'Picos de España (66 504 cumbres del IGN): descargados.' : 'Picos de España: se descargarán al conectarte.',
    persisted ? '' : 'El navegador podría borrar estos datos si falta espacio.',
  ].filter(Boolean).join(' ');
}

$('#zone-list').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const id = e.target.closest('li[data-id]')?.dataset.id;
  if (!act || !id) return;
  const zone = await db.get('zones', id);
  if (!zone) return;
  if (act === 'show') {
    setBaseLayer(zone.layerId);
    const b = zone.bounds;
    showTab('map');
    map.fitBounds([[b.south, b.west], [b.north, b.east]], sheetPadding());
  }
  if (act === 'delete' && confirm(`¿Borrar la zona «${zone.name}»?`)) {
    await deleteZone(id);
    toast('Zona borrada');
    renderZones();
  }
});

const zoneDlg = $('#dlg-zone');
const zoneForm = zoneDlg.querySelector('form');
let zoneBounds = null;
let zoneAbort = null;
zoneForm.elements.layer.innerHTML = OFFLINE_LAYERS.map(([id, d]) => `<option value="${id}">${esc(d.name)}</option>`).join('');

function updateZoneEstimate() {
  const f = zoneForm.elements;
  const layer = LAYERS[f.layer.value];
  f.maxZ.max = Math.min(17, layer.maxNativeZoom);
  f.zoomOut.value = f.maxZ.value;
  const est = estimate(zoneBounds, f.layer.value, +f.maxZ.value, f.relief.checked);
  const el = $('#zone-estimate');
  let ok = true;
  if (est.outside) { el.textContent = 'La zona visible está fuera de la cobertura del IGN (España).'; ok = false; }
  else if (est.tiles > MAX_TILES) { el.textContent = `Demasiado grande (${est.tiles.toLocaleString('es-ES')} teselas, máx. ${MAX_TILES.toLocaleString('es-ES')}). Acerca el mapa o baja el detalle.`; ok = false; }
  else el.textContent = `${est.tiles.toLocaleString('es-ES')} teselas · ~${fmt.bytes(est.bytes)} (estimado). Zoom ${MIN_ZOOM}–${f.maxZ.value}.`;
  el.classList.toggle('warn', !ok);
  $('#zone-go').disabled = !ok;
}
zoneForm.addEventListener('input', (e) => { if (e.target.name !== 'name') updateZoneEstimate(); });

$('#btn-new-zone').addEventListener('click', async () => {
  if (!navigator.onLine) { toast('Necesitas conexión para descargar mapas'); return; }
  const b = map.getBounds();
  zoneBounds = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  const count = (await db.all('zones')).length + 1;
  zoneForm.reset();
  zoneForm.elements.name.value = `Zona ${count}`;
  zoneForm.elements.layer.value = LAYERS[currentLayerId].offline ? currentLayerId : 'mtn';
  zoneForm.elements.maxZ.value = Math.min(16, Math.max(13, map.getZoom() + 2));
  $('#zone-progress').hidden = true;
  zoneForm.querySelectorAll('input, select').forEach((el) => { el.disabled = false; });
  updateZoneEstimate();
  zoneDlg.returnValue = '';
  zoneDlg.showModal();
});

zoneForm.addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = zoneForm.elements;
  const name = f.name.value.trim() || 'Zona';
  const layerId = f.layer.value;
  const maxZ = +f.maxZ.value;
  const withRelief = f.relief.checked;
  zoneForm.querySelectorAll('input, select').forEach((el) => { el.disabled = true; });
  $('#zone-go').disabled = true;
  $('#zone-progress').hidden = false;
  const bar = $('#zone-progress progress');
  const text = $('#zone-progress-text');
  bar.value = 0;
  text.textContent = 'Iniciando…';
  navigator.storage?.persist?.();
  zoneAbort = new AbortController();
  try {
    const zone = await downloadZone({ name, layerId, bounds: zoneBounds, maxZ, withRelief }, {
      signal: zoneAbort.signal,
      onProgress: (done, total, bytes) => {
        bar.value = done / total;
        text.textContent = done === total && withRelief
          ? 'Descargando picos de la zona…'
          : `${done.toLocaleString('es-ES')} / ${total.toLocaleString('es-ES')} teselas · ${fmt.bytes(bytes)}`;
      },
    });
    zoneAbort = null;
    if (zone) {
      zoneDlg.close('done');
      toast(zone.failed ? `Descargada con ${zone.failed} teselas fallidas` : `«${zone.name}» lista para usar sin conexión`);
      renderZones();
    }
  } catch (err) {
    zoneAbort = null;
    zoneDlg.close('error');
    toast(err.message || 'Error en la descarga');
  }
});

zoneDlg.addEventListener('close', () => {
  if (zoneAbort) { zoneAbort.abort(); zoneAbort = null; toast('Descarga cancelada'); }
});

// ---------- Connectivity & startup ----------
function updateOnline() { $('#offline-badge').hidden = navigator.onLine; }
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);
updateOnline();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}

init3D();
initPanorama();
initShare();
// Ask once per load: browsers grant persistence silently to installed or frequently used apps,
// which protects the precached peaks and downloaded zones from eviction.
navigator.storage?.persist?.().catch(() => {});
updateLegend();
renderRecorder();
tracker.restore().then(async (restored) => {
  if (restored) {
    updateLiveModes(true);
    toast('Tienes un paseo sin terminar. Pulsa Seguir o Fin.', 6000);
    livePhotos.show(await photosOf(tracker.id));
    liveVoices.show(await voicesOf(tracker.id));
  }
});
const savedFollow = store.get('follow');
if (savedFollow) {
  db.get('walks', savedFollow.id).then((w) => { if (w) startFollowing(w, savedFollow.reversed); });
}
