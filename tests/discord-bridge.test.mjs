import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeCommunityImage, MAX_IMAGE_BYTES } from '../server/community-image.mjs';
import { loadCommunityEnv } from '../server/community-env.mjs';
import { createCommunityStore } from '../server/community-store.mjs';
import { sendDiscordReport } from '../server/community-integrations.mjs';
import { BridgeError, createGroqAnalyzer, createGeminiAnalyzer, explicitCoordinates, resolveReportLocation, downloadReportImage, forwardDiscordReport, createDiscordMessageHandler } from '../scripts/discord-bridge.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
const temporary = fn => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-bridge-test-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test('integration env loader preserves exported values and ignores unrelated .env settings', () => temporary(dir => {
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'DISCORD_BOT_TOKEN="fixture"\nGEMINI_MODEL=fixture-model\nPORT=1\nDATA_BUNDLE_PATH=bad\n');
  const env = { DISCORD_BOT_TOKEN: '' }; loadCommunityEnv(env, file);
  assert.deepEqual(env, { DISCORD_BOT_TOKEN: '', GEMINI_MODEL: 'fixture-model' });
}));

test('image validation rejects URL fetches, SVG, incorrect MIME, malformed encoding and oversize data', () => {
  assert.equal(decodeCommunityImage(png).mimeType, 'image/png');
  assert.equal(decodeCommunityImage(''), null);
});

test('invalid image inputs never become stored report attachments', () => {
  for (const value of ['https://example.com/image.png', 'data:image/svg+xml;base64,PHN2Zz4=', png.replace('image/png', 'image/jpeg'), 'data:image/png;base64,%%%=', png + 'A', `data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')}`]) {
    assert.throws(() => decodeCommunityImage(value));
  }
  assert.equal(decodeCommunityImage(null), null);
});

test('images persist, unresolved named places stay pending, and Discord retries deduplicate', () => temporary(dir => {
  const store = createCommunityStore(dir);
  const post = store.createPost({ author: 'Relay', content: 'Fixture smoke report', imageBase64: png, locationName: 'Unresolved place' }, { source: 'discord', discordMessageId: '123456789012345678' });
  assert.equal(post.verificationStatus, 'pending'); assert.equal(post.lat, null);
  assert.equal(createCommunityStore(dir).getPosts()[0].imageBase64, png);
  const retry = store.createPost({ content: 'Changed retry' }, { source: 'discord', discordMessageId: '123456789012345678' });
  assert.equal(retry.id, post.id); assert.equal(store.getPosts().length, 1);
  assert.throws(() => store.createPost({ content: 'Bad', imageBase64: 'not-an-image' }));
}));

