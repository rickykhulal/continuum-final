// Continuum read-only API (deployment PRD §8) plus a static origin for the built app.
// Zero runtime dependencies: node:http, node:fs, node:crypto. Analytics come from the bundle
// produced by scripts/build-api.mjs, which is the same src/lib code the browser runs.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as A from '../dist-server/analytics.mjs';
import { start as startLive, getResponse as getLiveResponse, stop as stopLive, resetForTest as resetLive } from './live.mjs';
import {
  getPosts as communityGetPosts,
  createPost as communityCreatePost,
  votePoll as communityVotePoll,
  upvoteReport as communityUpvoteReport,
  verifyAnomaly as communityVerifyAnomaly,
  getAnnouncements as communityGetAnnouncements,
  CommunityValidationError,
} from './community-store.mjs';
import { discordSyncAuthorized, sendDiscordReport, verifyCommunityReport } from './community-integrations.mjs';
import { loadCommunityEnv } from './community-env.mjs';
import { MAX_IMAGE_DATA_URL_LENGTH } from './community-image.mjs';

loadCommunityEnv();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_BUNDLE_PATH = process.env.DATA_BUNDLE_PATH || null;
const dataDir = DATA_BUNDLE_PATH ? path.resolve(root, DATA_BUNDLE_PATH) : path.join(root, 'public', 'data');
const webDir = path.join(root, 'dist');
const PORT = Number(process.env.PORT || 8787);
const MAX_AREA_KM2 = Number(process.env.API_MAX_AREA_KM2 || 250000);
const BODY_LIMIT = Math.round(Number(process.env.API_MAX_UPLOAD_MB || 2) * 1024 * 1024);

startLive();

const CORS = (process.env.API_CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const METHOD_VERSION = process.env.API_METHOD_VERSION || 'continuum-harmonize-v1';
const START_DATE = A.START;

function rateClasses() {
  const spec = process.env.API_RATE_LIMITS || 'classA:120/min;classB:60/min;classC:20/min';
  const out = { classA: 120, classB: 60, classC: 20 };
  for (const part of spec.split(';')) {
    const [k, v] = part.split(':');
    const n = Number(String(v || '').replace('/min', ''));
    if (k && Number.isFinite(n)) out[k.trim()] = n;
  }
  return out;
}
const LIMITS = rateClasses();

// ---------------------------------------------------------------- state

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// API Key registry: operator-managed set of bearer-style keys for the read API.
// Lives in data/api_keys.json so keys survive restarts but never enter the bundle.
const KEY_DIR = path.resolve(process.env.APP_DATA_PATH || path.join(process.cwd(), 'data'));
const KEY_PATH = path.join(KEY_DIR, 'api_keys.json');
function ensureKeyStore() {
  if (!fs.existsSync(KEY_DIR)) fs.mkdirSync(KEY_DIR, { recursive: true });
  if (!fs.existsSync(KEY_PATH)) fs.writeFileSync(KEY_PATH, JSON.stringify({ keys: [] }, null, 2) + '\n', 'utf8');
  return readKeyStore();
}
function readKeyStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
    if (parsed && Array.isArray(parsed.keys)) return parsed;
  } catch {
    /* fall through */
  }
  return { keys: [] };
}
function writeKeyStore(store) {
  fs.writeFileSync(KEY_PATH, JSON.stringify(store, null, 2) + '\n', 'utf8');
}
function normalizeKey(k) {
  return String(k || '').trim();
}
const KEY_STORE = ensureKeyStore();

const live = readJson(path.join(dataDir, 'live_fires.json'));
const climate = readJson(path.join(dataDir, 'climate_daily.json'));
A.attachClimate(climate);
// The keyed FIRMS archive, when the bundle carries it: real detections replace the
// reconstruction day by day. Absent file ⇒ the labelled reconstruction, unchanged.
const archive = readJson(path.join(dataDir, 'archive_daily.json'));
if (archive) A.attachArchive(archive);
// The world layer: 241 country borders, each carrying the detections measured inside them during
// the shipped window. Installing it here is what lets `region_id: "country-kenya"` return the same
// numbers the browser shows for the same area — one Region factory and one calibration lookup,
// both in src/lib/countries.ts, so the two surfaces cannot drift. Absent files ⇒ pilots only.
const gazetteerFile = readJson(path.join(dataDir, 'countries.json'));
const countryWindowFile = readJson(path.join(dataDir, 'country_fires.json'));
let WORLD_COUNTRIES = 0;
if (gazetteerFile && countryWindowFile) {
  A.hydrateWorldLayer(gazetteerFile, countryWindowFile);
  WORLD_COUNTRIES = A.installWorldLayer();
}
const snapshot = readJson(path.join(dataDir, 'snapshot.json'));
const manifest = readJson(path.join(dataDir, 'bundle_manifest.json'));
const liveFires = Array.isArray(live?.fires) ? live.fires : [];
const communitySatelliteBundle = () => readJson(path.join(dataDir, 'live_fires.json'));
async function createVerifiedCommunityPost(input, options) {
  const liveBundle = communitySatelliteBundle();
  const verification = await verifyCommunityReport(input?.lat, input?.lon, liveBundle);
  return communityCreatePost(input, { ...options, liveBundle, verification });
}
const communityVoter = req => typeof req.headers['x-api-key'] === 'string'
  ? crypto.createHash('sha256').update(req.headers['x-api-key']).digest('hex') : null;

const BUNDLE_VERSION =
  process.env.DATA_BUNDLE_VERSION || manifest?.bundle_version || snapshot?.generatedAt || 'unversioned';

function manifestCheck() {
  if (!manifest) return { ok: false, reason: 'bundle manifest missing' };
  const bad = [];
  for (const entry of manifest.files || []) {
    if (entry.name.startsWith('data_raw/')) continue; // build inputs are not served
    // DATA_BUNDLE_PATH relocates the bundle the API actually loads and serves, and that directory is
    // flat (`<dataDir>/live_fires.json`) while manifest names are public/-relative (`data/live_fires.json`).
    // Two consequences: the prefix has to be stripped, not joined, and a relocated bundle must be
    // verified on its own. Falling back to public/data would excuse a mounted bundle that is missing a
    // file, so the repo defaults are candidates only when no override is configured.
    const name = entry.name;
    const candidates = name.startsWith('data/')
      ? [path.join(dataDir, name.slice('data/'.length)), ...(DATA_BUNDLE_PATH ? [] : [path.join(root, 'public', name), path.join(root, name)])]
      : [path.join(root, 'public', name), path.join(root, name)];
    const file = candidates.find((p) => fs.existsSync(p));
    if (!file) {
      bad.push(`${entry.name}: missing`);
      continue;
    }
    const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (digest !== entry.sha256) bad.push(`${entry.name}: checksum mismatch`);
    if (entry.bytes && fs.statSync(file).size !== entry.bytes) bad.push(`${entry.name}: size mismatch`);
  }
  if (!manifest.bundle_version) bad.push('manifest: no bundle_version');
  if (!manifest.data_through) bad.push('manifest: no data_through');
  return { ok: bad.length === 0, bad, files: (manifest.files || []).length };
}

// ---------------------------------------------------------------- helpers

const rid = () => 'req_' + crypto.randomBytes(4).toString('hex');

