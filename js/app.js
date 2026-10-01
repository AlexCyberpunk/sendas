import { db } from './db.js';
import { LAYERS } from './layers.js';
import { Locator, Tracker } from './tracker.js';
import { elevationProfile, segments, computeStats, toGPX, parseGPX, fmt, P } from './geo.js';
import { estimate, downloadZone, deleteZone, MAX_TILES, MIN_ZOOM } from './offline.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`sendas.${k}`)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`sendas.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const TRACK_COLOR = '#d6452f';
const SPAIN_BOUNDS = L.latLngBounds(LAYERS.mtn.bounds);
const isDesktop = () => window.matchMedia('(min-width: 760px)').matches;

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function ask(dialog, values = {}) {
  const form = dialog.querySelector('form');
  form.reset();
  for (const [k, v] of Object.entries(values)) form.elements[k].value = v;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve({ action: dialog.returnValue, data: Object.fromEntries(new FormData(form)) }), { once: true });
  });
}

// ---------- Map ----------
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
L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);

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
map.on('moveend', () => store.set('view', { center: map.getCenter(), zoom: map.getZoom() }));

const viewLayer = L.featureGroup().addTo(map);
const zoneLayer = L.featureGroup().addTo(map);
const liveLine = L.polyline([], { color: TRACK_COLOR, weight: 5, opacity: 0.9, interactive: false }).addTo(map);
const liveWaypoints = L.layerGroup().addTo(map);
const posMarker = L.marker([0, 0], { icon: L.divIcon({ className: 'pos-dot', iconSize: [18, 18] }), interactive: false, keyboard: false, zIndexOffset: 1000 });
const accCircle = L.circle([0, 0], { radius: 1, color: '#1a73e8', weight: 1, fillOpacity: 0.08, interactive: false });

const wpIcon = L.divIcon({ className: 'wp-icon', iconSize: [18, 18], iconAnchor: [9, 18] });
const dotIcon = (color) => L.divIcon({ className: 'end-icon', iconSize: [16, 16], html: `<div style="width:100%;height:100%;border-radius:50%;background:${color}"></div>` });

function waypointMarker(wp) {
  const m = L.marker([wp.lat, wp.lon], { icon: wpIcon });
  const time = new Date(wp.t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  m.bindPopup(`<strong>${esc(wp.note || 'Punto')}</strong><br>${time}${wp.alt != null ? ` · ${Math.round(wp.alt)} m` : ''}`);
  return m;
}

function sheetPadding() {
  const sheet = $('#sheet');
  if (sheet.hidden) return { paddingTopLeft: [30, 30], paddingBottomRight: [30, $('#recorder').offsetHeight + 40] };
  return isDesktop()
    ? { paddingTopLeft: [30, 30], paddingBottomRight: [sheet.offsetWidth + 40, 30] }
    : { paddingTopLeft: [30, 30], paddingBottomRight: [30, sheet.offsetHeight + 20] };
}

// ---------- Location ----------
const locator = new Locator();
const tracker = new Tracker(locator);
let follow = false;
let firstFix = true;

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

  if (tracker.state === 'recording') $('#st-alt').textContent = fmt.alt(c.altitude);
  if (c.accuracy > 35) updateGpsStatus(`Señal GPS débil (±${Math.round(c.accuracy)} m), esperando más precisión`, true);
  else updateGpsStatus(tracker.state !== 'idle' ? `GPS ±${Math.round(c.accuracy)} m` : '');
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
  if (last && $('#st-alt').textContent === '—') $('#st-alt').textContent = fmt.alt(last[P.ALT]);
}

function renderRecorder() {
  const st = tracker.state;
  $('#stats').hidden = st === 'idle';
  $('#btn-start').hidden = st !== 'idle';
  $('#btn-pause').hidden = st !== 'recording';
  $('#btn-resume').hidden = st !== 'paused';
  $('#btn-waypoint').hidden = st === 'idle';
  $('#btn-finish').hidden = st === 'idle';
  document.querySelector('[data-tab=map]').classList.toggle('rec', st === 'recording');
  if (st === 'idle') updateGpsStatus(locator.error ?? '', !!locator.error);
  if (st === 'paused') updateGpsStatus('En pausa');
  renderStats();
}

