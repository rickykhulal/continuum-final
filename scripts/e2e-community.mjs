// Focused real-browser Community checks against npm run dev, with an isolated database.
// Requires a free API port 8787 and npm run api:build. Real Open-Meteo search runs first;
// later provider failures/races are explicitly intercepted fixtures. No Discord messages sent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const origin = process.env.E2E_ORIGIN || 'http://127.0.0.1:5173';
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-community-browser-'));
const profile = path.join(runtime, 'chrome');
const imageBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
const imagePath = path.join(runtime, 'report.png');
fs.writeFileSync(imagePath, Buffer.from(imageBase64.split(',')[1], 'base64'));
const oversizedPath = path.join(runtime, 'oversized.png');
fs.writeFileSync(oversizedPath, Buffer.alloc(4 * 1024 * 1024 + 1));
const secret = crypto.randomBytes(32).toString('hex');
const api = spawn(process.execPath, ['tests/helpers/community-api.mjs'], { env: { ...process.env, PORT: '8787', APP_DATA_PATH: runtime,
  DISCORD_WEBHOOK_URL: '', DISCORD_SYNC_SECRET: secret, DISCORD_BOT_TOKEN: '', API_RATE_LIMITS: 'classA:1000/min;classB:1000/min;classC:1000/min' }, stdio: 'ignore' });