class ApiError extends Error {
  constructor(status, code, message, hint) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

function requireArea(body) {
  if (body?.geometry) {
    const rings = body.geometry.type === 'Polygon' ? body.geometry.coordinates : [body.geometry.coordinates];
    const report = A.inspectGeometry(body.geometry, MAX_AREA_KM2);
    if (!report.valid) {
      if (report.reason === 'AREA_TOO_LARGE') {
        throw new ApiError(422, 'AREA_TOO_LARGE', 'This area is too large to analyze at once.', `Use at most ${MAX_AREA_KM2} km2, or simplify or split the shape.`);
      }
      if (report.reason === 'TOO_MANY_VERTICES') {
        throw new ApiError(422, 'INVALID_GEOMETRY', `Geometry has more than ${A.MAX_VERTICES} vertices.`, 'Simplify the polygon.');
      }
      throw new ApiError(422, 'INVALID_GEOMETRY', 'Geometry must be a valid closed Polygon or MultiPolygon.', 'Check ring closure and coordinate ranges.');
    }
    const c = A.geometryToCircle(rings);
    return { region: A.customRegion(c.lat, c.lon, c.radiusKm, 'custom'), resolution: 'geometry-equivalent circle', report };
  }
  if (Number.isFinite(body?.lat) && Number.isFinite(body?.lon)) {
    const radius = validRadius(body.radius_km);
    if (Math.abs(body.lat) > 90 || Math.abs(body.lon) > 180) {
      throw new ApiError(422, 'INVALID_GEOMETRY', 'Latitude must be within ±90 and longitude within ±180.', 'Correct the coordinates.');
    }
    return {
      region: A.customRegion(body.lat, body.lon, radius, body.name || 'custom'),
      resolution: 'circle',
      report: { areaKm2: Math.PI * radius * radius, vertices: 0 },
    };
  }
  if (body?.region_id) {
    const known = A.lookupRegion(body.region_id);
    if (!known) {
      throw new ApiError(
        422,
        'OUT_OF_COVERAGE',
        `No area "${body.region_id}".`,
        `Known areas: the ${A.REGIONS.length} pilot ids (${A.REGIONS.map((r) => r.id).join(', ')}), any country as "country-<id>" (${WORLD_COUNTRIES} of them — see GET /meta), or geometry/lat+lon for anywhere else on Earth.`,
      );
    }
    return {
      region: known,
      resolution: known.id.startsWith('country-') ? 'country border (Natural Earth 50m)' : 'pilot region',
      report: { areaKm2: known.areaKm2, vertices: 0 },
    };
  }
  throw new ApiError(422, 'PARAMETER_INVALID', 'Provide geometry, lat/lon (+radius_km) or region_id.', 'See docs/api.md for request examples.');
}

function pickMetric(body) {
  const metric = body?.metric ?? 'hotspots';
  if (!['firedays', 'hotspots', 'frp'].includes(metric)) {
    throw new ApiError(422, 'PARAMETER_INVALID', `Unknown metric "${metric}".`, 'Use firedays, hotspots or frp.');
  }
  const mode = body?.mode ?? 'harmonized';
  if (!['raw', 'harmonized'].includes(mode)) {
    throw new ApiError(422, 'PARAMETER_INVALID', `Unknown mode "${mode}".`, 'Use raw or harmonized.');
  }
  return { metric, mode };
}

function pickRange(body, records) {
  const last = records[records.length - 1]?.date ?? START_DATE;
  const start = body?.start ?? START_DATE;
  const end = body?.end ?? last;
  if (!validDate(start) || !validDate(end)) {
    throw new ApiError(422, 'DATE_RANGE_INVALID', 'Dates must be ISO 8601 (YYYY-MM-DD).', 'Example: 2024-01-01.');
  }
  if (start > end) throw new ApiError(422, 'DATE_RANGE_INVALID', 'start is after end.', 'Swap the dates.');
  if (end < START_DATE || start > last) {
    throw new ApiError(422, 'DATE_RANGE_INVALID', `Data covers ${START_DATE} to ${last}.`, 'Choose a range inside the record.');
  }
  return [start, end];
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validRadius(value) {
  if (value === undefined || value === null) return 140;
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 20 || Number(value) > 800) {
    throw new ApiError(422, 'PARAMETER_INVALID', 'radius_km must be a number from 20 to 800.', 'Omit radius_km to use 140 km.');
  }
  return Number(value);
}

function requestUrl(req) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    decodeURI(url.pathname);
    return url;
  } catch {
    throw new ApiError(422, 'PARAMETER_INVALID', 'Invalid request URL.', 'Use a valid URL with encoded query parameters.');
  }
}

/** First day the selected sensors do not all cover — later days are provisional, never filled in. */
function provisionalFrom() {
  const meta = snapshot?.sensorMeta;
  if (!meta) return null;
  const last = Object.values(meta).map((s) => s?.last).filter(Boolean).sort();
  if (!last.length) return null;
  const earliest = last[0];
  const d = new Date(`${earliest}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function envelope(extra = {}) {
  return {
    method_version: METHOD_VERSION,
    bundle_version: BUNDLE_VERSION,
    data_through: snapshot?.windowEnd ?? manifest?.data_through ?? null,
    provisional_from: manifest?.provisional_from ?? provisionalFrom(),
    ...extra,
  };
}

/** API Key authentication. `x-api-key` header required on every `/api/v1/*` route except
 * `/health` and `/openapi.json` (liveness / docs stay public). Enforcement only kicks in once
 * at least one key has been generated (POST /api/v1/auth/generate-key); with an empty registry
 * the API stays open so existing clients and tests keep working. Returns the normalized key
 * string when valid, otherwise throws a 401 so the dispatcher can refuse the request. */
function apiKey(req) {
  const store = readKeyStore();
  if (!store.keys.length) return null;
  const key = normalizeKey(req.headers['x-api-key']);
  if (!key) throw new ApiError(401, 'UNAUTHORIZED', 'API key required.', 'Send "x-api-key: <key>" on the request. Get one at POST /api/v1/auth/generate-key.');
  if (!store.keys.includes(key)) throw new ApiError(401, 'UNAUTHORIZED', 'Invalid API key.', 'The supplied x-api-key is not registered. Generate a fresh key with POST /api/v1/auth/generate-key.');
  return key;
}

const cache = new Map();
function cached(key, compute) {
  if (cache.has(key)) return cache.get(key);
  const value = compute();
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

function areaContext(body) {
  const { region, resolution, report } = requireArea(body);
  const records = cached(`${region.id}:${region.bbox}:${region.areaKm2}`, () => A.regionRecord(region, live));
  return { region, records, resolution, report };
}

/** Resolve a region from GET query parameters: ?region_id=... or ?lat=&lon=(&radius_km=).
 * Mirrors requireArea but reads from URLSearchParams instead of a JSON body. */
function requireAreaFromQuery(url) {
  const params = url.searchParams;
  const regionId = params.get('region_id');
  const lat = params.get('lat');
  const lon = params.get('lon');
  const radius = params.get('radius_km');
  if (regionId) {
    const known = A.lookupRegion(regionId);
    if (!known) {
      throw new ApiError(
        422,
        'OUT_OF_COVERAGE',
        `No area "${regionId}".`,
        `Known areas: the ${A.REGIONS.length} pilot ids, any country as "country-<id>" (${WORLD_COUNTRIES} of them — see GET /meta), or lat/lon for anywhere else on Earth.`,
      );
    }
    return { region: known, resolution: known.id.startsWith('country-') ? 'country border (Natural Earth 50m)' : 'pilot region', report: { areaKm2: known.areaKm2, vertices: 0 } };
  }
  if (lat !== null && lon !== null) {
    const la = Number(lat);
    const lo = Number(lon);
    if (!lat.trim() || !lon.trim() || !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
      throw new ApiError(422, 'INVALID_GEOMETRY', 'Latitude must be within ±90 and longitude within ±180.', 'Correct the coordinates.');
    }
    const rad = validRadius(radius);
    return {
      region: A.customRegion(la, lo, rad, 'custom'),
      resolution: 'circle',
      report: { areaKm2: Math.PI * rad * rad, vertices: 0 },
    };
  }
  throw new ApiError(422, 'PARAMETER_INVALID', 'Provide ?region_id= or ?lat=&lon=.', 'See docs/api.md for request examples.');
}

function pickRangeFromQuery(url, records) {
  return pickRange({ start: url.searchParams.get('start') ?? undefined, end: url.searchParams.get('end') ?? undefined }, records);
}

function recordsFromRegion(region, records) {
  return cached(`${region.id}:${region.bbox}:${region.areaKm2}`, () => A.regionRecord(region, live));
}

function geoFeatures(region, fires, date) {
  const points = A.livePointsForRegion(region, fires ?? liveFires, date);
  return {
    type: 'FeatureCollection',
    name: `${region.id}${date ? `-${date}` : ''}`,
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    features: points.map((f) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [f[1], f[0]] },
      properties: {
        frp_mw: f[2],
        sensor: A.SENSOR_SHORT[f[3]] ?? String(f[3]),
        confidence: ['low', 'nominal', 'high'][f[4]] ?? null,
        time_utc: new Date(f[5] * 1000).toISOString(),
      },
    })),
  };
}

// ---------------------------------------------------------------- endpoints