tracker.addEventListener('change', (e) => {
  const pt = e.detail.point;
  if (pt) {
    const rings = liveLine.getLatLngs();
    const multi = rings.length && Array.isArray(rings[0]);
    const lastSeg = tracker.points.length > 1 && tracker.points[tracker.points.length - 2][P.SEG] === pt[P.SEG];
    if (multi && lastSeg) liveLine.addLatLng([pt[P.LAT], pt[P.LON]], rings[rings.length - 1]);
    else drawLiveTrack();
  } else {
    drawLiveTrack();
  }
  renderRecorder();
});

setInterval(() => { if (tracker.state === 'recording') $('#st-time').textContent = fmt.duration(tracker.elapsedMs / 1000); }, 1000);

$('#btn-start').addEventListener('click', () => {
  viewLayer.clearLayers();
  navigator.storage?.persist?.();
  tracker.start();
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
  tracker.addWaypoint(data.note.trim());
  toast('Punto marcado');
});

$('#btn-finish').addEventListener('click', async () => {
  const wasRecording = tracker.state === 'recording';
  const walk = tracker.finish();
  keepAwake(false);
  if (walk.points.length < 2) {
    if (confirm('No se ha registrado ningún recorrido. ¿Descartar el paseo?')) await tracker.reset();
    else if (wasRecording) { tracker.resume(); keepAwake(true); }
    return;
  }
  $('#dlg-save-title').textContent = 'Guardar paseo';
  $('#dlg-save-discard').hidden = false;
  const { action, data } = await ask($('#dlg-save'), { name: `Paseo ${fmt.datetime(walk.start)}`, notes: '' });
  if (action === 'save') {
    walk.name = data.name.trim() || 'Paseo';
    walk.notes = data.notes.trim();
    await db.put('walks', walk);
    await tracker.reset();
    toast('Paseo guardado');
    openWalk(walk.id);
  } else if (action === 'discard') {
    if (confirm('¿Seguro? El paseo se borrará.')) await tracker.reset();
  } else if (wasRecording) {
    tracker.resume();
    keepAwake(true);
  }
});

// ---------- Tabs & sheet ----------
let activeTab = 'map';
function showPane(name) {
  for (const p of ['walks', 'detail', 'zones']) $(`#sheet-${p}`).hidden = p !== name;
  $('#sheet').classList.toggle('compact', name === 'detail');
  $('#sheet').scrollTop = 0;
}

function showTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#sheet').hidden = tab === 'map';
  $('#recorder').hidden = tab !== 'map';
  if (tab !== 'zones') zoneLayer.clearLayers();
  if (tab === 'walks') { viewLayer.clearLayers(); showPane('walks'); renderWalks(); }
  if (tab === 'zones') { showPane('zones'); renderZones(); }
}
document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- Walks ----------
const chevron = '<svg viewBox="0 0 24 24" style="opacity:.5"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

