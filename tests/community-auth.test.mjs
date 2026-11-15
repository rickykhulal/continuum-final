import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-community-audit-'));
const base = 'http://127.0.0.1:4196/api/v1';
let server;
const syncSecret = crypto.randomBytes(32).toString('hex');
const live = JSON.parse(fs.readFileSync('public/data/live_fires.json', 'utf8'));
before(async () => {
  server = spawn(process.execPath, ['tests/helpers/community-api.mjs'], {
    env: { ...process.env, PORT: '4196', APP_DATA_PATH: runtime, API_RATE_LIMITS: 'classA:1000/min;classB:1000/min;classC:1000/min', API_CORS_ORIGINS: 'https://audit.example', DISCORD_SYNC_SECRET: syncSecret, DISCORD_WEBHOOK_URL: '', DISCORD_BOT_TOKEN: '' }, stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* startup */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Isolated community API did not start');
});

test('configured browser clients may send their API key through CORS preflight', async () => {
  const res = await fetch(`${base}/community/feed`, { method: 'OPTIONS', headers: {
    origin: 'https://audit.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-api-key',
  } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://audit.example');
  assert.match(res.headers.get('access-control-allow-headers'), /x-api-key/i);
});

test('first poll vote requires a real registered key even when the registry is empty', async () => {
  assert.equal((await fetch(`${base}/community/vote`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'unregistered' }, body: JSON.stringify({ postId: 'fixture', optionIndex: 0 }) })).status, 401);
  assert.equal((await fetch(`${base}/community/upvote`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'unregistered' }, body: JSON.stringify({ postId: 'fixture' }) })).status, 401);
});
after(async () => {
  if (server && server.exitCode === null) {
    await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
  }
  fs.rmSync(runtime, { recursive: true, force: true });
});