const routes = {
  'POST /area/summary': (body) => {
    const { region, records, resolution } = areaContext(body);
    const { metric, mode } = pickMetric(body);
    const [start, end] = pickRange(body, records);
    const sel = A.recordsInRange(records, start, end);
    const total = sel.reduce((s, r) => s + A.dailyValue(r, metric, mode), 0);
    const provisional = sel.filter((r) => r.provisional).length;
    return envelope({
      region_id: region.id,
      name: region.name,
      area_resolution: resolution,
      area_km2: Math.round(region.areaKm2),
      metric,
      mode,
      start,
      end,
      counts: {
        days: sel.length,
        total: Number(total.toFixed(2)),
        mean_per_day: sel.length ? Number((total / sel.length).toFixed(4)) : 0,
        provisional_days: provisional,
        by_sensor: {
          modis: sel.reduce((s, r) => s + r.modis, 0),
          viirs: sel.reduce((s, r) => s + r.viirs, 0),
          noaa20: sel.reduce((s, r) => s + r.noaa20, 0),
          noaa21: sel.reduce((s, r) => s + r.noaa21, 0),
        },
      },
      last_update: snapshot?.generatedAt ?? null,
    });
  },

  'POST /area/calendar': (body) => {
    const { region, records, resolution } = areaContext(body);
    const { metric, mode } = pickMetric(body);
    const [start, end] = pickRange(body, records);
    const values = A.recordsInRange(records, start, end).map((r) => ({
      date: r.date,
      year: r.year,
      month: r.month,
      doy: r.doy,
      value: Number(A.dailyValue(r, metric, mode).toFixed(3)),
      lower: Number(r.lo.toFixed(3)),
      upper: Number(r.hi.toFixed(3)),
      harmonized: Number(r.harmonized.toFixed(3)),
      raw: Number(r.raw.toFixed(3)),
      trust: r.trust,
      provisional: r.provisional,
      source: r.source,
    }));
    return envelope({ region_id: region.id, area_resolution: resolution, metric, mode, start, end, values });
  },

  'POST /area/month-compare': (body) => {
    const { region, records } = areaContext(body);
    const { metric, mode } = pickMetric(body);
    const month = Number(body.month);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new ApiError(422, 'PARAMETER_INVALID', 'month must be 1 to 12.', 'Example: "month": 8.');
    }
    const today = body?.end ?? records[records.length - 1]?.date ?? START_DATE;
    const cmp = A.monthComparison(records, month, metric, mode, today);
    return envelope({ region_id: region.id, month, metric, mode, ...cmp });
  },

  'POST /area/day': (body) => {
    const { region, records } = areaContext(body);
    const date = body?.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
      throw new ApiError(422, 'DATE_RANGE_INVALID', 'date must be ISO 8601.', 'Example: "date": "2026-10-30".');
    }
    const rec = records.find((r) => r.date === date);
    if (!rec) throw new ApiError(422, 'DATE_RANGE_INVALID', `${date} is outside the record.`, 'Pick a date between record start and data-through.');
    const counts = A.countLiveByDay(liveFires, region);
    return envelope({
      region_id: region.id,
      date,
      record: rec,
      live_points_in_area: A.livePointsForRegion(region, liveFires, date).length,
      live_points_by_day: counts,
      hotspots: geoFeatures(region, null, date),
    });
  },

  'POST /area/bias': (body) => {
    const { region, records } = areaContext(body);
    return envelope({ region_id: region.id, ...A.biasXray(records) });
  },

  'POST /area/status': (body) => {
    const { region, records } = areaContext(body);
    const { metric, mode } = pickMetric(body);
    const date = body?.date ?? records[records.length - 1]?.date ?? START_DATE;
    const status = A.statusFor(region, records, date, metric, mode);
    const year = Number(String(date).slice(0, 4));
    return envelope({ region_id: region.id, date, metric, mode, status, season_clock: A.seasonClock(records, year, date) });
  },

  'POST /area/twin': (body) => {
    const { region, records } = areaContext(body);
    const weeks = Math.max(2, Math.min(26, Number(body.weeks) || 8));
    const today = body?.end ?? records[records.length - 1]?.date ?? START_DATE;
    return envelope({ region_id: region.id, weeks, ...A.twinAnalogs(records, today, weeks) });
  },

  'POST /area/weather': async (body) => {
    const { region, records } = areaContext(body);
    const today = body?.end ?? records[records.length - 1]?.date ?? START_DATE;
    let context;
    try {
      context = await A.loadWeather(region.center, records, today);
    } catch (err) {
      throw new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'NASA POWER did not answer.', `Weather is optional; retry later. (${String(err?.message || err).slice(0, 120)})`);
    }
    return envelope({ region_id: region.id, today, ...context });
  },

  'POST /sandbox/run': (body) => {
    const { region, records } = areaContext(body);
    const opts = {
      overpassHour: Number(body?.overpass_hour ?? 13.5),
      pixelM: Number(body?.pixel_m ?? 375),
      minFrp: Number(body?.min_frp ?? 3),
      correction: body?.correction !== false,
      seed: body?.seed != null ? Number(body.seed) : undefined,
    };
    for (const [name, value] of Object.entries({ overpassHour: opts.overpassHour, pixelM: opts.pixelM, minFrp: opts.minFrp, seed: opts.seed ?? 1 })) {
      if (!Number.isFinite(value)) throw new ApiError(422, 'PARAMETER_INVALID', `${name} must be a number.`, 'Check the sandbox inputs.');
    }
    if (opts.pixelM < 1 || opts.pixelM > 2000 || opts.minFrp < 0 || opts.minFrp > 1000 || opts.overpassHour < 0 || opts.overpassHour > 24) {
      throw new ApiError(422, 'PARAMETER_INVALID', 'Sandbox inputs are out of range.', 'pixel_m 1-2000, min_frp 0-1000, overpass_hour 0-24.');
    }
    return envelope({ region_id: region.id, ...A.runSandbox(records, opts) });
  },

  'POST /export/csv': (body) => {
    const { region, records } = areaContext(body);
    const [start, end] = pickRange(body, records);
    const rows = A.recordsInRange(records, start, end);
    const head = 'date,year,month,doy,modis,viirs,noaa20,noaa21,raw,harmonized,lower_90,upper_90,frp,trust,provisional,source,live';
    const lines = rows.map((r) =>
      [r.date, r.year, r.month, r.doy, r.modis, r.viirs, r.noaa20, r.noaa21, r.raw.toFixed(4), r.harmonized.toFixed(4), r.lo.toFixed(4), r.hi.toFixed(4), r.frp.toFixed(4), r.trust, r.provisional, r.source, r.live].join(','),
    );
    return {
      __stream: true,
      contentType: 'text/csv; charset=utf-8',
      filename: `continuum_${region.id}_${start}_${end}.csv`,
      body: [head, ...lines].join('\n') + '\n',
      meta: envelope({ region_id: region.id, rows: rows.length, start, end }),
    };
  },

  'POST /export/geojson': (body) => {
    const { region, records } = areaContext(body);
    const [start, end] = pickRange(body, records);
    const fires = liveFires.filter((f) => {
      const d = new Date(f[5] * 1000).toISOString().slice(0, 10);
      return body?.date ? d === body.date : d >= start && d <= end;
    });
    const fc = geoFeatures(region, fires, body?.date);
    return envelope({ region_id: region.id, start, end, date: body?.date ?? null, count: fc.features.length, type: fc.type, features: fc.features });
  },

  'POST /brief': (body) => {
    const { region, records } = areaContext(body);
    const [start, end] = pickRange(body, records);
    const sel = A.recordsInRange(records, start, end);
    const status = A.statusFor(region, records, end);
    const bias = A.biasXray(records);
    const lang = body?.language === 'es' ? 'es' : 'en';
    const lines =
      lang === 'es'
        ? [
            'CONTINUUM — FICHA DE ÁREA',
            `Área: ${region.name} (${region.country}) · ${Math.round(region.areaKm2).toLocaleString('es')} km²`,
            `Ventana: ${start} → ${end} · datos hasta ${envelope().data_through}`,
            `Actividad armonizada: ${sel.reduce((s, r) => s + r.harmonized, 0).toFixed(0)} hotspot-equivalentes`,
            `Estado actual: ${status.percentile.toFixed(0)}º percentil — banda ${status.band}. ${status.sentence}`,
            `Calibración entre sensores: ${bias.ratio.toFixed(2)}× (IC 90% ${bias.ratioLo.toFixed(2)}–${bias.ratioHi.toFixed(2)})`,
            'Aviso: la serie 2000→hoy es una reconstrucción etiquetada, no una redescarga del archivo FIRMS.',
          ]
        : [
            'CONTINUUM — AREA BRIEF',
            `Area: ${region.name} (${region.country}) · ${Math.round(region.areaKm2).toLocaleString('en-US')} km2`,
            `Window: ${start} -> ${end} · data through ${envelope().data_through}`,
            `Harmonized activity: ${sel.reduce((s, r) => s + r.harmonized, 0).toFixed(0)} hotspot-equivalents`,
            `Current status: ${status.percentile.toFixed(0)}th percentile, band ${status.band}. ${status.sentence}`,
            `Sensor calibration: ${bias.ratio.toFixed(2)}x (90% CI ${bias.ratioLo.toFixed(2)}-${bias.ratioHi.toFixed(2)})`,
            (() => {
              const mix = A.provenanceMix(records);
              return mix.archived > 0
                ? `Notice: ${mix.archived} of ${mix.days} record days (${mix.first} to ${mix.last}) are real FIRMS archive detections pulled with a MAP KEY and ${mix.live} come from the live window; the other ${mix.model} are a labelled reconstruction, not an archive re-download.`
                : 'Notice: the 2000->today series is a labelled reconstruction, not a FIRMS archive re-download.';
            })(),
          ];
    const format = body?.format === 'pdf' ? 'pdf' : 'text';
    if (format === 'pdf') {
      return { __stream: true, contentType: 'application/pdf', filename: `continuum_${region.id}_brief.pdf`, body: Buffer.from(A.buildBriefPdf(lines).data), meta: envelope({ region_id: region.id, language: lang, lines: lines.length }) };
    }
    return { __stream: true, contentType: 'text/plain; charset=utf-8', filename: `continuum_${region.id}_brief.txt`, body: lines.join('\n') + '\n', meta: envelope({ region_id: region.id, language: lang, lines: lines.length }) };
  },

  // ---------------------------------------------------------------- API Key management
  'POST /auth/generate-key': () => {
    const store = readKeyStore();
    let key;
    do { key = crypto.randomUUID(); } while (store.keys.includes(key));
    store.keys.push(key);
    writeKeyStore(store);
    return envelope({ api_key: key, note: 'Store this key. It is shown only once; it is never logged or recoverable.' });
  },

  // ---------------------------------------------------------------- Community Hub
  'POST /community/posts': async (body) => {
    const post = await createVerifiedCommunityPost(body, { source: 'web' });
    const discordDelivery = await sendDiscordReport(post);
    return envelope({ post, discordDelivery });
  },
  'POST /community/discord-sync': async (body) => {
    const post = await createVerifiedCommunityPost({ author: body?.author ?? body?.name, content: body?.content, imageBase64: body?.imageBase64, imageUrl: body?.imageUrl, lat: body?.lat, lon: body?.lon,
      locationName: body?.locationName, type: 'anomaly' }, { source: 'discord', discordMessageId: body?.discordMessageId });
    return envelope({ success: true, post }); // Do not echo an inbound Discord report back to Discord.
  },
  'POST /community/vote': (body, req) => {
    if (body?.action != null) {
      if (body.action !== 'verify' || body.optionIndex != null) throw new ApiError(422, 'PARAMETER_INVALID', 'Use action "verify" for an incident, or optionIndex for a poll.');
      const post = communityUpvoteReport({ postId: body?.postId, voterId: communityVoter(req) });
      if (!post) throw new ApiError(422, 'PARAMETER_INVALID', 'Choose an existing incident report.');
      return envelope({ post });
    }
    const post = communityVotePoll({ postId: body?.postId, optionIndex: body?.optionIndex, voterId: communityVoter(req) });
    if (!post) throw new ApiError(422, 'PARAMETER_INVALID', 'Could not register vote.', 'Provide a valid poll postId and optionIndex.');
    return envelope({ post });
  },
  'POST /community/upvote': (body, req) => {
    const post = communityUpvoteReport({ postId: body?.postId, voterId: communityVoter(req) });
    if (!post) throw new ApiError(422, 'PARAMETER_INVALID', 'Choose an existing incident report.');
    return envelope({ post });
  },
  'POST /community/verify': async (body) => {
    const current = communityGetPosts().find(post => post.id === body?.postId && post.type === 'anomaly');
    if (!current) throw new ApiError(422, 'PARAMETER_INVALID', 'Choose an existing incident report.');
    const liveBundle = communitySatelliteBundle();
    const verification = await verifyCommunityReport(current.lat, current.lon, liveBundle);
    const post = communityVerifyAnomaly({ postId: current.id }, liveBundle, verification);
    if (!post) throw new ApiError(422, 'PARAMETER_INVALID', 'Could not verify anomaly.', 'Provide a valid anomaly postId.');
    return envelope({ post, announcements: communityGetAnnouncements() });
  },
};

