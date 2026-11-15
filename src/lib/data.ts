import regionsJson from '../data/regions.json';
import { fetchJsonWithTimeout, RequestTimeoutError } from './request';
import type {
  BiasResult,
  Calibration,
  ClimateBundle,
  ClimateSeries,
  DailyRecord,
  LiveBundle,
  LiveFire,
  LiveMeta,
  Metric,
  Mode,
  MonthComparison,
  Region,
  SeasonClock,
  StatusResult,
  TrustLevel,
  TwinResult,
  SandboxResult,
  SensorObservation,
} from './types';
import { clamp, gaussian, hashString, mean, mulberry32, percentileRank, poisson, quantile, stdev } from './random';
import { dayOfYear, isoDate, addDays, parseISO, daysBetween, ordinal } from './format';
import { haversineKm, pointInBbox } from './geo';
import {
  archiveCoverage,
  archiveDay,
  archiveLoaded,
  archiveRatio,
  archiveStamp,
  archiveStatus,
  attachArchive as attachArchiveBundle,
  constellationWeights,
  platformEquivalent,
  type ArchiveBundle,
} from './archive';

export {
  ARCHIVE_START,
  archiveCoverage,
  archiveLoaded,
  archiveStatus,
  archiveSupplementary,
  archiveDay,
  attachArchive as attachArchive,
  constellationSource,
  constellationWeights,
} from './archive';
export type { ArchiveBundle } from './archive';

export const REGIONS = regionsJson as Region[];
export const START = '2000-11-01';
export const VIIRS_START = '2012-01-20';
export const NOAA_START = '2018-04-01';
export const NOAA21_START = '2022-11-10';

let livePromise: Promise<LiveBundle> | null = null;
let climateStart = '';
let climateSeries = new Map<string, ClimateSeries>();
let climateCenters = new Map<string, [number, number]>();
const proxyCache = new Map<string, string | null>();

/** Turn the raw climate file into per-region persisted daily anomalies and
 * standardised annual anomalies. Gaps are persisted forward, which is how a
 * nowcast would treat the reanalysis lag. The browser calls this from
 * loadLiveBundle; the API and the tests call it directly after reading the file,
 * so both sides of the product run the same driver. */
export function attachClimate(raw: ClimateBundle | null) {
  if (!raw?.regions || !raw.dates?.start) {
    climateSeries = new Map();
    climateCenters = new Map();
    proxyCache.clear();
    climateStart = '';
    return false;
  }
  climateStart = raw.dates.start;
  climateSeries = new Map();
  climateCenters = new Map();
  proxyCache.clear();
  for (const [id, region] of Object.entries(raw.regions)) {
    if (region.center) climateCenters.set(id, [region.center[0], region.center[1]]);
    let last: number | null = null;
    const bw = region.bw.map((v) => (v == null ? last : (last = v)));
    const years = Object.values(region.annual);
    const meanAnnual = years.length ? years.reduce((a, b) => a + b, 0) / years.length : 0;
    const sdAnnual = stdev(years);
    const annualZ: Record<string, number> = {};
    if (sdAnnual > 1e-9) {
      for (const [y, v] of Object.entries(region.annual)) annualZ[y] = (v - meanAnnual) / sdAnnual;
    }
    const { anom, anomSd } = deseasonalize(bw, Date.parse(`${raw.dates.start}T00:00:00Z`));
    climateSeries.set(id, {
      bw,
      anom,
      anomSd,
      annualZ,
      season: region.season && region.season.length === 12 ? region.season.slice() : [],
    });
  }
  return true;
}

/**
 * Split the daily burn-weather index into the parts the reconstruction already
 * spends elsewhere: the calendar-month climatology (that is SEASON) and each
 * year's mean deviation (that is the year regime). What is left is the purely
 * interdaily weather excursion, and its annual mean is zero by construction — so
 * a dry year moves the level once, through the regime term, not twice.
 */
function deseasonalize(bw: (number | null)[], startMs: number) {
  const monthOf = (i: number) => new Date(startMs + i * 86400000).getUTCMonth();
  const yearOf = (i: number) => new Date(startMs + i * 86400000).getUTCFullYear();
  const sum = new Array(12).fill(0);
  const n = new Array(12).fill(0);
  let total = 0;
  let totalN = 0;
  const yearSum = new Map<number, { s: number; n: number }>();
  bw.forEach((v, i) => {
    if (v == null) return;
    const m = monthOf(i);
    sum[m] += v;
    n[m] += 1;
    total += v;
    totalN++;
    const y = yearOf(i);
    const cell = yearSum.get(y) ?? { s: 0, n: 0 };
    cell.s += v;
    cell.n += 1;
    yearSum.set(y, cell);
  });
  const overall = totalN ? total / totalN : 0;
  const mean = sum.map((s, m) => (n[m] >= 12 ? s / n[m] : null));
  const yearDev = new Map<number, number>();
  for (const [y, cell] of yearSum) if (cell.n >= 180) yearDev.set(y, cell.s / cell.n - overall);
  const anom = bw.map((v, i) => {
    const base = mean[monthOf(i)];
    if (v == null || base == null) return null;
    return v - base - (yearDev.get(yearOf(i)) ?? 0);
  });
  const values = anom.filter((v): v is number => v != null);
  return { anom, anomSd: stdev(values) };
}

/** Real MERRA-2 burn-weather anomaly for one region-day, or null with no climate file. */
export function burnWeather(regionId: string, date: string): number | null {
  const series = climateSeries.get(regionId);
  if (!series || !climateStart) return null;
  const idx = climateIndex(date);
  if (idx < 0 || idx >= series.bw.length) return null;
  return series.bw[idx];
}

/** The same value minus its calendar-month climatology: what the seasonal index
 * has not already spent. This is the term the daily weather factor reads. */
export function burnWeatherAnomaly(regionId: string, date: string): number | null {
  const series = climateSeries.get(regionId);
  if (!series || !climateStart) return null;
  const idx = climateIndex(date);
  if (idx < 0 || idx >= series.anom.length) return null;
  return series.anom[idx];
}

function climateIndex(date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${climateStart}T00:00:00Z`)) / 86400000);
}

export function climateStatus(): { loaded: boolean; regions: string[]; start: string } {
  return { loaded: climateSeries.size > 0, regions: [...climateSeries.keys()], start: climateStart };
}

/**
 * Which reanalysis point drives an area's weather and seasonal terms. A pilot
 * region has its own POWER point; a custom AOI is steered to the nearest one
 * instead of falling back to a simulated cycle, so the driver stays observed and
 * the distance is part of the number rather than hidden from it.
 */
export function climateSourceFor(region: Region): { id: string; distanceKm: number; proxied: boolean } | null {
  if (!climateSeries.size) return null;
  if (climateSeries.has(region.id)) return { id: region.id, distanceKm: 0, proxied: false };
  const key = region.center.map((v) => v.toFixed(3)).join(',');
  if (proxyCache.has(key)) {
    const hit = proxyCache.get(key)!;
    return hit ? { id: hit, distanceKm: Math.round(haversineKm(region.center, climateCenters.get(hit)!)), proxied: true } : null;
  }
  let bestId: string | null = null;
  let bestKm = Infinity;
  for (const [id, center] of climateCenters) {
    const d = haversineKm(region.center, center);
    if (d < bestKm) {
      bestKm = d;
      bestId = id;
    }
  }
  proxyCache.set(key, bestId);
  return bestId ? { id: bestId, distanceKm: Math.round(bestKm), proxied: true } : null;
}

/** The reanalysis series an area should read, with its provenance. */
function climateFor(region: Region): { series: ClimateSeries | null; source: string | null; distanceKm: number } {
  const direct = climateSeries.get(region.id);
  if (direct) return { series: direct, source: region.id, distanceKm: 0 };
  const src = climateSourceFor(region);
  return { series: src ? climateSeries.get(src.id) ?? null : null, source: src?.id ?? null, distanceKm: src?.distanceKm ?? -1 };
}

/** How much of a region's weather term is observed rather than simulated. */
export function weatherCoverage(regionId: string, from: string, to: string): { days: number; observed: number; share: number } {
  const series = climateSeries.get(regionId);
  if (!series || !climateStart) return { days: 0, observed: 0, share: 0 };
  const first = Math.round((Date.parse(`${from}T00:00:00Z`) - Date.parse(`${climateStart}T00:00:00Z`)) / 86400000);
  const last = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${climateStart}T00:00:00Z`)) / 86400000);
  let days = 0;
  let observed = 0;
  for (let i = Math.max(0, first); i <= Math.min(series.bw.length - 1, last); i++) {
    days++;
    if (series.bw[i] != null) observed++;
  }
  return { days, observed, share: days ? observed / days : 0 };
}

/**
 * Retained for callers of the former realtime alignment API. A stored snapshot
 * keeps its acquisition dates and published window, even when it is stale.
 * Fresh observations must come from an upstream refresh, never a clock shift.
 */
export function alignLiveToRealtime(bundle: LiveBundle, targetDate?: string): LiveBundle {
  return bundle;
}

export function refreshLiveBundle(targetDate?: string): Promise<LiveBundle> {
  livePromise = null;
  cache.clear();
  return loadLiveBundle(targetDate);
}

export function loadLiveBundle(targetDate?: string): Promise<LiveBundle> {
  if (!livePromise) {
    const base = import.meta.env.BASE_URL || './';
    let timedOut = false;
    const optional = <T,>(file: string) => fetchJsonWithTimeout<T>(`${base}data/${file}`).catch(error => {
      timedOut ||= error instanceof RequestTimeoutError;
      return null;
    });
    const snapshot = fetchJsonWithTimeout<LiveBundle>(`${base}data/live_fires.json`).catch(error => {
      timedOut ||= error instanceof RequestTimeoutError;
      // A cached snapshot can recover a stalled refresh, but missing data must remain an error.
      return fetchJsonWithTimeout<LiveBundle>(`${base}data/live_fires.json`, 3000, { cache: 'force-cache' });
    });
    livePromise = Promise.all([
      snapshot,
      optional<ClimateBundle>('climate_daily.json'),
      optional<ArchiveBundle>('archive_daily.json'),
    ])
      .then(([live, climate, archive]) => {
        if (!live?.meta?.windowStart || !live.meta.windowEnd || !Array.isArray(live.fires)) throw new Error('The bundled FIRMS snapshot is invalid.');
        attachClimate(climate);
        attachArchiveBundle(archive);
        return { ...alignLiveToRealtime(live, targetDate), ...(timedOut ? { loadNotice: 'Live API timeout. Using bundled snapshot.' } : {}) };
      });
  }
  return livePromise;
}

/** Clear the memoized live-bundle promise so the next loadLiveBundle() re-fetches from the network.
   Used by the app's retry button so a failed load can be recovered without a page refresh. */
export function resetLiveBundle(): void {
  livePromise = null;
}

export function getRegion(id: string): Region {
  return lookupRegion(id) ?? REGIONS[0];
}

export function regionRecord(region: Region, live: LiveBundle | null): DailyRecord[] {
  return buildRecord(region, live);
}

const cache = new Map<string, DailyRecord[]>();
const liveIds = new WeakMap<LiveBundle, number>();
let nextLiveId = 0;

function liveKey(live: LiveBundle | null): string {
  if (!live) return 'none';
  if (!liveIds.has(live)) liveIds.set(live, ++nextLiveId);
  const meta = live.meta;
  return `${liveIds.get(live)}:${meta?.windowStart ?? ''}:${meta?.windowEnd ?? ''}:${JSON.stringify(meta?.sensorMeta ?? null)}:${Array.isArray(meta?.sensors) ? meta.sensors.join(',') : ''}`;
}

function regionKey(region: Region): string {
  return `${region.id}:${region.bbox.join(',')}:${region.areaKm2}:${region.countryId ?? ''}`;
}

export function getRecord(regionId: string, live: LiveBundle | null): DailyRecord[] {
  const key = `${regionKey(getRegion(regionId))}:${liveKey(live)}:${archiveStamp()}`;
  if (!cache.has(key)) cache.set(key, buildRecord(getRegion(regionId), live));
  return cache.get(key)!;
}

