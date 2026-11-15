export type SensorKey = 'modis' | 'viirs' | 'noaa20' | 'noaa21';

export type SensorId = 0 | 1 | 2 | 3;
export const SENSOR_NAMES = ['MODIS', 'VIIRS S-NPP', 'NOAA-20 VIIRS', 'NOAA-21 VIIRS'] as const;
export const SENSOR_SHORT = ['MODIS', 'VIIRS', 'NOAA-20', 'NOAA-21'] as const;
export const SENSOR_COLORS = ['#ffb020', '#ff6a3d', '#4aa8ff', '#a78bfa'] as const;

export interface Region {
  id: string;
  name: string;
  shortName: string;
  country: string;
  admin: string;
  center: [number, number];
  bbox: [number, number, number, number];
  areaKm2: number;
  biome: string;
  language: 'en' | 'es' | 'pt';
  timezone: string;
  description: string;
  aliases: string[];
  /** Set when the area is a country polygon or sits inside one: unlocks the measured
   *  per-country FIRMS window instead of the pooled pilot calibration. */
  countryId?: string;
  /** A geographic rectangle selected on the globe; bbox is its exact analysis boundary. */
  selection?: 'bounds';
}

export type TrustLevel = 'high' | 'medium' | 'low';
export type DataSource = 'model' | 'live' | 'blend' | 'archive';

/** Per-instrument truth for one day: did the product publish it, or do we simply not have it? */
export interface SensorObservation {
  modis: boolean;
  viirs: boolean;
  noaa20: boolean;
  noaa21: boolean;
}

export interface DailyRecord {
  date: string;
  year: number;
  month: number;
  doy: number;
  modis: number;
  viirs: number;
  noaa20: number;
  noaa21: number;
  raw: number;
  harmonized: number;
  lo: number;
  hi: number;
  frp: number;
  trust: TrustLevel;
  provisional: boolean;
  source: DataSource;
  // Live availability uses each feed's detection-date envelope, not a ground-observation mask.
  observed?: SensorObservation;
  constellation?: 'complete' | 'estimated' | 'partial';
  /**
   * What the reconstruction alone said about this day, kept on the days an observation
   * replaced it. Lets the diagnostics read one provenance end to end instead of comparing
   * an observed year against a modelled one, so it carries every field the observation
   * overwrites rather than only the headline count.
   */
  modelled?: {
    raw: number;
    harmonized: number;
    modis: number;
    viirs: number;
    noaa20: number;
    noaa21: number;
    frp: number;
  };
  live: boolean;
}

/** Compact tuple used in live_fires.json: [lat, lon, frp, sensor, confidence, unix seconds]. */
export type LiveFire = [number, number, number, SensorId, 0 | 1 | 2, number];

export interface LiveDayAgg {
  m: number;
  v: number;
  n: number;
  n21: number;
  frpm: number;
  frpv: number;
  frpn: number;
  frpn21: number;
  firstT: number;
  lastT: number;
}

export interface LiveMeta {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  sensors: string[];
  sensorMeta: Record<string, { first: string; last: string; count: number }>;
  counts: { totalQuality: number; kept: number; region: number; globalSampled: number };
  regionDays: Record<string, Record<string, LiveDayAgg>>;
  sources: { name: string; url: string }[];
}

export interface LiveBundle {
  meta: LiveMeta;
  fires: LiveFire[];
  /** Browser loading notice; acquisition dates/provenance are never rewritten. */
  loadNotice?: string;
}

/** public/data/climate_daily.json — NASA POWER MERRA-2 daily burn-weather anomalies. */
export interface ClimateMetaRegion {
  days: number;
  validDays: number;
  bwMean: number;
  bwSd: number;
  bwMin: number;
  bwMax: number;
  annualYears: number;
  annualMin: number;
  annualMax: number;
  driestYear: string;
  wettestYear: string;
  season?: { min: number; max: number; peakMonth: number; aboveMean: number[] } | null;
}

export interface ClimateBundle {
  meta: {
    schema: string;
    generatedAt: string;
    source: string;
    endpoint: string;
    start: string;
    end: string;
    index: Record<string, string>;
    season?: Record<string, string>;
    regions: Record<string, ClimateMetaRegion>;
  };
  dates: { start: string; count: number };
  regions: Record<
    string,
    { center: [number, number]; bw: (number | null)[]; annual: Record<string, number>; season?: number[] | null }
  >;
}

/** Prepared per-region view of the climate file: persisted daily anomalies,
 * standardised annual anomalies and the observed monthly seasonal cycle, all
 * derived by scripts/build-climate.mjs from NASA POWER. */
export interface ClimateSeries {
  bw: (number | null)[];
  /**
   * bw minus its calendar-month climatology and minus its own year's mean
   * deviation. SEASON carries the within-year cycle and the regime term carries
   * the interannual one, so this residual must not repeat either — otherwise one
   * dry year moves the level two or three times over.
   */
  anom: (number | null)[];
  anomSd: number;
  annualZ: Record<string, number>;
  /** Twelve monthly burn-weather favourability factors that average exactly 1. */
  season: number[];
}