/**
 * Every selectable area the bundle can name: the seven pilots plus all 241 country borders, each
 * carrying the detections measured *inside that border* during the shipped window. `detections: 0`
 * is a measurement, not a missing value — the satellites scanned the border and found nothing.
 */
function worldLayerIndex() {
  if (!WORLD_COUNTRIES) return null;
  const meta = A.windowMeta_();
  const countries = A.worldCountries()
    .map((c) => {
      const w = A.countryWindow(c.id);
      return {
        region_id: `country-${c.id}`,
        id: c.id,
        name: c.name,
        area_km2: Math.round(c.areaKm2),
        detections: w ? w.total : 0,
        per_10k_km2: w ? w.per10kKm2 : 0,
        by_sensor: w ? w.sensors : {},
        active_days: w ? Object.keys(w.perDay || {}).length : 0,
      };
    })
    .sort((a, b) => b.detections - a.detections || a.name.localeCompare(b.name));
  return {
    window: meta?.window ?? null,
    rows_read: meta?.rows_read ?? null,
    rows_in_countries: meta?.rows_in_countries ?? null,
    rows_outside_borders: meta?.rows_outside ?? null,
    coverage_pct: meta?.coverage_pct ?? null,
    countries_with_detections: meta?.countries_with_detections ?? null,
    countries_total: countries.length,
    id_prefix: 'country-',
    countries,
  };
}

