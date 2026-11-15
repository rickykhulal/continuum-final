// API contract tests against a real server process on an isolated port.
// Run with: node --test tests/api.test.mjs   (needs `npm run api:build` first)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.API_TEST_PORT || 4191);
const BASE = `http://127.0.0.1:${PORT}`;
let child;
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-api-contract-'));

async function waitReady() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('API did not start for tests');
}

before(async () => {
  if (!fs.existsSync(path.join(ROOT, 'dist-server', 'analytics.mjs'))) {
    throw new Error('dist-server/analytics.mjs is missing — run `npm run api:build`');
  }
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'api.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), APP_DATA_PATH: runtime, DISCORD_WEBHOOK_URL: '', DISCORD_SYNC_SECRET: '', DISCORD_BOT_TOKEN: '', API_RATE_LIMITS: 'classA:120/min;classB:60/min;classC:200/min' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await waitReady();
});

after(async () => {
  if (child && child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  fs.rmSync(runtime, { recursive: true, force: true });
});

const post = async (sub, body) => {
  const res = await fetch(`${BASE}/api/v1${sub}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { res, text, json };
};

test('every response carries the version envelope', async () => {
  const { json } = await post('/area/summary', { region_id: 'chilecito' });
  for (const key of ['method_version', 'bundle_version', 'data_through', 'provisional_from']) {
    assert.ok(key in json, `${key} missing from the envelope`);
  }
  assert.equal(json.data_through, JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'snapshot.json'), 'utf8')).windowEnd);
  assert.ok(json.provisional_from >= json.start, 'provisional_from is a date inside or after the range');
});

test('GET outlook uses region_id and returns different regional analog records', async () => {
  const get = async id => {
    const response = await fetch(`${BASE}/api/v1/outlook?region_id=${id}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const nepal = await get('nepal'), california = await get('california');
  assert.equal(nepal.region_id, 'nepal'); assert.equal(california.region_id, 'california');
  assert.ok(nepal.analogs.length > 0); assert.ok(california.analogs.length > 0);
  assert.notDeepEqual(nepal.analogs, california.analogs);
  const spec = await (await fetch(`${BASE}/openapi.json`)).json();
  assert.ok(spec.paths['/outlook'].get.parameters.some(p => p.name === 'region_id'));
  const schema = spec.paths['/community/vote'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(schema.properties.action.enum, ['verify']); assert.equal(schema.oneOf.length, 2);
});

test('the same area resolved three ways returns the same record', async () => {
  const byId = await post('/area/summary', { region_id: 'chilecito', start: '2026-01-01', end: '2026-06-30' });
  const [lat, lon] = [-29.15, -67.5];
  const ring = [
    [lon - 0.5, lat - 0.5], [lon + 0.5, lat - 0.5], [lon + 0.5, lat + 0.5], [lon - 0.5, lat + 0.5], [lon - 0.5, lat - 0.5],
  ];
  assert.equal(byId.res.status, 200, byId.text.slice(0, 200));
  const byGeom = await post('/area/summary', { geometry: { type: 'Polygon', coordinates: [ring] }, start: '2026-01-01', end: '2026-06-30' });
  assert.equal(byGeom.res.status, 200);
  assert.ok(byGeom.json.area_km2 > 0 && byGeom.json.counts.days === byId.json.counts.days, 'same window, same number of days');
  const cal = await post('/area/calendar', { region_id: 'chilecito', start: '2026-01-01', end: '2026-06-30' });
  const sumFromCal = cal.json.values.reduce((s, v) => s + v.value, 0);
  assert.ok(Math.abs(sumFromCal - byId.json.counts.total) < 0.5, `calendar total ${sumFromCal} must match summary ${byId.json.counts.total}`);
});

test('the API and the browser compute from one implementation', async () => {
  const A = await import(pathToFileURL(path.join(ROOT, 'dist-server', 'analytics.mjs')).href);
  const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'live_fires.json'), 'utf8'));
  const region = A.getRegion('chilecito');
  const records = A.regionRecord(region, live);
  const expected = A.recordsInRange(records, '2026-01-01', '2026-10-31').reduce((s, r) => s + r.harmonized, 0);
  const { json } = await post('/area/summary', { region_id: 'chilecito', start: '2026-01-01', end: '2026-10-31' });
  assert.ok(Math.abs(json.counts.total - expected) < 0.05, `API ${json.counts.total} vs in-app ${expected.toFixed(2)}`);
});