const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=1440,1100',
  '--remote-debugging-port=9226', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return; await sleep(150); }
  throw new Error('Browser condition timed out');
}
const results = [], runtimeErrors = [], geocodeQueries = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); assert.ok(pass, name); };
let ws, failure, ev, screenshot;
try {
  await poll(async () => { try { return (await fetch('http://127.0.0.1:8787/health')).ok; } catch { return false; } });
  if (api.exitCode !== null) throw new Error('Isolated API could not claim port 8787');
  const key = (await (await fetch('http://127.0.0.1:8787/api/v1/auth/generate-key', { method: 'POST' })).json()).api_key;
  const feed = async () => (await (await fetch('http://127.0.0.1:8787/api/v1/community/feed', { headers: { 'x-api-key': key } })).json()).posts;
  await poll(async () => { try { return (await fetch('http://127.0.0.1:9226/json/version')).ok; } catch { return false; } });
  const version = await (await fetch('http://127.0.0.1:9226/json/version')).json();
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0, geocodeMode = 'real';
  const pending = new Map();
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) {
      const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) p.reject(new Error(message.error.message)); else p.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.text);
    else if (message.method === 'Fetch.requestPaused') {
      const q = new URL(message.params.request.url).searchParams.get('name');
      geocodeQueries.push(q);
      if (geocodeMode === 'real') send('Fetch.continueRequest', { requestId: message.params.requestId }, message.sessionId).catch(() => {});
      else {
        const mode = geocodeMode;
        const body = { results: [{ name: `${q} fixture`, country: 'Test only', latitude: q === 'Old' ? 1 : 2, longitude: 3 }] };
        setTimeout(() => send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: mode === 'error' ? 503 : 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
          body: Buffer.from(JSON.stringify(body)).toString('base64') }, message.sessionId).catch(() => {}), q === 'Old' ? 1800 : 100);
      }
    }
  };
  const { targetInfos } = await send('Target.getTargets');
  const { sessionId: session } = await send('Target.attachToTarget', { targetId: targetInfos.find(t => t.type === 'page').targetId, flatten: true });
  ev = async code => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true, userGesture: true }, session);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const fill = (label, value) => ev(`const e=document.querySelector('[aria-label=${JSON.stringify(label)}]'); if(!e) throw new Error('Missing field'); const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true})); return true;`);
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click(); return true;`);
  const upload = async file => {
    const { root } = await send('DOM.getDocument', {}, session);
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '[aria-label="Attach report image"]' }, session);
    await send('DOM.setFileInputFiles', { nodeId, files: [file] }, session);
  };
  const publish = async count => { await click('.compose-submit'); await poll(async () => (await feed()).length === count); await poll(() => ev(`return document.querySelectorAll('.feed-card').length===${count};`)); };
  screenshot = async name => { fs.mkdirSync('.shots', { recursive: true }); const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, session); fs.writeFileSync(`.shots/${name}.png`, Buffer.from(shot.data, 'base64')); };
  await send('Page.enable', {}, session); await send('Runtime.enable', {}, session);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*geocoding-api.open-meteo.com/v1/search*' }] }, session);
  await send('Page.navigate', { url: `${origin}/#/community` }, session);
  await poll(() => ev("return document.querySelector('.community-empty')?.textContent.includes('Start the conversation');"));
  check('Empty database renders a clean feed with no previous test posts', (await feed()).length === 0);
  const layout = await ev("const r=document.querySelector('.community-page').getBoundingClientRect();return {width:r.width,left:r.left,availableWidth:document.documentElement.clientWidth};");
  check('Desktop feed is centered and bounded to 760px', layout.width <= 760 && Math.abs(layout.left - (layout.availableWidth - layout.width) / 2) < 2, layout);
  await fill('Author name', 'LOCAL VERIFICATION ONLY');
  await fill('Post content', 'Local browser verification: location lookup, not an emergency report.');
  await upload(oversizedPath);
  await poll(() => ev("return document.querySelector('.compose-box [role=alert]')?.textContent.includes('at most 4 MiB');"));
  check('Oversized uploads are rejected before posting', await ev("return !document.querySelector('.community-image-preview');"));
  await upload(imagePath);
  await poll(() => ev("return document.querySelector('.community-image-preview img')?.naturalWidth===1;"));
  check('FileReader produces a decoded image preview', true);
  await click('.community-image-preview button');
  check('Attachment can be removed before posting', await ev("return !document.querySelector('.community-image-preview') && !document.querySelector('[aria-label=\"Attach report image\"]').value;"));
  await upload(imagePath);
  await poll(() => ev("return !!document.querySelector('.community-image-preview');"));
  await fill('Search report location', 'Biratnagar');
  await poll(() => ev("return [...document.querySelectorAll('.community-location-results button')].some(b=>b.textContent.includes('Biratnagar') && b.textContent.includes('Nepal'));"));
  check('Real Open-Meteo search returns Biratnagar, Nepal with coordinates', await ev("return document.querySelector('.community-location-results button').textContent.includes('26.');"), geocodeQueries.slice());
  await click('.community-location-results button');
  check('Choosing a geocoding result retains its name and coordinates', await ev("return document.querySelector('.community-selected-location').textContent.includes('Biratnagar, Nepal');"));
  await publish(1);
  const anomaly = (await feed())[0];
  check('Image bytes persist in the API record and render in the web feed', anomaly.imageBase64 === imageBase64 && await ev("return document.querySelector('.feed-card .community-post-image')?.naturalWidth===1;"));
  check('Successful publishing clears the attachment draft', await ev("return !document.querySelector('.community-image-preview');"));
  check('Anomaly saves geocoded coordinates and a server-computed verification badge', anomaly.source === 'web' && anomaly.type === 'anomaly' && anomaly.locationName === 'Biratnagar, Nepal'
    && anomaly.lat > 26 && anomaly.lat < 27 && anomaly.lon > 87 && anomaly.lon < 88 && ['pending', 'satellite_confirmed'].includes(anomaly.verificationStatus), { locationName: anomaly.locationName, lat: anomaly.lat, lon: anomaly.lon, status: anomaly.verificationStatus });
  check('Feed displays location, coordinates, source and status', await ev("const p=document.querySelector('.feed-card');return p.querySelector('.community-post-location').textContent.includes('Biratnagar, Nepal') && !!p.querySelector('.community-verification') && p.querySelector('.community-source').textContent==='Web';"));
  await fill('Post type', 'poll'); await fill('Post content', 'LOCAL TEST: Which monitoring view is useful?');
  await fill('Poll option 1', 'Satellite map'); await fill('Poll option 2', 'Community reports');
  await publish(2);
  await click('.feed-card.poll .poll-btn');
  await poll(() => ev("return document.querySelector('.feed-card.poll .poll-total').textContent.startsWith('1 vote');"));
  await click('.feed-card.poll .poll-btn'); await sleep(450);
  check('Voting persists once even after repeat clicks', (await feed()).find(p => p.type === 'poll').pollOptions[0].votes === 1);
  await click('.feed-card.poll .poll-btn:nth-child(2)');
  await poll(async () => (await feed()).find(p => p.type === 'poll').pollOptions[1].votes === 1);
  check('Changing choice moves the vote instead of adding a second one', (await feed()).find(p => p.type === 'poll').pollOptions.map(o => o.votes).join() === '0,1');
  await click('.community-feed-head button');
  await poll(() => ev("return !document.querySelector('.community-feed-head button').disabled;"));
  check('Refreshing feed preserves selected option and backend totals', await ev("return document.querySelectorAll('.feed-card.poll .poll-btn')[1].getAttribute('aria-pressed')==='true' && document.querySelector('.feed-card.poll .poll-total').textContent.startsWith('1 vote');"));
  await ev("document.querySelector('.community-feed-head').scrollIntoView({block:'center'});return true;");
  await screenshot('community-desktop');
  await fill('Post content', 'LOCAL TEST: incomplete location');
  await click('.community-manual summary'); await fill('Report latitude', '26.45');
  await click('.compose-submit');
  await poll(() => ev("return document.querySelector('.compose-box [role=alert]')?.textContent.includes('Enter both valid coordinates');"));
  check('Incomplete manual coordinates cannot publish a report', (await feed()).length === 2);
  const live = JSON.parse(fs.readFileSync('public/data/live_fires.json', 'utf8'));
  const [lat, lon] = live.fires[0];
  await fill('Report latitude', String(lat)); await fill('Report longitude', String(lon)); await fill('Manual location name', 'LOCAL TEST satellite coordinate');
  await publish(3);
  check('Manual location at an actual stored detection gets green badge and dated evidence', await ev("const p=document.querySelector('.feed-card');return p.querySelector('.community-verification.confirmed')?.textContent.includes('Satellite Confirmed') && p.querySelector('.community-match')?.textContent.includes('UTC');"));
  const synced = await fetch('http://127.0.0.1:8787/api/v1/community/discord-sync', { method: 'POST', headers: { 'content-type': 'application/json', 'x-discord-secret': secret },
    body: JSON.stringify({ author: 'LOCAL DISCORD TEST', content: 'Isolated inbound relay test.', imageBase64, locationName: 'Unmatched test coordinate', lat: 0, lon: 0 }) });
  check('Authenticated Discord relay saves a report successfully', synced.ok);
  await poll(() => ev("return !!document.querySelector('.community-source.discord');"));
  check('Discord image reports appear automatically without manual refresh', await ev("const p=document.querySelector('.feed-card');return p.querySelector('.community-post-image')?.naturalWidth===1 && p.querySelector('.card-author').textContent==='LOCAL DISCORD TEST';"));
  check('Discord inbound report appears in feed with source and pending badge', await ev("const p=document.querySelector('.feed-card');return p.querySelector('.community-source.discord') && !!p.querySelector('.community-verification.pending');"));
  await click('.community-filters button:nth-child(3)');
  check('Poll filter limits feed to polls', await ev("return document.querySelectorAll('.feed-card').length===1 && !!document.querySelector('.feed-card.poll');"));
  await click('.community-filters button');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, session);
  await sleep(200);
  check('Mobile feed and form fit without horizontal overflow', await ev("const p=document.querySelector('.community-page');return document.documentElement.scrollWidth<=innerWidth && p.scrollWidth<=p.clientWidth && [...p.querySelectorAll('.feed-card,.compose-box')].every(e=>e.getBoundingClientRect().right<=innerWidth);"));
  check('Companion does not cover mobile reports or voting controls', await ev("const pet=document.querySelector('.pet-companion');return !pet || getComputedStyle(pet).display==='none';"));
  await ev("document.querySelector('.community-feed-head').scrollIntoView({block:'start'});return true;");
  await screenshot('community-mobile');
  await send('Emulation.clearDeviceMetricsOverride', {}, session);
  geocodeMode = 'error'; await fill('Search report location', 'Unavailable');
  await poll(() => ev("return document.querySelector('.community-search-status').textContent.includes('HTTP 503');"));
  check('Provider failure is visible and manual coordinates remain available', await ev("return !!document.querySelector('.community-manual summary');"));
  geocodeMode = 'race'; await fill('Search report location', 'Old');
  await poll(() => geocodeQueries.includes('Old'));
  await fill('Search report location', 'New');
  await poll(() => ev("return document.querySelector('.community-location-results')?.textContent.includes('New fixture');"));
  await sleep(2100);
  check('Late results from a previous search cannot replace current results', await ev("const t=document.querySelector('.community-location-results').textContent;return t.includes('New fixture')&&!t.includes('Old fixture');"));
  await ev("document.querySelector('[aria-label=\"Search report location\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;");
  check('Location dropdown supports keyboard selection', await ev("return document.querySelector('.community-selected-location').textContent.includes('New fixture');"));
  await fill('Search report location', 'Changed');
  check('Editing selected location clears the old point', await ev("return !document.querySelector('.community-selected-location');"));
  await send('Page.reload', {}, session);
  await poll(() => ev("return document.querySelectorAll('.feed-card').length===4;"));
  check('Page reload preserves posts and vote totals', await ev("return document.querySelector('.feed-card.poll .poll-total').textContent.startsWith('1 vote');"));
  check('Page reload preserves image attachments', (await feed()).filter(post => post.imageBase64 === imageBase64).length === 2);
  await fill('Post content', 'TEST ONLY California summer weather fixture');
  await click('.community-manual summary');
  await fill('Report latitude', '34'); await fill('Report longitude', '-116'); await fill('Manual location name', 'California desert (fixture weather)');
  await publish(5);
  const hot = (await feed())[0];
  const hotSelector = `[data-post-id="${hot.id}"]`;
  check('Hot/dry/windy fixture renders orange High Risk Weather with measurements', hot.verificationStatus === 'weather_warning' && await ev(`const p=document.querySelector(${JSON.stringify(hotSelector)});return !!p.querySelector('.community-verification.weather-warning') && p.querySelector('.community-weather').textContent.includes('34.0°C') && p.querySelector('.community-weather').textContent.includes('20% RH') && p.querySelector('.community-weather').textContent.includes('25.0 km/h');`));
  await fill('Post content', 'TEST ONLY London cold/wet weather fixture');
  await fill('Report latitude', '51.5074'); await fill('Report longitude', '-0.1278'); await fill('Manual location name', 'London (fixture weather)');
  await publish(6);
  const cold = (await feed())[0];
  check('Cold/wet fixture stays yellow Pending Verification with separate readings', cold.verificationStatus === 'pending' && await ev(`const p=document.querySelector('[data-post-id="${cold.id}"]');return !!p.querySelector('.community-verification.pending') && p.querySelector('.community-weather').textContent.includes('8.0°C') && p.querySelector('.community-weather').textContent.includes('80% RH');`));
  await ev(`document.querySelector(${JSON.stringify(hotSelector)}).scrollIntoView({block:'center'});return true;`);
  await screenshot('community-weather-comparison');
  await click(`${hotSelector} .community-confirmations button`);
  await poll(() => ev(`return document.querySelector(${JSON.stringify(hotSelector + ' .community-confirmations span')}).textContent.startsWith('1 / 3');`));
  check('Human confirmation button records one vote and disables repeat voting', await ev(`return document.querySelector(${JSON.stringify(hotSelector + ' .community-confirmations button')}).disabled;`));
  for (let i = 0; i < 2; i++) {
    const voter = (await (await fetch('http://127.0.0.1:8787/api/v1/auth/generate-key', { method: 'POST' })).json()).api_key;
    const res = await fetch('http://127.0.0.1:8787/api/v1/community/upvote', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': voter }, body: JSON.stringify({ postId: hot.id }) });
    assert.ok(res.ok);
  }
  await poll(() => ev(`return !!document.querySelector(${JSON.stringify(hotSelector + ' .community-verification.community-verified')});`));
  check('Three distinct voters produce blue Community Verified while retaining weather evidence', await ev(`const p=document.querySelector(${JSON.stringify(hotSelector)});return p.querySelector('.community-confirmations span').textContent.startsWith('3 / 3') && !!p.querySelector('.community-weather') && !p.querySelector('.community-verification.confirmed');`));
  await screenshot('community-human-confirmed');
  await ev("scrollTo(0,0);return true;");
  await screenshot('community-images-and-laika');
  const response = await fetch('http://127.0.0.1:8787');
  check('Production CSP permits Open-Meteo geocoding', response.headers.get('content-security-policy')?.includes('https://geocoding-api.open-meteo.com'));
  check('No browser runtime exceptions in Community workflow', runtimeErrors.length === 0, runtimeErrors);
} catch (error) {
  failure = error.stack; process.exitCode = 1;
  if (ev) results.push({ name: 'Failure context', pass: false, detail: await ev("return document.querySelector('.community-page')?.innerText;").catch(() => 'Unavailable') });
  if (screenshot) await screenshot('community-failure').catch(() => {});
} finally {
  ws?.close(); chrome.kill();
  if (api.exitCode === null) await new Promise(resolve => { api.once('exit', resolve); api.kill(); });
  await sleep(700);
  const resolved = path.resolve(runtime);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('continuum-community-browser-')) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Chrome may briefly retain its temporary profile. */ }
  }
  const report = { status: failure ? 'partial' : 'verified', origin, database: 'isolated temporary store; user database untouched',
    providers: 'Real Biratnagar geocoding; later search failure/race fixtures. Real stored FIRMS tuples. Current weather uses explicit hot/dry and cold/wet fixtures from tests/helpers/community-api.mjs. Discord relay tested locally; outbound network disabled.',
    pass: results.filter(r => r.pass).length, total: results.length, failure, results };
  fs.writeFileSync('docs/community-e2e-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, pass: report.pass, total: report.total, failure }, null, 2));
}