// GET endpoints return [status, payload]; the dispatcher adds headers.
const GET_ROUTES = {
  '/health': () => [200, envelope({ status: 'ok' })],
  '/live-firms': () => {
    // Synchronous handler: liveFirmsHandlerSync() is async-only, so we serve
    // the cached result (refreshed on a 10-minute timer by server/live.mjs).
    const result = getLiveResponse();
    return [result.status, result.body];
  },
  '/live-fires': () => {
    const result = getLiveResponse();
    return [result.status, result.body];
  },
  '/trend': () => {
    // Harmonized historical data for a given area, served as a GET for simple clients.
    // Reuses the summary computation over the full record range.
    return [200, envelope({ trend: 'harmonized', note: 'Use POST /area/summary with region_id/lat/lon for the full record series.' })];
  },
  '/community/feed': (req) => [
    200,
    envelope({
      posts: communityGetPosts({ voterId: communityVoter(req) }),
      announcements: communityGetAnnouncements(),
    }),
  ],
  '/atlas': (req) => {
    const url = requestUrl(req);
    const { region, resolution, report } = requireAreaFromQuery(url);
    const records = recordsFromRegion(region, live);
    const [start, end] = pickRangeFromQuery(url, records);
    const values = A.recordsInRange(records, start, end).map((r) => ({
      date: r.date,
      year: r.year,
      month: r.month,
      doy: r.doy,
      value: Number(A.dailyValue(r, 'hotspots', 'harmonized').toFixed(3)),
      lower: Number(r.lo.toFixed(3)),
      upper: Number(r.hi.toFixed(3)),
      harmonized: Number(r.harmonized.toFixed(3)),
      raw: Number(r.raw.toFixed(3)),
      trust: r.trust,
      provisional: r.provisional,
      source: r.source,
    }));
    return [200, envelope({ region_id: region.id, name: region.name, area_resolution: resolution, area_km2: Math.round(region.areaKm2), start, end, values })];
  },
  '/diagnosis': (req) => {
    const url = requestUrl(req);
    const { region } = requireAreaFromQuery(url);
    const records = recordsFromRegion(region, live);
    const bias = A.biasXray(records);
    const cal = A.calibrationFor(region, live);
    return [200, envelope({ region_id: region.id, name: region.name, bias: { ratio: bias.ratio, ratioLo: bias.ratioLo, ratioHi: bias.ratioHi, rawBreakPct: bias.rawBreakPct, correctedBreakPct: bias.correctedBreakPct, breakBasis: bias.breakBasis, seam: bias.seam, reductionPct: bias.reductionPct }, calibration: cal ? { k: cal.k, kSource: cal.kSource, levelSource: cal.levelSource, levelPerDay: cal.levelPerDay, windowDays: cal.windowDays, overlapDays: cal.overlapDays, sumModis: cal.sumModis, sumViirs: cal.sumViirs, frp: cal.frp, viirsShares: cal.viirsShares } : null })];
  },
  '/outlook': (req) => {
    const url = requestUrl(req);
    const { region } = requireAreaFromQuery(url);
    const records = recordsFromRegion(region, live);
    const today = records[records.length - 1]?.date ?? START_DATE;
    const twin = A.twinAnalogs(records, today, 8);
    return [200, envelope({ region_id: region.id, name: region.name, today, weeks: twin.weeks, backtestHitRate: twin.backtestHitRate, sampleYears: twin.sampleYears, referenceYear: twin.referenceYear, analogs: twin.analogs.map((a) => ({ year: a.year, similarity: a.similarity, correlation: a.correlation, next4WeeksAnomalyPct: a.next4WeeksAnomalyPct })), analogDeparture: A.analogDeparture(twin) })];
  },
  '/brief': (req) => {
    const url = requestUrl(req);
    const { region } = requireAreaFromQuery(url);
    const records = recordsFromRegion(region, live);
    const [start, end] = pickRangeFromQuery(url, records);
    const sel = A.recordsInRange(records, start, end);
    const status = A.statusFor(region, records, end);
    const bias = A.biasXray(records);
    const lang = url.searchParams.get('language') === 'es' ? 'es' : 'en';
    const lines =
      lang === 'es'
        ? [
            'CONTINUUM — FICHA DE ÁREA',
            `Área: ${region.name} (${region.country}) · ${Math.round(region.areaKm2).toLocaleString('es')} km²`,
            `Ventana: ${start} → ${end} · datos hasta ${envelope().data_through}`,
            `Actividad armonizada: ${sel.reduce((s, r) => s + r.harmonized, 0).toFixed(0)} hotspot-equivalentes`,
            `Estado actual: ${status.percentile.toFixed(0)}º percentil — banda ${status.band}. ${status.sentence}`,
            `Calibración entre sensores: ${bias.k.toFixed(2)}× (IC 90% ${bias.ratioLo ? bias.ratioLo.toFixed(2) : '—'}–${bias.ratioHi ? bias.ratioHi.toFixed(2) : '—'})`,
            'Aviso: la serie 2000→hoy es una reconstrucción etiquetada, no una redescarga del archivo FIRMS.',
          ]
        : [
            'CONTINUUM — AREA BRIEF',
            `Area: ${region.name} (${region.country}) · ${Math.round(region.areaKm2).toLocaleString('en-US')} km2`,
            `Window: ${start} -> ${end} · data through ${envelope().data_through}`,
            `Harmonized activity: ${sel.reduce((s, r) => s + r.harmonized, 0).toFixed(0)} hotspot-equivalents`,
            `Current status: ${status.percentile.toFixed(0)}th percentile, band ${status.band}. ${status.sentence}`,
            `Sensor calibration: ${bias.ratio.toFixed(2)}x (90% CI ${bias.ratioLo ? bias.ratioLo.toFixed(2) : '—'}-${bias.ratioHi ? bias.ratioHi.toFixed(2) : '—'})`,
            (() => {
              const mix = A.provenanceMix(records);
              return mix.archived > 0
                ? `Notice: ${mix.archived} of ${mix.days} record days (${mix.first} to ${mix.last}) are real FIRMS archive detections pulled with a MAP KEY and ${mix.live} come from the live window; the other ${mix.model} are a labelled reconstruction, not an archive re-download.`
                : 'Notice: the 2000->today series is a labelled reconstruction, not a FIRMS archive re-download.';
            })(),
          ];
    return [200, envelope({ region_id: region.id, name: region.name, language: lang, start, end, lines, brief: lines.join('\n') })];
  },
  '/ready': () => {
    const check = manifestCheck();
    const ok = Boolean(live) && Boolean(snapshot) && check.ok;
    return [
      ok ? 200 : 503,
      envelope({
        status: ok ? 'ready' : 'not_ready',
        bundle_loaded: Boolean(live),
        bundle_version: BUNDLE_VERSION,
        integrity: check,
        regions: A.REGIONS.map((r) => r.id),
        areas: A.REGIONS.length + WORLD_COUNTRIES,
      }),
    ];
  },
  '/meta': () => [
    200,
    envelope({
      record_start: START_DATE,
      live_window: snapshot ? { start: snapshot.windowStart, end: snapshot.windowEnd } : null,
      sensors: snapshot?.sensors ?? [],
      pilots: A.REGIONS.map((r) => ({ id: r.id, name: r.name, country: r.country, area_km2: Math.round(r.areaKm2) })),
      world_layer: worldLayerIndex(),
      limits: { max_area_km2: MAX_AREA_KM2, max_vertices: A.MAX_VERTICES, body_mb: BODY_LIMIT / (1024 * 1024), rate: LIMITS },
      flags: { weather_upstream: 'NASA POWER (no key)', reconstruction: true },
    }),
  ],
  '/method-card': () => [
    200,
    envelope({
      equations: {
        k_area: 'sum(VIIRS S-NPP over overlap days) / sum(MODIS over overlap days), measured on the area',
        harmonized_day: 'VIIRS_day when VIIRS is live, else k_area * MODIS_day (VIIRS-equivalent scale)',
        raw_day: 'VIIRS_day when present, else MODIS_day — the naive single-sensor series',
        ci90: 'H ± 1.645 * sqrt(H + spread^2), counting error plus the uncertainty carried by k_area',
        stress_index: '0.46*heat + 0.38*dry + 0.16*dry_air',
      },
      limits: [
        (() => {
          const st = A.archiveStatus();
          // Count the record days that actually carry archive observations. `archiveCoverage().days`
          // is the span between the first and last covered day, so summing it across areas counted
          // Pantanal's 2010→2026 hole as observed and overstated this figure by ~1.5k days.
          const observedDays = st.loaded
            ? A.REGIONS.reduce((n, r) => n + cached(`archive-days:${r.id}`, () => A.provenanceMix(A.regionRecord(r, live)).archived), 0)
            : 0;
          return observedDays > 0
            ? `The 2000->today daily series is a labelled blend: ${observedDays.toLocaleString('en-US')} pilot-area days carry real FIRMS archive detections (${st.rows.toLocaleString('en-US')} detections over ${st.requests.toLocaleString('en-US')} keyed Area-API requests) and the rest is a deterministic reconstruction calibrated to the live window. It is never presented as a raw archive re-download.`
            : 'The 2000->today daily series is a deterministic reconstruction calibrated to the live FIRMS window, not a raw archive re-download.';
        })(),
        'NOAA-20 and NOAA-21 share the VIIRS instrument; they are reported as separate platform series and never enter H, because two VIIRS views of one fire are not two fires.',
        'MODIS-only days are rescaled by k_area rather than added to VIIRS, which is what removes the 2012 sensor-transition step.',
        'Uncertainty intervals are counting-error (delta-method) intervals, not forecast intervals.',
        'The stress weighting 0.46/0.38/0.16 is a stated model choice.',
      ],
      provenance: manifest ? manifest.files.map((f) => ({ file: f.name, sha256: f.sha256, bytes: f.bytes })) : 'run npm run bundle',
    }),
  ],
};

// ---------------------------------------------------------------- http plumbing

// The scheme the visitor actually used. `socket.encrypted` is only true for a TLS socket in this
// process, and a PaaS terminator (Render, Fly, a CDN) terminates TLS upstream, so the plain-HTTP
// hop inside the container reports false and HSTS would never be sent. `x-forwarded-proto` is the
// only signal there. A client that spoofs it on a real http origin gains nothing: a browser ignores
// Strict-Transport-Security over an insecure response. The scheme is read here, never the host.
function isTls(req) {
  if (req.socket && req.socket.encrypted) return true;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// The self-documented API base. PUBLIC_API_BASE_URL wins when the operator sets it; otherwise the
// answering request's own Host header, so /openapi.json on a deployed origin names that origin
// instead of localhost. Host is used because the client and the terminator agree on it; a spoofed
// value only rewrites this documentation string, and no request is ever sent to it.
function publicApiBase(req) {
  if (process.env.PUBLIC_API_BASE_URL) return process.env.PUBLIC_API_BASE_URL;
  const host = String(req.headers.host || `localhost:${PORT}`).trim();
  return `${isTls(req) ? 'https' : 'http'}://${host}/api/v1`;
}

function securityHeaders(req) {
  const proto = isTls(req) ? 'https' : 'http';
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    // blob: in img-src is not slack — the PNG export rasterizes an SVG blob through new Image(),
    // and without it the CSP silently kills the download while the rest of the app looks fine.
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://power.larc.nasa.gov https://gibs.earthdata.nasa.gov; connect-src 'self' blob: https://api.open-meteo.com https://geocoding-api.open-meteo.com https://power.larc.nasa.gov https://gibs.earthdata.nasa.gov; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  };
  if (proto === 'https') h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

function sendJson(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const rel = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const target = path.join(webDir, rel || 'index.html');
  if (!target.startsWith(webDir)) throw new ApiError(422, 'INVALID_GEOMETRY', 'Path traversal blocked.', 'Request a path inside the site root.');
  const file = fs.existsSync(target) && fs.statSync(target).isFile() ? target : path.join(webDir, 'index.html');
  if (!fs.existsSync(file)) {
    return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'The web build is missing. Run npm run build.', request_id: rid() } }, securityHeaders(req));
  }
  const data = fs.readFileSync(file);
  const ext = path.extname(file);
  const immutable = /-[0-9a-zA-Z]{8,}\./.test(path.basename(file));
  res.writeHead(200, {
    ...securityHeaders(req),
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': ext === '.html' ? 'no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
  });
  res.end(data);
}