/**
 * Which measurement actually produced this area's MODIS→VIIRS bridge: the keyed
 * archive's own overlap days, the live window, or (only as a last resort) the
 * model's internal overlap. Reported next to the ratio so the number carries its
 * own evidence.
 */
export function bridgeFor(region: Region, live: LiveBundle | null): { source: 'firms-archive' | 'area' | 'country-window' | 'pilot-regions' | 'model-overlap'; k: number; days: number } {
  const cal = calibration(region, live);
  const completion = constellationWeights(region.id) ?? (cal ? { ...cal.viirsShares } : null);
  const fromArchive = archiveRatio(region, completion);
  if (fromArchive) return { source: 'firms-archive', k: fromArchive.k, days: fromArchive.days };
  if (cal?.k) return { source: cal.kSource, k: cal.k, days: cal.overlapDays };
  return { source: 'model-overlap', k: 0, days: 0 };
}

/**
 * How much of an area's displayed record is an observation rather than a reconstruction,
 * counted from the rows the product actually shows. The UI quotes this instead of a
 * sentence, so the claim moves with the archive instead of going stale.
 */
export function provenanceMix(records: DailyRecord[]) {
  let model = 0;
  let archived = 0;
  let live = 0;
  let first = '';
  let last = '';
  for (const r of records) {
    if (r.source === 'archive') {
      archived++;
      if (!first) first = r.date;
      last = r.date;
    } else if (r.source === 'live') live++;
    else model++;
  }
  const days = records.length;
  const observed = archived + live;
  return { days, model, archived, live, observed, share: days ? observed / days : 0, first, last };
}

/**
 * The within-year shape of an area's activity. With the climate file these are
 * the twelve observed burn-weather favourability factors from NASA POWER, read
 * from the nearest reanalysis point for a custom AOI; with no file the cycle is
 * flat, because inventing a peak month is exactly what the reconstruction is
 * not supposed to do.
 */
function monthlyWeights(region: Region): number[] {
  const observed = climateFor(region).series?.season;
  if (observed && observed.length === 12 && observed.every((v) => Number.isFinite(v) && v > 0)) return observed;
  return new Array(12).fill(1);
}

function dayWeight(weights: number[], month: number, day: number): number {
  const curr = weights[month - 1];
  const next = weights[month % 12];
  const prev = weights[(month + 10) % 12];
  const frac = (day - 15) / 30;
  const slope = frac >= 0 ? next - curr : curr - prev;
  return Math.max(0.04, curr + slope * Math.abs(frac));
}

/** Months whose observed burn-weather favourability is at or above the annual mean. */
export function seasonMonths(region: Region): number[] {
  const s = climateFor(region).series?.season;
  if (!s || s.length !== 12) return [];
  return s.map((v, i) => (v >= 1 ? i + 1 : 0)).filter(Boolean);
}

/** The same window as prose, e.g. "Aug – Jan", read off the observed cycle. */
export function seasonLabelFor(region: Region): string {
  const months = seasonMonths(region);
  if (!months.length) return 'no observed seasonal cycle';
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Walk the shortest run of months that contains every above-mean month.
  const present = new Set(months);
  let best: { start: number; len: number } | null = null;
  for (let start = 1; start <= 12; start++) {
    for (let len = present.size; len <= 12; len++) {
      let covers = true;
      for (let k = 0; k < len; k++) if (!present.has(((start - 1 + k) % 12) + 1)) covers = false;
      if (covers && (!best || len < best.len)) best = { start, len };
      if (best && best.len === present.size) break;
    }
  }
  if (!best) return `${names[months[0] - 1]} – ${names[months[months.length - 1] - 1]}`;
  const end = ((best.start - 1 + best.len - 1) % 12) + 1;
  return best.len === 12 ? 'year-round' : `${names[best.start - 1]} – ${names[end - 1]}`;
}

function sensorEra(date: string): { modis: boolean; viirs: boolean; noaa: boolean; noaa21: boolean } {
  return {
    modis: true,
    viirs: date >= VIIRS_START,
    noaa: date >= NOAA_START,
    noaa21: date >= NOAA21_START,
  };
}

/* ------------------------------------------------------------------ */
/* Live-window calibration — every constant the model uses is measured  */
/* ------------------------------------------------------------------ */

type DayObservation = { m: number; v: number; n: number; n21: number };
type CompletionShares = Calibration['viirsShares'];
const LIVE_SENSOR_NAMES = ['MODIS', 'VIIRS-SNPP', 'NOAA-20', 'NOAA-21'] as const;
const LIVE_SENSOR_KEYS = ['modis', 'viirs', 'noaa20', 'noaa21'] as const;

export function liveSensorAvailability(meta: LiveMeta, date: string): SensorObservation {
  if (!meta || !meta.sensorMeta) return { modis: false, viirs: false, noaa20: false, noaa21: false };
  const available = (name: string) => {
    const lane = meta.sensorMeta[name];
    return !!lane && Array.isArray(meta.sensors) && meta.sensors.includes(name) && date >= meta.windowStart && date <= meta.windowEnd
      && date >= lane.first && date <= lane.last;
  };
  return { modis: available('MODIS'), viirs: available('VIIRS-SNPP'), noaa20: available('NOAA-20'), noaa21: available('NOAA-21') };
}

function observedViirs(d: DayObservation, seen: SensorObservation, weights: CompletionShares | null) {
  if (!seen.viirs && !seen.noaa20 && !seen.noaa21) return null;
  const raw = (seen.viirs ? d.v : 0) + (seen.noaa20 ? d.n : 0) + (seen.noaa21 ? d.n21 : 0);
  const complete = seen.viirs && seen.noaa20 && seen.noaa21;
  const share = weights ? (seen.viirs ? weights.snpp : 0) + (seen.noaa20 ? weights.noaa20 : 0) + (seen.noaa21 ? weights.noaa21 : 0) : 0;
  const constellation: DailyRecord['constellation'] = complete ? 'complete' : share > 0 ? 'estimated' : 'partial';
  return { raw, harmonized: complete || share <= 0 ? raw : raw / share, constellation };
}

function liveCompletion(byDay: Map<string, DayObservation>, meta: LiveMeta): CompletionShares | null {
  if (!meta?.windowStart) return null;
  let snpp = 0, noaa20 = 0, noaa21 = 0;
  for (let date = meta.windowStart; date <= meta.windowEnd; date = addDays(date, 1)) {
    const seen = liveSensorAvailability(meta, date);
    if (!seen.viirs || !seen.noaa20 || !seen.noaa21) continue;
    const d = byDay.get(date) ?? { m: 0, v: 0, n: 0, n21: 0 };
    snpp += d.v; noaa20 += d.n; noaa21 += d.n21;
  }
  const total = snpp + noaa20 + noaa21;
  return total > 0 ? { snpp: snpp / total, noaa20: noaa20 / total, noaa21: noaa21 / total } : null;
}

function liveBridge(byDay: Map<string, DayObservation>, meta: LiveMeta, weights: CompletionShares | null) {
  let sumM = 0, sumV = 0, days = 0;
  for (let date = meta.windowStart; date <= meta.windowEnd; date = addDays(date, 1)) {
    const seen = liveSensorAvailability(meta, date);
    const d = byDay.get(date) ?? { m: 0, v: 0, n: 0, n21: 0 };
    const viirs = observedViirs(d, seen, weights);
    if (!seen.modis || !viirs || viirs.constellation === 'partial') continue;
    sumM += d.m; sumV += viirs.harmonized; days++;
  }
  return { sumM, sumV, days };
}

const MIN_AREA_OVERLAP_MODIS = 30;

const VIIRS_REFERENCE_HOUR = 13.5; // Reference local time of 13:30 as specified in the PRD

/** Compute the daily fire probability cycle from overlap days.
 *  Returns a function p(hour) that gives the relative detection probability
 *  for a given hour of day (in UTC, 0-23). The function is normalized so
 *  that its integral over 24 hours equals 1.
 */
function dailyCycleFromOverlap(dates: string[], mods: number[], viirs: number[]): (hour: number) => number {
  // Compute hour of day (in UTC) for each fire date
  // We use the fire's unix timestamp to get the UTC hour
  const hourCounts = new Map<number, number>();
  const n = Math.min(mods.length, viirs.length);
  for (let i = 0; i < n; i++) {
    if (mods[i] <= 0 && viirs[i] <= 0) continue; // no detection either side
    const d = new Date(dates[i]);
    const h = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    hourCounts.set(h, (hourCounts.get(h) ?? 0) + 1);
  }

  // If we have too few points, fall back to uniform distribution
  if (hourCounts.size < 6) {
    return () => 1 / 24; // uniform
  }

  // Build a smooth daily cycle using kernel smoothing (simple approach: bin and normalize)
  const bins = 24;
  const binCounts = new Array(bins).fill(0);
  hourCounts.forEach((count, hour) => {
    const bin = Math.min(bins - 1, Math.floor(hour));
    binCounts[bin] += count;
  });

  // Apply a simple smoothing: each bin influences its neighbors
  const smoothed = new Array(bins).fill(0);
  for (let i = 0; i < bins; i++) {
    let sum = 0;
    let weightSum = 0;
    for (let j = -2; j <= 2; j++) {
      const idx = (i + j + bins) % bins;
      const w = Math.max(0, 1 - Math.abs(j) / 3); // triangular kernel
      sum += binCounts[idx] * w;
      weightSum += w;
    }
    smoothed[i] = weightSum > 0 ? sum / weightSum : 0;
  }

  // Normalize so the "area" under the 24-hour curve is 1
  const total = smoothed.reduce((a, b) => a + b, 0) || 1;
  const normalized = smoothed.map((v) => v / total);

  // Return a function that interpolates between bins
  return (hour: number) => {
    const bin = hour % 1;
    const idx = Math.floor(hour) % bins;
    const below = normalized[idx];
    const above = normalized[(idx + 1) % bins];
    return below * (1 - bin) + above * bin;
  };
}

function logStats(values: number[]): { mean: number; logSd: number; n: number } {
  const logs = values.map((v) => Math.log(Math.max(0.05, v)));
  const n = logs.length;
  if (!n) return { mean: 0, logSd: 0, n: 0 };
  const mean = logs.reduce((a, b) => a + b, 0) / n;
  const varr = n > 1 ? logs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  // E[FRP] of a lognormal, which is what the daily sum needs.
  return { mean: Math.exp(mean + varr / 2), logSd: Math.sqrt(varr), n };
}

/** Real detections inside one area, split by instrument and by UTC day. */
function observeArea(region: Region, live: LiveBundle) {
  const byDay = new Map<string, DayObservation>();
  const frpByDay = new Map<string, number>();
  const frpModis: number[] = [];
  const frpViirs: number[] = [];
  const day = (iso: string): DayObservation => {
    let d = byDay.get(iso);
    if (!d) {
      d = { m: 0, v: 0, n: 0, n21: 0 };
      byDay.set(iso, d);
    }
    return d;
  };
  let sumM = 0;
  let sumV = 0;
  let overlapDays = 0;
  for (const f of live.fires) {
    if (!pointInBbox(f[0], f[1], region.bbox)) continue;
    const iso = new Date(f[5] * 1000).toISOString().slice(0, 10);
    if (!liveSensorAvailability(live.meta, iso)[LIVE_SENSOR_KEYS[f[3]]]) continue;
    const d = day(iso);
    frpByDay.set(iso, (frpByDay.get(iso) ?? 0) + f[2]);
    if (f[3] === 0) {
      d.m++;
      sumM++;
      if (f[2] > 0) frpModis.push(f[2]);
    } else if (f[3] === 1) {
      d.v++;
      sumV++;
      if (f[2] > 0) frpViirs.push(f[2]);
    } else if (f[3] === 2) {
      d.n++;
      sumV++;
      if (f[2] > 0) frpViirs.push(f[2]);
    } else {
      d.n21++;
      sumV++;
      if (f[2] > 0) frpViirs.push(f[2]);
    }
  }
  for (const d of byDay.values()) if (d.m > 0 && d.v + d.n + d.n21 > 0) overlapDays++;
  return { byDay, frpByDay, frpModis, frpViirs, sumM, sumV, overlapDays };
}

const observationCache = new Map<string, ReturnType<typeof observeArea>>();

