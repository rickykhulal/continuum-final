import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { satelliteCrossCheck, discordSyncAuthorized, sendDiscordReport } from '../server/community-integrations.mjs';
import { createCommunityStore, CommunityValidationError } from '../server/community-store.mjs';

const timestamp = Date.parse('2026-11-01T12:00:00Z') / 1000;
const bundle = (...points) => ({ fires: points.map(([lat, lon]) => [lat, lon, 10, 0, 90, timestamp]), meta: { windowStart: '2026-10-26', windowEnd: '2026-11-02' } });
const temporary = fn => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-community-unit-'));
  try { fn(createCommunityStore(dir), dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test('satellite distance handles the radius boundary, nearest point and antimeridian', () => {
  const degrees = km => km / 6371 * 180 / Math.PI;
  assert.equal(satelliteCrossCheck(0, 0, bundle([degrees(14.999), 0])).verificationStatus, 'satellite_confirmed');
  assert.equal(satelliteCrossCheck(0, 0, bundle([degrees(15.001), 0])).verificationStatus, 'pending');
  const match = satelliteCrossCheck(0, 0, bundle([degrees(10), 0], [degrees(3), 0])).satelliteMatch;
  assert.ok(Math.abs(match.distanceKm - 3) < 1e-8);
  assert.equal(match.acquiredAt, '2026-11-01T12:00:00.000Z');
  assert.equal(match.windowEnd, '2026-11-02');
  assert.equal(satelliteCrossCheck(0, 179.99, bundle([0, -179.99])).verificationStatus, 'satellite_confirmed');
});

test('missing or malformed evidence and invalid coordinates remain pending', () => {
  for (const data of [null, {}, { fires: [] }, { fires: [[0, 0, 10, 0, 90, null]] }, bundle([91, 0])]) {
    assert.deepEqual(satelliteCrossCheck(0, 0, data), { verificationStatus: 'pending', satelliteMatch: null });
  }
  for (const point of [[null, null], [NaN, 0], [0, 181], ['0', 0]]) assert.equal(satelliteCrossCheck(...point, bundle([0, 0])).verificationStatus, 'pending');
});

test('database regenerates as an empty array and schema uses server authority', () => temporary((store, dir) => {
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'community.json'))), []);
  const post = store.createPost({ content: 'Test only', lat: 0, lon: 0, locationName: 'Equator', source: 'discord', verificationStatus: 'satellite_confirmed' });
  assert.equal(post.source, 'web'); assert.equal(post.verificationStatus, 'pending');
  assert.equal(post.lat, 0); assert.equal(post.lon, 0); assert.equal(post.author, 'Anonymous');
  assert.deepEqual(post.pollOptions, []); assert.equal(post._voters, undefined);
  fs.unlinkSync(path.join(dir, 'community.json'));
  assert.deepEqual(store.getPosts(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'community.json'))), []);
}));

test('store validates content, coordinates, and distinct poll options without writing invalid posts', () => temporary(store => {
  for (const input of [{}, { content: ' ' }, { content: 'x'.repeat(1001) }, { content: 'x', type: 'other' },
    { content: 'x', lat: 5 }, { content: 'x', lat: '', lon: '' }, { content: 'x', lat: 91, lon: 0 },
    { content: 'x', locationName: 'Incomplete coordinates', lon: 0 }, { content: 'x', type: 'poll', pollOptions: ['One'] },
    { content: 'x', type: 'poll', pollOptions: ['One', ' one '] }, { content: 'x', type: 'poll', pollOptions: ['', 'Two'] }]) {
    assert.throws(() => store.createPost(input), CommunityValidationError);
  }
  assert.equal(store.getPosts().length, 0);
}));

