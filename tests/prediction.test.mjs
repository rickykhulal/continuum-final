import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { predictFutureRisk, loadPredictionArchive, climatologyDoy, forecastToday, forecastWindRequest, parseWindForecast, fetchWindForecast } from '../dist-server/analytics.mjs';

const row = (date, count) => ({ date, count });
const archiveStart = '2020-01-01';
const indexOf = date => (Date.parse(date) - Date.parse(archiveStart)) / 86400000;
function asArchive(rows) {
  const indices = [...new Set(rows.map(r => indexOf(r.date)))].sort((a, b) => a - b);
  const ranges = [];
  for (const index of indices) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] + 1 === index) last[1] = index;
    else ranges.push([index, index, 0]);
  }
  return { schema: 'continuum-archive-1', start: archiveStart, regions: { fixture: {
    days: { m: rows.filter(r => r.count !== 0).map(r => [indexOf(r.date), r.count, 0]) }, covered: { m: ranges },
  } } };
}
function history(valueFor = date => date.slice(5) === '01-01' ? 100 : ['08', '09'].includes(date.slice(5, 7)) ? 20 : 2) {
  const rows = [];
  for (let date = '2020-01-01'; date < '2025-01-01'; date = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10)) rows.push(row(date, valueFor(date)));
  return rows;
}
const rows = history();
const predict = ({ rows: input = rows, ...options } = {}) => predictFutureRisk('fixture', { archive: asArchive(input), startDate: '2026-01-01', ...options });

test('climatology computes each calendar day mean and interpolated P90; holds out current year', () => {
  const input = history(date => date.slice(5) === '01-01' ? (Number(date.slice(0, 4)) - 2019) * 10 : 2);
  input.push(row('2026-01-01', 1000000), row('2027-01-01', 1000000));
  const model = predict({ rows: input });
  assert.equal(model.days[0].mean, 30);
  assert.equal(model.days[0].p90, 46);
  assert.equal(model.days[0].sampleYears, 5);
  assert.equal(model.training.last, '2024-12-31');
  assert.deepEqual(model, predict({ rows: input }));
});

test('risk separates low, moderate, high and critical; wind threshold is strictly greater than 20', () => {
  assert.equal(predict().days[0].risk, 'high');
  assert.equal(predict().days[1].risk, 'low');
  assert.equal(predict({ startDate: '2026-08-01' }).days[0].risk, 'moderate');
  assert.equal(predict({ wind: [{ date: '2026-01-01', speedKmh: 20, direction: 0 }] }).days[0].risk, 'high');
  const model = predict({ wind: [{ date: '2026-01-01', speedKmh: 20.01, direction: 0 }, { date: '2026-01-02', speedKmh: 80, direction: 0 }] });
  assert.equal(model.days[0].risk, 'critical');
  assert.equal(model.days[1].risk, 'low');
  assert.equal(model.days[0].mean, 100);
});

test('forecast winds join by exact date and cannot affect day 8 or later', () => {
  const model = predict({ startDate: '2025-12-25', wind: [
    { date: '2026-01-01', speedKmh: 90, direction: 0 },
    { date: '2025-01-01', speedKmh: 90, direction: 0 },
    { date: '2025-12-26', speedKmh: -999, direction: 0 },
  ] });
  assert.equal(model.days[7].risk, 'high');
  assert.ok(model.days.every(day => day.wind === null));
});

test('30-day calendar crosses year and leap boundaries without shifting March bins', () => {
  assert.equal(climatologyDoy('2024-03-01'), climatologyDoy('2023-03-01'));
  assert.notEqual(climatologyDoy('2024-02-29'), climatologyDoy('2023-03-01'));
  const year = predict({ startDate: '2025-12-20' });
  assert.equal(year.days.length, 30);
  assert.equal(year.days[29].date, '2026-01-18');
  const leap = predict({ startDate: '2028-02-28' });
  assert.equal(leap.days[1].date, '2028-02-29');
  assert.equal(leap.days[1].sampleYears, 2);
  assert.equal(leap.days[1].risk, 'unavailable');
  assert.equal(leap.days[2].doy, 61);
  assert.equal(forecastToday(new Date('2026-11-15T23:59:00Z')), '2026-11-15');
});

