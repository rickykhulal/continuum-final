// Focused Outlook integration checks. Provider fixtures are explicitly test data.
// Run after npm run build + npm test, with the production API on :8787.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REGIONS, predictFutureRisk } from '../dist-server/analytics.mjs';

const origin = process.env.E2E_ORIGIN || 'http://127.0.0.1:8787';
const port = 9225;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-outlook-'));
const archive = JSON.parse(fs.readFileSync('public/data/archive_daily.json', 'utf8'));
const region = REGIONS.find(r => r.id === 'chilecito');
const baseline = predictFutureRisk(region.id, { archive, startDate: '2026-01-01' });
const peak = baseline.climatology.filter(d => d.monthDay !== '02-29').sort((a, b) => b.mean - a.mean)[0];
const startDate = `2026-${peak.monthDay}`;
const dates = Array.from({ length: 30 }, (_, i) => new Date(Date.parse(startDate) + i * 86400000).toISOString().slice(0, 10));
const expected = predictFutureRisk(region.id, { archive, startDate });
const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=1440,1100',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await fn(); if (result) return result; await sleep(150); }
  throw new Error('Browser condition timed out');
}
const results = [], requests = [], runtimeErrors = [];
let archiveRequests = 0;
const check = (name, condition, detail) => { results.push({ name, pass: !!condition, detail }); assert.ok(condition, name); };
let ws, mode = 'success', failure;
try {
  const version = await poll(async () => { try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { return null; } });
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (pending.has(msg.id)) {
      const promise = pending.get(msg.id); pending.delete(msg.id); clearTimeout(promise.timer);
      if (msg.error) promise.reject(new Error(msg.error.message)); else promise.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') runtimeErrors.push(msg.params.exceptionDetails.text);
    else if (msg.method === 'Fetch.requestPaused') {
      const url = new URL(msg.params.request.url);
      if (url.pathname.endsWith('/archive_daily.json') || url.pathname.endsWith('/live_fires.json')) {
        const isArchive = url.pathname.endsWith('/archive_daily.json');
        if (isArchive) archiveRequests++;
        if ((isArchive && mode === 'archive-error') || (!isArchive && mode === 'live-error')) {
          send('Fetch.fulfillRequest', { requestId: msg.params.requestId, responseCode: 503, body: '' }, msg.sessionId).catch(() => {});
        } else send('Fetch.continueRequest', { requestId: msg.params.requestId }, msg.sessionId).catch(() => {});
        return;
      }
      if (mode === 'real-weather') {
        send('Fetch.continueRequest', { requestId: msg.params.requestId }, msg.sessionId).catch(() => {});
        return;
      }
      const latitude = Number(url.searchParams.get('latitude'));
      const currentMode = mode;
      requests.push({ latitude, longitude: Number(url.searchParams.get('longitude')), days: url.searchParams.get('forecast_days'), units: url.searchParams.get('wind_speed_unit') });
      const speed = currentMode === 'race' ? (latitude === REGIONS.find(r => r.id === 'greece').center[0] ? 88 : 11) : 25;
      const body = { utc_offset_seconds: 0, daily_units: { wind_speed_10m_max: 'km/h', wind_direction_10m_dominant: '°' }, daily: {
        time: currentMode === 'stale' ? ['2001-01-01'] : dates.slice(0, 7),
        wind_speed_10m_max: Array(7).fill(speed), wind_direction_10m_dominant: Array(7).fill(0),
      } };
      const delay = currentMode === 'race' && speed === 88 ? 1800 : 350;
      setTimeout(() => send('Fetch.fulfillRequest', { requestId: msg.params.requestId, responseCode: currentMode === 'error' ? 503 : 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
        body: Buffer.from(JSON.stringify(body)).toString('base64'),
      }, msg.sessionId).catch(() => {}), delay);
    }
  };
  const { targetInfos } = await send('Target.getTargets');
  const { sessionId: session } = await send('Target.attachToTarget', { targetId: targetInfos.find(t => t.type === 'page').targetId, flatten: true });
  const ev = async code => {
    const result = await send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true, userGesture: true }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await send('Page.enable', {}, session);
  await send('Runtime.enable', {}, session);
  const { identifier: clockOverride } = await send('Page.addScriptToEvaluateOnNewDocument', { source: `{
    const RealDate = Date;
    globalThis.Date = class extends RealDate { constructor(...args) { if (args.length) super(...args); else super('${startDate}T12:00:00Z'); } static now() { return RealDate.parse('${startDate}T12:00:00Z'); } };
  }` }, session);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*api.open-meteo.com/v1/forecast*' }, { urlPattern: '*/data/archive_daily.json' }, { urlPattern: '*/data/live_fires.json' }] }, session);
  await send('Page.navigate', { url: `${origin}/#/outlook?r=chilecito` }, session);
  await poll(() => ev("return !!document.querySelector('.future-day[data-risk=critical]');"));
  const calendar = await ev("return [...document.querySelectorAll('.future-day')].map(b=>({date:b.dataset.date,risk:b.dataset.risk,label:b.getAttribute('aria-label')}));");
  check('Thirty distinct future dates start today, independent of the fire snapshot', calendar.length === 30 && calendar.every((d, i) => d.date === dates[i]), calendar.map(d => d.date));
  check('High seasonal activity plus 25 km/h forecast becomes Critical', expected.days[0].risk === 'high' && calendar[0].risk === 'critical', calendar[0]);
  check('Day 8 onward uses climatology with no invented forecast', calendar.slice(7).every((d, i) => d.risk === expected.days[i + 7].risk && d.label.includes('wind unavailable')), calendar.slice(7));
  check('Open-Meteo request preserves coordinates and seven-day units', requests[0].latitude === region.center[0] && requests[0].longitude === region.center[1] && requests[0].days === '7' && requests[0].units === 'kmh', requests[0]);
  const detail = await ev("return document.querySelector('#future-day-detail').textContent;");
  check('Explanation includes daily mean, historical P90, archive samples and wind from North', /Expected sensor detections/.test(detail) && /historical P90/.test(detail) && /observed archive samples/.test(detail) && /25.0 km\/h/.test(detail) && /from N \(0°\)/.test(detail), detail);
  const order = await ev("return [...document.querySelectorAll('.outlook-page h2')].map(h=>h.textContent);");
  check('Calendar and historical insights precede preserved analog and four-week features', order[0] === '30-Day Future Fire Risk Calendar' && order[1] === 'Historical Pattern Insights' && await ev("return document.querySelectorAll('.analog-row').length >= 3 && document.querySelector('.decision-facts').textContent.includes('4 wk');"), order);
  await ev("document.querySelectorAll('.future-day')[10].click(); return true;");
  check('Clicking a day updates the detail and states the wind horizon', await ev(`return document.querySelectorAll('.future-day')[10].getAttribute('aria-pressed') === 'true' && document.querySelector('#future-day-detail').textContent.includes('Beyond the seven-day');`));
  await ev("document.querySelectorAll('.future-day')[10].focus(); return true;");
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }, session);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }, session);
  check('Keyboard arrows move focus and update the selected day', await ev("return document.activeElement === document.querySelectorAll('.future-day')[11] && document.activeElement.getAttribute('aria-pressed')==='true';"));
  await ev("document.querySelector('.future-day').click();document.querySelector('.future-risk-panel').scrollIntoView({block:'start'});return true;");
  fs.mkdirSync('.shots', { recursive: true });
  const screenshot = async name => { const shot = await send('Page.captureScreenshot', { format: 'png' }, session); fs.writeFileSync(`.shots/${name}.png`, Buffer.from(shot.data, 'base64')); };
  await screenshot('outlook-desktop');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, session);
  check('Reduced motion stops the Critical pulse', await ev("return getComputedStyle(document.querySelector('.future-day.risk-critical')).animationName === 'none';"));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, session);
  await sleep(250);
  check('Mobile calendar fits the viewport and retains 30 named controls', await ev("const p=document.querySelector('.future-calendar');return p.getBoundingClientRect().right <= innerWidth && p.scrollWidth <= p.clientWidth && document.querySelectorAll('.future-day[aria-label]').length === 30;"));
  await ev("document.querySelector('.future-calendar-heading').scrollIntoView({block:'start'});return true;");
  await screenshot('outlook-mobile');
  await ev("document.documentElement.dataset.theme='light';return true;");
  check('Light theme keeps explicit risk labels and separate palette', await ev("return getComputedStyle(document.querySelector('.future-day.risk-critical')).getPropertyValue('--risk-color').trim() === '#6836ad';"));
  await send('Emulation.clearDeviceMetricsOverride', {}, session);
  const refresh = () => ev("document.querySelector('.future-wind-status button').click();return true;");
  mode = 'error'; await refresh();
  await poll(() => ev("return document.querySelector('.future-wind-status').textContent.includes('HTTP 503');"));
  check('Failed forecast degrades to climatology and removes Critical without clearing the calendar', await ev("return !document.querySelector('.future-day.risk-critical') && document.querySelectorAll('.future-day').length === 30 && document.querySelector('.future-day').dataset.risk === 'high';"));
  mode = 'stale'; await refresh();
  await poll(() => ev("return document.querySelector('.future-wind-status').textContent.includes('no wind dates');"));
  check('Expired forecast dates are rejected with an explicit notice', await ev("return !document.querySelector('.future-day.risk-critical');"));
  mode = 'success'; await refresh();
  await poll(() => ev("return !!document.querySelector('.future-day.risk-critical');"));
  check('Retry recovers the forecast and risk classification', true);
  const chooseRegion = async id => {
    const name = REGIONS.find(r => r.id === id).shortName;
    await ev(`if (!document.querySelector('.context-picker')) document.querySelector('.context-switch-btn').click(); return true;`);
    await poll(() => ev("return !!document.querySelector('.context-picker');"));
    await ev(`const button = [...document.querySelectorAll('.context-chip')].find(b => b.querySelector('strong')?.textContent === ${JSON.stringify(name)}); if (!button) throw new Error('Missing region button'); button.click(); return true;`);
    await poll(() => ev(`return document.querySelector('.future-risk-summary')?.dataset.regionId === ${JSON.stringify(id)};`));
  };
  const summaries = [];
  for (const id of ['nepal', 'california', 'chilecito']) {
    await chooseRegion(id);
    await poll(() => ev("return document.querySelector('.future-wind-status').textContent.includes('Wind forecast available');"));
    const target = predictFutureRisk(id, { archive, startDate, wind: dates.slice(0, 7).map(date => ({ date, speedKmh: 25, direction: 0 })) });
    const displayed = await ev("return {id:document.querySelector('.future-risk-summary').dataset.regionId, risks:[...document.querySelectorAll('.future-day')].map(b=>b.dataset.risk), mean:document.querySelector('.future-day-facts dd').textContent, p90:document.querySelectorAll('.future-day-facts dd')[1].textContent, insights:document.querySelector('.future-insights').textContent, method:document.querySelector('.future-method').textContent};");
    const number = value => new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
    check(`Change area → ${id} recomputes all 30 colours, mean, P90 and archive insights`, displayed.risks.every((risk, i) => risk === target.days[i].risk)
      && displayed.mean === number(target.days[0].mean) && displayed.p90 === number(target.days[0].p90)
      && target.insights.every(insight => displayed.insights.includes(insight)) && displayed.method.includes(`Source ID: ${id}`), displayed);
    const labels = await ev("return [...document.querySelectorAll('.future-day')].map(b=>({label:b.getAttribute('aria-label'),average:b.querySelector('.future-day-expected')?.textContent}));");
    check(`${id} exposes each date's own expected count even when risk colours match`, labels.every((cell, i) => cell.average && cell.label.includes(`Expected ${number(target.days[i].mean)} sensor detections`)));
    await ev("document.querySelector('.future-insights').scrollIntoView({block:'center'});return true;");
    await screenshot(`outlook-${id}-archive`);
    summaries.push(displayed);
  }
  check('Different selected regions produce different values and insights', new Set(summaries.map(s => s.mean)).size === 3 && new Set(summaries.map(s => s.insights)).size === 3);
  check('Nepal has an April peak and California an August peak from the shipped archive', summaries[0].insights.includes('Peak month is April') && summaries[1].insights.includes('Peak month is August'));
  mode = 'race';
  await chooseRegion('greece');
  await poll(() => requests.some(r => r.latitude === REGIONS.find(r => r.id === 'greece').center[0]));
  await chooseRegion('nepal');
  await poll(() => ev("return document.querySelector('#future-day-detail').textContent.includes('11.0 km/h');"));
  await sleep(2100);
  check('Rapid region changes reject late winds from the previous area', await ev("const t=document.querySelector('#future-day-detail').textContent;return t.includes('11.0 km/h') && !t.includes('88.0 km/h') && location.hash.includes('nepal');"));
  const nepalExpected = predictFutureRisk('nepal', { archive, startDate });
  const nepalRisk = await ev("return [...document.querySelectorAll('.future-day')].map(b=>b.dataset.risk);");
  check('Changing the area recomputes its seasonal risk and insights', nepalRisk.every((r, i) => r === nepalExpected.days[i].risk) && await ev("return document.querySelector('.future-insights').textContent.includes('Nepal');"));
  await ev("location.hash='/outlook?r=country-nepal';return true;");
  await poll(() => ev("return document.querySelector('.future-risk-summary')?.dataset.regionId === 'country-nepal';"));
  check('A country without an exact archive key has No Data Available, no inherited pilot numbers', await ev("return document.querySelector('.future-archive-empty').textContent.includes('No Data Available') && [...document.querySelectorAll('.future-day')].every(b=>b.dataset.risk==='unavailable') && document.querySelector('.future-day-facts dd').textContent==='—' && !document.querySelector('.future-insights').textContent.includes('Peak month is');"));
  await ev("[...document.querySelectorAll('.future-archive-options button')].find(b=>b.textContent==='Nepal').click();return true;");
  await poll(() => ev("return document.querySelector('.future-risk-summary')?.dataset.regionId === 'nepal';"));
  check('No-data action explicitly selects the named archive area', await ev("return document.querySelector('.context-name').textContent.includes('Nepal Terai') && !document.querySelector('.future-archive-empty');"));
  mode = 'archive-error';
  await send('Page.reload', {}, session);
  await poll(() => ev("return document.querySelector('.future-archive-empty')?.textContent.includes('HTTP 503');"));
  check('Failed archive fetch never falls back to reconstruction', await ev("return [...document.querySelectorAll('.future-day')].every(b=>b.dataset.risk==='unavailable') && document.querySelector('.future-day-facts dd').textContent==='—';"));
  mode = 'success';
  await ev("document.querySelector('.future-archive-empty button').click();return true;");
  await poll(() => ev("return !document.querySelector('.future-archive-empty') && document.querySelector('.future-insights')?.textContent.includes('Peak month is April');"));
  check('Retrying the archive restores the selected region from the real file', archiveRequests >= 3, { archiveRequests });
  mode = 'live-error';
  await send('Page.reload', {}, session);
  await poll(() => ev("return document.querySelector('.future-insights')?.textContent.includes('Peak month is April');"));
  check('Prediction is independent of a failed live/reconstructed-record load', await ev("return !document.querySelector('.future-archive-empty') && document.querySelector('.future-risk-summary').dataset.regionId === 'nepal';"));
  // Remove test clock and weather interception for the user's current-date review.
  mode = 'real-weather';
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: clockOverride }, session);
  await send('Page.reload', {}, session);
  await poll(() => ev("return document.querySelector('.future-insights')?.textContent.includes('Peak month is April');"));
  const today = new Date().toISOString().slice(0, 10);
  for (const id of ['nepal', 'california', 'chilecito']) {
    await chooseRegion(id);
    const target = predictFutureRisk(id, { archive, startDate: today });
    const displayed = await ev("return {date:document.querySelector('.future-day').dataset.date,mean:document.querySelector('.future-day-facts dd').textContent,p90:document.querySelectorAll('.future-day-facts dd')[1].textContent,insights:document.querySelector('.future-insights').textContent};");
    const number = value => new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
    check(`Current date, real file: Change area → ${id} matches its archive`, displayed.date === today && displayed.mean === number(target.days[0].mean)
      && displayed.p90 === number(target.days[0].p90) && target.insights.every(insight => displayed.insights.includes(insight)), displayed);
    await ev("document.querySelector('.future-calendar-heading').scrollIntoView({block:'center'});return true;");
    await screenshot(`outlook-${id}-today`);
  }
  const response = await fetch(origin);
  check('Production CSP allows forecast wind', response.headers.get('content-security-policy')?.includes('https://api.open-meteo.com'));
  check('No browser runtime exceptions in the focused Outlook flow', runtimeErrors.length === 0, runtimeErrors);
} catch (error) { failure = error.stack; process.exitCode = 1; }
finally {
  ws?.close(); chrome.kill();
  await sleep(800);
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('continuum-outlook-')) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Chrome may retain its temp profile briefly. */ }
  }
  const report = { status: failure ? 'partial' : 'verified', fixture: 'Peak-season date and Open-Meteo fixtures for threshold/failure tests; final three region checks use the real current date and no provider interception. Archive counts always come from the shipped file.', startDate, pass: results.filter(r => r.pass).length, total: results.length, failure, results };
  fs.writeFileSync('docs/outlook-e2e-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, pass: report.pass, total: report.total, failure }, null, 2));
}