async function renderWalks() {
  const walks = (await db.all('walks')).sort((a, b) => b.start - a.start);
  $('#walk-list').innerHTML = walks.length
    ? walks.map((w) => `
      <li class="clickable" data-id="${esc(w.id)}">
        <div class="main">
          <div class="title">${esc(w.name)}</div>
          <div class="meta">${fmt.date(w.start)} · ${fmt.distance(w.stats.distance)} · ${fmt.duration(w.activeMs ? w.activeMs / 1000 : w.stats.duration)} · +${Math.round(w.stats.gain)} m</div>
        </div>${chevron}
      </li>`).join('')
    : '<li class="empty">Aún no hay paseos. Pulsa «Iniciar paseo» en el mapa o importa un GPX.</li>';
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

function showWalkOnMap(w) {
  viewLayer.clearLayers();
  const rings = segments(w.points).map((s) => s.map((p) => [p[P.LAT], p[P.LON]]));
  L.polyline(rings, { color: TRACK_COLOR, weight: 5, opacity: 0.9 }).addTo(viewLayer);
  const first = w.points[0];
  const last = w.points[w.points.length - 1];
  L.marker([first[P.LAT], first[P.LON]], { icon: dotIcon('#2e9e4f'), title: 'Inicio' }).addTo(viewLayer);
  L.marker([last[P.LAT], last[P.LON]], { icon: dotIcon('#c0392b'), title: 'Final' }).addTo(viewLayer);
  (w.waypoints || []).forEach((wp) => waypointMarker(wp).addTo(viewLayer));
  setFollow(false);
  map.fitBounds(viewLayer.getBounds(), { ...sheetPadding(), maxZoom: 16 });
}

async function openWalk(id) {
  const w = await db.get('walks', id);
  if (!w) return;
  if (activeTab !== 'walks') {
    activeTab = 'walks';
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'walks'));
    $('#sheet').hidden = false;
    $('#recorder').hidden = true;
  }
  const s = w.stats;
  const total = w.activeMs ? w.activeMs / 1000 : s.duration;
  $('#sheet-detail').innerHTML = `
    <header class="pane-head">
      <button class="back" data-act="back">‹ Paseos</button>
    </header>
    <h2 style="margin:0 0 2px;font-size:20px">${esc(w.name)}</h2>
    <p class="hint">${fmt.datetime(w.start)}${w.imported ? ' · importado' : ''}</p>
    <div class="detail-stats">
      <div><span>${fmt.distance(s.distance)}</span><small>Distancia</small></div>
      <div><span>${fmt.duration(s.moving)}</span><small>En movimiento</small></div>
      <div><span>${fmt.duration(total)}</span><small>Tiempo total</small></div>
      <div><span>+${Math.round(s.gain)} m</span><small>Desnivel subida</small></div>
      <div><span>−${Math.round(s.loss)} m</span><small>Desnivel bajada</small></div>
      <div><span>${fmt.pace(s.distance, s.moving)}</span><small>Ritmo medio</small></div>
    </div>
    ${profileSVG(w.points)}
    ${w.notes ? `<p class="notes">${esc(w.notes)}</p>` : ''}
    ${w.waypoints?.length ? `<p class="hint">${w.waypoints.length} punto(s) marcado(s) — tócalos en el mapa.</p>` : ''}
    <div class="actions">
      <button class="btn small" data-act="fit">Ver en mapa</button>
      <button class="btn small" data-act="gpx">Exportar GPX</button>
      <button class="btn small" data-act="edit">Editar</button>
      <button class="btn small danger" data-act="delete">Borrar</button>
    </div>`;
  $('#sheet-detail').dataset.id = id;
  showPane('detail');
  showWalkOnMap(w);
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
  const w = await db.get('walks', id);
  if (act === 'back') { showTab('walks'); return; }
  if (!w) return;
  if (act === 'fit') showWalkOnMap(w);
  if (act === 'gpx') exportGPX(w);
  if (act === 'edit') {
    $('#dlg-save-title').textContent = 'Editar paseo';
    $('#dlg-save-discard').hidden = true;
    const { action, data } = await ask($('#dlg-save'), { name: w.name, notes: w.notes ?? '' });
    if (action !== 'save') return;
    w.name = data.name.trim() || w.name;
    w.notes = data.notes.trim();
    await db.put('walks', w);
    openWalk(id);
  }
  if (act === 'delete' && confirm(`¿Borrar «${w.name}»? No se puede deshacer.`)) {
    await db.delete('walks', id);
    toast('Paseo borrado');
    showTab('walks');
  }
});

$('#gpx-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { name, points, waypoints } = parseGPX(await file.text());
    const walk = {
      id: crypto.randomUUID(),
      name,
      notes: '',
      start: points[0][P.T],
      end: points[points.length - 1][P.T],
      points,
      waypoints,
      stats: computeStats(points),
      imported: true,
    };
    await db.put('walks', walk);
    toast(`Importado: ${name}`);
    openWalk(walk.id);
  } catch (err) {
    toast(err.message || 'No se pudo importar el archivo');
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
          <div class="meta">${esc(LAYERS[z.layerId]?.name ?? z.layerId)} · zoom ${z.minZ}–${z.maxZ} · ${fmt.bytes(z.bytes)}${z.failed ? ` · ${z.failed} teselas fallidas` : ''}</div>
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
  const est = estimate(zoneBounds, f.layer.value, +f.maxZ.value);
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
    const zone = await downloadZone({ name, layerId, bounds: zoneBounds, maxZ }, {
      signal: zoneAbort.signal,
      onProgress: (done, total, bytes) => {
        bar.value = done / total;
        text.textContent = `${done.toLocaleString('es-ES')} / ${total.toLocaleString('es-ES')} teselas · ${fmt.bytes(bytes)}`;
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

renderRecorder();
tracker.restore().then((restored) => {
  if (restored) toast('Tienes un paseo sin terminar. Pulsa Reanudar o Fin.', 6000);
});