test('missing, negative, nonfinite and conflicting archive tuples never manufacture samples', () => {
  const empty = predict({ rows: [] });
  assert.ok(empty.days.every(day => day.risk === 'unavailable' && day.mean === null));
  assert.equal(empty.training.days, 0);
  const input = [row('2020-01-01', 1), row('2020-01-01', 1), row('2021-01-01', -1), row('2022-01-01', NaN), row('2023-01-01', 2), row('2023-01-01', 3)];
  const sparse = predict({ rows: input });
  assert.equal(sparse.training.days, 1);
  assert.equal(sparse.days[0].sampleYears, 1);
  assert.ok(sparse.days.every(day => day.risk === 'unavailable'));
  assert.ok(predictFutureRisk('unknown-region').days.every(day => day.risk === 'unavailable'));
  assert.throws(() => predict({ startDate: '2026-02-30' }), /Invalid/);
  assert.equal(predict({ archive: { ...asArchive(rows), start: '2020-02-30' } }).training.days, 0);
  assert.equal(predict({ archive: { ...asArchive(rows), schema: 'unknown' } }).training.days, 0);
});

test('observed zeros remain low while missing seasonal coverage remains unavailable', () => {
  const zero = predict({ rows: history(() => 0) });
  assert.ok(zero.days.every(day => day.risk === 'low' && day.mean === 0));
  assert.ok(zero.insights[0].includes('No positive seasonal peak'));
  const missing = predict({ rows: rows.filter(row => row.date.slice(5) !== '12-01') });
  assert.ok(missing.days.every(day => day.risk === 'unavailable'));
});

test('insights count only complete observed months and state missing years in the last 20', () => {
  const observed = history(date => date.slice(5, 7) === '08' ? 10 : 0);
  const model = predict({ rows: observed, startDate: '2026-08-01' });
  assert.ok(model.insights[0].includes('August, averaging 310'));
  assert.ok(model.insights[1].includes('5 of 5'));
  assert.ok(model.insights[1].includes('15 years lack complete coverage'));
  assert.deepEqual(model.training.sensors, ['MODIS']);
  assert.equal(model.days[0].fireYears, 5);
  const partial = predict({ rows: observed.filter(r => r.date !== '2020-08-10'), startDate: '2026-08-01' });
  assert.ok(partial.insights[1].includes('4 of 4'));
});

test('shipped archive independently verifies Nepal April, California August and Chilecito August peaks', () => {
  const archive = JSON.parse(fs.readFileSync('public/data/archive_daily.json', 'utf8'));
  const models = [];
  for (const [id, peak] of [['nepal', 4], ['california', 8], ['chilecito', 8]]) {
    const model = predictFutureRisk(id, { archive, startDate: '2026-11-15' });
    const block = archive.regions[id];
    const counts = [];
    // Independent calculation from disk, without the model's decoder or app record.
    for (let year = 2000; year < 2026; year++) {
      const index = (Date.parse(`${year}-11-15`) - Date.parse(archive.start)) / 86400000;
      let count = 0, covered = false;
      for (const [sensor, ranges] of Object.entries(block.covered)) {
        if (!ranges.some(([s, e]) => index >= s && index <= e)) continue;
        covered = true;
        count += block.days[sensor].find(([i]) => i === index)?.[1] ?? 0;
      }
      if (covered) counts.push(count);
    }
    assert.equal(model.days[0].mean, counts.reduce((s, v) => s + v, 0) / counts.length);
    const sorted = counts.toSorted((a, b) => a - b), pos = (counts.length - 1) * .9;
    assert.equal(model.days[0].p90, sorted[Math.floor(pos)] + (sorted[Math.ceil(pos)] - sorted[Math.floor(pos)]) * (pos % 1));
    assert.equal(model.peakMonth, peak);
    assert.ok(model.training.days > 9000);
    assert.equal(model.days.length, 30);
    models.push(model);
  }
  assert.equal(new Set(models.map(m => JSON.stringify(m.days.map(d => d.mean)))).size, 3);
  for (const id of ['country-nepal', 'country-united-states-of-america', 'unknown']) {
    assert.ok(predictFutureRisk(id, { archive }).days.every(d => d.risk === 'unavailable' && d.mean === null));
  }
  assert.equal(predictFutureRisk('nepal', { records: history(() => 10000) }).training.days, 0);
});

