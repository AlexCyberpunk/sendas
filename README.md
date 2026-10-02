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
- **Identificador de picos**: horizonte calculado desde el MDT (40 km, con curvatura y refracción), prueba de visibilidad de cada pico, brújula del móvil, cámara y ajuste manual arrastrando. En España usa las 66 504 montañas del Nomenclátor Geográfico Básico del IGN incluidas en la app (`data/peaks-es.json`, 2,4 MB; ~0,6 MB descargados con brotli) y funciona sin conexión desde la instalación; fuera de España consulta OpenStreetMap.
- **Zonas sin conexión** (capas IGN) con opción de incluir relieve y picos para que pendientes, 3D, altitudes y panorama funcionen sin cobertura.
- **Fotos a posteriori**: añade fotos de la galería a un paseo guardado. Se colocan por el GPS de la foto o, si no lo trae (el selector de fotos de Android lo elimina), por su hora de captura sobre el recorrido; las que no se puedan ubicar se colocan tocando el mapa.
- **Notas de voz** de hasta 5 minutos (unos 1,2 MB), durante el paseo con su posición o después desde el detalle.
- **Simulación**: eliges la hora de salida y un reloj recorre la ruta (×30 a ×600, pausa y barra para moverte). Rutas planificadas o importadas usan MIDE por tramos; paseos grabados reproducen su ritmo real. Avisa si llegarías de noche.
- **Bloqueo de pantalla** durante el paseo: pantalla negra con hora, tiempo, distancia, altitud, desnivel, tiempo hasta el atardecer/amanecer, ruta restante y batería. Color de los datos a elegir (blanco, gris, rojo, verde o azul), que se recuerda. Se desbloquea dibujando 3 círculos en sentido antihorario. Es un bloqueo dentro de la app: no desactiva los botones del sistema.
- **Imagen para compartir** de cada paseo: foto del paseo (u otra de la galería) de fondo con trazado, perfil y los datos que elijas (nombre, fecha, distancia, tiempos, desnivel, altitud, ritmo, pendiente, cumbre…), en 4:5, 1:1 o historia 9:16. La selección se recuerda entre usos; botones para seleccionar o limpiar todos.
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
| IGN Nomenclátor (NGBE) | Picos de España, incluidos en la app | Sí |
| Overpass API (OSM) | Picos fuera de España | Sí, caché por celdas en IndexedDB |
| Open-Meteo | Previsión del tiempo | Última consulta guardada |
| Waymarked Trails, EEA Natura 2000 | Capas superpuestas | No |

## Datos de picos

`data/peaks-es.json` se genera desde el WFS INSPIRE del Nomenclátor (`https://www.ign.es/wfs-inspire/ngbe`), filtrando `localType = Montaña` y guardando `[lat, lon, nombre]`. Los nombres son los oficiales (p. ej. «Picu Urriellu» para el Naranjo de Bulnes) y el Nomenclátor no incluye altitud, que se toma del MDT.

## Limitaciones conocidas

- **Grabación con la pantalla apagada**: los navegadores móviles (sobre todo iOS) pueden suspender el GPS de una web en segundo plano. La app mantiene la pantalla encendida (Wake Lock) y guarda cada pocos segundos; para grabación fiable en el bolsillo hace falta empaquetarla como app nativa (p. ej. Capacitor).
- **Brújula**: la del móvil se desvía 5–15° y le afectan objetos metálicos. El panorama permite corregirlo arrastrando; el cálculo del horizonte no depende de ella.
- **MDT de ~30 m**: suaviza cimas y cortados. Las altitudes de las cumbres pueden salir unos metros por debajo de las oficiales y la pendiente de paredes muy verticales se subestima.
- **Offline fuera de España**: OSM y OpenTopoMap prohíben la descarga masiva; haría falta alojar teselas propias (p. ej. PMTiles).
- Los datos viven solo en el navegador del dispositivo; no hay sincronización (exporta GPX para respaldo).

## Atribución

Mapas y Nomenclátor Geográfico Básico © IGN/CNIG (CC BY 4.0), © colaboradores de OpenStreetMap (ODbL), © OpenTopoMap (CC-BY-SA), senderos © Waymarked Trails (CC-BY-SA), Natura 2000 © EEA, relieve © Mapzen/AWS Terrain Tiles, rutas BRouter, tiempo © Open-Meteo (CC BY 4.0).
