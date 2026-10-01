const IGN_ATTR = '© <a href="https://www.ign.es" target="_blank" rel="noopener">IGN/CNIG</a> (CC BY 4.0)';
const SPAIN = [[27.4, -18.5], [44.1, 4.6]];

const ign = (service, layer, format) =>
  `https://www.ign.es/wmts/${service}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}` +
  `&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;

// avgKB: measured average tile weight, used only for download size estimates.
// offline: false where the provider's usage policy forbids bulk downloading.
export const LAYERS = {
  mtn: {
    name: 'IGN Topográfico (España)',
    url: ign('mapa-raster', 'MTN', 'image/jpeg'),
    maxNativeZoom: 17,
    bounds: SPAIN,
    attribution: IGN_ATTR,
    offline: true,
    avgKB: 18,
  },
  base: {
    name: 'IGN Base (España)',
    url: ign('ign-base', 'IGNBaseTodo', 'image/png'),
    maxNativeZoom: 18,
    bounds: SPAIN,
    attribution: IGN_ATTR,
    offline: true,
    avgKB: 35,
  },
  pnoa: {
    name: 'Ortofoto PNOA (España)',
    url: ign('pnoa-ma', 'OI.OrthoimageCoverage', 'image/jpeg'),
    maxNativeZoom: 19,
    bounds: SPAIN,
    attribution: IGN_ATTR,
    offline: true,
    avgKB: 22,
  },
  otm: {
    name: 'OpenTopoMap (mundial, solo online)',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: 'abc',
    maxNativeZoom: 17,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>, © <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA)',
    offline: false,
  },
  osm: {
    name: 'OpenStreetMap (mundial, solo online)',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxNativeZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    offline: false,
  },
};

// Online-only overlays. kind 'tile' → XYZ template, kind 'wms' → WMS GetMap.
export const OVERLAYS = {
  trails: {
    name: 'Senderos señalizados (GR, PR, SL)',
    kind: 'tile',
    url: 'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png',
    maxNativeZoom: 17,
    opacity: 0.85,
    attribution: 'Senderos © <a href="https://hiking.waymarkedtrails.org" target="_blank" rel="noopener">Waymarked Trails</a> (CC-BY-SA)',
  },
  natura: {
    name: 'Espacios protegidos (Red Natura 2000)',
    kind: 'wms',
    url: 'https://bio.discomap.eea.europa.eu/arcgis/services/ProtectedSites/Natura2000Sites/MapServer/WMSServer',
    layers: '0,1,2',
    opacity: 0.45,
    attribution: 'Natura 2000 © <a href="https://www.eea.europa.eu" target="_blank" rel="noopener">EEA</a>',
  },
};

export function tileUrl(layerId, z, x, y) {
  return LAYERS[layerId].url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}
