import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCommunityReport } from '../server/community-integrations.mjs';
const now = () => Date.parse('2026-11-15T12:00:00Z');
const body = (temp = 34, humidity = 20, wind = 25) => ({ current_units: { temperature_2m: '°C', relative_humidity_2m: '%', wind_speed_10m: 'km/h' }, current: { time: '2026-11-15T12:00', temperature_2m: temp, relative_humidity_2m: humidity, wind_speed_10m: wind } });
const verify = (value, extra = {}) => verifyCommunityReport(34, -116, { fires: [] }, { now, log: () => {}, fetchImpl: async () => new Response(JSON.stringify(value)), ...extra });

test('satellite match wins and skips weather completely', async () => {
  const value = await verifyCommunityReport(34, -116, { fires: [[34, -116, 5, 0, 90, now() / 1000]] }, { now, fetchImpl: async () => assert.fail('Weather must not be requested') });
  assert.equal(value.verificationStatus, 'satellite_confirmed'); assert.equal(value.weatherData, null);
});
test('strict hot/dry/windy thresholds and metric request derive weather warning', async () => {
  let request;
  const value = await verify(body(), { fetchImpl: async url => { request = url; return new Response(JSON.stringify(body())); } });
  assert.equal(value.verificationStatus, 'weather_warning'); assert.deepEqual(value.weatherData, { temp: 34, humidity: 20, wind: 25 });
  assert.equal(request.searchParams.get('latitude'), '34'); assert.equal(request.searchParams.get('longitude'), '-116'); assert.equal(request.searchParams.get('wind_speed_unit'), 'kmh');
  for (const values of [[30, 20, 25], [34, 30, 25], [34, 20, 15], [8, 80, 5]]) assert.equal((await verify(body(...values))).verificationStatus, 'pending');
});
test('bad units, stale/missing/non-numeric weather all fail to pending without weather data', async () => {
  for (const data of [{}, { ...body(), current: { ...body().current, temperature_2m: null } }, { ...body(), current_units: { ...body().current_units, wind_speed_10m: 'mp/h' } }, { ...body(), current: { ...body().current, time: '2025-01-01T00:00' } }, body(34, -1, 25)]) {
    const result = await verify(data); assert.equal(result.verificationStatus, 'pending'); assert.equal(result.weatherData, null);
  }
});
test('weather timeout or HTTP failure logs a fixed reason and returns pending', async () => {
  const logs = [];
  for (const fetchImpl of [async () => new Response('', { status: 503 }), async () => { throw new Error('private upstream content'); }, () => new Promise(() => {})]) {
    const result = await verify(body(), { fetchImpl, log: message => logs.push(message), timeoutMs: 5 });
    assert.equal(result.verificationStatus, 'pending'); assert.equal(result.weatherData, null);
  }
  assert.equal(logs.length, 3); assert.ok(logs.every(line => !line.includes('private upstream')));
});
test('missing coordinates do not request weather or invent conditions', async () => {
  const result = await verifyCommunityReport(null, null, null, { now, fetchImpl: async () => assert.fail('No location') });
  assert.equal(result.weatherData, null); assert.equal(result.verificationStatus, 'pending');
});