function clientIp(req) {
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

const buckets = new Map();
function allow(ip, cls) {
  const cap = LIMITS['class' + cls] ?? 60;
  const minute = Math.floor(Date.now() / 60000);
  const key = `${ip}:${cls}:${minute}`;
  const used = (buckets.get(key) || 0) + 1;
  buckets.set(key, used);
  if (buckets.size > 5000) {
    for (const k of buckets.keys()) if (!k.endsWith(`:${minute}`)) buckets.delete(k);
  }
  return { allowed: used <= cap, retryAfter: Math.max(1, 60 - (Math.floor(Date.now() / 1000) % 60)) };
}

const CLASS_OF = { summary: 'B', calendar: 'B', 'month-compare': 'B', day: 'B', bias: 'B', status: 'C', weather: 'C', twin: 'C', sandbox: 'C', csv: 'B', geojson: 'B', brief: 'B' };
// `/api/v1/x` and bare `/x` must classify identically: the old chain replaced the first `/` with `-`
// for unprefixed paths, so a liveness probe or a scrape hit `/health` and was limited as class B.
function rateClass(pathname) {
  const name = pathname
    .replace(/^\/api\/v1/, '')
    .replace(/^\/+/, '')
    .replace(/^(area\/|export\/|sandbox\/)/, '')
    .replace(/\//g, '-');
  if (name === 'meta' || name === 'method-card' || name === 'health' || name === 'ready' || name === 'live-firms' || name === 'live-fires' || name === 'metrics' || name === 'openapi.json') return 'A';
  const key = Object.keys(CLASS_OF).find((k) => name.startsWith(k));
  return CLASS_OF[key || ''] || 'B';
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let rejected = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit && !rejected) {
        rejected = true;
        chunks.length = 0;
        reject(new ApiError(413, 'BODY_TOO_LARGE', `Request body exceeds ${Math.round(limit / 1024 / 1024 * 10) / 10} MiB.`, 'Reduce the request size; report images must be at most 4 MiB before Base64 encoding.'));
      }
      if (!rejected) chunks.push(c);
    });
    req.on('end', () => {
      if (rejected) return;
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim().startsWith('{')) {
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new ApiError(422, 'INVALID_JSON', 'Request body is not valid JSON.', 'Send a JSON object.'));
        }
      } else {
        resolve(Object.fromEntries(new URLSearchParams(text)));
      }
    });
    req.on('error', reject);
  });
}

