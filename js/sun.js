import { fmt } from './geo.js';

const FALLBACK_SPEED = 1.1;

export function sunTimes(lat, lon, date = new Date()) {
  const t = window.SunCalc.getTimes(date, lat, lon);
  return { sunrise: t.sunrise.getTime(), sunset: t.sunset.getTime(), dusk: t.dusk.getTime() };
}

// Estimates how long the walker still needs and compares it with the remaining daylight.
// Following a route: remaining distance at the observed moving speed.
// Otherwise: assumes returning the same way, i.e. as long as the moving time so far.
export function daylightCheck({ lat, lon, stats, follow, now = Date.now() }) {
  const { sunset } = sunTimes(lat, lon, new Date(now));
  const speed = stats.moving > 120 && stats.distance > 200 ? stats.distance / stats.moving : FALLBACK_SPEED;
  const needSec = follow ? follow.remaining / speed : stats.moving;
  const arrival = now + needSec * 1000;
  const lightLeft = (sunset - now) / 1000;
  let level = 'ok';
  if (sunset < now) level = 'night';
  else if (arrival > sunset) level = 'dark';
  else if (arrival > sunset - 30 * 60 * 1000) level = 'tight';

  const basis = follow ? 'al ritmo actual' : 'si vuelves por el mismo camino';
  let text = sunset < now ? 'El sol ya se ha puesto' : `Ocaso ${fmt.time(sunset)} · quedan ${fmt.hm(lightLeft)} de luz`;
  let warning = '';
  if (level === 'dark') warning = `Llegarás ~${fmt.hm((arrival - sunset) / 1000)} después del ocaso ${basis}`;
  else if (level === 'tight') warning = `Vas justo de luz: llegada estimada ${fmt.time(arrival)} ${basis}`;
  if (needSec < 60 && !follow) warning = '';
  return { level, text, warning, sunset, arrival };
}
