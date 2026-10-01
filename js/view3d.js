import { $, loadScript, loadStyle, toast } from './ui.js';
import { LAYERS } from './layers.js';
import { demUrl, DEM_Z, DEM_ATTR, slopeImage } from './dem.js';
import { slopeLegendHTML } from './slope.js';

let map3d = null;
let protocolReady = false;
let slopesOn = false;

async function ensureLib() {
  if (!window.maplibregl) {
    loadStyle('vendor/maplibre/maplibre-gl.css');
    await loadScript('vendor/maplibre/maplibre-gl.js');
  }
  if (!protocolReady) {
    // Slope tiles are computed on the fly from the DEM and handed to MapLibre as PNG.
    window.maplibregl.addProtocol('slope', async ({ url }) => {
      const [, z, x, y] = url.match(/slope:\/\/(\d+)\/(\d+)\/(\d+)/).map(Number);
      const img = await slopeImage(z, x, y);
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = 256;
      c.getContext('2d').putImageData(img, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return { data: await blob.arrayBuffer() };
    });
    protocolReady = true;
  }
}

function baseTiles(def) {
  if (!def.url.includes('{s}')) return [def.url];
  return (def.subdomains || 'abc').split('').map((s) => def.url.replace('{s}', s));
}

function style(layerId) {
  const def = LAYERS[layerId];
  const dem = { type: 'raster-dem', tiles: [demUrl('{z}', '{x}', '{y}')], encoding: 'terrarium', tileSize: 256, maxzoom: DEM_Z };
  return {
    version: 8,
    sources: {
      base: { type: 'raster', tiles: baseTiles(def), tileSize: 256, maxzoom: def.maxNativeZoom, attribution: def.attribution },
      terrain: { ...dem, attribution: DEM_ATTR },
      hillshade: dem,
      slope: { type: 'raster', tiles: ['slope://{z}/{x}/{y}'], tileSize: 256, minzoom: 10, maxzoom: 15 },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#dfe6d8' } },
      { id: 'base', type: 'raster', source: 'base' },
      { id: 'hillshade', type: 'hillshade', source: 'hillshade', paint: { 'hillshade-exaggeration': 0.25 } },
      { id: 'slope', type: 'raster', source: 'slope', layout: { visibility: slopesOn ? 'visible' : 'none' }, paint: { 'raster-opacity': 0.75 } },
    ],
    terrain: { source: 'terrain', exaggeration: 1.4 },
    sky: { 'sky-color': '#8fbde6', 'horizon-color': '#e6eef2', 'fog-color': '#ffffff', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.3 },
  };
}

function setSlopes(on) {
  slopesOn = on;
  $('#v3d-slope').classList.toggle('on', on);
  $('#v3d-legend').hidden = !on;
  if (map3d?.getLayer('slope')) map3d.setLayoutProperty('slope', 'visibility', on ? 'visible' : 'none');
}

export function close3D() {
  map3d?.remove();
  map3d = null;
  $('#view3d').hidden = true;
}

export async function open3D({ layerId, center, zoom, tracks = [], position = null }) {
  $('#view3d').hidden = false;
  $('#v3d-legend').innerHTML = slopeLegendHTML();
  try {
    await ensureLib();
  } catch {
    toast('No se pudo cargar el visor 3D');
    close3D();
    return;
  }
  map3d?.remove();
  map3d = new window.maplibregl.Map({
    container: 'map3d',
    style: style(layerId),
    center: [center.lng, center.lat],
    // MapLibre zoom levels are one step lower than Leaflet's for the same scale.
    zoom: Math.max(1, zoom - 1),
    pitch: 62,
    maxPitch: 80,
    attributionControl: { compact: true },
  });
  map3d.addControl(new window.maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  setSlopes(slopesOn);

  map3d.on('load', () => {
    const features = tracks.filter((t) => t.length > 1).map((t) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: t.map(([lat, lon]) => [lon, lat]) } }));
    map3d.addSource('tracks', { type: 'geojson', data: { type: 'FeatureCollection', features } });
    map3d.addLayer({ id: 'tracks-casing', type: 'line', source: 'tracks', paint: { 'line-color': '#ffffff', 'line-width': 7 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
    map3d.addLayer({ id: 'tracks', type: 'line', source: 'tracks', paint: { 'line-color': '#d6452f', 'line-width': 4 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
    if (position) {
      const el = document.createElement('div');
      el.className = 'pos-dot';
      el.style.cssText = 'width:18px;height:18px';
      new window.maplibregl.Marker({ element: el }).setLngLat([position.lng, position.lat]).addTo(map3d);
    }
    if (features.length) {
      const b = new window.maplibregl.LngLatBounds();
      features.forEach((f) => f.geometry.coordinates.forEach((c) => b.extend(c)));
      map3d.fitBounds(b, { padding: 60, pitch: 62, duration: 0, maxZoom: 15 });
    }
  });
}

export function init3D() {
  $('#v3d-close').addEventListener('click', close3D);
  $('#v3d-slope').addEventListener('click', () => setSlopes(!slopesOn));
}
