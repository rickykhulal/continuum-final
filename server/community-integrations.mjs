import crypto from 'node:crypto';
import { decodeCommunityImage } from './community-image.mjs';

export const SATELLITE_RADIUS_KM = 15;
export const HUMAN_CONFIRMATION_THRESHOLD = 3;
export const highRiskWeather = data => data && Number.isFinite(data.temp) && Number.isFinite(data.humidity)
  && Number.isFinite(data.wind) && data.temp > 30 && data.humidity < 30 && data.wind > 15;
const validCoordinate = (lat, lon) => typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90
  && typeof lon === 'number' && Number.isFinite(lon) && Math.abs(lon) <= 180;

/** Match real detection tuples; retain the acquisition date as evidence. */
export function satelliteCrossCheck(lat, lon, bundle) {
  const pending = { verificationStatus: 'pending', satelliteMatch: null };
  if (!validCoordinate(lat, lon) || !Array.isArray(bundle?.fires)) return pending;
  let closest = null;
  const radians = value => value * Math.PI / 180;
  for (const fire of bundle.fires) {
    if (!Array.isArray(fire) || !validCoordinate(fire[0], fire[1]) || !Number.isFinite(fire[5]) || fire[5] <= 0) continue;
    const a = Math.sin(radians(fire[0] - lat) / 2) ** 2
      + Math.cos(radians(lat)) * Math.cos(radians(fire[0])) * Math.sin(radians(fire[1] - lon) / 2) ** 2;
    const distanceKm = 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
    const acquired = new Date(fire[5] * 1000);
    if (!Number.isFinite(acquired.getTime()) || distanceKm > SATELLITE_RADIUS_KM || (closest && distanceKm >= closest.distanceKm)) continue;
    closest = { distanceKm, lat: fire[0], lon: fire[1], acquiredAt: acquired.toISOString(),
      windowStart: bundle.meta?.windowStart ?? null, windowEnd: bundle.meta?.windowEnd ?? null };
  }
  return closest ? { verificationStatus: 'satellite_confirmed', satelliteMatch: closest } : pending;
}

/** Satellite evidence takes precedence. Weather is a current risk estimate, never proof of fire. */
export async function verifyCommunityReport(lat, lon, bundle, { fetchImpl = fetch, now = Date.now, timeoutMs = 6000, log = message => console.warn(message) } = {}) {
  const checkedAt = new Date(now()).toISOString();
  const satellite = satelliteCrossCheck(lat, lon, bundle);
  const result = { ...satellite, weatherData: null, weatherObservedAt: null, verificationCheckedAt: checkedAt };
  if (satellite.verificationStatus === 'satellite_confirmed' || !validCoordinate(lat, lon)) return result;
  const controller = new AbortController();
  let timer;
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({ latitude: String(lat), longitude: String(lon), current: 'temperature_2m,relative_humidity_2m,wind_speed_10m', temperature_unit: 'celsius', wind_speed_unit: 'kmh', timezone: 'GMT' }).toString();
    const weather = await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); }),
    ]);
    const current = weather?.current, units = weather?.current_units;
    if (units?.temperature_2m !== '°C' || units?.relative_humidity_2m !== '%' || units?.wind_speed_10m !== 'km/h') throw new Error('invalid units');
    const data = { temp: current?.temperature_2m, humidity: current?.relative_humidity_2m, wind: current?.wind_speed_10m };
    const time = typeof current?.time === 'string' ? Date.parse(/Z$|[+-]\d\d:\d\d$/.test(current.time) ? current.time : `${current.time}Z`) : NaN;
    if (!Object.values(data).every(Number.isFinite) || data.temp < -100 || data.temp > 70 || data.humidity < 0 || data.humidity > 100 || data.wind < 0
      || !Number.isFinite(time) || now() - time > 90 * 60000 || time - now() > 10 * 60000) throw new Error('invalid or stale weather');
    return { ...result, verificationStatus: highRiskWeather(data) ? 'weather_warning' : 'pending', weatherData: data, weatherObservedAt: new Date(time).toISOString() };
  } catch (error) {
    const reason = /^(HTTP \d{3}|timeout|invalid units|invalid or stale weather)$/.test(error?.message) ? error.message : 'network error';
    log(`Community weather check failed (${reason}); falling back to pending.`);
    return result;
  } finally { clearTimeout(timer); }
}

export function discordSyncAuthorized(candidate, secret = process.env.DISCORD_SYNC_SECRET) {
  if (typeof secret !== 'string' || !secret.trim() || typeof candidate !== 'string' || !candidate) return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(candidate).digest(), crypto.createHash('sha256').update(secret).digest());
}

/** Delivery failure must not turn a saved report into a failed submission. */
export async function sendDiscordReport(post, { webhookUrl = process.env.DISCORD_WEBHOOK_URL,
  botToken = process.env.DISCORD_BOT_TOKEN, channelId = process.env.DISCORD_REPORT_CHANNEL_ID, fetchImpl = fetch } = {}) {
  if (!webhookUrl && !(botToken && channelId)) return 'not_configured';
  try {
    let target;
    const headers = {};
    if (webhookUrl) {
      const url = new URL(webhookUrl);
      if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(url.hostname)
          || url.username || url.password || url.port || !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+$/.test(url.pathname)) return 'failed';
      target = url.href;
    } else {
      if (!/^\d{10,25}$/.test(channelId)) return 'failed';
      target = `https://discord.com/api/v10/channels/${channelId}/messages`;
      headers.Authorization = `Bot ${botToken}`;
    }
    const location = post.locationName || (post.lat != null && post.lon != null ? `${post.lat}, ${post.lon}` : 'Not provided');
    const payload = { allowed_mentions: { parse: [] }, embeds: [{ title: '🔥 New Community Report',
        description: post.content, fields: [{ name: 'Location', value: location }, { name: 'Status', value: post.verificationStatus }],
      }] };
    const image = decodeCommunityImage(post.imageBase64);
    let body;
    if (image) {
      payload.embeds[0].image = { url: `attachment://${image.filename}` };
      payload.attachments = [{ id: 0, filename: image.filename }];
      body = new FormData();
      body.append('payload_json', JSON.stringify(payload));
      body.append('files[0]', new Blob([image.bytes], { type: image.mimeType }), image.filename);
    } else { headers['Content-Type'] = 'application/json'; body = JSON.stringify(payload); }
    const response = await fetchImpl(target, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers, body,
    });
    return response.ok ? 'sent' : 'failed';
  } catch { return 'failed'; } // Never print a webhook URL, response body or secret.
}
