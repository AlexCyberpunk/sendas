import { slopeImage, SLOPE_CLASSES } from './dem.js';

export const SlopeLayer = L.GridLayer.extend({
  options: { minZoom: 11, maxNativeZoom: 15, maxZoom: 19, opacity: 0.75, attribution: 'Pendientes calculadas del MDT' },
  createTile(coords, done) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    slopeImage(coords.z, coords.x, coords.y)
      .then((img) => { c.getContext('2d').putImageData(img, 0, 0); done(null, c); })
      .catch((e) => done(e, c));
    return c;
  },
});

export const slopeLegendHTML = () => `<b>Pendiente del terreno</b>${SLOPE_CLASSES.map((c) => `<span><i style="background:rgb(${c.color.join(',')})"></i>${c.label}</span>`).join('')}`;
