# Sendas

PWA para registrar paseos por la naturaleza. Sin backend ni build: HTML + JS (módulos ES) + Leaflet.

## Funciones

- Grabación GPS con pausa/reanudar, puntos marcados con nota y recuperación si se cierra la pestaña.
- Estadísticas: distancia, tiempo total y en movimiento, desnivel +/− (filtro de histéresis de 5 m), ritmo y perfil de elevación.
- Historial local (IndexedDB), exportar/compartir GPX e importar GPX.
- Mapas: IGN Topográfico (MTN), IGN Base y ortofoto PNOA (España); OpenTopoMap y OSM (mundial, solo online).
- Descarga de zonas para usar sin conexión (solo capas IGN), con estimación de tamaño previa.

## Ejecutar en local

```sh
npm start   # http://localhost:8080
```

Geolocalización y Service Worker requieren HTTPS (o `localhost`). Para probar en el móvil, publícalo en cualquier hosting estático con HTTPS (Netlify, Cloudflare Pages, GitHub Pages).

Al cambiar archivos de la app, sube la versión de `SHELL` en `sw.js` para que los clientes actualicen la caché.

## Limitaciones conocidas

- **Grabación con la pantalla apagada**: los navegadores móviles (sobre todo iOS) pueden suspender el GPS de una web en segundo plano. La app mantiene la pantalla encendida (Wake Lock) y guarda cada pocos segundos, pero para grabación fiable en bolsillo hace falta empaquetarla como app nativa (p. ej. Capacitor con un plugin de geolocalización en segundo plano).
- **Altitud**: viene del GPS, con error típico de ±10 m. El desnivel es una aproximación; se podría corregir con el modelo digital del terreno del IGN.
- **Offline fuera de España**: las políticas de OpenStreetMap y OpenTopoMap prohíben la descarga masiva. Para cubrirlo habría que generar teselas propias (p. ej. PMTiles desde un extracto de OSM) y alojarlas.
- Los datos viven solo en el navegador del dispositivo; no hay sincronización ni copia en la nube (exporta GPX para respaldo).

## Atribución

Mapas © IGN/CNIG (CC BY 4.0), © colaboradores de OpenStreetMap, © OpenTopoMap (CC-BY-SA).