test('key issuance stays public while data endpoints continue enforcing registered keys', async () => {
  const issue = () => fetch(`${base}/auth/generate-key`, { method: 'POST' });
  const first = await issue();
  assert.equal(first.status, 200);
  const firstKey = (await first.json()).api_key;
  assert.equal(typeof firstKey, 'string');
  assert.equal((await fetch(`${base}/community/feed`)).status, 401);
  assert.equal((await fetch(`${base}/community/feed`, { headers: { 'x-api-key': 'not-a-key' } })).status, 401);
  const second = await issue();
  assert.equal(second.status, 200);
  const secondKey = (await second.json()).api_key;
  assert.ok(secondKey !== firstKey);
  for (const key of [firstKey, secondKey]) {
    assert.equal((await fetch(`${base}/community/feed`, { headers: { 'x-api-key': key } })).status, 200);
  }
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/openapi.json`)).status, 200);
});

test('satellite matches auto-confirm and rechecks announce exactly once; client flags cannot confirm', async () => {
  const key = (await (await fetch(`${base}/auth/generate-key`, { method: 'POST' })).json()).api_key;
  const post = (route, body) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body),
  });
  const [lat, lon] = live.fires[0];
  const created = await post('/community/posts', { author: 'TEST ONLY', type: 'text', isAnomaly: true, content: 'Synthetic local regression report.', lat, lon });
  assert.equal(created.status, 200);
  const report = (await created.json()).post;
  assert.equal(report.type, 'anomaly');
  assert.equal(report.verificationStatus, 'satellite_confirmed');
  assert.equal(report.satelliteMatch.distanceKm, 0);
  const humanVote = (await (await post('/community/upvote', { postId: report.id })).json()).post;
  assert.equal(humanVote.verificationStatus, 'satellite_confirmed'); assert.equal(humanVote.verificationVotes, 0);
  for (let i = 0; i < 2; i++) {
    const verified = await post('/community/verify', { postId: report.id, verified: true });
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).post.verified, true);
  }
  const feed = await (await fetch(`${base}/community/feed`, { headers: { 'x-api-key': key } })).json();
  assert.equal(feed.announcements.filter(a => a.sourcePostId === report.id).length, 1);
  const unlocated = (await (await post('/community/posts', { content: 'Unlocated fixture', type: 'anomaly', verified: true, verificationStatus: 'satellite_confirmed', source: 'discord' })).json()).post;
  assert.equal(unlocated.source, 'web');
  assert.equal(unlocated.verificationStatus, 'pending');
  assert.equal((await (await post('/community/verify', { postId: unlocated.id, verified: true })).json()).post.verified, false);
});

test('Discord sync requires its own secret, imports location, and never echoes outbound', async () => {
  const key = (await (await fetch(`${base}/auth/generate-key`, { method: 'POST' })).json()).api_key;
  const payload = { name: 'Discord fixture', content: 'Test only', lat: live.fires[0][0], lon: live.fires[0][1], locationName: 'Fixture detection' };
  const sync = headers => fetch(`${base}/community/discord-sync`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  assert.equal((await sync({})).status, 401);
  assert.equal((await sync({ 'x-discord-secret': 'wrong' })).status, 401);
  assert.equal((await sync({ 'x-api-key': key })).status, 401);
  const accepted = await sync({ 'x-discord-secret': syncSecret });
  assert.equal(accepted.status, 200);
  const result = await accepted.json();
  assert.equal(result.success, true);
  assert.equal(result.post.source, 'discord');
  assert.equal(result.post.author, payload.name);
  assert.equal(result.post.locationName, payload.locationName);
  assert.equal(result.post.verificationStatus, 'satellite_confirmed');
  assert.equal(result.discordDelivery, undefined);
  assert.equal((await fetch(`${base}/community/discord-sync`, { method: 'GET' })).status, 405);
  assert.equal((await fetch(`${base}/community/discord-sync`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-discord-secret': syncSecret }, body: JSON.stringify({ content: 'Invalid coordinates', lat: 100, lon: 0 }) })).status, 422);
});

test('poll API persists votes, treats repeat votes as idempotent, and supports changing choice', async () => {
  const key = (await (await fetch(`${base}/auth/generate-key`, { method: 'POST' })).json()).api_key;
  const headers = { 'content-type': 'application/json', 'x-api-key': key };
  const post = async (route, body) => {
    const res = await fetch(`${base}/community/${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(res.status, 200); return res.json();
  };
  const { post: poll } = await post('posts', { type: 'poll', content: 'Test question', pollOptions: [{ text: 'Yes', votes: 99 }, { text: 'No' }] });
  assert.deepEqual(poll.pollOptions.map(o => o.votes), [0, 0]);
  for (let i = 0; i < 2; i++) assert.deepEqual((await post('vote', { postId: poll.id, optionIndex: 0 })).post.pollOptions.map(o => o.votes), [1, 0]);
  assert.deepEqual((await post('vote', { postId: poll.id, optionIndex: 1 })).post.pollOptions.map(o => o.votes), [0, 1]);
  const feed = await (await fetch(`${base}/community/feed`, { headers })).json();
  const saved = feed.posts.find(p => p.id === poll.id);
  assert.equal(saved.selectedOption, 1);
  assert.equal(saved._voters, undefined);
  assert.deepEqual(saved.pollOptions.map(o => o.votes), [0, 1]);
  assert.equal((await fetch(`${base}/community/vote`, { method: 'POST', headers, body: JSON.stringify({ postId: poll.id, optionIndex: 6 }) })).status, 422);
});

test('web and Discord image posts persist; relay retries do not duplicate; invalid images are rejected', async () => {
  const imageBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
  const key = (await (await fetch(`${base}/auth/generate-key`, { method: 'POST' })).json()).api_key;
  const web = await fetch(`${base}/community/posts`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ content: 'Image fixture', imageBase64 }) });
  assert.equal(web.status, 200); assert.equal((await web.json()).post.imageBase64, imageBase64);
  const headers = { 'content-type': 'application/json', 'x-discord-secret': syncSecret };
  const imageUrl = 'https://i.imgur.com/fixture.png';
  const body = JSON.stringify({ author: 'Image relay', content: 'Smoke fixture', imageBase64, imageUrl, locationName: 'Unresolved location', discordMessageId: '123456789012345678' });
  const first = await fetch(`${base}/community/discord-sync`, { method: 'POST', headers, body });
  assert.equal(first.status, 200);
  const original = (await first.json()).post;
  const retry = (await (await fetch(`${base}/community/discord-sync`, { method: 'POST', headers, body })).json()).post;
  assert.equal(original.id, retry.id); assert.equal(original.author, 'Image relay'); assert.equal(original.source, 'discord');
  assert.equal(original.imageBase64, imageBase64); assert.equal(original.verificationStatus, 'pending');
  assert.equal(original.imageUrl, imageUrl);
  const saved = (await (await fetch(`${base}/community/feed`, { headers: { 'x-api-key': key } })).json()).posts.find(post => post.id === original.id);
  assert.equal(saved.imageUrl, imageUrl); assert.equal(saved.imageBase64, imageBase64);
  const invalid = await fetch(`${base}/community/discord-sync`, { method: 'POST', headers, body: JSON.stringify({ content: 'Invalid image', imageBase64: 'data:image/svg+xml;base64,PHN2Zz4=' }) });
  assert.equal(invalid.status, 422);
});

