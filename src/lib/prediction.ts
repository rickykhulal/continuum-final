import { addDays, dayOfYear, MONTHS_LONG, nf } from './format';
import { mean, quantile } from './random';
import type { ArchiveBundle } from './archive';
import type { ForecastWindDay } from './wind';

export type FutureRisk = 'low' | 'moderate' | 'high' | 'critical' | 'unavailable';
export const RISK_LABELS: Record<FutureRisk, string> = {
  low: 'Low', moderate: 'Moderate', high: 'High', critical: 'Critical', unavailable: 'No data',
};
export const HIGH_WIND_KMH = 20;
const MIN_SAMPLE_YEARS = 3;

export interface ClimatologyDay {
  /** Leap-year calendar index: March 1 is always 61; February 29 has its own bin. */
  doy: number;
  monthDay: string;
  mean: number | null;
  p90: number | null;
  sampleYears: number;
  fireYears: number;
}

export interface FutureRiskDay extends ClimatologyDay {
  date: string;
  risk: FutureRisk;
  wind: ForecastWindDay | null;
}

export interface FutureRiskModel {
  regionId: string;
  startDate: string;
  days: FutureRiskDay[];
  climatology: ClimatologyDay[];
  referenceMean: number | null;
  referenceP90: number | null;
  training: { days: number; years: number; first: string | null; last: string | null; sensors: string[] };
  peakMonth: number | null;
  insights: string[];
}

let archivePromise: Promise<ArchiveBundle> | null = null;