/** Everything the reconstruction needs about an area, measured from the live
 * FIRMS window rather than typed into a config file. */
export interface Calibration {
  /** Detections per day in VIIRS-equivalent units, averaged over the live window. */
  levelPerDay: number;
  /** Calendar days spanned by the window, including days with no detection. */
  windowDays: number;
  /** Days in the window with both MODIS and VIIRS seeing the area. */
  overlapDays: number;
  sumModis: number;
  sumViirs: number;
  /** VIIRS-equivalent detections per MODIS detection, and where it came from. */
  k: number;
  kSource: 'area' | 'country-window' | 'pilot-regions';
  /** Share of the VIIRS signal carried by each spacecraft, from the window. */
  viirsShares: { snpp: number; noaa20: number; noaa21: number };
  /** FRP per detection, in MJ/min, measured on the detections themselves. */
  frp: {
    modis: { mean: number; logSd: number; n: number };
    viirs: { mean: number; logSd: number; n: number };
  };
  frpSource: 'area' | 'pilot-regions';
  /** 'area' = this AOI's own detections set the level; 'country-window' = the area lies outside
   * the full-precision pilot bboxes, so its rate is its country's exact measured window scaled to
   * the area; 'pilot-density' = neither had a measurement, so the pilot regions' per-km² rate. */
  levelSource: 'area' | 'country-window' | 'pilot-density';
}

export type Metric = 'hotspots' | 'firedays' | 'frp';
export type Mode = 'harmonized' | 'raw';

export interface SatelliteSpec {
  id: string;
  name: string;
  short: string;
  norad: number;
  agency: string;
  sensor: string;
  altitude: number;
  inclination: number;
  swath: number;
  pixel: number;
  overpass: string;
  color: string;
  era: string;
  role: string;
  tle: [string, string];
}

export interface MonthComparison {
  month: number;
  years: { year: number; value: number; partial: boolean }[];
  median: number;
  p25: number;
  p75: number;
  currentYear: number;
  currentValue: number;
  percentile: number;
  anomalyPct: number;
  mean5: number;
  mean10: number;
  mean20: number;
  topYears: { year: number; value: number }[];
}

export interface StatusResult {
  date: string;
  regionId: string;
  windowDays: number;
  current: number;
  baselineMedian: number;
  percentile: number;
  band: 'quiet' | 'normal' | 'elevated' | 'high' | 'extreme';
  ratioToMedian: number;
  anomalyPct: number;
  freshnessDays: number;
  provisional: boolean;
  sentence: string;
}

export interface SeasonClock {
  startDoy: number;
  peakDoy: number;
  endDoy: number;
  startLabel: string;
  peakLabel: string;
  endLabel: string;
  seasonStartLabel: string;
  currentOffsetDays: number;
  direction: 'ahead' | 'behind' | 'on pace';
  phase: 'pre-season' | 'building' | 'waning' | 'off-season';
  yearShare: number;
}

export interface AnalogSeason {
  year: number;
  similarity: number;
  correlation: number;
  next4WeeksAnomalyPct: number;
  values: number[];
}

export interface TwinResult {
  analogs: AnalogSeason[];
  observed: number[];
  weeks: string[];
  backtestHitRate: number;
  sampleYears: number;
  referenceYear: number;
}

export interface BiasComponent {
  key: string;
  label: string;
  value: number;
  lo: number;
  hi: number;
  explanation: string;
}

export interface BiasResult {
  /**
   * Which single provenance the instrument break was measured on. `observations` once the
   * archive reaches back to 2011 with both sensors; until then the reconstruction, because
   * comparing an observed 2013 to a modelled 2011 would measure the calibration, not the instruments.
   */
  breakBasis: 'observations' | 'reconstruction';
  rawBreakPct: number;
  correctedBreakPct: number;
  /**
   * The reconstruction→observation step, measured on the same days in both sources: the
   * observed level against what the reconstruction predicted for exactly those days. Reported
   * apart from the instrument break above because it is a cost of mixing sources, not a
   * sensor artefact.
   */
  seam: { from: string; days: number; switches: number; pct: number } | null;
  reductionPct: number;
  components: BiasComponent[];
  annualRaw: { year: number; value: number }[];
  annualHarmonized: { year: number; value: number }[];
  ratio: number;
  ratioLo: number;
  ratioHi: number;
  /** Days both instruments published in the VIIRS era — the denominator the bridge ratio is summed over. */
  eraDays: number;
  /** Of those, days the keyed archive observed on both instruments. Zero means the ratio is by construction. */
  observedEraDays: number;
  overlapDays: number;
}

export interface SandboxResult {
  apparent: number[];
  truth: number[];
  corrected: number[];
  /** Weekly (7-day block) mean absolute error after correction, as % of mean truth. Daily Poisson noise is irreducible. */
  recoveryError: number;
  rawBiasPct: number;
  residualBiasPct: number;
}
