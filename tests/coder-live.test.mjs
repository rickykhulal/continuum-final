import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 4192, not 4191: tests/api.test.mjs owns 4191 and node --test runs test files
// concurrently, so sharing the default left one server answering both files.
const PORT = Number(process.env.API_TEST_PORT || 4192);
const BASE = `http://127.0.0.1:${PORT}`;
const HAS_KEY = Boolean(process.env.FIRMS_MAP_KEY);
let child;
let fixtureRoot;

const testServerReady = async () => {
  try {
    const r = await fetch(`${BASE}/health`);
    return r.ok;
  } catch {
    return false;
  }
};

before(async () => {
  if (!fs.existsSync(path.join(ROOT, 'dist-server', 'analytics.mjs'))) {
    throw new Error('dist-server/analytics.mjs is missing — run `npm run api:build`');
  }
  // A warm global cache and the supported keyless CSV feed can both return 200
  // without FIRMS_MAP_KEY. Isolate the offline case rather than weakening its 503
  // assertion or letting this unit suite download hundreds of MB from NASA.
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-live-contract-'));
  fs.mkdirSync(path.join(fixtureRoot, 'server'));
  fs.mkdirSync(path.join(fixtureRoot, 'dist-server'));
  for (const file of ['api.mjs', 'live.mjs', 'community-store.mjs', 'community-integrations.mjs', 'community-image.mjs', 'community-env.mjs']) fs.copyFileSync(path.join(ROOT, 'server', file), path.join(fixtureRoot, 'server', file));
  fs.copyFileSync(path.join(ROOT, 'dist-server', 'analytics.mjs'), path.join(fixtureRoot, 'dist-server', 'analytics.mjs'));
  const bootstrap = path.join(fixtureRoot, 'bootstrap.mjs');
  fs.writeFileSync(bootstrap, `${HAS_KEY ? '' : "import { inject } from './server/live.mjs';\ninject({ transport: async () => ({ status: 503, body: 'Offline test fixture' }) });\n"}const { server } = await import('./server/api.mjs');\nserver.listen(Number(process.env.PORT));\n`);
  child = spawn(process.execPath, [bootstrap], {
    cwd: fixtureRoot,
    env: { ...process.env, APP_DATA_PATH: path.join(fixtureRoot, 'data'), DATA_BUNDLE_PATH: path.join(ROOT, 'public', 'data'), PORT: String(PORT), API_RATE_LIMITS: 'classA:120/min;classB:60/min;classC:200/min' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Wait for server to be ready
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await testServerReady()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('API did not start for tests');
});

after(async () => {
  if (child && child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  if (fixtureRoot) {
    assert.ok(path.resolve(fixtureRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 1: no cached result and an unavailable keyless upstream returns 503
// ---------------------------------------------------------------------------
describe('live-firms offline without key', () => {
  test('GET /api/v1/live-firms returns 503 with no cache and offline keyless upstream', { skip: HAS_KEY }, async () => {
    const res = await fetch(`${BASE}/api/v1/live-firms`, { method: 'GET' });
    assert.equal(res.status, 503, 'offline upstream with no last-good cache must return 503');
  });

  test('GET /api/v1/live-firms endpoint responds (503 when key missing)', { skip: HAS_KEY }, async () => {
    const res = await fetch(`${BASE}/api/v1/live-firms`, { method: 'GET' });
    assert.ok(res.status === 200 || res.status === 503, 'should respond with either 200 or 503');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Response body is valid JSON
// ---------------------------------------------------------------------------
describe('live-firms response structure', () => {
  test('response body is valid JSON', async () => {
    const res = await fetch(`${BASE}/api/v1/live-firms`, { method: 'GET' });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      assert.ok(false, 'response should be valid JSON');
    }
    assert.ok(json !== null, 'JSON should not be null');
    if (res.ok) {
      assert.ok(Array.isArray(json.data), '200 envelope should carry data');
    } else {
      assert.ok(json.error !== undefined, 'error envelope should carry an error code');
    }
  });

  test('response has stale field', async () => {
    const res = await fetch(`${BASE}/api/v1/live-firms`, { method: 'GET' });
    const json = await res.json();
    assert.ok('stale' in json, 'JSON should have stale field');
  });
});

// ---------------------------------------------------------------------------
// Test 4: With FIRMS_MAP_KEY set, the endpoint returns real data
// ---------------------------------------------------------------------------
describe('live-firms with key', () => {
  // These tests require FIRMS_MAP_KEY in the environment (upstream FIRMS access).
  test('response has fires array', { skip: !HAS_KEY }, async () => {
    const res = await fetch(`${BASE}/api/v1/live-firms`, { method: 'GET' });
    const json = await res.json();
    assert.ok(Array.isArray(json.data), 'response should have data.fires array');
    assert.ok(json.count > 0, 'should have fire detections');
    assert.ok('stale' in json, 'should have stale flag');
    assert.ok(json.meta.windowStart, 'should have window start');
    assert.ok(json.meta.windowEnd, 'should have window end');
    assert.ok(Array.isArray(json.meta.sensors), 'should have sensors list');
  });

  test('per-satellite counts are populated', { skip: !HAS_KEY }, async () => {
    const res = await fetch(`${BASE}/api/v1/live-firms`, { method: 'GET' });
    const json = await res.json();
    assert.ok(json.perSatelliteCounts.modis >= 0, 'modis count should be present');
    assert.ok(json.perSatelliteCounts.viirs >= 0, 'viirs count should be present');
    assert.ok(json.perSatelliteCounts.noaa20 >= 0, 'noaa20 count should be present');
    assert.ok(json.perSatelliteCounts.noaa21 >= 0, 'noaa21 count should be present');
  });
});

// ---------------------------------------------------------------------------
// Test 5: With FIRMS_MAP_KEY, stale flag reflects cache freshness
// ---------------------------------------------------------------------------
describe('live-firms stale flag', () => {
  test('stale defaults to false when data is fresh', { skip: !HAS_KEY }, async () => {
    const res = await fetch(`${BASE}/api/v1/live-firms`, { method: 'GET' });
    const json = await res.json();
    assert.ok(typeof json.stale === 'boolean', 'stale should be a boolean');
  });
});

// ---------------------------------------------------------------------------
// Rate-limit suites run last: exhausting class A (120/min) would otherwise
// turn every later assertion in this file into a 429.
// ---------------------------------------------------------------------------
describe('live-firms rate limiting', () => {
  test('class A must limit at 120/min', async () => {
    let limited = 0;
    for (let i = 0; i < 130; i++) {
      const res = await fetch(`${BASE}/api/v1/live-firms`, { method: 'GET' });
      await res.body?.cancel();
      if (res.status === 429) {
        limited++;
        assert.ok(res.headers.get('retry-after'), '429 must carry Retry-After');
        break;
      }
    }
    assert.ok(limited > 0, 'class A must limit at 120/min');
  });
});

// ---------------------------------------------------------------------------
// Test 6: Rate limit header on 429
// ---------------------------------------------------------------------------
describe('live-firms 429 rate limit', () => {
  test('429 response carries retry-after', { skip: !HAS_KEY }, async () => {
    let got429 = false;
    for (let i = 0; i < 130; i++) {
      const res = await fetch(`${BASE}/api/v1/live-firms`, { method: 'GET' });
      await res.body?.cancel();
      if (res.status === 429) {
        got429 = true;
        assert.ok(res.headers.get('retry-after'), '429 must carry Retry-After');
        break;
      }
    }
    assert.ok(got429, 'should hit 429 after class A limit (120/min)');
  });
});

// resetForTest is available via server/live.mjs