function observations(region: Region, live: LiveBundle | null) {
  const empty = { byDay: new Map(), frpByDay: new Map(), frpModis: [], frpViirs: [], sumM: 0, sumV: 0, overlapDays: 0 };
  if (!live?.fires?.length || !live.meta.windowStart) return empty;
  const key = `${regionKey(region)}|${liveKey(live)}`;
  let hit = observationCache.get(key);
  if (!hit) {
    hit = observeArea(region, live);
    observationCache.set(key, hit);
  }
  return hit;
}

let pooledCache: { key: string; k: number | null; frpModis: number[]; frpViirs: number[]; density: number; shares: CompletionShares | null } | null = null;

/** What the shipped per-country window provides: exact counts for a whole border. */
export interface CountryWindowStats {
  name: string;
  total: number;
  perDay: Record<string, number>;
  perDaySensors: Record<string, Record<string, number>>;
  perDayFrp: Record<string, number>;
  sensors: Record<string, number>;
  areaKm2: number;
  windowStart: string;
  /** Mean fire-radiative power of the detections inside this border in this window (MW). */
  frpMean?: number;
  /** The FIRMS window these counts belong to; a stale file must never calibrate a new one. */
  windowEnd: string;
}

/**
 * The bundle keeps every detection for the pilot bboxes but only a deterministic stride sample
 * outside them, so a hand-picked AOI cannot measure its own rate honestly. A registered lookup
 * hands the pipeline the country's exact window instead: measured, not modelled, and the same
 * bridge-ratio evidence at four orders of magnitude more points than the sample.
 */
let countryLookup: ((countryId: string) => CountryWindowStats | null) | null = null;
export function setCountryWindowLookup(fn: ((countryId: string) => CountryWindowStats | null) | null) {
  countryLookup = fn;
  pooledCache = null;
  calibrationCache.clear();
  cache.clear();
}

/**
 * Country polygons promoted to analysable areas. The world layer is a second region table: a
 * caller that asks for `country-kenya` must get the same Region object the browser builds, or the
 * API and the UI would disagree about a number for the same area.
 */
let countryRegions = new Map<string, Region>();
export function registerCountryRegions(regions: Region[]) {
  countryRegions = new Map(regions.map((r) => [r.id, r]));
  // A country asked for before the layer was installed resolved to REGIONS[0]; drop those entries.
  cache.clear();
}
export function lookupRegion(id: string): Region | null {
  return REGIONS.find((r) => r.id === id) ?? countryRegions.get(id) ?? null;
}
export function countryRegionCount(): number {
  return countryRegions.size;
}

function insidePilotCoverage(region: Region): boolean {
  const [w, s, e, n] = region.bbox;
  return REGIONS.some((r) => w >= r.bbox[0] && e <= r.bbox[2] && s >= r.bbox[1] && n <= r.bbox[3]);
}

function countryStatsFor(region: Region, live: LiveBundle | null): CountryWindowStats | null {
  if (!region.countryId || !countryLookup || !live?.meta.windowEnd) return null;
  // The border window only outranks an area's own readings where the area *is* the border, or where
  // the bundle holds nothing but a stride sample for it. A hand-picked AOI inside a pilot bbox has
  // every detection measured inside its own radius — the whole-border count is the coarser reading
  // and must not replace it.
  const isBorder = region.id.startsWith('country-');
  if (!isBorder && insidePilotCoverage(region)) return null;
  const s = countryLookup(region.countryId);
  // A border the satellites scanned and produced nothing for is still a measurement: `total: 0`
  // is the country's rate, and must not fall through to the pooled pilot density.
  if (!s) return null;
  return s.windowStart === live.meta.windowStart && s.windowEnd === live.meta.windowEnd && s.perDaySensors && s.perDayFrp ? s : null;
}

/**
 * The live days of a country come from its own border count instead of the bundle's stride
 * sample. Every day in the window gets a row — including days that produced nothing, which are
 * observed zeros — so no day can keep a modelled value next to its neighbours' sampled ones.
 */
function countryObservations(exact: CountryWindowStats, meta: LiveMeta) {
  const byDay = new Map<string, DayObservation>();
  const frpByDay = new Map<string, number>();
  let sumM = 0, sumV = 0, overlapDays = 0;
  for (let date = meta.windowStart; date <= meta.windowEnd; date = addDays(date, 1)) {
    const sensors = exact.perDaySensors[date] ?? {};
    const seen = liveSensorAvailability(meta, date);
    const m = sensors['MODIS'] ?? 0;
    const v = sensors['VIIRS-SNPP'] ?? 0;
    const n = sensors['NOAA-20'] ?? 0;
    const n21 = sensors['NOAA-21'] ?? 0;
    byDay.set(date, { m, v, n, n21 });
    frpByDay.set(date, exact.perDayFrp[date] ?? 0);
    sumM += m; sumV += v + n + n21;
    if (seen.modis && (seen.viirs || seen.noaa20 || seen.noaa21)) overlapDays++;
  }
  return { byDay, frpByDay, frpModis: [] as number[], frpViirs: [] as number[], sumM, sumV, overlapDays };
}

/** The pilot regions' measured rates, pooled: the fallback for an area whose own
 * live window is too thin to calibrate from. */
function pooledCalibration(live: LiveBundle | null) {
  const key = liveKey(live);
  if (pooledCache && pooledCache.key === key) return pooledCache;
  let sumM = 0;
  let sumV = 0;
  const frpModis: number[] = [];
  const frpViirs: number[] = [];
  const densities: number[] = [];
  let snpp = 0, noaa20 = 0, noaa21 = 0;
  const start = live?.meta?.windowStart ?? '';
  const end = live?.meta?.windowEnd ?? '';
  for (const region of REGIONS) {
    const obs = observations(region, live);
    const byDay = obs.byDay;
    // The bridge ratio is measured only on days both lanes published. A MODIS-only day
    // (VIIRS never pulled) must not dilute the denominator with a silent zero.
    for (let date = start; live && date <= end; date = addDays(date, 1)) {
      const seen = liveSensorAvailability(live?.meta ?? null, date);
      const viirs = seen.viirs || seen.noaa20 || seen.noaa21;
      if (!seen.modis || !viirs) continue;
      const d = byDay.get(date) ?? { m: 0, v: 0, n: 0, n21: 0 };
      sumM += d.m; sumV += d.v + d.n + d.n21;
    }
    for (let date = start; live && date <= end; date = addDays(date, 1)) {
      const d = byDay.get(date);
      if (!d) continue;
      snpp += d.v; noaa20 += d.n; noaa21 += d.n21;
    }
    frpModis.push(...obs.frpModis);
    frpViirs.push(...obs.frpViirs);
    const days = windowDayCount(live);
    if (days > 0 && obs.sumV) densities.push(obs.sumV / days / region.areaKm2);
  }
  const k = sumM >= MIN_AREA_OVERLAP_MODIS ? sumV / sumM : 0;
  const total = snpp + noaa20 + noaa21 || 1;
  const shares = { snpp: snpp / total, noaa20: noaa20 / total, noaa21: noaa21 / total };
  const sorted = densities.slice().sort((a, b) => a - b);
  const density = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  pooledCache = { key, k, frpModis, frpViirs, density, shares };
  return pooledCache;
}