/** Fetch this dashboard's sole training source. A failed request can be retried. */
export function loadPredictionArchive(): Promise<ArchiveBundle> {
  if (!archivePromise) {
    archivePromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(`${import.meta.env.BASE_URL || './'}data/archive_daily.json`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Archive unavailable (HTTP ${response.status}).`);
        const archive = await response.json() as ArchiveBundle;
        if (!validArchive(archive)) throw new Error('The archive has an unsupported schema or invalid start date.');
        return archive;
      } finally { clearTimeout(timer); }
    })().catch(error => {
      archivePromise = null;
      throw error;
    });
  }
  return archivePromise;
}

/** UTC dates keep the calendar and Open-Meteo's daily windows on the same clock. */
export function forecastToday(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function validDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}

export function climatologyDoy(date: string): number {
  return dayOfYear(`2000-${date.slice(5)}`);
}

function validArchive(archive: ArchiveBundle | null): archive is ArchiveBundle {
  return !!archive && archive.schema === 'continuum-archive-1' && typeof archive.start === 'string'
    && validDate(archive.start) && !!archive.regions && typeof archive.regions === 'object' && !Array.isArray(archive.regions);
}

interface ArchiveCount { date: string; count: number }
const ARCHIVE_SENSORS = { m: 'MODIS', v: 'VIIRS S-NPP', n: 'VIIRS NOAA-20', n21: 'VIIRS NOAA-21' };

/**
 * Decode only this exact archive key. Sparse tuples omit observed zeros, so the
 * coverage ranges, not the presence of a count tuple, define an observed day.
 * Count every published spacecraft once; never bridge sensors, fill gaps with a
 * reconstruction, shift dates, or substitute a country/pilot with a similar name.
 */
function archiveCounts(archive: ArchiveBundle | null, regionId: string, cutoff: string) {
  const empty = { rows: [] as ArchiveCount[], sensors: [] as string[] };
  if (!validArchive(archive) || !Object.prototype.hasOwnProperty.call(archive.regions, regionId)) return empty;
  const block = archive.regions[regionId];
  if (!block?.covered || !block.days) return empty;
  const epoch = Date.parse(`${archive.start}T00:00:00Z`);
  const lastIndex = Math.floor((Date.parse(`${cutoff}T00:00:00Z`) - epoch) / 86400000) - 1;
  const totals = new Map<number, number>();
  const invalidDays = new Set<number>();
  const sensors: string[] = [];
  for (const [sensor, label] of Object.entries(ARCHIVE_SENSORS)) {
    const ranges = block.covered[sensor];
    const tuples = block.days[sensor];
    if (!Array.isArray(ranges) || !Array.isArray(tuples)) continue;
    const counts = new Map<number, number | null>();
    for (const tuple of tuples) {
      if (!Array.isArray(tuple)) continue;
      const [index, count] = tuple;
      if (!Number.isInteger(index) || index < 0 || index > lastIndex) continue;
      const value = Number.isInteger(count) && count >= 0 ? count : null;
      counts.set(index, counts.has(index) && counts.get(index) !== value ? null : value);
    }
    const visited = new Set<number>();
    for (const range of ranges) {
      if (!Array.isArray(range)) continue;
      const [first, last, kind] = range;
      if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || (kind !== 0 && kind !== 1)) continue;
      for (let index = first; index <= Math.min(last, lastIndex); index++) {
        if (visited.has(index)) continue;
        visited.add(index);
        const count = counts.has(index) ? counts.get(index)! : 0;
        if (count === null) { invalidDays.add(index); continue; }
        totals.set(index, (totals.get(index) ?? 0) + count);
      }
    }
    if (visited.size) sensors.push(label);
  }
  const rows = [...totals].filter(([index]) => !invalidDays.has(index)).sort(([a], [b]) => a - b)
    .map(([index, count]) => ({ date: new Date(epoch + index * 86400000).toISOString().slice(0, 10), count }));
  return { rows, sensors };
}

function historicalInsights(rows: ArchiveCount[], startDate: string): { insights: string[]; peakMonth: number | null } {
  if (!rows.length) return { peakMonth: null, insights: ['No Data Available. This selected area has no observed history in archive_daily.json before the current year.'] };
  const months = new Map<string, ArchiveCount[]>();
  for (const row of rows) {
    const key = row.date.slice(0, 7);
    const group = months.get(key) ?? [];
    group.push(row);
    months.set(key, group);
  }
  // A missing day is never an invented zero; monthly claims use complete months only.
  const complete = [...months].filter(([key, group]) =>
    group.length === new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5)), 0)).getUTCDate());
  const totals = Array.from({ length: 12 }, (_, month) => {
    const groups = complete.filter(([key]) => Number(key.slice(5)) === month + 1);
    return { month, years: groups.length, average: groups.length ? mean(groups.map(([, days]) => days.reduce((s, d) => s + d.count, 0))) : 0 };
  }).filter(m => m.years >= MIN_SAMPLE_YEARS).sort((a, b) => b.average - a.average);
  const insights: string[] = [];
  const peak = totals[0];
  if (peak?.average > 0) {
    insights.push(`Peak month is ${MONTHS_LONG[peak.month]}, averaging ${nf(peak.average)} archived sensor detections per complete month across ${peak.years} years.`);
  } else {
    insights.push('No positive seasonal peak can be established from complete months in this record.');
  }
  const year = Number(startDate.slice(0, 4));
  const month = Number(startDate.slice(5, 7));
  const recent = complete.filter(([key]) => Number(key.slice(5)) === month && Number(key.slice(0, 4)) >= year - 20);
  if (recent.length) {
    const active = recent.filter(([, days]) => days.some(d => d.count > 0)).length;
    insights.push(`${MONTHS_LONG[month - 1]} had observed fire activity in ${active} of ${recent.length} years with complete coverage in ${year - 20}–${year - 1} (the last 20 years). ${20 - recent.length} years lack complete coverage and are excluded.`);
  } else {
    insights.push(`No complete ${MONTHS_LONG[month - 1]} is available within the previous 20 years; monthly recurrence is unavailable.`);
  }
  return { insights, peakMonth: peak?.average > 0 ? peak.month + 1 : null };
}

/**
 * Deterministic seasonal model, not a calibrated ignition forecast.
 *
 * The archive argument is the JSON returned by loadPredictionArchive (or read
 * directly from that same file by Node callers). No store records, climate
 * driver, live-window calibration or generated history enters this calculation.
 * These are raw sensor detection counts, not harmonized or unique ignition counts.
 *
 * Hold out the entire current year. Group by month/day on a leap-year template,
 * not the year-dependent ordinal (which would mix Feb 29 with March 1).
 * Calendar risk compares each DOY mean with the distribution of all DOY means.
 * Its own within-DOY P90 describes historical variability, not a threshold that
 * the same DOY mean could sensibly be expected to exceed.
 */
export function predictFutureRisk(regionId: string, options: {
  archive?: ArchiveBundle | null;
  startDate?: string;
  wind?: ForecastWindDay[];
} = {}): FutureRiskModel {
  const startDate = options.startDate ?? forecastToday();
  if (!validDate(startDate)) throw new Error('Invalid prediction start date.');
  const cutoff = `${startDate.slice(0, 4)}-01-01`;
  const { rows, sensors } = archiveCounts(options.archive ?? null, regionId, cutoff);
  const bins = Array.from({ length: 366 }, () => [] as ArchiveCount[]);
  for (const row of rows) bins[climatologyDoy(row.date) - 1].push(row);
  const climatology: ClimatologyDay[] = bins.map((group, index) => {
    const values = group.map(row => row.count).sort((a, b) => a - b);
    return {
      doy: index + 1, monthDay: addDays('2000-01-01', index).slice(5),
      mean: values.length ? mean(values) : null, p90: values.length ? quantile(values, 0.9) : null,
      sampleYears: group.length, fireYears: group.filter(r => r.count > 0).length,
    };
  });
  const cycle = climatology.filter(d => d.sampleYears >= MIN_SAMPLE_YEARS).map(d => d.mean!).sort((a, b) => a - b);
  // Require a full seasonal cycle before ranking a season; Feb 29 may be absent.
  const seasonalCoverage = climatology.filter(d => d.monthDay !== '02-29' && d.sampleYears >= MIN_SAMPLE_YEARS).length === 365;
  const referenceMean = seasonalCoverage ? mean(cycle) : null;
  const referenceP90 = seasonalCoverage ? quantile(cycle, 0.9) : null;
  const winds = new Map((options.wind ?? []).filter(w => validDate(w.date) && w.date >= startDate && w.date <= addDays(startDate, 6)
    && Number.isFinite(w.speedKmh) && w.speedKmh >= 0
    && (w.direction === null || (Number.isFinite(w.direction) && w.direction >= 0 && w.direction <= 360)))
    .map(w => [w.date, w]));
  const days: FutureRiskDay[] = Array.from({ length: 30 }, (_, i) => {
    const date = addDays(startDate, i);
    const bin = climatology[climatologyDoy(date) - 1];
    const wind = winds.get(date) ?? null;
    let risk: FutureRisk = 'unavailable';
    if (bin.sampleYears >= MIN_SAMPLE_YEARS && bin.mean != null && referenceMean != null && referenceP90 != null) {
      risk = bin.mean > referenceP90 ? 'high' : bin.mean === 0 || bin.mean < referenceMean ? 'low' : 'moderate';
      if (risk === 'high' && wind && wind.speedKmh > HIGH_WIND_KMH) risk = 'critical';
    }
    return { ...bin, date, risk, wind };
  });
  return {
    regionId, startDate, days, climatology, referenceMean, referenceP90,
    training: { days: rows.length, years: new Set(rows.map(r => r.date.slice(0, 4))).size,
      first: rows[0]?.date ?? null, last: rows[rows.length - 1]?.date ?? null, sensors },
    ...historicalInsights(rows, startDate),
  };
}
