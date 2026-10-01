import { $, esc, store } from './ui.js';
import { elevationAt } from './dem.js';
import { fmt } from './geo.js';

const API = 'https://api.open-meteo.com/v1/forecast';

const WMO = {
  0: 'Despejado', 1: 'Casi despejado', 2: 'Parcialmente nuboso', 3: 'Cubierto',
  45: 'Niebla', 48: 'Niebla con escarcha',
  51: 'Llovizna débil', 53: 'Llovizna', 55: 'Llovizna intensa', 56: 'Llovizna helada', 57: 'Llovizna helada',
  61: 'Lluvia débil', 63: 'Lluvia', 65: 'Lluvia fuerte', 66: 'Lluvia helada', 67: 'Lluvia helada fuerte',
  71: 'Nieve débil', 73: 'Nieve', 75: 'Nieve fuerte', 77: 'Granizo fino',
  80: 'Chubascos débiles', 81: 'Chubascos', 82: 'Chubascos fuertes', 85: 'Chubascos de nieve', 86: 'Chubascos de nieve fuertes',
  95: 'Tormenta', 96: 'Tormenta con granizo', 99: 'Tormenta con granizo',
};
const wmo = (c) => WMO[c] ?? '—';

const cacheKey = (lat, lon) => `wx.${lat.toFixed(2)},${lon.toFixed(2)}`;

async function fetchForecast(lat, lon, elevation) {
  const p = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,freezing_level_height',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_gusts_10m_max,sunrise,sunset',
    timezone: 'auto',
    forecast_days: '3',
    wind_speed_unit: 'kmh',
  });
  // Passing the terrain altitude makes Open-Meteo correct temperatures for the actual height.
  if (elevation != null) p.set('elevation', Math.round(elevation));
  const res = await fetch(`${API}?${p}`);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  return res.json();
}

function warnings(data, elevation) {
  const out = [];
  const h = data.hourly;
  const next = h.time.map((t, i) => i).filter((i) => Date.parse(h.time[i]) >= Date.now() - 3600e3).slice(0, 24);
  const gust = Math.max(...next.map((i) => h.wind_gusts_10m[i] ?? 0));
  if (gust >= 70) out.push(`Rachas muy fuertes (hasta ${Math.round(gust)} km/h)`);
  else if (gust >= 50) out.push(`Rachas fuertes (hasta ${Math.round(gust)} km/h)`);
  if (next.some((i) => h.weather_code[i] >= 95)) out.push('Riesgo de tormenta en las próximas 24 h');
  const fz = Math.min(...next.map((i) => h.freezing_level_height[i] ?? Infinity));
  if (elevation != null && Number.isFinite(fz) && fz < elevation + 300) out.push(`Isocero a ${Math.round(fz)} m: posible hielo o nieve a tu altura`);
  return out;
}

function render(data, { elevation, fetchedAt, stale }) {
  const h = data.hourly;
  const d = data.daily;
  const start = h.time.findIndex((t) => Date.parse(t) >= Date.now() - 3600e3);
  const hours = Array.from({ length: 12 }, (_, k) => start + k).filter((i) => i >= 0 && i < h.time.length);
  const fz = Math.round(Math.min(...hours.map((i) => h.freezing_level_height[i] ?? Infinity)));
  const w = warnings(data, elevation);
  return `
    <p class="hint">${elevation != null ? `Altitud del punto: ${Math.round(elevation)} m · ` : ''}${stale ? '<strong>Sin conexión</strong> · ' : ''}actualizado ${fmt.datetime(fetchedAt)}</p>
    ${w.length ? `<div class="wx-warn">${w.map((x) => `<div>${esc(x)}</div>`).join('')}</div>` : ''}
    <h4>Próximas horas</h4>
    <div class="wx-hours">
      ${hours.map((i) => `
        <div class="wx-h">
          <b>${h.time[i].slice(11, 16)}</b>
          <span class="wx-t">${Math.round(h.temperature_2m[i])}°</span>
          <small>${esc(wmo(h.weather_code[i]))}</small>
          <small>Lluvia ${h.precipitation_probability[i] ?? 0}%</small>
          <small>Viento ${Math.round(h.wind_speed_10m[i])} (${Math.round(h.wind_gusts_10m[i])})</small>
        </div>`).join('')}
    </div>
    ${Number.isFinite(fz) ? `<p class="hint">Isocero (0 °C) mínima próximas 12 h: ${fz} m</p>` : ''}
    <h4>Próximos días</h4>
    <table class="wx-days">
      ${d.time.map((t, i) => `
        <tr>
          <td>${new Date(`${t}T12:00`).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric' })}</td>
          <td>${esc(wmo(d.weather_code[i]))}</td>
          <td>${Math.round(d.temperature_2m_min[i])}° / ${Math.round(d.temperature_2m_max[i])}°</td>
          <td>${d.precipitation_probability_max[i] ?? 0}% · ${d.precipitation_sum[i] ?? 0} mm</td>
          <td>Rachas ${Math.round(d.wind_gusts_10m_max[i])} km/h</td>
        </tr>`).join('')}
    </table>
    <p class="hint">Sol: ${d.sunrise[0].slice(11, 16)} – ${d.sunset[0].slice(11, 16)} · Viento en km/h (rachas). Datos: <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a></p>`;
}

export async function showWeather(lat, lon) {
  const dlg = $('#dlg-weather');
  const body = $('#weather-body');
  $('#weather-title').textContent = `Tiempo en ${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  body.innerHTML = '<p class="hint">Cargando previsión…</p>';
  dlg.showModal();
  const elevation = await elevationAt(lat, lon).catch(() => null);
  try {
    const data = await fetchForecast(lat, lon, elevation);
    const entry = { data, elevation, fetchedAt: Date.now() };
    store.set(cacheKey(lat, lon), entry);
    body.innerHTML = render(data, entry);
  } catch {
    const cached = store.get(cacheKey(lat, lon));
    body.innerHTML = cached
      ? render(cached.data, { ...cached, stale: true })
      : '<p class="hint">No se pudo obtener la previsión y no hay datos guardados para este punto.</p>';
  }
}
