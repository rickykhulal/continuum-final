// Focused release checks: real built UI, with explicitly stalled/failed network fixtures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const origin = process.env.E2E_ORIGIN || 'http://127.0.0.1:8787';
const port = 9227, profile = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-release-'));
const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
let ws, failure, diagnose, mode = 'archive-timeout', liveStarted = 0;
const held = [];
const check = (name, condition, detail) => { results.push({ name, pass: !!condition, detail }); assert.ok(condition, name); };
async function poll(fn, timeout = 25000) { const start = Date.now(); while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await sleep(100); } throw new Error('Browser condition timed out'); }

try {
  const version = await poll(async () => { try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { return null; } });
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
    } else if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      if ((mode === 'archive-timeout' && request.url.includes('/data/archive_daily.json')) || request.url.includes('/api/v1/live-firms')) {
        held.push([requestId, message.sessionId]);
        if (request.url.includes('/api/v1/live-firms')) liveStarted = Date.now();
      } else if (mode === 'snapshot-failure' && request.url.includes('/data/live_fires.json')) {
        void send('Fetch.fulfillRequest', { requestId, responseCode: 503, body: '' }, message.sessionId).catch(() => {});
      } else void send('Fetch.continueRequest', { requestId }, message.sessionId).catch(() => {});
    }
  };
  const targets = await send('Target.getTargets');
  const { sessionId: session } = await send('Target.attachToTarget', { targetId: targets.targetInfos.find(t => t.type === 'page').targetId, flatten: true });
  const ev = async body => { const result = await send('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true }, session); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  diagnose = async () => {
    const state = await ev("return {url:location.href,boot:document.querySelector('.boot-error-card')?.textContent,loading:document.querySelector('.boot-loading-card')?.textContent,cells:document.querySelectorAll('.cal-cell').length,atlas:!!document.querySelector('.atlas-page'),toast:document.querySelector('.toast')?.textContent,body:document.body.innerText.slice(-1000)};");
    fs.mkdirSync('.shots', {recursive:true});
    const shot = await send('Page.captureScreenshot', {format:'png'}, session); fs.writeFileSync('.shots/release-failure.png',Buffer.from(shot.data,'base64'));
    return state;
  };
  await send('Page.enable', {}, session); await send('Runtime.enable', {}, session);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/data/archive_daily.json' }, { urlPattern: '*/api/v1/live-firms' }, { urlPattern: '*/data/live_fires.json' }] }, session);
  const navigate = hash => send('Page.navigate', { url: `${origin}/?release=${Date.now()}${hash}` }, session);
  const start = Date.now();
  await navigate('#/developers');
  const fallback = await poll(() => ev("return document.querySelector('.developers-page') && document.querySelector('.toast')?.textContent;"));
  check('A stalled archive cannot keep bundled startup loading forever', /Live API timeout. Using bundled snapshot./.test(fallback), { elapsedMs: Date.now() - start, toast: fallback });
  const portal = await ev("return document.querySelector('.dev-table').textContent;");
  check('Developer portal documents regional outlook and verification action', portal.includes('/outlook?region_id=nepal') && portal.includes('/community/vote') && portal.includes('action: "verify"'));
  mode = 'live-timeout';
  for (const [requestId, sessionId] of held.splice(0)) await send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }, sessionId).catch(() => {});
  await navigate('#/atlas?r=chilecito');
  await poll(() => ev("return document.querySelectorAll('.cal-cell').length > 0 && !!document.querySelector('.pet-drag-handle canvas');"));
  const liveFallback = await poll(() => ev("return document.querySelector('.toast')?.textContent?.includes('Live API timeout.') && document.querySelector('.toast').textContent;"));
  check('Stalled live API falls back after ten seconds with a toast', !!liveFallback && Date.now() - liveStarted < 16000, { elapsedMs: Date.now() - liveStarted });
  check('Map identifies its bundled snapshot after the timeout', await ev("return document.querySelector('.atlas-page').textContent.includes('Bundled snapshot (Live API offline)');"));

  const geometry = () => ev(`
    const box=document.querySelector('.pet-drag-handle').getBoundingClientRect();
    const svg=document.querySelector('.pet-oxygen-pipe');
    const path=svg.querySelector('path').getAttribute('d');
    const numbers=path.match(/-?\\d+(?:\\.\\d+)?/g).map(Number);
    return {x:box.x,y:box.y,w:box.width,h:box.height,start:numbers.slice(0,2),end:numbers.slice(-2),paths:[...svg.querySelectorAll('path')].map(p=>p.getAttribute('d')),pointerEvents:getComputedStyle(svg).pointerEvents,viewport:[innerWidth,innerHeight],bubble:!!document.querySelector('.pet-speech-bubble')};`);
  const connected = value => Math.hypot(value.end[0] - value.x - value.w / 2, value.end[1] - value.y - value.h / 2) < 1 && value.start.every((n,i) => n === value.viewport[i]) && value.paths[0] === value.paths[1];
  const before = await geometry();
  check('Both tether paths attach to the suit center and viewport corner', connected(before), before);
  check('Tether cannot intercept pointer events', before.pointerEvents === 'none');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x + before.w / 2, y: before.y + before.h / 2, button: 'left', clickCount: 1 }, session);
  for (const [dx,dy] of [[-80,-40],[-170,-100],[-250,-150]]) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x + before.w / 2 + dx, y: before.y + before.h / 2 + dy, button: 'left', buttons: 1 }, session);
    await sleep(75);
    const moving = await geometry(); check(`Tether stays attached during drag ${dx},${dy}`, connected(moving), moving);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x + before.w / 2 - 250, y: before.y + before.h / 2 - 150, button: 'left', clickCount: 1 }, session);
  const after = await geometry();
  check('Dragging moves Laika without opening a fact', Math.abs(after.x - before.x + 250) < 2 && !after.bubble, after);
  await send('Emulation.setDeviceMetricsOverride', { width: 920, height: 720, deviceScaleFactor: 1, mobile: false }, session);
  await sleep(150); const resized = await geometry(); check('Resize clamps Laika and reconnects tether', connected(resized) && resized.x >= 0 && resized.x + resized.w <= 920, resized);
  await ev("document.querySelector('.pet-drag-handle').focus();");
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }, session);
  await sleep(100); check('Keyboard movement keeps the tether attached', connected(await geometry()));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, session);
  check('Laika still shares an educational fact on demand', await ev("return !!document.querySelector('.pet-speech-bubble')?.textContent?.trim();"));
  fs.mkdirSync('.shots', { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' }, session); fs.writeFileSync('.shots/release-laika-tether.png', Buffer.from(shot.data, 'base64'));

  mode = 'snapshot-failure'; await navigate('#/developers');
  await poll(() => ev("return !!document.querySelector('.boot-error-card');"));
  check('Missing snapshot shows a recoverable error rather than invented zero detections', await ev("return document.querySelector('.boot-error-card').textContent.includes('Retry connection') && !document.querySelector('.developers-page');"));
  mode = 'success'; await ev("document.querySelector('.boot-error-card button').click();");
  await poll(() => ev("return !!document.querySelector('.developers-page');"));
  check('Retry recovers after the snapshot becomes available', true);
} catch (error) { failure = {message:error.message, state:await diagnose?.().catch(() => null)}; }
finally {
  ws?.close(); chrome.kill(); await sleep(500);
  fs.rmSync(profile, { recursive: true, force: true });
  const report = { status: failure ? 'partial' : 'verified', origin, providers: 'Bundled data; explicit archive/live API timeout and snapshot HTTP failure fixtures; no posts or Discord messages sent.', pass: results.filter(r => r.pass).length, total: results.length, failure, results };
  fs.writeFileSync('docs/release-e2e-report.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
  if (failure) process.exitCode = 1;
}