test('report image envelope accepts 4 MiB decoded images and rejects larger images', async () => {
  const bytes = Buffer.alloc(4 * 1024 * 1024);
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64').copy(bytes);
  const headers = { 'content-type': 'application/json', 'x-discord-secret': syncSecret };
  const send = image => fetch(`${base}/community/discord-sync`, { method: 'POST', headers, body: JSON.stringify({ content: 'Boundary-size image fixture', imageBase64: `data:image/png;base64,${image.toString('base64')}` }) });
  const accepted = await send(bytes);
  assert.equal(accepted.status, 200);
  assert.equal(Buffer.from((await accepted.json()).post.imageBase64.split(',')[1], 'base64').length, bytes.length);
  const rejected = await send(Buffer.concat([bytes, Buffer.from([0])]));
  assert.equal(rejected.status, 422);
});

test('weather risk and three independent human confirmations persist through API rechecks', async () => {
  const keys = await Promise.all(Array.from({ length: 3 }, async () => (await (await fetch(`${base}/auth/generate-key`, { method: 'POST' })).json()).api_key));
  const request = async (route, body, key = keys[0]) => {
    const response = await fetch(`${base}/community/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return (await response.json()).post;
  };
  const hot = await request('posts', { type: 'anomaly', content: 'TEST hot/dry fixture', lat: 34, lon: -116 });
  assert.equal(hot.verificationStatus, 'weather_warning'); assert.deepEqual(hot.weatherData, { temp: 34, humidity: 20, wind: 25 });
  const cold = await request('posts', { type: 'anomaly', content: 'TEST London fixture', lat: 51.5074, lon: -0.1278 });
  assert.equal(cold.verificationStatus, 'pending'); assert.deepEqual(cold.weatherData, { temp: 8, humidity: 80, wind: 5 });
  const failed = await request('posts', { type: 'anomaly', content: 'TEST provider failure', lat: -60, lon: 0 });
  assert.equal(failed.verificationStatus, 'pending'); assert.equal(failed.weatherData, null);
  for (const report of [hot, cold]) {
    const route = report.id === hot.id ? 'vote' : 'upvote';
    const ballot = route === 'vote' ? { postId: report.id, action: 'verify' } : { postId: report.id };
    for (let i = 0; i < 2; i++) assert.equal((await request(route, ballot)).verificationVotes, 1);
    const second = await request(route, ballot, keys[1]);
    assert.equal(second.verificationVotes, 2); assert.notEqual(second.verificationStatus, 'community_verified');
    const third = await request(route, ballot, keys[2]);
    assert.equal(third.verificationStatus, 'community_verified'); assert.equal(third.verificationVotes, 3);
    assert.equal(third.verified, false); assert.equal(third._verificationVoters, undefined);
    assert.equal((await request('verify', { postId: report.id })).verificationStatus, 'community_verified');
  }
  for (const extra of [{ action: 'approve' }, { action: 'verify', optionIndex: 0 }]) {
    const response = await fetch(`${base}/community/vote`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': keys[0] }, body: JSON.stringify({ postId: hot.id, ...extra }) });
    assert.equal(response.status, 422);
  }
  const forged = await request('posts', { type: 'anomaly', content: 'Forged votes fixture', verificationStatus: 'community_verified', verificationVotes: 3, _verificationVoters: { a: true, b: true, c: true }, weatherData: { temp: 99, humidity: 0, wind: 99 } });
  assert.equal(forged.verificationStatus, 'pending'); assert.equal(forged.verificationVotes, 0);
});
