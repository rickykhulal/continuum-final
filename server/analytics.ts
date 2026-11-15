// Node entry point that exposes the browser analytics to the read-only API.
// The science lives in src/lib — this file only re-exports it so the API and the UI can never
// disagree about a number.

import { attachArchive, attachClimate } from '../src/lib/data';

export {
  REGIONS,
  START,
  VIIRS_START,
  NOAA_START,
  NOAA21_START,
  ARCHIVE_START,
  attachArchive,
  attachClimate,
  archiveCoverage,
  archiveDay,
  archiveLoaded,
  archiveStatus,
  constellationSource,
  constellationWeights,
  bridgeFor,
  provenanceMix,
  sensorCount,
  liveSensorAvailability,
  setCountryWindowLookup,
  registerCountryRegions,
  lookupRegion,
  countryRegionCount,
  burnWeather,
  burnWeatherAnomaly,
  calibrationFor,
  climateStatus,
  climateSourceFor,
  seasonLabelFor,
  seasonMonths,
  notableSeasons,
  weatherCoverage,
  getRegion,
  regionRecord,
  recordsInRange,
  dailyValue,
  annualSeries,
  monthComparison,
  statusFor,
  seasonClock,
  twinAnalogs,
  analogDeparture,
  analogDepartureSummary,
  biasXray,
  runSandbox,
  livePointsForRegion,
  countLiveByDay,
  alignLiveToRealtime,
  refreshLiveBundle,
} from '../src/lib/data';
export { platformEquivalent, archiveRatio, archiveSupplementary } from '../src/lib/archive';
export { historicalMapSummary } from '../src/lib/historicalMap';
export { windRequest, parseWind, windCompass, fetchWind } from '../src/lib/wind';
export { forecastWindRequest, parseWindForecast, fetchWindForecast } from '../src/lib/wind';
export { predictFutureRisk, loadPredictionArchive, climatologyDoy, forecastToday } from '../src/lib/prediction';
export { highFrpAlerts, verifiedCommunityAlerts, HIGH_FRP_MW } from '../src/lib/realAlerts';
export { customRegion, customBounds, searchPlaces, PLACES } from '../src/data/places';
export { hydrateWorldLayer, installWorldLayer, uninstallWorldLayer, countryRegion, countryById, worldCountries, countryWindow, windowMeta_, searchWorld, SPELLING_ALIASES, alignCountryFiresToRealtime } from '../src/lib/countries';
export { SENSOR_SHORT } from '../src/lib/types';
export { loadWeather, stressBand } from '../src/lib/weather';
export { buildPdf as buildBriefPdf, downloadPdf } from '../src/lib/pdf';
export {
  inspectGeometry,
  geometryToCircle,
  polygonAreaKm2,
  ringCentroid,
  ringBBox,
  circleRing,
  rectRing,
  ringToPolygon,
  simplifyRing,
  pointInRing,
  estimateDataVolume,
  MAX_VERTICES,
  MIN_RING_POINTS,
} from '../src/lib/geometry';
export { bboxAreaKm2, boundsBetween, haversineKm, pointInBbox, R_EARTH_KM } from '../src/lib/geo';
export { isoDate, addDays, parseISO, dayOfYear } from '../src/lib/format';

// A browser fetches the climate driver through loadLiveBundle; a Node process has no relative
// URL to fetch, so it is attached from disk here. The API, the validate gate and the tests then
// build the series from the same observed weather term the UI uses — the invariant the parity
// test enforces. A bundle without the file keeps the documented fallback driver.
if (globalThis.process?.versions?.node) {
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const reloc = globalThis.process.env.DATA_BUNDLE_PATH;
    const dir = reloc
      ? path.resolve(globalThis.process.cwd(), reloc)
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
    const file = path.join(dir, 'climate_daily.json');
    if (fs.existsSync(file)) attachClimate(JSON.parse(fs.readFileSync(file, 'utf8')));
    const archiveFile = path.join(dir, 'archive_daily.json');
    if (fs.existsSync(archiveFile)) attachArchive(JSON.parse(fs.readFileSync(archiveFile, 'utf8')));
  } catch {
    /* climate file unreadable: the reconstruction falls back to its simulated weather term */
  }
}
