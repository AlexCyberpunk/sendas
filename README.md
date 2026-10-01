# Sendas

PWA para registrar paseos por la naturaleza. Sin backend ni build: HTML + JS (módulos ES), Leaflet para el mapa 2D y MapLibre (carga diferida) para el 3D.

## Funciones

- **Grabación GPS** con pausa/reanudar, puntos con nota, fotos geolocalizadas y recuperación si se cierra la pestaña.
- **Altitud del modelo del terreno (MDT)**: cada punto toma la altitud del relieve, mucho más estable que la del GPS. Desnivel, perfil y pendiente máxima salen de ahí; el trazado se colorea por pendiente.
- **Seguir una ruta** (grabada, planificada o importada) con distancia restante y aviso por vibración + pitido si te alejas más de 40 m.
- **Aviso de ocaso**: hora de puesta de sol y aviso si, al ritmo actual (o volviendo por el mismo camino), llegarías de noche.
- **SOS**: posición en decimal, GMS y UTM (ETRS89), llamada al 112, SMS (funciona sin datos), WhatsApp, compartir y copiar.
- **Planificador**: toca puntos en el mapa; los tramos se ajustan a senderos con BRouter. Distancia, desnivel con MDT y tiempo estimado por el método MIDE.
- **Previsión del tiempo** (Open-Meteo) corregida a la altitud del punto: próximas horas, 3 días, rachas, isocero y avisos. La última consulta queda guardada para verla sin conexión.
- **Capas**: IGN Topográfico, IGN Base y ortofoto PNOA (España); OpenTopoMap y OSM (mundial, solo online). Superpuestas: senderos señalizados (Waymarked Trails), Red Natura 2000 (EEA) y pendientes del terreno ≥ 25° calculadas del MDT.
- **Vista 3D** del relieve con la capa base actual, trazados y pendientes.
- **Identificador de picos**: horizonte calculado desde el MDT (40 km, con curvatura y refracción), picos de OpenStreetMap con prueba de visibilidad, brújula del móvil, cámara y ajuste manual arrastrando.
- **Zonas sin conexión** (capas IGN) con opción de incluir relieve y picos para que pendientes, 3D, altitudes y panorama funcionen sin cobertura.
- Historial local (IndexedDB), exportar/compartir GPX e importar GPX.

## Ejecutar en local

```sh
npm install && npm run vendor   # solo si actualizas Leaflet, MapLibre o SunCalc
npm start                       # http://localhost:8080
```

Geolocalización, brújula, cámara y Service Worker requieren HTTPS (o `localhost`).

Al cambiar archivos de la app, sube la versión de `SHELL` en `sw.js` para que los clientes actualicen la caché.

## Servicios externos

| Servicio | Uso | Sin conexión |
|---|---|---|
| IGN/CNIG WMTS | Mapas base de España | Sí, con zonas descargadas |
| AWS Terrain Tiles (Terrarium) | MDT global (~30 m) | Sí, con zonas con relieve |
| BRouter (brouter.de) | Ajuste a senderos al planificar | No (tramos en línea recta) |
| Overpass API (OSM) | Picos con nombre | Sí, caché por celdas en IndexedDB |
| Open-Meteo | Previsión del tiempo | Última consulta guardada |
| Waymarked Trails, EEA Natura 2000 | Capas superpuestas | No |

## Limitaciones conocidas

- **Grabación con la pantalla apagada**: los navegadores móviles (sobre todo iOS) pueden suspender el GPS de una web en segundo plano. La app mantiene la pantalla encendida (Wake Lock) y guarda cada pocos segundos; para grabación fiable en el bolsillo hace falta empaquetarla como app nativa (p. ej. Capacitor).
- **Brújula**: la del móvil se desvía 5–15° y le afectan objetos metálicos. El panorama permite corregirlo arrastrando; el cálculo del horizonte no depende de ella.
- **MDT de ~30 m**: suaviza cimas y cortados. Las altitudes de las cumbres pueden salir unos metros por debajo de las oficiales y la pendiente de paredes muy verticales se subestima.
- **Offline fuera de España**: OSM y OpenTopoMap prohíben la descarga masiva; haría falta alojar teselas propias (p. ej. PMTiles).
- Los datos viven solo en el navegador del dispositivo; no hay sincronización (exporta GPX para respaldo).

## Atribución

Mapas © IGN/CNIG (CC BY 4.0), © colaboradores de OpenStreetMap (ODbL), © OpenTopoMap (CC-BY-SA), senderos © Waymarked Trails (CC-BY-SA), Natura 2000 © EEA, relieve © Mapzen/AWS Terrain Tiles, rutas BRouter, tiempo © Open-Meteo (CC BY 4.0).