test('error model returns the documented codes with hints', async () => {
  const cases = [
    [{}, 422, 'PARAMETER_INVALID'],
    [{ region_id: 'nope' }, 422, 'OUT_OF_COVERAGE'],
    [{ lat: 95, lon: 0 }, 422, 'INVALID_GEOMETRY'],
    [{ region_id: 'chilecito', start: '2030-01-01', end: '2031-01-01' }, 422, 'DATE_RANGE_INVALID'],
    [{ region_id: 'chilecito', metric: 'x' }, 422, 'PARAMETER_INVALID'],
    [{ region_id: 'chilecito', mode: 'x' }, 422, 'PARAMETER_INVALID'],
    [{ region_id: 'chilecito', month: 13 }, 422, 'PARAMETER_INVALID'],
  ];
  for (const [body, status, code] of cases) {
    const route = body.month ? '/area/month-compare' : '/area/summary';
    const { res, json } = await post(route, body);
    assert.equal(res.status, status, `${JSON.stringify(body)} → ${res.status}`);
    assert.equal(json.error.code, code, `${JSON.stringify(body)} → ${json.error?.code}`);
    assert.ok(json.error.hint, 'every error tells the caller what to do');
    assert.match(json.error.request_id, /^req_/);
  }
});

test('malformed JSON is rejected without a crash', async () => {
  const res = await fetch(`${BASE}/api/v1/area/summary`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"region_id": ' });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, 'INVALID_JSON');
});

test('oversized bodies are refused at the declared limit', async () => {
  const limit = Number(process.env.API_MAX_UPLOAD_MB || 2);
  const big = { region_id: 'chilecito', blob: 'x'.repeat(Math.round(limit * 1024 * 1024) + 64) };
  const res = await fetch(`${BASE}/api/v1/area/summary`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(big) });
  assert.ok(res.status === 413 || res.status === 422, `status ${res.status}`);
});

test('security headers are set on API and static responses', async () => {
  const api = await fetch(`${BASE}/api/v1/meta`);
  const page = await fetch(`${BASE}/`);
  for (const res of [api, page]) {
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.ok(String(res.headers.get('content-security-policy')).includes("frame-ancestors 'none'"));
    assert.ok(String(res.headers.get('content-security-policy')).includes("object-src 'none'"));
  }
});