test('poll votes survive reopening, exclude voter identities, and change atomically', () => temporary((store, dir) => {
  const post = store.createPost({ content: 'Test poll', type: 'poll', pollOptions: [{ text: 'A', votes: 20 }, { text: 'B' }] });
  assert.deepEqual(post.pollOptions.map(o => o.votes), [0, 0]);
  for (let i = 0; i < 3; i++) store.votePoll({ postId: post.id, optionIndex: 0, voterId: 'voter1' });
  store.votePoll({ postId: post.id, optionIndex: 1, voterId: 'voter2' });
  const reopened = createCommunityStore(dir);
  assert.deepEqual(reopened.getPosts()[0].pollOptions.map(o => o.votes), [1, 1]);
  reopened.votePoll({ postId: post.id, optionIndex: 1, voterId: 'voter1' });
  const visible = reopened.getPosts({ voterId: 'voter1' })[0];
  assert.deepEqual(visible.pollOptions.map(o => o.votes), [0, 2]);
  assert.equal(visible.selectedOption, 1); assert.equal(visible._voters, undefined);
  assert.equal(reopened.votePoll({ postId: post.id, optionIndex: 2, voterId: 'voter1' }), null);
}));

test('satellite recheck can remove confirmation and announcements when evidence disappears', () => temporary(store => {
  const post = store.createPost({ content: 'Fixture only', type: 'anomaly', lat: 0, lon: 0 }, { source: 'discord', liveBundle: bundle([0, 0]) });
  assert.equal(post.source, 'discord'); assert.equal(post.verified, true);
  assert.equal(store.getAnnouncements().length, 1);
  assert.equal(store.verifyAnomaly({ postId: post.id, verified: true }, null).verified, false);
  assert.equal(store.getAnnouncements().length, 0);
}));

test('legacy store migrates but old manual verification is not satellite evidence', () => temporary((store, dir) => {
  fs.writeFileSync(path.join(dir, 'community.json'), JSON.stringify({ posts: [{ id: 'legacy', author: 'Test', content: 'Test', createdAt: '2026-01-01', type: 'poll', verified: true, options: ['A', 'B'], votes: { 0: 3 } }] }));
  const legacy = store.getPosts()[0];
  assert.equal(legacy.verified, false); assert.deepEqual(legacy.pollOptions.map(o => o.votes), [3, 0]);
  store.createPost({ content: 'New fixture' });
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(path.join(dir, 'community.json')))));
  fs.writeFileSync(path.join(dir, 'community.json'), 'broken JSON');
  assert.throws(() => store.getPosts());
  assert.equal(fs.readFileSync(path.join(dir, 'community.json'), 'utf8'), 'broken JSON');
}));

test('Discord authentication denies unconfigured, blank, and mismatched secrets', () => {
  assert.equal(discordSyncAuthorized('', ''), false);
  assert.equal(discordSyncAuthorized('anything', ' '), false);
  assert.equal(discordSyncAuthorized(undefined, 'fixture-secret'), false);
  assert.equal(discordSyncAuthorized('wrong', 'fixture-secret'), false);
  assert.equal(discordSyncAuthorized('fixture-secret', 'fixture-secret'), true);
});

test('Discord outbound creates the required embed and suppresses mention notifications', async () => {
  let request;
  const post = { content: 'Test @everyone', locationName: 'Biratnagar, Nepal', verificationStatus: 'pending' };
  const result = await sendDiscordReport(post, { webhookUrl: 'https://discord.com/api/webhooks/123/fixture', fetchImpl: async (url, options) => { request = options; return { ok: true }; } });
  assert.equal(result, 'sent'); assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
  const body = JSON.parse(request.body);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(body.embeds[0].title, '🔥 New Community Report');
  assert.equal(body.embeds[0].description, post.content);
  assert.deepEqual(body.embeds[0].fields, [{ name: 'Location', value: post.locationName }, { name: 'Status', value: 'pending' }]);
});

test('Discord absence and failures are nonfatal and invalid destinations are never fetched', async () => {
  const post = { content: 'Test', verificationStatus: 'pending' };
  for (const webhookUrl of ['', 'http://discord.com/api/webhooks/123/fixture', 'https://example.com/api/webhooks/123/fixture']) {
    const result = await sendDiscordReport(post, { webhookUrl, fetchImpl: async () => { assert.fail('Unexpected fetch'); } });
    assert.equal(result, webhookUrl ? 'failed' : 'not_configured');
  }
  const webhookUrl = 'https://discord.com/api/webhooks/123/fixture';
  assert.equal(await sendDiscordReport(post, { webhookUrl, fetchImpl: async () => ({ ok: false }) }), 'failed');
  assert.equal(await sendDiscordReport(post, { webhookUrl, fetchImpl: async () => { throw new Error('fixture failure'); } }), 'failed');
});
