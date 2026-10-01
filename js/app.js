import { db } from './db.js';
import { $, esc, store, toast, ask, alertUser } from './ui.js';
import { LAYERS, OVERLAYS } from './layers.js';
import { Locator, Tracker } from './tracker.js';
import { elevationProfile, segments, computeStats, toGPX, parseGPX, fmt, P, gradeChunks, gradeColor, GRADE_CLASSES, mideSeconds } from './geo.js';
import { estimate, downloadZone, deleteZone, MAX_TILES, MIN_ZOOM } from './offline.js';
import { elevationsAt, elevationAt } from './dem.js';
import { SlopeLayer, slopeLegendHTML } from './slope.js';
import { RouteFollower } from './routefollow.js';
import { daylightCheck, sunTimes } from './sun.js';
import { toUTM, toDMS, locationText } from './sos.js';
import { Planner } from './planner.js';
import { showWeather } from './weather.js';
import { savePhoto, photosOf, deletePhotosOf, deletePhoto, PhotoLayer } from './photos.js';
import { open3D, init3D } from './view3d.js';
import { openPanorama, initPanorama } from './panorama.js';

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
  if (sheet.hidden) return { paddingTopLeft: [30, 30], paddingBottomRight: [30, $('#recorder').offsetHeight + 40] };
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
  $('#photo-meta').textContent = `${fmt.datetime(photo.t)}${photo.lat != null ? ` · ${photo.lat.toFixed(5)}, ${photo.lon.toFixed(5)}` : ''}${photo.alt != null ? ` · ${Math.round(photo.alt)} m` : ''}`;
  $('#dlg-photo').showModal();
}
const livePhotos = new PhotoLayer(map, openPhoto);
const viewPhotos = new PhotoLayer(map, openPhoto);