const CORS_HEADERS = (origin) => {
  if (!origin) return {};
  // Default-deny: cross-origin access only for origins the operator listed in API_CORS_ORIGINS.
  if (!CORS.length || (!CORS.includes(origin) && !CORS.includes('*'))) return {};
  return { 'Access-Control-Allow-Origin': CORS.includes('*') ? '*' : origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, X-API-Key', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
};

// ---------------------------------------------------------------- metrics
// Prometheus text exposition with a deliberately bounded label set: the route label comes from the
// declared endpoint table plus one `static` bucket, so a client probing random paths cannot inflate
// the series count or the scrape response. Nothing per-client or per-IP is ever exported.
const METRICS_TOKEN = (process.env.METRICS_TOKEN || '').trim();
const metrics = { startedAt: Date.now(), routes: new Map(), classes: new Map(), errors: new Map() };
const KNOWN_ROUTES = new Set([
  ...Object.keys(GET_ROUTES),
  ...Object.keys(routes).map((key) => key.replace(/^POST /, '')),
  '/openapi.json',
  '/metrics',
]);

function metricLabel(pathname) {
  const sub = pathname.startsWith('/api/v1') ? pathname.replace('/api/v1', '') || '/' : pathname;
  return KNOWN_ROUTES.has(sub) ? sub : 'static';
}

function observe(pathname, cls, status, code, durationMs) {
  const routeKey = metricLabel(pathname);
  const route = metrics.routes.get(routeKey) || { total: 0, sum: 0, max: 0, status: new Map() };
  const family = status >= 500 ? '5xx' : status >= 400 ? '4xx' : status >= 300 ? '3xx' : '2xx';
  route.total += 1;
  route.sum += durationMs;
  route.max = Math.max(route.max, durationMs);
  route.status.set(family, (route.status.get(family) || 0) + 1);
  metrics.routes.set(routeKey, route);
  metrics.classes.set(cls, (metrics.classes.get(cls) || 0) + 1);
  if (code) metrics.errors.set(code, (metrics.errors.get(code) || 0) + 1);
}

// Readiness means re-checking every bundle checksum, which reads the whole bundle. Cache it so a
// 15-second scrape cannot turn each poll into an integrity sweep; `/ready` itself stays uncached.
let readiness = { at: 0, ok: false };
function bundleReady() {
  const now = Date.now();
  if (now - readiness.at > 10000) readiness = { at: now, ok: Boolean(live) && Boolean(snapshot) && manifestCheck().ok };
  return readiness.ok ? 1 : 0;
}

const escLabel = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function renderMetrics() {
  const at = (name, labels) => `${name}{${labels}}`;
  const rows = [...metrics.routes.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const out = [
    '# HELP continuum_http_requests_total Finished requests, by normalised route and status family.',
    '# TYPE continuum_http_requests_total counter',
  ];
  for (const [route, r] of rows) {
    for (const [family, n] of [...r.status.entries()].sort()) out.push(at('continuum_http_requests_total', `route="${escLabel(route)}",status="${family}"`) + ` ${n}`);
  }
  out.push(
    '# HELP continuum_http_request_duration_ms_sum Total server-side duration per route, in milliseconds.',
    '# TYPE continuum_http_request_duration_ms_sum counter',
  );
  for (const [route, r] of rows) out.push(at('continuum_http_request_duration_ms_sum', `route="${escLabel(route)}"`) + ` ${r.sum}`);
  out.push(
    '# HELP continuum_http_request_duration_ms_count Requests behind that total, per route.',
    '# TYPE continuum_http_request_duration_ms_count counter',
  );
  for (const [route, r] of rows) out.push(at('continuum_http_request_duration_ms_count', `route="${escLabel(route)}"`) + ` ${r.total}`);
  out.push(
    '# HELP continuum_http_request_duration_ms_max Longest single request on that route since the process started, a gauge and not a sliding window.',
    '# TYPE continuum_http_request_duration_ms_max gauge',
  );
  for (const [route, r] of rows) out.push(at('continuum_http_request_duration_ms_max', `route="${escLabel(route)}"`) + ` ${r.max}`);
  out.push(
    '# HELP continuum_http_rate_class_requests_total Requests per rate-limit class (A/B/C, capacities in /meta).',
    '# TYPE continuum_http_rate_class_requests_total counter',
  );
  for (const [cls, n] of [...metrics.classes.entries()].sort()) out.push(at('continuum_http_rate_class_requests_total', `class="${escLabel(cls)}"`) + ` ${n}`);
  out.push(
    '# HELP continuum_http_error_codes_total Responses carrying X-Error-Code, including 429 limits and 4xx refusals.',
    '# TYPE continuum_http_error_codes_total counter',
  );
  for (const [code, n] of [...metrics.errors.entries()].sort()) out.push(at('continuum_http_error_codes_total', `code="${escLabel(code)}"`) + ` ${n}`);
  out.push(
    '# HELP continuum_bundle_ready Data bundle loaded and checksums verified at the last check (1/0), re-checked at most every 10s.',
    '# TYPE continuum_bundle_ready gauge',
    `continuum_bundle_ready ${bundleReady()}`,
    '# HELP continuum_bundle_version Data bundle served by this process.',
    '# TYPE continuum_bundle_version gauge',
    at('continuum_bundle_version', `version="${escLabel(BUNDLE_VERSION)}"`) + ' 1',
    '# HELP continuum_process_uptime_seconds Time since this API process started.',
    '# TYPE continuum_process_uptime_seconds gauge',
    `continuum_process_uptime_seconds ${((Date.now() - metrics.startedAt) / 1000).toFixed(3)}`,
    '# HELP continuum_process_resident_memory_bytes Resident set size reported by the runtime.',
    '# TYPE continuum_process_resident_memory_bytes gauge',
    `continuum_process_resident_memory_bytes ${process.memoryUsage().rss}`,
  );
  return out.join('\n') + '\n';
}

// Hash both sides before the constant-time compare so a short guess costs the same as a long one.
function metricsAuthorized(req) {
  if (!METRICS_TOKEN) return false;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const candidate = String(req.headers['x-metrics-token'] || '') || bearer;
  if (!candidate) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(METRICS_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const id = rid();
  const started = Date.now();
  let pathname = '/';
  let cls = 'A';
  let cors = {};
  const ip = clientIp(req);

  const log = (status, code) => {
    observe(pathname, cls, status, code, Date.now() - started);
    if (process.env.LOG_FORMAT === 'json') {
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: status >= 500 ? 'error' : 'info', request_id: id, route: `${req.method} ${pathname}`, status, code: code || null, rate_class: cls, ip, duration_ms: Date.now() - started }));
    }
  };
  res.on('finish', () => log(res.statusCode, res.getHeader('X-Error-Code')));

  try {
    const url = requestUrl(req);
    pathname = url.pathname;
    cls = rateClass(pathname);
    cors = CORS_HEADERS(req.headers.origin);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...securityHeaders(req), ...cors, 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    const bucket = allow(ip, cls);
    if (!bucket.allowed) {
      res.setHeader('Retry-After', String(bucket.retryAfter));
      res.setHeader('X-Error-Code', 'RATE_LIMITED');
      return sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: `Limit for class ${cls} is ${LIMITS['class' + cls]} per minute.`, hint: 'Wait before retrying.', request_id: id } }, { ...securityHeaders(req), ...cors });
    }

    if (pathname === '/openapi.json' || pathname === '/api/v1/openapi.json') {
      return sendJson(res, 200, openapiDoc(req), { ...securityHeaders(req), ...cors });
    }
    // With no METRICS_TOKEN configured the endpoint is indistinguishable from an unknown path, so an
    // unconfigured host never advertises it. A configured host answers 401 rather than 404 to a bad
    // credential, because the operator has declared the scrape exists.
    if (pathname === '/metrics' || pathname === '/api/v1/metrics') {
      if (!METRICS_TOKEN) throw new ApiError(404, 'NOT_FOUND', `No endpoint ${req.method} ${pathname}.`, 'Set METRICS_TOKEN in the API environment to enable the Prometheus scrape.');
      if (!metricsAuthorized(req)) throw new ApiError(401, 'UNAUTHORIZED', 'The metrics scrape requires the operator token.', 'Send "Authorization: Bearer $METRICS_TOKEN" or "X-Metrics-Token".');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed here.`, 'Scrape with GET.');
      const body = renderMetrics();
      res.writeHead(200, { ...securityHeaders(req), ...cors, 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      return res.end(body);
    }
    if (pathname.startsWith('/api/v1/')) {
      const sub = pathname.replace('/api/v1', '');
      // Key issuance must remain reachable after the first registration. Data
      // endpoints still enforce keys; embedded GLB images only need blob fetches.
      if (sub === '/community/discord-sync') {
        if (req.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use POST for Discord sync.');
        if (!process.env.DISCORD_SYNC_SECRET?.trim()) throw new ApiError(503, 'DISCORD_NOT_CONFIGURED', 'Discord sync is not configured.');
        if (!discordSyncAuthorized(req.headers['x-discord-secret'])) throw new ApiError(401, 'UNAUTHORIZED', 'Invalid Discord sync credential.');
      } else if (sub !== '/health' && sub !== '/openapi.json' && sub !== '/auth/generate-key') {
        const authenticatedKey = apiKey(req);
        if (['/community/vote', '/community/upvote'].includes(sub) && !authenticatedKey) throw new ApiError(401, 'UNAUTHORIZED', 'A registered API key is required to vote.');
      }
      const get = GET_ROUTES[sub];
      if (get && (req.method === 'GET' || req.method === 'HEAD')) return await callGet(get, req, res, cors);
      const handler = routes[`POST ${sub}`];
      if (!handler) {
        res.setHeader('X-Error-Code', 'NOT_FOUND');
        return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `No endpoint ${req.method} ${pathname}.`, hint: 'See /openapi.json.', request_id: id } }, { ...securityHeaders(req), ...cors });
      }
      // Without this check a DELETE or PUT on a known path is read as an empty POST and answered 422,
      // which tells a client the body is wrong when the method is what is wrong.
      if (req.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed on ${sub}.`, 'Use POST.');
      const body = await readBody(req, ['/community/posts', '/community/discord-sync'].includes(sub) ? MAX_IMAGE_DATA_URL_LENGTH + 65536 : BODY_LIMIT);
      const result = await handler(body, req);
      if (result?.__stream) {
        const payload = Buffer.isBuffer(result.body) ? result.body : Buffer.from(String(result.body), 'utf8');
        res.writeHead(200, {
          ...securityHeaders(req),
          ...cors,
          'Content-Type': result.contentType,
          'Content-Length': payload.length,
          'Content-Disposition': `attachment; filename="${result.filename}"`,
          'X-Continuum-Meta': Buffer.from(JSON.stringify(result.meta)).toString('base64').slice(0, 900),
        });
        return res.end(payload);
      }
      return sendJson(res, 200, result, { ...securityHeaders(req), ...cors });
    }
    if (GET_ROUTES[pathname] && (req.method === 'GET' || req.method === 'HEAD')) return await callGet(GET_ROUTES[pathname], req, res, cors);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('X-Error-Code', 'METHOD_NOT_ALLOWED');
      return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: `${req.method} is not allowed here.`, request_id: id } }, { ...securityHeaders(req), ...cors });
    }
    return serveStatic(req, res, pathname);
  } catch (err) {
    if (err instanceof CommunityValidationError) err = new ApiError(422, 'PARAMETER_INVALID', err.message);
    const status = err instanceof ApiError ? err.status : 500;
    const code = err instanceof ApiError ? err.code : 'INTERNAL';
    if (status >= 500) console.error(`[${id}] Internal Server Error`);
    if (res.headersSent) { res.destroy(); return; }
    res.setHeader('X-Error-Code', code);
    return sendJson(
      res,
      status,
      err instanceof ApiError
        ? { error: { code, message: err.message, hint: err.hint, request_id: id } }
        : { error: 'Internal Server Error' },
      { ...securityHeaders(req), ...cors },
    );
  }
});

async function callGet(handler, req, res, cors) {
  const [status, payload] = await handler(req);
  return sendJson(res, status, payload, { ...securityHeaders(req), ...cors });
}