test('CORS is closed by default and opt-in by environment', async () => {
  const res = await fetch(`${BASE}/api/v1/meta`, { headers: { origin: 'https://evil.example' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'no cross-origin allowance unless configured');
  const preflight = await fetch(`${BASE}/api/v1/area/summary`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
});

test('exports are downloadable files with the right content type', async () => {
  const csv = await post('/export/csv', { region_id: 'chilecito', start: '2026-01-01', end: '2026-01-31' });
  assert.equal(csv.res.headers.get('content-type').split(';')[0], 'text/csv');
  assert.match(csv.res.headers.get('content-disposition'), /attachment; filename="continuum_chilecito_2026-01-01_2026-01-31.csv"/);
  assert.ok(csv.text.split('\n').length >= 31);

  const pdf = await post('/brief', { region_id: 'chilecito', format: 'pdf' });
  assert.equal(pdf.res.headers.get('content-type'), 'application/pdf');
  assert.ok(pdf.text.startsWith('%PDF-1.'), 'PDF magic header');
  assert.ok(pdf.text.includes('%%EOF'), 'PDF trailer present');

  const geo = await post('/export/geojson', { region_id: 'chilecito', start: '2026-10-24', end: '2026-10-31' });
  assert.ok(geo.json.features.every((f) => f.geometry.coordinates[0] >= -180 && f.geometry.coordinates[0] <= 180));
  assert.ok(geo.json.features.every((f) => f.properties.time_utc));
});

test('openapi documents every route the server actually answers', async () => {
  const doc = await (await fetch(`${BASE}/openapi.json`)).json();
  for (const p of Object.keys(doc.paths)) {
    const isGet = Boolean(doc.paths[p].get);
    const res = isGet ? await fetch(`${BASE}/api/v1${p}`) : await fetch(`${BASE}/api/v1${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ region_id: 'chilecito' }) });
    if (p === '/community/discord-sync') {
      assert.equal(res.status, 503, 'Discord sync is explicitly disabled without its server secret');
      assert.equal((await res.json()).error.code, 'DISCORD_NOT_CONFIGURED');
      continue;
    }
    assert.ok(res.status < 500, `${p} → ${res.status}`);
    if (!isGet) await res.text().catch(() => '');
  }
});

/* The world layer over HTTP. Added 2026-11-03 with ADR-22: the browser can analyse all 241 country
 * borders, so the read-only API must answer for the same ids with the same numbers — a border's own
 * measurement, never the stride sample and never a pooled pilot density. */
const BORDER = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'country_fires.json'), 'utf8'));
const LIVE = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'live_fires.json'), 'utf8'));
const WINDOW = { start: LIVE.meta.windowStart, end: LIVE.meta.windowEnd };
const borderRow = (id) => BORDER.countries.find((c) => c.id === id);
const viirsOf = (row) => ['VIIRS-SNPP', 'NOAA-20', 'NOAA-21'].reduce((n, s) => n + (row.sensors[s] || 0), 0);

test('GET /meta publishes every country id the API will answer for', async () => {
  const meta = await (await fetch(`${BASE}/api/v1/meta`)).json();
  const w = meta.world_layer;
  assert.ok(w, 'the world layer index must be published');
  assert.equal(w.countries_total, 241, 'all 241 Natural Earth countries must be selectable');
  assert.equal(w.countries.length, w.countries_total);
  assert.ok(w.countries.every((c) => typeof c.region_id === 'string' && c.region_id.startsWith('country-')), 'each row carries its region id');
  assert.ok(w.countries.every((c) => typeof c.detections === 'number'), 'each row carries a number, including the zeros');
  assert.deepEqual(w.window, BORDER.meta.window);
  assert.equal(w.coverage_pct, BORDER.meta.coverage_pct, 'the index repeats the builder\'s own coverage figure');
  const kenya = w.countries.find((c) => c.id === 'kenya');
  assert.equal(kenya.detections, borderRow('kenya').total, 'the index row is the border measurement');
  const sum = w.countries.reduce((a, c) => a + c.detections, 0);
  assert.equal(sum, BORDER.meta.rows_in_countries, 'the per-country rows add back to the rows inside borders');
});

test('a country id returns that border\'s measured window, continent across', async () => {
  const ids = ['kenya', 'brazil', 'russia', 'australia', 'canada', 'france', 'nepal', 'antarctica'];
  for (const id of ids) {
    const row = borderRow(id);
    const measured = row ? viirsOf(row) : 0;
    const { res, json } = await post('/area/summary', { region_id: `country-${id}`, ...WINDOW });
    assert.equal(res.status, 200, `country-${id} → ${res.status} ${JSON.stringify(json.error || '')}`);
    assert.equal(json.area_resolution, 'country border (Natural Earth 50m)', `${id}: the resolution must name the border`);
    assert.equal(json.counts.days, 8, `${id}: the shipped window must be fully observed`);
    assert.equal(json.counts.by_sensor.viirs + json.counts.by_sensor.noaa20 + json.counts.by_sensor.noaa21, measured, `${id}: VIIRS lanes must be the measured border counts`);
    assert.equal(json.counts.by_sensor.modis, row ? row.sensors.MODIS || 0 : 0, `${id}: MODIS must be the measured border count`);
    assert.equal(json.counts.total, measured, `${id}: the harmonized window total must be the measurement, not a model`);
  }
});

test('the calendar for a country adds back to its summary, and quiet borders print measured zeros', async () => {
  const { json } = await post('/area/calendar', { region_id: 'country-kenya', ...WINDOW });
  const rows = json.values;
  assert.equal(rows.length, 8, 'one row per window day');
  assert.ok(rows.every((r) => r.source === 'live'), 'no country day may stay modelled inside an observed window');
  const summary = await post('/area/summary', { region_id: 'country-kenya', ...WINDOW });
  assert.ok(Math.abs(rows.reduce((s, v) => s + v.value, 0) - summary.json.counts.total) < 1e-9, 'calendar and headline must tie out');
  const quiet = await post('/area/calendar', { region_id: 'country-antarctica', ...WINDOW });
  assert.equal(quiet.json.values.reduce((s, v) => s + v.value, 0), 0, 'Antarctica must print its measured zero, not a pilot average');
});

test('an unknown country id is refused with the coverage hint, and a pilot number does not move', async () => {
  const { res, json } = await post('/area/summary', { region_id: 'country-atlantis' });
  assert.equal(res.status, 422);
  assert.equal(json.error.code, 'OUT_OF_COVERAGE');
  assert.match(json.error.hint, /country-<id>/, 'the hint must teach the caller the country id form');
  // The in-app reference for a pilot area, computed with the world layer installed, must equal what
  // the HTTP route returns: registering 241 borders cannot change an area that has its own pull.
  const A = await import(pathToFileURL(path.join(ROOT, 'dist-server', 'analytics.mjs')).href);
  const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'live_fires.json'), 'utf8'));
  A.attachClimate(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'climate_daily.json'), 'utf8')));
  A.hydrateWorldLayer(
    JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'countries.json'), 'utf8')),
    BORDER,
  );
  A.installWorldLayer();
  try {
    const region = A.getRegion('california');
    const expected = A.recordsInRange(A.regionRecord(region, live), WINDOW.start, WINDOW.end).reduce((s, r) => s + r.harmonized, 0);
    const { json: j2 } = await post('/area/summary', { region_id: 'california', ...WINDOW });
    assert.ok(Math.abs(j2.counts.total - expected) < 0.05, `pilot area with the world layer installed: API ${j2.counts.total} vs in-app ${expected}`);
    assert.equal(j2.area_resolution, 'pilot region');
  } finally {
    A.uninstallWorldLayer();
  }
});

// Declared last on purpose: it deliberately exhausts the class-B minute bucket.
test('rate limiting answers with Retry-After once the class cap is hit', async () => {
  let limited = 0;
  for (let i = 0; i < 90; i++) {
    const res = await fetch(`${BASE}/api/v1/area/bias`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ region_id: 'chilecito' }) });
    await res.text().catch(() => '');
    if (res.status === 429) {
      limited++;
      assert.ok(res.headers.get('retry-after'), '429 must carry Retry-After');
      break;
    }
  }
  assert.ok(limited > 0, 'class B must limit at 60/min');
});