$('#dlg-photo').addEventListener('close', () => {
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null;
});
$('#photo-delete').addEventListener('click', async () => {
  const p = openPhotoRef;
  if (!p || !confirm('¿Borrar esta foto?')) return;
  await deletePhoto(p.id);
  $('#dlg-photo').close();
  if (p.walkId === tracker.id) livePhotos.show(await photosOf(p.walkId));
  else if ($('#sheet-detail').dataset.id === p.walkId) openWalk(p.walkId, { keepView: true });
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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && tracker.state === 'recording') keepAwake(true);
  if (document.visibilityState === 'hidden') tracker.persist();
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
  $('#btn-waypoint').hidden = st === 'idle';
  $('#btn-photo').hidden = st === 'idle';
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

$('#btn-waypoint').addEventListener('click', async () => {
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
  w.stats = computeStats(w.points);
  return true;
}

$('#btn-finish').addEventListener('click', async () => {
  const wasRecording = tracker.state === 'recording';
  const walk = tracker.finish();
  keepAwake(false);
  if (walk.points.length < 2) {
    if (confirm('No se ha registrado ningún recorrido. ¿Descartar el paseo?')) {
      await deletePhotosOf(walk.id);
      livePhotos.clear();
      await tracker.reset();
    } else if (wasRecording) { tracker.resume(); keepAwake(true); }
    return;
  }
  $('#dlg-save-title').textContent = 'Guardar paseo';
  $('#dlg-save-discard').hidden = false;
  const { action, data } = await ask($('#dlg-save'), { name: `Paseo ${fmt.datetime(walk.start)}`, notes: '' });
  if (action === 'save') {
    walk.name = data.name.trim() || 'Paseo';
    walk.notes = data.notes.trim();
    await enrichWithDem(walk).catch(() => false);
    await db.put('walks', walk);
    await tracker.reset();
    livePhotos.clear();
    toast('Paseo guardado');
    openWalk(walk.id);
  } else if (action === 'discard') {
    if (confirm('¿Seguro? El paseo y sus fotos se borrarán.')) {
      await deletePhotosOf(walk.id);
      livePhotos.clear();
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

function showPane(name) {
  for (const p of ['walks', 'detail', 'zones']) $(`#sheet-${p}`).hidden = p !== name;
  $('#sheet').classList.toggle('compact', name === 'detail');
  $('#sheet').scrollTop = 0;
}

function showTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#sheet').hidden = tab === 'map';
  $('#recorder').hidden = tab !== 'map' || planning;
  $('#planner').hidden = tab !== 'map' || !planning;
  if (tab !== 'zones') zoneLayer.clearLayers();
  if (tab === 'walks') { viewLayer.clearLayers(); viewPhotos.clear(); viewedWalk = null; showPane('walks'); renderWalks(); }
  if (tab === 'zones') { showPane('zones'); renderZones(); }
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
          <div class="meta">${fmt.date(w.start)} · ${fmt.distance(w.stats.distance)} · ${time} · +${Math.round(w.stats.gain)} m</div>
        </div>${chevron}
      </li>`;
    }).join('')
    : '<li class="empty">Aún no hay paseos. Pulsa «Iniciar paseo» en el mapa, planifica una ruta o importa un GPX.</li>';
}

$('#walk-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openWalk(li.dataset.id);
});

function profileSVG(points) {
  const prof = elevationProfile(points);
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
  L.polyline(rings, { color: '#ffffff', weight: 8, opacity: 0.9, interactive: false }).addTo(viewLayer);
  for (const c of gradeChunks(w.points)) {
    L.polyline(c.latlngs, { color: gradeColor(c.grade), weight: 5, opacity: 0.95 })
      .bindTooltip(`Pendiente ${c.grade >= 0 ? '+' : ''}${Math.round(c.grade)} %`, { sticky: true })
      .addTo(viewLayer);
  }
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
    updateLegend();
  }
  viewedWalk = w;
  renderDetail(w);
  showPane('detail');
  showWalkOnMap(w, !keepView);
  const photos = await photosOf(id);
  viewPhotos.show(photos);
  renderGallery(photos);
  // Walks saved offline or imported get DEM altitudes as soon as tiles are reachable.
  if (await enrichWithDem(w).catch(() => false)) {
    await db.put('walks', w);
    if ($('#sheet-detail').dataset.id === id) {
      renderDetail(w);
      renderGallery(photos);
      showWalkOnMap(w, false);
    }
  }
}

function renderDetail(w) {
  const s = w.stats;
  const timed = isTimed(w);
  const total = w.activeMs ? w.activeMs / 1000 : s.duration;
  const mide = mideSeconds(s.distance, s.gain, s.loss);
  const cells = timed
    ? [
      [fmt.distance(s.distance), 'Distancia'], [fmt.duration(s.moving), 'En movimiento'], [fmt.duration(total), 'Tiempo total'],
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
    <div class="detail-stats">${cells.map(([v, l]) => `<div><span>${v}</span><small>${l}</small></div>`).join('')}</div>
    ${sunNote}
    ${gradeLegend()}
    ${profileSVG(w.points)}
    <div id="gallery" class="gallery" hidden></div>
    ${w.notes ? `<p class="notes">${esc(w.notes)}</p>` : ''}
    ${w.waypoints?.length ? `<p class="hint">${w.waypoints.length} punto(s) marcado(s): tócalos en el mapa.</p>` : ''}
    <div class="actions">
      <button class="btn small primary" data-act="follow">Seguir ruta</button>
      <button class="btn small" data-act="fit">Ver en mapa</button>
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
  photos.forEach((p) => {
    const img = document.createElement('img');
    img.src = viewPhotos.url(p.thumb);
    img.alt = 'Foto del paseo';
    img.addEventListener('click', () => openPhoto(p));
    el.appendChild(img);
  });
}

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
  if (act === '3d') {
    open3D({ layerId: currentLayerId, center: map.getCenter(), zoom: map.getZoom(), tracks: segments(w.points).map((s) => s.map((p) => [p[P.LAT], p[P.LON]])) });
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
    const walk = {
      id: crypto.randomUUID(),
      name,
      notes: '',
      start: timed ? points.find((p) => p[P.T] > 0)[P.T] : Date.now(),
      end: timed ? points[points.length - 1][P.T] : Date.now(),
      points,
      waypoints,
      stats: computeStats(points),
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
  $('#storage-info').textContent = info ? `Espacio usado por la app: ${fmt.bytes(info.usage)} de ${fmt.bytes(info.quota)} disponibles.` : '';
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
updateLegend();
renderRecorder();
tracker.restore().then(async (restored) => {
  if (restored) {
    toast('Tienes un paseo sin terminar. Pulsa Seguir o Fin.', 6000);
    livePhotos.show(await photosOf(tracker.id));
  }
});
const savedFollow = store.get('follow');
if (savedFollow) {
  db.get('walks', savedFollow.id).then((w) => { if (w) startFollowing(w, savedFollow.reversed); });
}