function windowDayCount(live: LiveBundle | null): number {
  if (!live?.meta?.windowStart || !live?.meta?.windowEnd) return 0;
  const a = Date.parse(`${live.meta.windowStart}T00:00:00Z`);
  const b = Date.parse(`${live.meta.windowEnd}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 86400000) + 1 : 0;
}

/**
 * Measure everything the reconstruction is about to multiply: the area's own
 * detections-per-day, the MODIS→VIIRS bridge ratio, the spacecraft split, and the
 * fire-radiative-power carried by a single detection. Nothing here is a constant.
 */
export function calibrationFor(region: Region, live: LiveBundle | null): Calibration | null {
  const days = windowDayCount(live);
  if (!live || !days) return null;
  const obs = observations(region, live);
  const pool = pooledCalibration(live);
  const exact = countryStatsFor(region, live);
  const measuredShares = liveCompletion(exact ? countryObservations(exact, live.meta).byDay : obs.byDay, live.meta);
  // Outside a pilot bbox the bundle holds only a stride sample, so a hand-picked AOI's own count
  // measures the sampling rate, not the fire rate. Its country's exact window is the honest level.
  const fullyObserved = insidePilotCoverage(region);
  const countryModis = exact ? exact.sensors.MODIS || 0 : 0;
  // A country's own bridge is measured on days both lanes published, not on window
  // margins. A MODIS-only day (VIIRS never pulled) does not contribute a silent zero.
  let countryK = 0;
  if (exact) {
    let cSumM = 0, cSumV = 0;
    for (let date = live.meta.windowStart; date <= live.meta.windowEnd; date = addDays(date, 1)) {
      const seen = liveSensorAvailability(live.meta, date);
      const viirs = seen.viirs || seen.noaa20 || seen.noaa21;
      if (!seen.modis || !viirs) continue;
      const s = exact.perDaySensors[date] ?? {};
      cSumM += s['MODIS'] ?? 0;
      cSumV += (s['VIIRS-SNPP'] ?? 0) + (s['NOAA-20'] ?? 0) + (s['NOAA-21'] ?? 0);
    }
    countryK = cSumM > 0 ? cSumV / cSumM : 0;
  }
  /** A country's own window is measured globally from the four FIRMS CSVs, so where it exists it
   *  replaces the area's readings outright — including for a country whose bbox spans every
   *  longitude (Russia, Antarctica), where the band count is not the country's count, and for a
   *  country whose centre happens to sit inside a pilot bbox (Brazil), where the area reading is
   *  only the pilot's. */
  const trustCountry = !!exact;
  // Area bridge over shared (both lanes published) days only.
  let areaSumM = 0, areaSumV = 0;
  if (!trustCountry) {
    for (let date = live.meta.windowStart; date <= live.meta.windowEnd; date = addDays(date, 1)) {
      const seen = liveSensorAvailability(live.meta, date);
      const viirs = seen.viirs || seen.noaa20 || seen.noaa21;
      if (!seen.modis || !viirs) continue;
      const d = obs.byDay.get(date) ?? { m: 0, v: 0, n: 0, n21: 0 };
      areaSumM += d.m; areaSumV += d.v + d.n + d.n21;
    }
  }
  const areaK = areaSumM > 0 ? areaSumV / areaSumM : 0;
  const useAreaK = !trustCountry && areaSumM >= MIN_AREA_OVERLAP_MODIS && areaSumV > 0;
  const k = useAreaK ? areaK : countryK || pool.k;
  if (!k) return null;
  const kSource: Calibration['kSource'] = useAreaK ? 'area' : countryK ? 'country-window' : 'pilot-regions';

  // Days the area was observed but produced no detection are real zeros, so the
  // mean runs over every day in the window, not only the days with a hit.
  let harmonizedTotal = 0;
  let snpp = 0;
  let noaa20 = 0;
  let noaa21 = 0;
  for (let i = 0; i < days; i++) {
    const iso = addDays(live.meta.windowStart, i);
    const seen = liveSensorAvailability(live.meta, iso);
    const d = obs.byDay.get(iso) ?? { m: 0, v: 0, n: 0, n21: 0 };
    const viirs = observedViirs(d, seen, measuredShares);
    harmonizedTotal += viirs ? viirs.harmonized : d.m * k;
    snpp += d.v;
    noaa20 += d.n;
    noaa21 += d.n21;
  }
  let levelPerDay: number;
  let levelSource: Calibration['levelSource'];
  if (exact) {
    // Same rule the record uses on a real day — the VIIRS-equivalent count where VIIRS saw the
    // fire, the MODIS count converted where it did not — so the level and the calendar tie out.
    let harmonized = 0;
    for (let i = 0; i < days; i++) {
      const iso = addDays(live.meta.windowStart, i);
      const seen = liveSensorAvailability(live.meta, iso);
      const s = exact.perDaySensors[iso] ?? {};
      const d = { m: s['MODIS'] ?? 0, v: s['VIIRS-SNPP'] ?? 0, n: s['NOAA-20'] ?? 0, n21: s['NOAA-21'] ?? 0 };
      const viirs = observedViirs(d, seen, measuredShares);
      harmonized += viirs ? viirs.harmonized : d.m * k;
    }
    levelPerDay = (harmonized / days / exact.areaKm2) * region.areaKm2;
    levelSource = 'country-window';
  } else if (fullyObserved && obs.sumV + obs.sumM > 0) {
    levelPerDay = harmonizedTotal / days;
    levelSource = 'area';
  } else {
    levelPerDay = pool.density * region.areaKm2;
    levelSource = 'pilot-density';
  }

  const frpSource: Calibration['frpSource'] = !trustCountry && obs.frpViirs.length >= 30 && obs.frpModis.length >= 30 ? 'area' : 'pilot-regions';
  const frpV = frpSource === 'area' ? logStats(obs.frpViirs) : logStats(pool.frpViirs);
  const frpM = frpSource === 'area' ? logStats(obs.frpModis) : logStats(pool.frpModis);
  const viirsTotal = snpp + noaa20 + noaa21 || 1;
  const shares = measuredShares ?? { snpp: snpp / viirsTotal, noaa20: noaa20 / viirsTotal, noaa21: noaa21 / viirsTotal };
  return {
    levelPerDay,
    windowDays: days,
    overlapDays: trustCountry && exact ? (countryModis && exact.total - countryModis ? Object.keys(exact.perDay).length : 0) : obs.overlapDays,
    sumModis: trustCountry && exact ? countryModis : obs.sumM,
    sumViirs: trustCountry && exact ? exact.total - countryModis : obs.sumV,
    k,
    kSource,
    viirsShares: shares,
    frp: { modis: frpM, viirs: frpV },
    frpSource,
    levelSource,
  };
}

const calibrationCache = new Map<string, Calibration | null>();

function calibration(region: Region, live: LiveBundle | null): Calibration | null {
  const key = `${regionKey(region)}:${liveKey(live)}`;
  if (!calibrationCache.has(key)) calibrationCache.set(key, calibrationFor(region, live));
  return calibrationCache.get(key)!;
}

/**
 * Copy the fields an overlay is about to overwrite, so the day keeps both readings: what the
 * reconstruction said and what the satellites said. A single-provenance diagnostic needs the
 * per-sensor counts too, not only the headline number.
 */
function snapshotModel(r: DailyRecord): DailyRecord['modelled'] {
  return { raw: r.raw, harmonized: r.harmonized, modis: r.modis, viirs: r.viirs, noaa20: r.noaa20, noaa21: r.noaa21, frp: r.frp };
}

function buildRecord(region: Region, live: LiveBundle | null): DailyRecord[] {
  const liveMeta = live?.meta ?? null;
  const today = liveMeta?.windowEnd ?? isoDate(new Date());
  const end = today < START ? START : today;
  const rng = mulberry32(hashString(`continuum-v1:${region.id}`));
  const weights = monthlyWeights(region);
  const cal = calibration(region, live);
  const { series: climate, source: climateId } = climateFor(region);
  const yearRegime = new Map<number, number>();

  // Pass 1 — the shape of every day, from observation only: the MERRA-2 monthly
  // favourability, the MERRA-2 annual regime, the MERRA-2 daily anomaly. Each term
  // is drawn once so the anchor and the record replay exactly the same days.
  type DayShape = { date: string; year: number; month: number; doy: number; shape: number };
  const shapes: DayShape[] = [];
  let ar = 0;
  let cursor = START;
  while (cursor <= end) {
    const d = parseISO(cursor);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const annualZ = climate?.annualZ[String(year)];
    let yearFactor: number;
    if (annualZ != null) yearFactor = Math.exp(0.26 * annualZ - 0.5 * 0.26 * 0.26);
    else {
      if (!yearRegime.has(year)) {
        const drawn = Math.exp(0.26 * gaussian(rng) - 0.5 * 0.26 * 0.26);
        yearRegime.set(year, drawn);
      }
      yearFactor = yearRegime.get(year)!;
    }
    const anom = climate && climateId ? burnWeatherAnomaly(climateId, cursor) : null;
    let weather: number;
    if (anom != null && climate && climate.anomSd > 0) weather = Math.exp(0.38 * (anom / climate.anomSd) - 0.5 * 0.38 * 0.38);
    else {
      ar = 0.82 * ar + Math.sqrt(1 - 0.82 * 0.82) * gaussian(rng);
      weather = Math.exp(0.38 * ar - 0.5 * 0.38 * 0.38);
    }
    shapes.push({
      date: cursor,
      year,
      month,
      doy: dayOfYear(cursor),
      shape: dayWeight(weights, month, d.getUTCDate()) * yearFactor * weather,
    });
    cursor = addDays(cursor, 1);
  }

  // Pass 2 — scale the shape so its live-window mean equals the level actually
  // measured in that window. This replaces the hand-typed reference rate.
  const anchorIndex = new Map<string, number>();
  for (const s of shapes) anchorIndex.set(s.date, s.shape);
  let anchor = 1;
  if (cal && liveMeta?.windowStart) {
    let acc = 0;
    let n = 0;
    for (let i = 0; i < cal.windowDays; i++) {
      const iso = addDays(liveMeta.windowStart, i);
      const v = anchorIndex.get(iso);
      if (v != null) {
        acc += v;
        n++;
      }
    }
    if (n) anchor = acc / n;
  }
  const level = cal?.levelPerDay ?? 0;
  const k = cal?.k ?? 1;

  const pre: Array<{
    date: string;
    year: number;
    month: number;
    doy: number;
    modis: number;
    viirs: number;
    noaa20: number;
    noaa21: number;
    frpM: number;
    frpV: number;
    match: boolean;
  }> = [];

  for (const s of shapes) {
    const era = sensorEra(s.date);
    const lambda = Math.max(0, (level * s.shape) / anchor);

    // λ is already in VIIRS-equivalent units, so the VIIRS total is Poisson(λ) and
    // MODIS sees 1/k of the same fires. k is the measured bridge ratio.
    const viirsTotal = era.viirs ? poisson(lambda, rng) : 0;
    const modis = era.modis ? poisson(lambda / k, rng) : 0;
    const snppShare = cal?.viirsShares.snpp ?? 1;
    const noaa20Share = era.noaa ? (cal?.viirsShares.noaa20 ?? 0) : 0;
    const noaa21Share = era.noaa21 ? (cal?.viirsShares.noaa21 ?? 0) : 0;
    const shareTotal = snppShare + noaa20Share + noaa21Share || 1;
    const viirs = Math.round((viirsTotal * snppShare) / shareTotal);
    const noaa20 = Math.round((viirsTotal * noaa20Share) / shareTotal);
    const noaa21 = Math.max(0, viirsTotal - viirs - noaa20);

    // FRP per detection comes from the live detections themselves; the spread is
    // the measured spread of those same values, not a guessed variance.
    const frpM = modis ? modis * (cal?.frp.modis.mean ?? 0) * Math.exp((cal?.frp.modis.logSd ?? 0) * gaussian(rng)) : 0;
    const frpV =
      viirs + noaa20 + noaa21
        ? (viirs + noaa20 + noaa21) * (cal?.frp.viirs.mean ?? 0) * Math.exp((cal?.frp.viirs.logSd ?? 0) * gaussian(rng))
        : 0;

    pre.push({
      date: s.date, year: s.year, month: s.month, doy: s.doy,
      modis, viirs, noaa20, noaa21,
      frpM, frpV,
      match: era.viirs && modis > 0 && viirs > 0,
    });
  }

  // A day observed by one spacecraft is still printed in the full-constellation unit, so the
  // completion shares come from the archive once all three lanes are pulled and from the live
  // window until then. Without a share model, the archive's first days would step down at 2012.
  const measured = constellationWeights(region.id);
  const completion = measured ?? (cal ? { ...cal.viirsShares } : null);
  // Bridge ratio for MODIS-only days, in order of evidence: the keyed archive measures
  // it over every real day both instruments saw; the live window reaches one week; the
  // model's own overlap is the last resort and keeps the series internally consistent.
  const bridge = archiveRatio(region, completion);
  let ratio = bridge?.k ?? cal?.k ?? 0;
  let sumM = bridge?.sumM ?? 0;
  let sumV = bridge?.sumV ?? 0;
  let overlap = bridge?.days ?? 0;
  if (!ratio) {
    for (const r of pre) {
      if (!r.match || r.date >= (liveMeta?.windowStart ?? '')) continue;
      sumM += r.modis;
      sumV += r.viirs;
      overlap++;
    }
    ratio = sumM > 0 && sumV > 0 ? sumV / sumM : 0;
  }
  const ratioSampleM = ratio ? Math.max(12, sumM) : 0;
  const varRatio = ratio > 0 ? ratio * ratio * (1 / ratioSampleM + 1 / Math.max(12, sumV)) : 0;
  const seRatio = Math.sqrt(varRatio);

  const records: DailyRecord[] = pre.map((r) => {
    const after = r.date >= VIIRS_START;
    // The harmonized unit is "a VIIRS detection", and in the live window three
    // spacecraft contribute one each — so the reference day counts all of them.
    const viirsTotal = r.viirs + r.noaa20 + r.noaa21;
    const useViirs = after && viirsTotal > 0;
    let harmonized: number;
    let lo: number;
    let hi: number;
    let trust: TrustLevel;
    if (useViirs) {
      harmonized = viirsTotal;
      const se = Math.sqrt(harmonized + (0.03 * harmonized + 0.15) ** 2);
      lo = Math.max(0, harmonized - 1.645 * se);
      hi = harmonized + 1.645 * se;
      trust = 'high';
    } else {
      harmonized = r.modis * ratio;
      const se = Math.sqrt(ratio * ratio * r.modis + r.modis * r.modis * varRatio + (0.055 * harmonized + 0.2) ** 2);
      lo = Math.max(0, harmonized - 1.645 * se);
      hi = harmonized + 1.645 * se;
      trust = r.year < 2004 ? 'low' : r.modis < 6 ? 'medium' : 'high';
    }
    const raw = after ? (viirsTotal > 0 ? viirsTotal : r.modis) : r.modis;
    return {
      date: r.date,
      year: r.year,
      month: r.month,
      doy: r.doy,
      modis: r.modis,
      viirs: r.viirs,
      noaa20: r.noaa20,
      noaa21: r.noaa21,
      raw,
      harmonized,
      lo,
      hi,
      frp: after ? r.frpV || r.frpM : r.frpM,
      trust,
      provisional: false,
      source: 'model',
      live: false,
    };
  });

  // Archive overlay: real NASA detections replace the reconstruction wherever the keyed
  // archive reaches. Coverage decides, not the count — a day the product published with
  // zero fires is an observed zero, a day it has not published stays a modelled day.
  // The live window is applied after this, so the freshest week keeps its LIVE label.
  if (archiveLoaded()) {
    for (const r of records) {
      const hit = archiveDay(region.id, r.date);
      if (!hit) continue;
      const { cell, kindM, kindV, kindN, kindN21 } = hit;
      // Keep what the reconstruction said about this day. The diagnostics need to be able to
      // read one provenance on both sides of 2012, and to compare an observation with the
      // model on the very same days rather than across different calendars.
      r.modelled = snapshotModel(r);
      // Coverage, not the count, decides what the UI may print: a day the product
      // published with no detections is an observed zero, a sensor whose lane has not
      // been pulled yet is unknown and must never read as "no fires".
      r.observed = { modis: kindM >= 0, viirs: kindV >= 0, noaa20: kindN >= 0, noaa21: kindN21 >= 0 };
      r.modis = cell.m;
      r.viirs = cell.v;
      r.noaa20 = cell.n;
      r.noaa21 = cell.n21;
      r.frp = cell.frpM + cell.frpV;
      r.source = 'archive';
      // NRT lanes are provisional the same way the live window is; SP lanes are settled.
      r.provisional = kindM === 1 || kindV === 1 || kindN === 1 || kindN21 === 1;
      const seenVIIRS = kindV >= 0 || kindN >= 0 || kindN21 >= 0;
      if (seenVIIRS) {
        const full = kindV >= 0 && kindN >= 0 && kindN21 >= 0;
        const share = completion ? (kindV >= 0 ? completion.snpp : 0) + (kindN >= 0 ? completion.noaa20 : 0) + (kindN21 >= 0 ? completion.noaa21 : 0) : 0;
        r.constellation = full ? 'complete' : share > 0 ? 'estimated' : 'partial';
        r.harmonized = Math.round(platformEquivalent(region.id, cell, kindV, kindN, kindN21, completion) ?? 0);
        r.raw = (kindV >= 0 ? cell.v : 0) + (kindN >= 0 ? cell.n : 0) + (kindN21 >= 0 ? cell.n21 : 0);
        const spread = r.provisional ? [0.08, 0.25] : [0.03, 0.15];
        const se = Math.sqrt(r.harmonized + (spread[0] * r.harmonized + spread[1]) ** 2);
        r.lo = Math.max(0, r.harmonized - 1.645 * se);
        r.hi = r.harmonized + 1.645 * se;
        r.trust = r.constellation === 'complete' ? 'high' : r.constellation === 'estimated' ? 'medium' : 'low';
      } else {
        r.harmonized = cell.m * ratio;
        r.raw = cell.m;
        const se = Math.sqrt(ratio * ratio * cell.m + cell.m * cell.m * varRatio + (0.055 * r.harmonized + 0.2) ** 2);
        r.lo = Math.max(0, r.harmonized - 1.645 * se);
        r.hi = r.harmonized + 1.645 * se;
        r.trust = cell.m < 6 ? 'medium' : 'high';
      }
    }
  }

  // Live overlay: real FIRMS detections replace the reference record inside the
  // rolling window, and days with no real detection become zero — never model.
  const liveStart = liveMeta?.windowStart ?? '';
  // Only a complete pull may turn a missed day into an observed zero: inside a pilot bbox the
  // snapshot's own counts prove completeness, and a country's border window is measured globally.
  // Anywhere else the bundle holds a stride sample, so the day keeps its modelled value and its
  // model label instead of a count that is really the sampling rate.
  const exact = countryStatsFor(region, live);
  const useCountryObservations = region.id.startsWith('country-') && !!exact;
  const completePull = useCountryObservations || insidePilotCoverage(region);
  const hasLiveFeeds = liveMeta ? Object.values(liveSensorAvailability(liveMeta, liveMeta.windowStart)).some(Boolean) : false;
  if (liveMeta && liveStart && completePull && hasLiveFeeds) {
    const observed = useCountryObservations && exact ? countryObservations(exact, liveMeta) : observations(region, live);
    const weights = liveCompletion(observed.byDay, liveMeta);
    const byDate = new Map(records.map((r) => [r.date, r]));
    for (const r of records) {
      if (r.date < liveStart || r.date > liveMeta.windowEnd) continue;
      r.modelled = r.modelled ?? snapshotModel(r);
      const seen = liveSensorAvailability(liveMeta, r.date);
      const d = observed.byDay.get(r.date) ?? { m: 0, v: 0, n: 0, n21: 0 };
      r.modis = seen.modis ? d.m : 0;
      r.viirs = seen.viirs ? d.v : 0;
      r.noaa20 = seen.noaa20 ? d.n : 0;
      r.noaa21 = seen.noaa21 ? d.n21 : 0;
      r.frp = observed.frpByDay.get(r.date) ?? 0;
      r.observed = seen;
      r.live = true;
      r.source = 'live';
      r.provisional = true;
      const viirs = observedViirs(d, seen, weights);
      if (viirs) {
        r.harmonized = Math.round(viirs.harmonized);
        r.raw = viirs.raw;
        r.constellation = viirs.constellation;
      } else {
        r.harmonized = d.m * ratio;
        r.raw = d.m;
        delete r.constellation;
      }
      const spread = [0.08, 0.25];
      const se = Math.sqrt(Math.max(0, r.harmonized) + (spread[0] * Math.max(0, r.harmonized) + spread[1]) ** 2);
      r.lo = Math.max(0, r.harmonized - 1.645 * se);
      r.hi = r.harmonized + 1.645 * se;
      r.trust = r.constellation === 'partial' ? 'low' : r.constellation === 'estimated' ? 'medium' : 'high';
    }
  }

  return records;
}

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

/**
 * The count for one instrument as the UI should print it. An archive day whose lane for
 * that sensor has not been pulled shows an em dash, never the zero sitting in the cell:
 * "we have no MODIS row yet" and "MODIS saw nothing" are different claims.
 */
export function sensorCount(r: DailyRecord, key: 'modis' | 'viirs' | 'noaa20' | 'noaa21'): string {
  return r.observed && !r.observed[key] ? '—' : String(r[key]);
}

export function dailyValue(r: DailyRecord, metric: Metric, mode: Mode): number {
  if (metric === 'firedays') return (mode === 'raw' ? r.raw : r.harmonized) > 0 ? 1 : 0;
  if (metric === 'frp') return r.frp;
  return mode === 'raw' ? r.raw : r.harmonized;
}

export function recordsInRange(records: DailyRecord[], from: string, to: string): DailyRecord[] {
  return records.filter((r) => r.date >= from && r.date <= to);
}

/**
 * Prefix-sum index over the harmonized daily series: ISO dates compare correctly as strings, so the
 * "sum this window" question the analog backtests ask thousands of times becomes a binary search
 * instead of a full-array filter and reduce. Built once per region because the record arrays are cached.
 */
type SumSpan = { dates: string[]; prefix: Float64Array };
type RangeIndex = { all: SumSpan; byYear: Map<number, SumSpan>; years: number[] };

const rangeIndexCache = new WeakMap<DailyRecord[], RangeIndex>();

function lowerBound(dates: string[], value: string): number {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(dates: string[], value: string): number {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function spanOf(source: SumSpan, from: string, to: string) {
  const lo = lowerBound(source.dates, from);
  const hi = upperBound(source.dates, to);
  return { lo, hi, sum: source.prefix[hi] - source.prefix[lo] };
}

function buildSumSpan(rows: DailyRecord[]): SumSpan {
  const dates = rows.map((r) => r.date);
  const prefix = new Float64Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++) prefix[i + 1] = prefix[i] + rows[i].harmonized;
  return { dates, prefix };
}

function rangeIndex(records: DailyRecord[]): RangeIndex {
  const cached = rangeIndexCache.get(records);
  if (cached) return cached;
  const ordered = [...records].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const grouped = new Map<number, DailyRecord[]>();
  for (const r of ordered) {
    const bucket = grouped.get(r.year);
    if (bucket) bucket.push(r);
    else grouped.set(r.year, [r]);
  }
  const byYear = new Map<number, SumSpan>();
  for (const [year, rows] of grouped) byYear.set(year, buildSumSpan(rows));
  const index: RangeIndex = { all: buildSumSpan(ordered), byYear, years: [...grouped.keys()].sort((a, b) => a - b) };
  rangeIndexCache.set(records, index);
  return index;
}

export function annualSeries(records: DailyRecord[], metric: Metric, mode: Mode): { year: number; value: number; partial: boolean }[] {
  const target = records[records.length - 1]?.year ?? 2026;
  const map = new Map<number, { sum: number; days: number }>();
  for (const r of records) {
    const e = map.get(r.year) ?? { sum: 0, days: 0 };
    e.sum += dailyValue(r, metric, mode);
    e.days++;
    map.set(r.year, e);
  }
  return [...map.entries()]
    .map(([year, e]) => ({ year, value: e.sum, partial: year === target || (year === 2000 && e.days < 300) }))
    .sort((a, b) => a.year - b.year);
}

export function monthComparison(
  records: DailyRecord[],
  month: number,
  metric: Metric,
  mode: Mode,
  today: string,
): MonthComparison {
  const currentYear = parseISO(today).getUTCFullYear();
  const currentDay = parseISO(today).getUTCDate();
  const byYear = new Map<number, number>();
  for (const r of records) {
    if (r.month !== month) continue;
    if (r.year === currentYear && r.date > today) continue;
    if (r.year === currentYear && r.month === parseISO(today).getUTCMonth() + 1 && r.date !== today) {
      if (parseISO(r.date).getUTCDate() > currentDay) continue;
    }
    byYear.set(r.year, (byYear.get(r.year) ?? 0) + dailyValue(r, metric, mode));
  }
  const years = [...byYear.entries()].map(([year, value]) => ({
    year,
    value,
    partial: year === currentYear,
  }));
  years.sort((a, b) => a.year - b.year);
  const history = years.filter((y) => y.year < currentYear && !y.partial).map((y) => y.value).sort((a, b) => a - b);
  const currentValue = byYear.get(currentYear) ?? 0;
  const median = quantile(history, 0.5);
  const p25 = quantile(history, 0.25);
  const p75 = quantile(history, 0.75);
  const lastN = (n: number) => mean(history.slice(-n));
  const topYears = [...years].sort((a, b) => b.value - a.value).slice(0, 5);
  return {
    month,
    years,
    median,
    p25,
    p75,
    currentYear,
    currentValue,
    percentile: percentileRank(history, currentValue),
    anomalyPct: median ? ((currentValue - median) / median) * 100 : 0,
    mean5: lastN(5),
    mean10: lastN(10),
    mean20: lastN(20),
    topYears,
  };
}

function bandFor(percentile: number): StatusResult['band'] {
  if (percentile >= 97) return 'extreme';
  if (percentile >= 90) return 'high';
  if (percentile >= 75) return 'elevated';
  if (percentile >= 25) return 'normal';
  return 'quiet';
}

export function statusFor(
  region: Region,
  records: DailyRecord[],
  today: string,
  metric: Metric = 'hotspots',
  mode: Mode = 'harmonized',
): StatusResult {
  const d = parseISO(today);
  const month = d.getUTCMonth() + 1;
  const year = d.getUTCFullYear();
  const cutoff = d.getUTCDate();
  // Month-to-date comparison is more stable than a single day and matches the
  // emergency-manager question: "is this month unusual so far?"
  const perYear = new Map<number, number>();
  const perYearDays = new Map<number, number>();
  for (const r of records) {
    if (r.year >= year) continue;
    if (r.month !== month) continue;
    const day = parseISO(r.date).getUTCDate();
    if (day > cutoff) continue;
    perYear.set(r.year, (perYear.get(r.year) ?? 0) + dailyValue(r, metric, mode));
    perYearDays.set(r.year, (perYearDays.get(r.year) ?? 0) + 1);
  }
  const history = [...perYear.entries()]
    .filter(([y, v]) => y >= year - 25 && (perYearDays.get(y) ?? 0) >= Math.min(20, cutoff - 2))
    .map(([, v]) => v)
    .sort((a, b) => a - b);
  let current = 0;
  for (const r of records) {
    if (r.year !== year || r.month !== month) continue;
    if (parseISO(r.date).getUTCDate() > cutoff) continue;
    current += dailyValue(r, metric, mode);
  }
  const baseline = quantile(history, 0.5);
  const pct = percentileRank(history, current);
  const latest = records.filter((r) => r.date <= today).slice(-1)[0];
  const freshness = latest ? Math.max(0, Math.round((parseISO(today).getTime() - parseISO(latest.date).getTime()) / 86400000)) : 99;
  const ratio = baseline ? current / baseline : 0;
  const band = bandFor(pct);
  const metricWord = metric === 'firedays' ? 'fire-days' : metric === 'frp' ? 'fire radiative power' : 'hotspots';
  const sentence =
    history.length < 5
      ? `Not enough history to rank this month reliably. Showing the observed ${metricWord} for ${region.shortName}.`
      : current === 0
        ? `No ${metricWord} recorded in ${region.shortName} for ${cutoff} days into ${monthName(month)}. That is not proof of no fire — only no detection.`
        : `${region.shortName} is at the ${ordinal(Math.round(pct))} percentile of the ${year - 25}–${year - 1} record for the first ${cutoff} days of ${monthName(month)}. ` +
          `${ratio >= 1 ? `${ratio.toFixed(1)}× the historical median` : `${Math.round((1 - ratio) * 100)}% below the historical median`}. ` +
          `Band: ${band}. Thresholds: elevated ≥75th, high ≥90th, extreme ≥97th.`;
  return {
    date: today,
    regionId: region.id,
    windowDays: cutoff,
    current,
    baselineMedian: baseline,
    percentile: pct,
    band,
    ratioToMedian: ratio,
    anomalyPct: baseline ? ((current - baseline) / baseline) * 100 : 0,
    freshnessDays: freshness,
    provisional: !!latest?.provisional,
    sentence,
  };
}

function monthName(m: number): string {
  return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1];
}

export function seasonClock(records: DailyRecord[], year: number, today: string): SeasonClock {
  const byDoy = new Map<number, number[]>();
  for (const r of records) {
    if (r.year >= year) continue;
    if (r.year === 2000 && r.month === 11 && r.doy < 300) continue;
    const arr = byDoy.get(r.doy) ?? [];
    arr.push(r.harmonized);
    byDoy.set(r.doy, arr);
  }
  const clim: number[] = [];
  for (let doy = 1; doy <= 366; doy++) {
    const arr = byDoy.get(doy);
    clim.push(arr && arr.length ? mean(arr) : 0);
  }
  // smooth with a 15-day circular window
  const smooth = clim.map((_, i) => {
    let s = 0;
    for (let k = -7; k <= 7; k++) s += clim[(i + k + 366) % 366];
    return s / 15;
  });
  const total = smooth.reduce((a, b) => a + b, 0) || 1;

  // Anchor the season at the middle of the climatological off-season trough, not at 1 January.
  // A calendar-year anchor makes a Southern Hemisphere peak precede its "start" and double-counts one season.
  const minVal = Math.min(...smooth);
  const isTrough = smooth.map((v) => v <= minVal * 1.001 + 1e-9);
  let anchor = 0;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (let k = 0; k < 732; k++) {
    const i = k % 366;
    if (isTrough[i] && runLen < 366) {
      if (runLen === 0) runStart = i;
      runLen++;
      if (runLen > bestLen) {
        bestLen = runLen;
        anchor = (runStart + Math.floor(runLen / 2)) % 366;
      }
    } else {
      runLen = 0;
    }
  }

  const shiftedDoy = (j: number) => ((anchor + j) % 366) + 1;
  let cum = 0;
  let startJ = 0;
  let endJ = 365;
  let peakJ = 0;
  let peakVal = -1;
  for (let j = 0; j < 366; j++) {
    const v = smooth[shiftedDoy(j) - 1];
    cum += v;
    const frac = cum / total;
    if (frac >= 0.25 && startJ === 0) startJ = j;
    if (frac >= 0.75 && endJ === 365) endJ = j;
    if (v > peakVal) {
      peakVal = v;
      peakJ = j;
    }
  }
  // A unimodal season always has its mode inside the interquartile window; guard the degenerate case.
  if (peakJ < startJ) startJ = peakJ;
  if (peakJ > endJ) endJ = peakJ;
  const start = shiftedDoy(startJ);
  const peak = shiftedDoy(peakJ);
  const end = shiftedDoy(endJ);

  // Current season = the trough-to-trough cycle containing today.
  const currentDoy = dayOfYear(today);
  const todayJ = ((currentDoy - 1 - anchor) % 366 + 366) % 366;
  const seasonStart = addDays(today, -todayJ);
  const currentRecs = records.filter((r) => r.date >= seasonStart && r.date <= today);
  const currentTotal = currentRecs.reduce((a, r) => a + r.harmonized, 0);
  const expectedToDate = currentRecs.reduce((a, r) => a + smooth[(r.doy - 1 + 366) % 366], 0);
  const yearShare = expectedToDate ? (currentTotal / expectedToDate) * 100 : 0;
  const direction = yearShare >= 110 ? 'ahead' : yearShare <= 90 ? 'behind' : 'on pace';
  const phase =
    todayJ < startJ ? 'pre-season' : todayJ < peakJ ? 'building' : todayJ <= endJ ? 'waning' : 'off-season';
  const currentOffsetDays = ((currentDoy - peak + 183 + 366) % 366) - 183;
  const label = (doy: number) => {
    const d = new Date(Date.UTC(2021, 0, 1));
    d.setUTCDate(doy);
    return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
  };
  return {
    startDoy: start,
    peakDoy: peak,
    endDoy: end,
    startLabel: label(start),
    peakLabel: label(peak),
    endLabel: label(end),
    seasonStartLabel: label(anchor + 1),
    currentOffsetDays,
    direction,
    phase,
    yearShare,
  };
}

export interface NotableSeason {
  year: number;
  value: number;
  percentile: number;
  weatherAnomaly: number | null;
}

/**
 * The largest seasons in this area's own record, ranked from the reconstructed
 * annual totals and annotated with the observed burn-weather anomaly of that year.
 * This replaces the curated event list that used to sit in regions.json: nothing
 * here is a hand-written date, and every number is reproducible from the bundle.
 */
export function notableSeasons(records: DailyRecord[], region: Region, limit = 5): NotableSeason[] {
  const annual = annualSeries(records, 'hotspots', 'harmonized').filter((a) => !a.partial && a.year >= 2004);
  if (!annual.length) return [];
  const values = annual.map((a) => a.value).sort((a, b) => a - b);
  const climate = climateFor(region).series;
  return [...annual]
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
    .map((a) => ({
      year: a.year,
      value: a.value,
      percentile: percentileRank(values, a.value),
      weatherAnomaly: climate?.annualZ[String(a.year)] ?? null,
    }));
}

export function twinAnalogs(records: DailyRecord[], today: string, weeks = 8): TwinResult {
  const currentYear = parseISO(today).getUTCFullYear();
  const end = today;
  const start = addDays(end, -weeks * 7 + 1);
  const index = rangeIndex(records);
  const sum = (from: string, to: string) => spanOf(index.all, from, to).sum;
  const dayCount = (from: string, to: string) => {
    const s = spanOf(index.all, from, to);
    return s.hi - s.lo;
  };
  const sumInYear = (year: number, from: string, to: string) => {
    const group = index.byYear.get(year);
    return group ? spanOf(group, from, to).sum : 0;
  };
  // The same week-aligned window is asked for once per candidate year and again for every backtest
  // year, so each distinct start date is reduced a single time.
  const weeklyCache = new Map<string, number[]>();
  const weekly = (from: string): number[] => {
    const cached = weeklyCache.get(from);
    if (cached) return cached;
    const out: number[] = [];
    for (let w = 0; w < weeks; w++) {
      const a = addDays(from, w * 7);
      out.push(sum(a, addDays(a, 6)));
    }
    weeklyCache.set(from, out);
    return out;
  };
  const observed = weekly(start);
  const observedMean = mean(observed) || 1;
  const observedShape = observed.map((v) => v / observedMean);
  const candidates: { year: number; similarity: number; correlation: number; values: number[]; next: number }[] = [];
  for (let y = 2002; y < currentYear; y++) {
    const yStart = `${y}${start.slice(4)}`;
    const yEnd = `${y}${end.slice(4)}`;
    if (dayCount(yStart, yEnd) < weeks * 7 * 0.8) continue;
    const vals = weekly(yStart);
    const m = mean(vals);
    if (m < 1) continue;
    const shape = vals.map((v) => v / m);
    const rmse = Math.sqrt(mean(shape.map((v, i) => (v - observedShape[i]) ** 2)));
    const sim = clamp(100 * (1 - rmse / 1.2), 0, 100);
    const a = mean(shape);
    const b = mean(observedShape);
    const sa = stdev(shape);
    const sb = stdev(observedShape);
    const corr = sa && sb ? mean(shape.map((v, i) => (v - a) * (observedShape[i] - b))) / (sa * sb) : 0;
    const nextStart = addDays(yEnd, 1);
    const nextEnd = addDays(nextStart, 27);
    const next = sum(nextStart, nextEnd);
    candidates.push({ year: y, similarity: sim, correlation: corr, values: vals, next });
  }
  candidates.sort((a, b) => b.similarity - a.similarity);
  const analogs = candidates.slice(0, 3);
  // Next 4-week climatological median for each analog year
  const outcomes = analogs.map((a) => {
    const climVals = index.years
      .filter((y) => y < a.year && y >= a.year - 15)
      .map((y) => {
        const from = `${y}${end.slice(4)}`;
        return sumInYear(y, from, addDays(from, 27));
      });
    const base = quantile(climVals.filter((v) => v > 0).sort((x, y) => x - y), 0.5);
    return { year: a.year, anomaly: base ? ((a.next - base) / base) * 100 : 0 };
  });
  // Leave-one-out backtest on the historical analogue method
  let hits = 0;
  let trials = 0;
  for (let y = 2006; y < currentYear; y++) {
    const yStart = `${y}${start.slice(4)}`;
    const yEnd = `${y}${end.slice(4)}`;
    const yObs = weekly(yStart);
    if (mean(yObs) < 1) continue;
    const shape = yObs.map((v) => v / mean(yObs));
    let best: { year: number; sim: number } | null = null;
    for (let z = 2002; z < y - 1; z++) {
      const vals = weekly(`${z}${start.slice(4)}`);
      if (mean(vals) < 1) continue;
      const s = vals.map((v) => v / mean(vals));
      const rmse = Math.sqrt(mean(s.map((v, i) => (v - shape[i]) ** 2)));
      const sim = 1 - rmse / 1.2;
      if (!best || sim > best.sim) best = { year: z, sim };
    }
    if (!best) continue;
    const bestFrom = `${best.year}${end.slice(4)}`;
    const analogNext = sum(addDays(bestFrom, 1), addDays(bestFrom, 28));
    const actualNext = sum(addDays(yEnd, 1), addDays(yEnd, 28));
    const clim = index.years
      .filter((yy) => yy < best.year)
      .map((yy) => {
        const from = `${yy}${end.slice(4)}`;
        return sumInYear(yy, addDays(from, 1), addDays(from, 28));
      })
      .filter((v) => v > 0)
      .sort((x, y) => x - y);
    const med = quantile(clim, 0.5);
    const pred = analogNext > med ? 1 : -1;
    const act = actualNext > med ? 1 : -1;
    if (pred === act) hits++;
    trials++;
  }
  const weeksLabels: string[] = [];
  for (let w = 0; w < weeks; w++) weeksLabels.push(`W${w + 1}`);
  return {
    analogs: analogs.map((a, i) => ({
      year: a.year,
      similarity: a.similarity,
      correlation: a.correlation,
      next4WeeksAnomalyPct: outcomes[i]?.anomaly ?? 0,
      values: a.values,
    })),
    observed,
    weeks: weeksLabels,
    backtestHitRate: trials ? (hits / trials) * 100 : 0,
    sampleYears: trials,
    referenceYear: currentYear,
  };
}

function medianOf(values: number[]): number {
  return quantile(values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b), 0.5);
}

/** Robust next-four-week analogue departure. Three analogue seasons can include one extreme year,
 *  so the median is the headline number in every view; per-analogue values stay visible in the Twin. */
export function analogDeparture(twin: TwinResult): number {
  return analogDepartureSummary(twin).median ?? NaN;
}

/** Median headline and separately labelled supplementary mean; missing values are not zeros. */
export function analogDepartureSummary(twin: Pick<TwinResult, 'analogs'>): {
  median: number | null; mean: number | null; sampleSize: number; excludedCount: number;
} {
  const values = twin.analogs.map((a) => a.next4WeeksAnomalyPct).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    median: values.length ? quantile(values, 0.5) : null,
    mean: values.length ? mean(values) : null,
    sampleSize: values.length,
    excludedCount: twin.analogs.length - values.length,
  };
}

export function biasXray(records: DailyRecord[]): BiasResult {
  // The sensor-transition arithmetic needs one provenance on both sides of 2012: wherever
  // the keyed archive reaches, a real 2013 would otherwise sit beside a reconstructed 2011
  // and the step would measure the calibration's level rather than the instruments'. Every
  // observed day keeps the value the reconstruction gave it, so one array carries both
  // readings: the observations alone, and the reconstruction alone. Observations win as
  // soon as they reach back to 2011 (the MODIS archive lane); until then the break is
  // measured on the reconstruction and says so. The seam between the two sources is
  // counted separately, on the same days, and reported by name.
  const observations = records.filter((r) => r.source === 'archive' || r.source === 'live');
  const reconstruction = records.map((r) => (r.modelled ? { ...r, ...r.modelled, modelled: undefined } : r));
  const reached = (rows: DailyRecord[], year: number) => rows.filter((r) => r.year === year).length >= 180;
  const useObservations = reached(observations, 2011) && reached(observations, 2013);
  const breakBasis: 'observations' | 'reconstruction' = useObservations ? 'observations' : 'reconstruction';
  const basis = useObservations ? observations : reconstruction;
  const annualH = annualSeries(basis, 'hotspots', 'harmonized').filter((a) => a.year >= 2004 && a.year <= 2025);
  const annualR = annualSeries(basis, 'hotspots', 'raw').filter((a) => a.year >= 2004 && a.year <= 2025);
  const fitYears = annualH.filter((a) => a.year !== 2012 && a.year !== 2013 && !a.partial);
  const xs = fitYears.map((a) => a.year);
  const ys = fitYears.map((a) => Math.log(Math.max(1, a.value)));
  const mx = mean(xs);
  const my = mean(ys);
  const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / Math.max(1e-9, xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  const intercept = my - slope * mx;
  const predict = (year: number) => Math.exp(intercept + slope * year);
  const trendRatio = predict(2013) / predict(2011);
  const raw2011 = annualR.find((a) => a.year === 2011)?.value ?? 1;
  const raw2013 = annualR.find((a) => a.year === 2013)?.value ?? 1;
  const h2011 = annualH.find((a) => a.year === 2011)?.value ?? 1;
  const h2013 = annualH.find((a) => a.year === 2013)?.value ?? 1;
  const rawBreak = ((raw2013 / Math.max(1, raw2011)) / trendRatio - 1) * 100;
  const corrected = ((h2013 / Math.max(1, h2011)) / trendRatio - 1) * 100;
  const effect = rawBreak - corrected;
  // Recover the bridge quantities from the record itself, then let those measured
  // magnitudes decide how the removed artefact is attributed. No share below is a
  // typed constant: each one is a ratio, a dispersion or an exposure counted here.
  // Conditioning the ratio on days where both counts are non-zero biases it towards 1,
  // because a quiet area draws MODIS zeros far more often than VIIRS zeros. The bridge
  // is measured over every day of the VIIRS era, zero detections included.
  // But a lane that has not been published for a day is *unknown*, not zero: the keyed
  // archive brings Chilecito's MODIS lane to 2015 and its VIIRS lane to 2026, so summing the
  // whole era reads seven years of silence as seven years of no fires and inflates k to 80×.
  // Same coverage rule `sensorCount()` uses before it prints an em dash.
  const bothPublished = (r: DailyRecord) => r.observed?.modis !== false && r.observed?.viirs !== false;
  const era = basis.filter((r) => r.date >= VIIRS_START && bothPublished(r));
  // "Published" is not "observed". Where the keyed archive has not carried a MODIS lane into
  // the VIIRS era, the MODIS side of the day is model output, and a ratio summed over those
  // days is the weighting the reconstruction was built with — not a measurement of two
  // instruments looking at the same fire. The Method line has to say which one it is.
  const observedEra = era.filter((r) => r.observed?.modis === true && r.observed?.viirs === true);
  const overlap = era.filter((r) => r.modis > 0 && r.viirs + r.noaa20 + r.noaa21 > 0);
  const sumM = era.reduce((s, r) => s + r.modis, 0);
  // A day the archive answers with Suomi-NPP alone is a *partial* constellation, and the record
  // puts it on the full-constellation scale by completion weight. Summing the raw lane counts
  // instead would divide that same day by an unweighted MODIS count and report a bridge of 3.7×
  // beside the 10.8× actually applied. Where VIIRS really was observed, take the record's own
  // scaled value; where it is a reconstruction, keep the by-construction lane sum.
  const sumV = era.reduce((s, r) => s + (r.observed?.viirs === true ? r.harmonized : r.viirs + r.noaa20 + r.noaa21), 0);
  const ratio = sumM ? sumV / sumM : 0;
  const se = Math.sqrt(ratio * ratio * (1 / Math.max(12, sumM) + 1 / Math.max(12, sumV)));

  // Energy carried by a single detection, instrument by instrument.
  const viirsDays = basis.filter((r) => r.viirs > 0 && r.frp > 0);
  const modisOnly = basis.filter((r) => r.viirs === 0 && r.modis > 0 && r.frp > 0);
  const frpPerViirs = viirsDays.length ? viirsDays.reduce((s, r) => s + r.frp, 0) / viirsDays.reduce((s, r) => s + r.viirs, 0) : 0;
  const frpPerModis = modisOnly.length ? modisOnly.reduce((s, r) => s + r.frp, 0) / modisOnly.reduce((s, r) => s + r.modis, 0) : 0;
  const frpBridge = frpPerViirs > 0 && frpPerModis > 0 ? Math.abs(Math.log(frpPerModis / frpPerViirs)) : 0;
  // How much of the record had to be rescaled at all, and how far the calibration
  // itself could be off — the honest size of the "imperfect overlap" term.
  const rescaledShare = basis.length ? basis.filter((r) => r.viirs + r.noaa20 + r.noaa21 === 0).length / basis.length : 0;
  const kRelUncertainty = Math.min(1, ratio > 0 ? (1.645 * se) / ratio : 1);

  // The reconstruction→observation seam is a transition, so it is measured on the first
  // year of archive after every model→archive switch, pooled, against what the model would
  // have printed for those same days. Comparing the whole observed record with the model is
  // a model-bias statistic, not a source switch, and reading it as a seam put +3,172% on a
  // region whose archive never leaves observation.
  const seamRows: DailyRecord[] = [];
  let seamSwitches = 0;
  let run = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.source !== 'archive') { run = 0; continue; }
    if (records[i - 1] && records[i - 1].source !== 'archive') { seamSwitches++; run = 0; }
    if (seamSwitches > 0 && run < 365) { seamRows.push(r); run++; }
  }
  let seam: { from: string; days: number; switches: number; pct: number } | null = null;
  if (seamSwitches > 0 && seamRows.length >= 30) {
    const observed = seamRows.reduce((s, r) => s + r.harmonized, 0);
    const modelled = seamRows.reduce((s, r) => s + (r.modelled?.harmonized ?? 0), 0);
    if (modelled > 0) {
      seam = { from: seamRows[0].date, days: seamRows.length, switches: seamSwitches, pct: (observed / modelled - 1) * 100 };
    }
  }

  const weights = [
    {
      key: 'resolution',
      label: 'Pixel resolution & detection probability',
      w: Math.abs(Math.log(ratio)),
      explanation: `A MODIS detection stands for ${ratio.toFixed(2)} VIIRS-equivalent detections across the ${era.length} days of this record where both instruments publish in the VIIRS era (${overlap.length} of them with a detection in both)${observedEra.length ? `, ${observedEra.length} of those days observed side by side in the keyed FIRMS archive` : '; the archive has not published a MODIS lane that reaches into the VIIRS era here, so this is the weighting the reconstruction applies, not a measured bridge'}; the bridge ratio corrects this dominant term.`,
    },
    {
      key: 'sensitivity',
      label: 'Sensitivity & FRP mapping',
      w: frpBridge,
      explanation: `One MODIS detection carries ${frpPerModis.toFixed(1)} MJ/min against ${frpPerViirs.toFixed(1)} MJ/min for a VIIRS detection. Confidence thresholds and fire radiative power differ between instruments and are mapped explicitly.`,
    },
    {
      key: 'overpass',
      label: 'Record rescaled rather than observed',
      w: Math.max(0.01, rescaledShare),
      explanation: `${(rescaledShare * 100).toFixed(0)}% of the record has no VIIRS detection at all, so those days are expressed in VIIRS-equivalent units by rescaling MODIS instead of measuring them directly.`,
    },
    {
      key: 'residual',
      label: 'Residual / imperfect overlap',
      w: Math.max(0.01, kRelUncertainty),
      explanation: `The 90% interval on the bridge ratio is ${ratio.toFixed(2)} ± ${(1.645 * se).toFixed(2)}. Cloud, view angle and sampling noise sit inside that interval; this term is reported, not hidden.`,
    },
  ];
  const wTotal = weights.reduce((s, x) => s + x.w, 0) || 1;
  const components = weights.map((s) => {
    const value = (effect * s.w) / wTotal;
    const band = Math.abs(value) * kRelUncertainty + 0.4;
    return { key: s.key, label: s.label, value, lo: value - band, hi: value + band, explanation: s.explanation };
  });
  return {
    breakBasis,
    rawBreakPct: rawBreak,
    correctedBreakPct: corrected,
    seam,
    reductionPct: rawBreak !== 0 ? clamp(100 * (1 - Math.abs(corrected) / Math.abs(rawBreak)), 0, 100) : 0,
    components,
    annualRaw: annualR.map((a) => ({ year: a.year, value: a.value })),
    annualHarmonized: annualH.map((a) => ({ year: a.year, value: a.value })),
    ratio,
    ratioLo: ratio - 1.645 * se,
    ratioHi: ratio + 1.645 * se,
    eraDays: era.length,
    observedEraDays: observedEra.length,
    overlapDays: overlap.length,
  };
}

export function runSandbox(
  records: DailyRecord[],
  opts: { overpassHour: number; pixelM: number; minFrp: number; correction: boolean; seed?: number },
): SandboxResult {
  const rng = mulberry32(opts.seed ?? 42);
  const recent = records.filter((r) => r.year >= 2024 && r.date <= records[records.length - 1].date);
  const truth: number[] = [];
  const apparent: number[] = [];
  const corrected: number[] = [];
  const pixelFactor = Math.pow(375 / opts.pixelM, 0.55);
  const diurnal = clamp(0.55 + 0.45 * Math.cos(((opts.overpassHour - 13.5) * Math.PI) / 12), 0.12, 1);
  const frpFactor = Math.exp(-opts.minFrp / 26);
  const p = clamp(0.93 * pixelFactor * diurnal * frpFactor, 0.02, 1);
  const pRef = clamp(0.93 * Math.pow(375 / 375, 0.55) * 1 * 1, 0.02, 1);
  for (const r of recent) {
    const t = r.harmonized;
    truth.push(t);
    const a = poisson(t * p, rng);
    apparent.push(a);
    corrected.push(a / p);
  }
  const sumT = truth.reduce((a, b) => a + b, 0) || 1;
  const sumA = apparent.reduce((a, b) => a + b, 0);
  // Score at the decision cadence (7-day blocks), not single days: daily Poisson noise is irreducible
  // and would make a working correction look broken.
  const blockT: number[] = [];
  const blockC: number[] = [];
  for (let i = 0; i + 7 <= truth.length; i += 7) {
    blockT.push(truth.slice(i, i + 7).reduce((a, b) => a + b, 0));
    blockC.push(corrected.slice(i, i + 7).reduce((a, b) => a + b, 0));
  }
  const meanBlockT = blockT.length ? mean(blockT) : 1;
  const recoveryError = blockT.length
    ? (mean(blockC.map((v, i) => Math.abs(v - blockT[i]))) / (meanBlockT || 1)) * 100
    : 0;
  const residualBiasPct = blockT.length ? (blockC.reduce((a, b) => a + b, 0) / blockT.reduce((a, b) => a + b, 0) - 1) * 100 : 0;
  const finalSeries = opts.correction ? corrected : apparent;
  return {
    apparent,
    truth,
    corrected: finalSeries,
    recoveryError,
    rawBiasPct: (sumA / sumT - 1) * 100,
    residualBiasPct,
  };
}

/** Explicit inputs for numerical evaluation; never inferred from the reconstructed record. */
export interface ScientificEvaluationInput {
  kind: 'independent-validation' | 'calibration' | 'model-fit' | 'backtest' | 'synthetic-check';
  regionId: string;
  metric: Metric;
  mode: Mode;
  units: string;
  period: { from: string; to: string };
  referenceSource: { id: string; version: string; description: string; kind: 'observations' | 'synthetic-fixture' };
  predictionSource: { id: string; version: string; description: string };
  methodology: { description: string; holdoutStatement: string | null; minimumSamples: number; minimumCoverage: number };
  pairs: { date: string; prediction: number | null; reference: number | null }[];
}

export interface ScientificEvaluationResult {
  status: 'not_performed' | 'insufficient_data' | 'insufficient_coverage' | 'completed';
  kind: ScientificEvaluationInput['kind'] | null;
  performed: boolean;
  // A calculation cannot authenticate a caller's provenance or prove holdout independence.
  independence: 'unassessed' | 'not_independent' | 'declared_by_caller';
  scientificAcceptance: 'not_assessed';
  sampleSize: number;
  inputRows: number;
  rejectedRows: number;
  period: { from: string; to: string } | null;
  coverage: { expectedDays: number | null; pairedDays: number; fraction: number | null };
  referenceDataSource: ScientificEvaluationInput['referenceSource'] | null;
  predictionDataSource: ScientificEvaluationInput['predictionSource'] | null;
  methodology: ScientificEvaluationInput['methodology'] | null;
  units: string;
  metrics: { meanError: number; meanAbsoluteError: number; rootMeanSquaredError: number } | null;
  errors: { date: string; error: number }[] | null;
  errorDefinition: string;
  confidenceInterval: null;
  intervalCoverage: null;
  limitations: string[];
}

function scientificDate(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

function scientificUnits(metric: Metric, mode: Mode): string {
  if (metric === 'firedays') return 'fire-day indicator (0 or 1)';
  if (metric === 'frp') return 'MW (daily sum of sampled detection FRP)';
  return mode === 'raw' ? 'sensor detections/day' : 'VIIRS-equivalent detections/day';
}

function evaluateScientificPairs(
  input: ScientificEvaluationInput | undefined,
  regionId: string,
  today: string,
  metric: Metric,
  mode: Mode,
): ScientificEvaluationResult {
  const units = scientificUnits(metric, mode);
  const result: ScientificEvaluationResult = {
    status: 'not_performed', kind: input?.kind ?? null, performed: false,
    independence: 'unassessed', scientificAcceptance: 'not_assessed',
    sampleSize: 0, inputRows: Array.isArray(input?.pairs) ? input.pairs.length : 0, rejectedRows: 0,
    period: null, coverage: { expectedDays: null, pairedDays: 0, fraction: null },
    referenceDataSource: null, predictionDataSource: null,
    methodology: null, units, metrics: null, errors: null,
    errorDefinition: 'error = prediction - reference; meanError = mean(error); MAE = mean(abs(error)); RMSE = sqrt(mean(error^2)).',
    confidenceInterval: null, intervalCoverage: null,
    limitations: [
      'Numerical evaluation is not scientific acceptance or proof of independent validation.',
      'Provenance and holdout isolation require external review; this function cannot authenticate them.',
      'Coverage is paired UTC calendar days divided by requested calendar days, not spatial or sensor coverage.',
      'No confidence interval or predictive-interval coverage is estimated by this report.',
    ],
  };
  if (!input) {
    result.limitations.push('Validation not performed: no explicit prediction/reference evidence was supplied.');
    return result;
  }
  result.status = 'insufficient_data';
  const from = scientificDate(input.period?.from);
  const to = scientificDate(input.period?.to);
  const asOf = scientificDate(today);
  const problems: string[] = [];
  if (from == null || to == null || asOf == null || from > to || to > asOf) {
    problems.push('A valid UTC date-only period ending on or before the assessment date is required.');
  } else {
    result.period = { ...input.period };
    result.coverage.expectedDays = (to - from) / 86400000 + 1;
  }
  const textPresent = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  if (!['independent-validation', 'calibration', 'model-fit', 'backtest', 'synthetic-check'].includes(input.kind)) {
    problems.push('An explicit evaluation kind is required.');
  }
  if (input.regionId !== regionId || input.metric !== metric || input.mode !== mode || input.units !== units) {
    problems.push('Evidence region, metric, mode and units must match the requested report.');
  }
  for (const source of [input.referenceSource, input.predictionSource]) {
    if (!source || ![source.id, source.version, source.description].every(textPresent)) {
      problems.push('Both reference and prediction sources need an identifier, version and provenance description.');
    }
  }
  if (!['observations', 'synthetic-fixture'].includes(input.referenceSource?.kind)) {
    problems.push('Reference data must explicitly identify observations or a synthetic fixture.');
  }
  if ((input.kind === 'synthetic-check') !== (input.referenceSource?.kind === 'synthetic-fixture')) {
    problems.push('Synthetic reference data must be evaluated and labelled only as a synthetic check.');
  }
  const method = input.methodology;
  if (!method || !textPresent(method.description)
    || !Number.isInteger(method.minimumSamples) || method.minimumSamples < 1
    || !Number.isFinite(method.minimumCoverage) || method.minimumCoverage < 0 || method.minimumCoverage > 1) {
    problems.push('A method and predeclared positive sample minimum and coverage fraction in [0,1] are required.');
  }
  if (input.kind === 'independent-validation' && !textPresent(method?.holdoutStatement)) {
    problems.push('Independent validation requires an explicit statement of reference exclusion from training and calibration.');
  }
  if (!Array.isArray(input.pairs)) problems.push('Dated prediction/reference pairs are required.');
  if (problems.length) {
    result.limitations.push(...problems);
    return result;
  }
  result.referenceDataSource = { ...input.referenceSource };
  result.predictionDataSource = { ...input.predictionSource };
  result.methodology = { ...method };
  result.independence = input.kind === 'independent-validation' ? 'declared_by_caller' : 'not_independent';
  if (input.kind === 'synthetic-check') result.limitations.push('TEST ONLY synthetic fixture; these results are not observation-based validation.');

  // Reject every row for an ambiguous date rather than choosing a duplicate arbitrarily.
  const occurrences = new Map<string, number>();
  for (const row of input.pairs) occurrences.set(row.date, (occurrences.get(row.date) ?? 0) + 1);
  const errors: { date: string; error: number }[] = [];
  for (const row of input.pairs) {
    const date = scientificDate(row.date);
    const validValues = typeof row.prediction === 'number' && Number.isFinite(row.prediction) && row.prediction >= 0
      && typeof row.reference === 'number' && Number.isFinite(row.reference) && row.reference >= 0;
    const validFireDays = metric !== 'firedays' || ((row.reference === 0 || row.reference === 1)
      && (row.prediction === 0 || row.prediction === 1));
    if (date == null || date < from! || date > to! || occurrences.get(row.date) !== 1 || !validValues || !validFireDays) {
      result.rejectedRows++;
      continue;
    }
    errors.push({ date: row.date, error: row.prediction! - row.reference! });
  }
  errors.sort((a, b) => a.date.localeCompare(b.date));
  const n = errors.length;
  result.sampleSize = n;
  result.coverage.pairedDays = n;
  result.coverage.fraction = n / result.coverage.expectedDays!;
  if (!n) {
    result.limitations.push('Insufficient data: no unique, finite, compatible prediction/reference pairs in the requested period.');
    return result;
  }
  // Scaling avoids squaring large errors directly; zero-reference days remain eligible.
  const scale = errors.reduce((m, row) => Math.max(m, Math.abs(row.error)), 0);
  result.metrics = {
    meanError: errors.reduce((sum, row) => sum + row.error / n, 0),
    meanAbsoluteError: errors.reduce((sum, row) => sum + Math.abs(row.error) / n, 0),
    rootMeanSquaredError: scale ? scale * Math.sqrt(errors.reduce((sum, row) => sum + (row.error / scale) ** 2 / n, 0)) : 0,
  };
  result.errors = errors;
  result.performed = true;
  result.status = n >= method.minimumSamples && result.coverage.fraction >= method.minimumCoverage
    ? 'completed' : 'insufficient_coverage';
  if (result.status === 'insufficient_coverage') {
    result.limitations.push('Errors were calculated, but the predeclared sample-size or calendar-coverage criterion was not met.');
  }
  return result;
}

function scientificRecordCoverage(records: DailyRecord[], today: string, metric: Metric, mode: Mode) {
  const asOf = scientificDate(today);
  const dates = new Map<string, DailyRecord[]>();
  let excludedRows = 0;
  for (const row of records) {
    const date = scientificDate(row.date);
    // Validate the underlying count before converting it to a fire-day indicator;
    // otherwise NaN > 0 would silently turn an invalid observation into a zero.
    const value = metric === 'frp' ? row.frp : mode === 'raw' ? row.raw : row.harmonized;
    if (asOf == null || date == null || date > asOf || !Number.isFinite(value) || value < 0) {
      excludedRows++;
      continue;
    }
    const group = dates.get(row.date) ?? [];
    group.push(row);
    dates.set(row.date, group);
  }
  const usable: DailyRecord[] = [];
  for (const group of dates.values()) {
    if (group.length === 1) usable.push(group[0]);
    else excludedRows += group.length;
  }
  usable.sort((a, b) => a.date.localeCompare(b.date));
  const first = usable[0]?.date ?? null;
  const expectedDays = first && asOf != null ? (asOf - scientificDate(first)!) / 86400000 + 1 : null;
  return {
    period: first ? { from: first, to: today } : null,
    inputRows: records.length, availableDays: usable.length, excludedRows, expectedDays,
    missingDays: expectedDays == null ? null : expectedDays - usable.length,
    calendarCoverage: expectedDays == null ? null : usable.length / expectedDays,
    observationSourceDays: usable.filter((r) => r.source === 'archive' || r.source === 'live').length,
    modelOrBlendDays: usable.filter((r) => r.source === 'model' || r.source === 'blend').length,
    limitation: 'Record availability is not independent validation or complete sensor coverage; source labels are reported as supplied.',
  };
}

/**
 * Report calibration provenance and explicit numerical evaluation separately.
 * No held-out reference is inferred from archive/live/model records. The optional
 * evidence must document its sources, period, units, method and coverage policy.
 * Completed means the supplied pairs were evaluated and met that stated policy;
 * it does not certify provenance, model validity or release acceptance.
 */
export function generateValidationReport(
  records: DailyRecord[],
  region: Region,
  today: string,
  live: LiveBundle | null,
  metric: Metric = 'hotspots',
  mode: Mode = 'harmonized',
  evidence?: ScientificEvaluationInput,
) {
  const bridge = bridgeFor(region, live);
  const available = Number.isFinite(bridge.k) && bridge.k > 0
    && Number.isInteger(bridge.days) && bridge.days > 0;
  return {
    schemaVersion: 'continuum-science-validation-2' as const,
    validationDate: today,
    regionId: region.id,
    regionName: region.shortName,
    metric, mode, units: scientificUnits(metric, mode),
    dailyCycle: {
      status: 'deferred' as const,
      correctedK: null,
      reason: 'No approved exposure-aware daily-cycle method or adequate hourly inclusion-probability data is available. No correction is applied.',
    },
    bridgeRatio: {
      kind: 'calibration' as const,
      status: available ? 'available' as const : 'insufficient_data' as const,
      k: available ? bridge.k : null,
      days: Number.isInteger(bridge.days) && bridge.days >= 0 ? bridge.days : 0,
      source: bridge.source,
      sourceVersion: bridge.source === 'firms-archive' ? archiveStamp() : live?.meta.generatedAt ?? null,
      ratioLo: null, ratioHi: null,
      units: 'VIIRS-equivalent detections per MODIS detection',
      description: 'Existing uncorrected bridge calibration; this is not independent validation. No validated confidence interval is available.',
    },
    recordCoverage: scientificRecordCoverage(records, today, metric, mode),
    validation: evaluateScientificPairs(evidence, region.id, today, metric, mode),
    limitations: [
      'Daily-cycle correction is deferred; raw archive calibration and its provenance are retained.',
      'Model fit, calibration, backtesting and independent validation are different evaluation kinds.',
      'Calibration uses the attached data and is not refitted within historical validation folds.',
      'No sensitivity analysis, historical ranking, sandbox recovery or causal decomposition is presented as independent validation.',
      'No confidence intervals are fabricated from calibration ratios or copied from unrelated diagnostic bands.',
    ],
  };
}

export function livePointsForRegion(region: Region, fires: LiveFire[], day?: string): LiveFire[] {
  const bbox = region.bbox;
  return fires.filter((f) => {
    if (!pointInBbox(f[0], f[1], bbox)) return false;
    if (day) {
      const d = new Date(f[5] * 1000).toISOString().slice(0, 10);
      if (d !== day) return false;
    }
    return true;
  });
}

export function countLiveByDay(fires: LiveFire[], region: Region): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of fires) {
    if (!pointInBbox(f[0], f[1], region.bbox)) continue;
    const d = new Date(f[5] * 1000).toISOString().slice(0, 10);
    out[d] = (out[d] ?? 0) + 1;
  }
  return out;
}