test('Discord multipart upload carries image bytes and embeds an attachment reference', async () => {
  let request;
  assert.equal(await sendDiscordReport({ content: 'Test image', imageBase64: png, verificationStatus: 'pending' }, {
    webhookUrl: 'https://discord.com/api/webhooks/123/fixture', fetchImpl: async (url, options) => { request = options; return { ok: true }; },
  }), 'sent');
  assert.ok(request.body instanceof FormData); assert.equal(request.headers['Content-Type'], undefined);
  const payload = JSON.parse(request.body.get('payload_json'));
  assert.equal(payload.embeds[0].image.url, 'attachment://report.png');
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  const file = request.body.get('files[0]');
  assert.equal(file.type, 'image/png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), decodeCommunityImage(png).bytes);
});

test('bot-token delivery supports web cross-posts without a webhook', async () => {
  let request, target;
  const result = await sendDiscordReport({ content: 'Fixture', verificationStatus: 'pending' }, { webhookUrl: '', botToken: 'fixture', channelId: '123456789012345678',
    fetchImpl: async (url, options) => { target = url; request = options; return { ok: true }; } });
  assert.equal(result, 'sent'); assert.equal(target, 'https://discord.com/api/v10/channels/123456789012345678/messages');
  assert.equal(request.headers.Authorization, 'Bot fixture');
});

test('Groq receives text and image and returns only classification plus location, never invented coordinates', async () => {
  let received;
  const analyze = createGroqAnalyzer({ generate: async input => { received = input; return JSON.stringify({ isFireReport: true, locationName: 'Biratnagar, Nepal', lat: 12, lon: 34, verificationStatus: 'satellite_confirmed' }); } });
  assert.deepEqual(await analyze({ content: 'Smoke', imageBase64: png }), { isFireReport: true, locationName: 'Biratnagar, Nepal' });
  assert.equal(received.content, 'Smoke');
  assert.equal(received.image.mimeType, 'image/png');
});

test('Groq malformed or unavailable responses fail closed without leaking upstream errors', async () => {
  for (const generate of [async () => 'not JSON', async () => '{"isFireReport":"true","locationName":null}', async () => { throw new Error('private upstream details'); }]) {
    await assert.rejects(createGroqAnalyzer({ generate })({ content: 'Fixture' }), error => error instanceof BridgeError && !error.message.includes('private upstream'));
  }
});

test('location resolution uses explicit coordinates and unique geocoding results; ambiguity is not guessed', async () => {
  assert.deepEqual(explicitCoordinates('Smoke (26.455, 87.270)'), { lat: 26.455, lon: 87.27 });
  assert.deepEqual(explicitCoordinates('lat: 0, lon: 0'), { lat: 0, lon: 0 });
  assert.equal(explicitCoordinates('lat: 91, lon: 0'), null);
  const known = { name: 'Biratnagar', country: 'Nepal', latitude: 26.455, longitude: 87.27 };
  const resolved = await resolveReportLocation('Smoke', 'Biratnagar, Nepal', async () => new Response(JSON.stringify({ results: [known] })));
  assert.equal(resolved.lat, known.latitude);
  const ambiguous = await resolveReportLocation('Smoke', 'Biratnagar', async () => new Response(JSON.stringify({ results: [known, { ...known, latitude: 26.5 }] })));
  assert.equal(ambiguous.lat, null);
  const unavailable = await resolveReportLocation('Smoke', 'Biratnagar, Nepal', async () => { throw new Error(); });
  assert.equal(unavailable.lat, null); assert.equal(unavailable.locationName, 'Biratnagar, Nepal');
});

test('Discord attachment download is limited to bounded images from its CDN', async () => {
  const attachment = { contentType: 'image/png', size: 68, url: 'https://cdn.discordapp.com/attachments/1/2/report.png' };
  assert.equal(await downloadReportImage(attachment, async () => new Response(decodeCommunityImage(png).bytes)), png);
  await assert.rejects(downloadReportImage({ ...attachment, url: 'http://localhost/private' }, async () => { assert.fail('Should not fetch'); }));
  await assert.rejects(downloadReportImage({ ...attachment, size: MAX_IMAGE_BYTES + 1 }));
  await assert.rejects(downloadReportImage(attachment, async () => new Response(Buffer.alloc(MAX_IMAGE_BYTES + 1))));
});

test('forwarding retries transient failures with the same message ID and does not retry unauthorized responses', async () => {
  const payload = { content: 'Fixture', discordMessageId: '123456789012345678' }; const sent = [];
  const post = await forwardDiscordReport(payload, { secret: 'fixture', delay: async () => {}, fetchImpl: async (url, request) => {
    sent.push(JSON.parse(request.body));
    return sent.length === 1 ? new Response('', { status: 503 }) : new Response(JSON.stringify({ success: true, post: { verificationStatus: 'pending' } }));
  } });
  assert.equal(post.verificationStatus, 'pending'); assert.deepEqual(sent, [payload, payload]);
  let calls = 0;
  await assert.rejects(forwardDiscordReport(payload, { secret: 'fixture', fetchImpl: async () => { calls++; return new Response('', { status: 401 }); } }), /HTTP 401/);
  assert.equal(calls, 1);
  await assert.rejects(forwardDiscordReport(payload, { secret: 'fixture', apiUrl: 'http://example.com/api/v1', fetchImpl: async () => { assert.fail(); } }), /HTTPS/);
});

const message = overrides => ({ id: '123456789012345678', channelId: 'reports', author: { username: 'Observer', bot: false }, content: 'Smoke in Biratnagar', attachments: new Map(), reply: async () => {}, ...overrides });
test('bot ignores other channels, bot posts and webhooks to prevent loops', async () => {
  const handler = createDiscordMessageHandler({ channelId: 'reports', analyze: async () => assert.fail('Should ignore') });
  for (const item of [message({ channelId: 'other' }), message({ author: { bot: true } }), message({ webhookId: 'fixture' })]) await handler(item);
});

test('bot forwards image and author once, then replies with the actual satellite outcome', async () => {
  const forwarded = [], replies = [];
  const handler = createDiscordMessageHandler({ channelId: 'reports', analyze: async () => ({ isFireReport: true, locationName: 'Biratnagar, Nepal' }),
    downloadImage: async () => png, resolveLocation: async () => ({ lat: 26.455, lon: 87.27, locationName: 'Biratnagar, Nepal' }),
    forward: async payload => { forwarded.push(payload); return { verificationStatus: 'satellite_confirmed' }; } });
  const item = message({ reply: async payload => replies.push(payload) });
  await Promise.all([handler(item), handler(item)]); await handler(item);
  assert.equal(forwarded.length, 1); assert.equal(forwarded[0].imageBase64, png); assert.equal(forwarded[0].author, 'Observer');
  assert.match(replies[0].content, /nearby satellite detection/);
  assert.deepEqual(replies[0].allowedMentions, { parse: [], repliedUser: false });
});

test('unrelated reports and failed Gemini analysis are not forwarded', async () => {
  const replies = [];
  for (const analyze of [async () => ({ isFireReport: false, locationName: '' }), async () => { throw new BridgeError('Analysis unavailable'); }]) {
    const handler = createDiscordMessageHandler({ channelId: 'reports', analyze, forward: async () => assert.fail('Should not forward') });
    await handler(message({ reply: async payload => replies.push(payload.content) }));
  }
  assert.match(replies[0], /Nothing was forwarded/); assert.equal(replies[1], 'Analysis unavailable');
});