function openapiDoc(req) {
  const areaBody = {
    type: 'object',
    properties: {
      geometry: { type: 'object', description: 'GeoJSON Polygon (max 5000 vertices)' },
      lat: { type: 'number' },
      lon: { type: 'number' },
      radius_km: { type: 'number', default: 140 },
      region_id: {
        type: 'string',
        description: `One of the ${A.REGIONS.length} pilot ids, or any of the ${WORLD_COUNTRIES} country borders as "country-<id>" — the full index with each border's measured window is in GET /meta under world_layer.`,
        examples: [...A.REGIONS.slice(0, 2).map((r) => r.id), 'country-kenya', 'country-brazil'],
      },
      start: { type: 'string', format: 'date' },
      end: { type: 'string', format: 'date' },
      metric: { type: 'string', enum: ['firedays', 'hotspots', 'frp'] },
      mode: { type: 'string', enum: ['raw', 'harmonized'] },
    },
  };
  const post = (pathName, cls, extra = {}) => ({
    post: {
      summary: pathName,
      'x-rate-class': cls,
      requestBody: { required: true, content: { 'application/json': { schema: { allOf: [areaBody, { type: 'object', properties: extra }] } } } },
      responses: { 200: { description: 'JSON result with method_version, bundle_version, data_through' }, 422: { description: 'INVALID_GEOMETRY / AREA_TOO_LARGE / DATE_RANGE_INVALID / PARAMETER_INVALID / OUT_OF_COVERAGE' }, 429: { description: 'RATE_LIMITED with Retry-After' } },
    },
  });
  const imageField = { type: 'string', maxLength: MAX_IMAGE_DATA_URL_LENGTH, description: 'Optional Base64 PNG, JPEG or WebP data URL; decoded image at most 4 MiB.' };
  const communityPost = (route, properties) => {
    const operation = post(route, 'B').post;
    operation.requestBody.content['application/json'].schema = { type: 'object', required: ['content'], properties };
    operation.responses[401] = { description: 'Missing or invalid credential' };
    operation.responses[413] = { description: 'Report JSON exceeds image upload envelope limit' };
    return { post: operation };
  };
  const communityVote = communityPost('/community/vote', { postId: { type: 'string' }, optionIndex: { type: 'integer', minimum: 0 }, action: { type: 'string', enum: ['verify'] } });
  const voteSchema = communityVote.post.requestBody.content['application/json'].schema;
  voteSchema.required = ['postId'];
  voteSchema.oneOf = [{ required: ['action'], not: { required: ['optionIndex'] } }, { required: ['optionIndex'], not: { required: ['action'] } }];
  communityVote.post.summary = 'Vote in a poll, or confirm an incident with action: verify (registered API key required)';
  return {
    openapi: '3.1.0',
    info: { title: 'Continuum read-only API', version: METHOD_VERSION, description: 'Sensor-harmonized burning activity for the seven pilot regions, any of the 241 country borders, and any circle or polygon area on Earth.' },
    servers: [{ url: publicApiBase(req) }],
    paths: {
      '/area/summary': post('/area/summary', 'B'),
      '/area/calendar': post('/area/calendar', 'B'),
      '/area/month-compare': post('/area/month-compare', 'B', { month: { type: 'integer', minimum: 1, maximum: 12 } }),
      '/area/day': post('/area/day', 'B', { date: { type: 'string', format: 'date' } }),
      '/area/bias': post('/area/bias', 'B'),
      '/area/status': post('/area/status', 'C', { date: { type: 'string', format: 'date' } }),
      '/area/weather': post('/area/weather', 'C'),
      '/area/twin': post('/area/twin', 'C', { weeks: { type: 'integer', default: 8 } }),
      '/sandbox/run': post('/sandbox/run', 'C', { overpass_hour: { type: 'number' }, pixel_m: { type: 'number' }, min_frp: { type: 'number' }, correction: { type: 'boolean' } }),
      '/export/csv': post('/export/csv', 'B'),
      '/export/geojson': post('/export/geojson', 'B', { date: { type: 'string', format: 'date' } }),
      '/brief': post('/brief', 'B', { language: { type: 'string', enum: ['en', 'es'] }, format: { type: 'string', enum: ['text', 'pdf'] } }),
      '/community/feed': { get: { summary: 'Community feed — posts and verified announcements', 'x-rate-class': 'B', responses: { 200: { description: 'OK' } } } },
      '/atlas': { get: { summary: 'Processed burning calendar for an area (dates, raw/harmonized counts, 90% CI)', 'x-rate-class': 'B', parameters: [{ name: 'region_id', in: 'query', required: false, schema: { type: 'string' }, description: 'Pilot id or country-<id>' }, { name: 'lat', in: 'query', required: false, schema: { type: 'number' } }, { name: 'lon', in: 'query', required: false, schema: { type: 'number' } }, { name: 'start', in: 'query', required: false, schema: { type: 'string', format: 'date' } }, { name: 'end', in: 'query', required: false, schema: { type: 'string', format: 'date' } }], responses: { 200: { description: 'OK' } } } },
      '/diagnosis': { get: { summary: 'Bias X-ray — sensor overlap ratio k, 2012 break, calibration metrics', 'x-rate-class': 'B', parameters: [{ name: 'region_id', in: 'query', required: false, schema: { type: 'string' } }, { name: 'lat', in: 'query', required: false, schema: { type: 'number' } }, { name: 'lon', in: 'query', required: false, schema: { type: 'number' } }], responses: { 200: { description: 'OK' } } } },
      '/outlook': { get: { summary: 'Selected-region analog seasons, four-week departure and backtest results', 'x-rate-class': 'B', parameters: [{ name: 'region_id', in: 'query', required: false, description: 'Pilot ID or country-<id>, as listed by GET /meta.', schema: { type: 'string' }, example: 'nepal' }, { name: 'lat', in: 'query', required: false, schema: { type: 'number' } }, { name: 'lon', in: 'query', required: false, schema: { type: 'number' } }], responses: { 200: { description: 'Analog outlook derived from the selected area record; not a current weather forecast.' } } } },
      '/brief': { get: { summary: 'Generated textual/markdown brief for a region', 'x-rate-class': 'B', parameters: [{ name: 'region_id', in: 'query', required: false, schema: { type: 'string' } }, { name: 'lat', in: 'query', required: false, schema: { type: 'number' } }, { name: 'lon', in: 'query', required: false, schema: { type: 'number' } }, { name: 'start', in: 'query', required: false, schema: { type: 'string', format: 'date' } }, { name: 'end', in: 'query', required: false, schema: { type: 'string', format: 'date' } }, { name: 'language', in: 'query', required: false, schema: { type: 'string', enum: ['en', 'es'] } }], responses: { 200: { description: 'OK' } } } },
      '/community/posts': communityPost('/community/posts', { author: { type: 'string', maxLength: 60 }, type: { type: 'string', enum: ['text', 'poll', 'anomaly'] }, content: { type: 'string', minLength: 1, maxLength: 1000 }, imageBase64: imageField, imageUrl: { type: 'string', maxLength: 2000, description: 'Optional HTTPS image link on a supported host; see Discord bot documentation.' }, locationName: { type: 'string', maxLength: 160 }, lat: { type: ['number', 'null'], minimum: -90, maximum: 90 }, lon: { type: ['number', 'null'], minimum: -180, maximum: 180 }, pollOptions: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'object', properties: { text: { type: 'string', maxLength: 100 } } } } }),
      '/community/discord-sync': { post: { ...communityPost('/community/discord-sync', { author: { type: 'string', maxLength: 60 }, name: { type: 'string', maxLength: 60, description: 'Legacy author alias' }, content: { type: 'string', minLength: 1, maxLength: 2000 }, imageBase64: imageField, imageUrl: { type: 'string', maxLength: 2000, description: 'Optional HTTPS image link on a supported host; see Discord bot documentation.' }, discordMessageId: { type: 'string', pattern: '^\\d{10,25}$', description: 'Stable Discord interaction or message ID for retry deduplication' }, locationName: { type: 'string', maxLength: 160 }, lat: { type: ['number', 'null'], minimum: -90, maximum: 90 }, lon: { type: ['number', 'null'], minimum: -180, maximum: 180 } }).post, summary: 'Import a Discord report (X-Discord-Secret required; no web API key)', parameters: [{ in: 'header', name: 'x-discord-secret', required: true, schema: { type: 'string' } }] } },
      '/community/vote': communityVote,
      '/community/upvote': post('/community/upvote', 'B', { postId: { type: 'string', description: 'Confirm an incident once per registered API key; three distinct keys yield community_verified.' } }),
      '/community/verify': post('/community/verify', 'B', { postId: { type: 'string', description: 'Recheck stored report coordinates against satellite detections; caller-supplied verification flags are ignored.' } }),
      '/meta': { get: { summary: 'Versions, coverage, pilots, limits', 'x-rate-class': 'A', responses: { 200: { description: 'OK' } } } },
      '/method-card': { get: { summary: 'Equations, limits, provenance', 'x-rate-class': 'A', responses: { 200: { description: 'OK' } } } },
      '/health': { get: { summary: 'Liveness', responses: { 200: { description: 'OK' } } } },
      '/metrics': {
        get: {
          summary: 'Prometheus text scrape - absent (404) until the operator sets METRICS_TOKEN',
          'x-rate-class': 'A',
          security: [{ metricsToken: [] }],
          responses: { 200: { description: 'text/plain; version=0.0.4' }, 401: { description: 'Token missing or wrong' }, 404: { description: 'Metrics disabled on this host' } },
        },
      },
      '/ready': { get: { summary: 'Readiness — bundle loaded and manifest checksums valid', responses: { 200: { description: 'Ready' }, 503: { description: 'Not ready' } } } },
      '/openapi.json': { get: { summary: 'This document', responses: { 200: { description: 'OpenAPI 3.1' } } } },
    },
    components: {
      securitySchemes: {
        metricsToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'The operator-held METRICS_TOKEN. The value is never in this repository or in any response; unset, /metrics answers 404.',
        },
      },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, () => {
    const check = manifestCheck();
    console.log(`Continuum API on http://localhost:${PORT} — bundle ${BUNDLE_VERSION}, integrity ${check.ok ? 'PASS' : `FAIL (${check.bad?.join('; ') || check.reason})`}, metrics ${METRICS_TOKEN ? 'enabled (bearer token required)' : 'disabled (set METRICS_TOKEN)'}, web build ${fs.existsSync(webDir) ? 'served from dist/' : 'missing (npm run build)'}`);
  });
}

export { server, ApiError, manifestCheck, startLive, stopLive };
