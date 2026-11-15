export interface WindData {
  source: 'Open-Meteo' | 'NASA POWER';
  speedKmh: number;
  direction: number;
  time: string;
  historical: boolean;
}

export function windRequest(lat: number, lon: number, date?: string | null, today = new Date().toISOString().slice(0, 10)) {
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw new Error('Invalid wind coordinates.');
  }
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) {
    throw new Error('Invalid wind date.');
  }
  if (date && date > today) throw new Error('Wind data is unavailable for future dates.');
  const historical = !!date && date < today;
  const url = new URL(historical
    ? 'https://power.larc.nasa.gov/api/temporal/daily/point'
    : 'https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  if (historical) {
    url.searchParams.set('parameters', 'WS10M,WD10M');
    url.searchParams.set('community', 'RE');
    url.searchParams.set('start', date!.replace(/-/g, ''));
    url.searchParams.set('end', date!.replace(/-/g, ''));
    url.searchParams.set('format', 'JSON');
  } else {
    url.searchParams.set('current_weather', 'true');
    url.searchParams.set('windspeed_unit', 'kmh');
    url.searchParams.set('timezone', 'UTC');
  }
  return { url: url.href, historical };
}

export function parseWind(body: any, historical: boolean, date?: string | null): WindData {
  const key = date?.replace(/-/g, '') ?? '';
  const speed = historical ? body?.properties?.parameter?.WS10M?.[key] : body?.current_weather?.windspeed;
  const direction = historical ? body?.properties?.parameter?.WD10M?.[key] : body?.current_weather?.winddirection;
  const time = historical ? date : body?.current_weather?.time;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0 ||
      typeof direction !== 'number' || !Number.isFinite(direction) || direction < 0 || direction > 360 || !time) {
    throw new Error('The wind provider returned no usable wind data for this location and date.');
  }
  return { source: historical ? 'NASA POWER' : 'Open-Meteo', speedKmh: historical ? speed * 3.6 : speed, direction: direction % 360, time, historical };
}

export function windCompass(degrees: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(degrees / 45) % 8];
}

export async function fetchWind(lat: number, lon: number, date?: string | null, signal?: AbortSignal): Promise<WindData> {
  const request = windRequest(lat, lon, date);
  return parseWind(await fetchWindBody(request.url, signal), request.historical, date);
}

async function fetchWindBody(url: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Wind provider unavailable (HTTP ${response.status}).`);
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error('Wind request timed out. Please retry.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export interface ForecastWindDay {
  date: string;
  /** Daily maximum sustained wind at 10 m, not a gust speed. */
  speedKmh: number;
  /** Daily dominant direction (from); may be missing even when speed is known. */
  direction: number | null;
}

export function forecastWindRequest(lat: number, lon: number): string {
  const url = new URL(windRequest(lat, lon).url);
  url.searchParams.delete('current_weather');
  url.searchParams.delete('windspeed_unit');
  url.searchParams.set('daily', 'wind_speed_10m_max,wind_direction_10m_dominant');
  url.searchParams.set('wind_speed_unit', 'kmh');
  url.searchParams.set('forecast_days', '7');
  return url.href;
}

export function parseWindForecast(body: any): ForecastWindDay[] {
  if (body?.daily_units?.wind_speed_10m_max !== 'km/h' || body?.utc_offset_seconds !== 0
      || !Array.isArray(body?.daily?.time) || !Array.isArray(body?.daily?.wind_speed_10m_max)) {
    throw new Error('The wind forecast has missing daily data or unexpected units/timezone.');
  }
  const days: ForecastWindDay[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < body.daily.time.length; i++) {
    const date = body.daily.time[i];
    const speed = body.daily.wind_speed_10m_max[i];
    const direction = body.daily.wind_direction_10m_dominant?.[i];
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || seen.has(date)
      || typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0) continue;
    seen.add(date);
    days.push({ date, speedKmh: speed,
      direction: body.daily_units.wind_direction_10m_dominant === '°' && typeof direction === 'number'
        && Number.isFinite(direction) && direction >= 0 && direction <= 360 ? direction % 360 : null });
  }
  if (!days.length) throw new Error('No usable daily wind forecast was returned.');
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchWindForecast(lat: number, lon: number, signal?: AbortSignal): Promise<ForecastWindDay[]> {
  return parseWindForecast(await fetchWindBody(forecastWindRequest(lat, lon), signal));
}