test('archive coverage excludes unobserved tuples, counts all covered sensors and deduplicates ranges', () => {
  const archive = asArchive([row('2020-01-01', 3), row('2020-01-02', 0)]);
  const block = archive.regions.fixture;
  block.covered.m.push([0, 1, 0]);
  block.days.m.push([2, 99999, 0]); // not covered
  block.covered.v = [[0, 0, 1]];
  block.days.v = [[0, 7, 0]];
  const model = predict({ archive });
  assert.equal(model.training.days, 2);
  assert.equal(model.days[0].mean, 10);
  assert.equal(model.days[1].mean, 0);
  assert.equal(model.days[2].mean, null);
  block.days.m[0][1] = 13;
  assert.equal(predict({ archive }).days[0].mean, 20); // changing the input changes the model
});

test('archive loader fetches only archive_daily.json, retries failures and shares the successful file', async () => {
  const saved = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async url => { assert.equal(url, './data/archive_daily.json'); calls++; return new Response('', { status: 503 }); };
    await assert.rejects(loadPredictionArchive(), /HTTP 503/);
    globalThis.fetch = async url => { assert.equal(url, './data/archive_daily.json'); calls++; return new Response(JSON.stringify({ schema: 'wrong' })); };
    await assert.rejects(loadPredictionArchive(), /unsupported schema/);
    const archive = asArchive(rows);
    globalThis.fetch = async url => { assert.equal(url, './data/archive_daily.json'); calls++; return new Response(JSON.stringify(archive)); };
    assert.deepEqual(await loadPredictionArchive(), archive);
    assert.strictEqual(await loadPredictionArchive(), await loadPredictionArchive());
    assert.equal(calls, 3);
  } finally { globalThis.fetch = saved; }
});

const forecastBody = { utc_offset_seconds: 0, daily_units: { wind_speed_10m_max: 'km/h', wind_direction_10m_dominant: '°' }, daily: { time: ['2026-11-15', '2026-11-16', '2026-11-17'], wind_speed_10m_max: [25, 0, null], wind_direction_10m_dominant: [360, null, 80] } };
test('forecast request uses exact coordinates, seven UTC days and explicit km/h units', () => {
  const url = new URL(forecastWindRequest(38.1, 23.7));
  assert.equal(url.searchParams.get('latitude'), '38.1');
  assert.equal(url.searchParams.get('longitude'), '23.7');
  assert.equal(url.searchParams.get('forecast_days'), '7');
  assert.equal(url.searchParams.get('timezone'), 'UTC');
  assert.equal(url.searchParams.get('wind_speed_unit'), 'kmh');
  assert.equal(url.searchParams.get('daily'), 'wind_speed_10m_max,wind_direction_10m_dominant');
  assert.ok(!url.searchParams.has('current_weather'));
  assert.throws(() => forecastWindRequest(NaN, 0));
});
test('forecast parser preserves calm, rejects missing speeds and keeps missing directions unknown', () => {
  assert.deepEqual(parseWindForecast(forecastBody), [{ date: '2026-11-15', speedKmh: 25, direction: 0 }, { date: '2026-11-16', speedKmh: 0, direction: null }]);
  assert.throws(() => parseWindForecast({ ...forecastBody, utc_offset_seconds: 3600 }));
  assert.throws(() => parseWindForecast({ ...forecastBody, daily_units: { wind_speed_10m_max: 'm/s' } }));
  assert.throws(() => parseWindForecast({}));
  const invalid = structuredClone(forecastBody);
  invalid.daily.wind_speed_10m_max = [NaN, -999, '25'];
  assert.throws(() => parseWindForecast(invalid), /No usable/);
});
test('forecast transport propagates HTTP failure and supports cancellation', async () => {
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('', { status: 503 });
    await assert.rejects(fetchWindForecast(0, 0), /HTTP 503/);
    globalThis.fetch = async () => new Response(JSON.stringify(forecastBody));
    assert.equal((await fetchWindForecast(0, 0))[0].speedKmh, 25);
    globalThis.fetch = async (_url, options) => { assert.ok(options.signal.aborted); throw new DOMException('Aborted', 'AbortError'); };
    const controller = new AbortController(); controller.abort();
    await assert.rejects(fetchWindForecast(0, 0, controller.signal), { name: 'AbortError' });
  } finally { globalThis.fetch = saved; }
});
