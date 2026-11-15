import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionFlagsBits, MessageFlags, ButtonStyle, TextInputStyle, ChannelType, Events } from 'discord.js';
import { setupReportCommand, reportPanel, reportModal, registerReportCommand, attachReportInteractions, createDiscordInteractionHandler } from '../scripts/discord-interactions.mjs';
import { BridgeError, resolveModalLocation, resolveReportLocation, downloadReportImageUrl, verificationMessage, createGeminiLocationParser } from '../scripts/discord-bridge.mjs';

const event = (kind, fields = {}, extras = {}) => {
  const calls = [];
  return { id: '1571531995589378269', guildId: 'guild', channel: { type: ChannelType.GuildText }, user: { username: 'Observer' }, calls,
    inGuild: () => true, memberPermissions: { has: () => true }, appPermissions: { has: () => true },
    isChatInputCommand: () => kind === 'command', isButton: () => kind === 'button', isModalSubmit: () => kind === 'modal',
    commandName: 'setup-report', customId: kind === 'button' ? 'report_fire_btn' : 'report_fire_modal',
    fields: { getTextInputValue: name => fields[name] || '' },
    reply: async body => calls.push(['reply', body]), deferReply: async body => calls.push(['defer', body]),
    editReply: async body => calls.push(['edit', body]), showModal: async modal => calls.push(['modal', modal.toJSON()]), ...extras };
};
const validFields = { location_input: '34, -116', description_input: 'Smoke fixture' };
const handler = options => createDiscordInteractionHandler({ guildId: 'guild', parseLocation: async () => 'Biratnagar, Nepal', forward: async () => ({ verificationStatus: 'pending' }), ...options });

test('admin-only command and panel serialize the required button and embed', () => {
  assert.equal(setupReportCommand().default_member_permissions, PermissionFlagsBits.Administrator.toString());
  const panel = reportPanel();
  assert.equal(panel.embeds[0].toJSON().title, '🔥 Continuum Fire Report System');
  const button = panel.components[0].toJSON().components[0];
  assert.equal(button.custom_id, 'report_fire_btn'); assert.equal(button.label, 'Report an Incident'); assert.equal(button.style, ButtonStyle.Primary);
});
test('modal has four required/optional fields with exact IDs and limits', () => {
  const modal = reportModal().toJSON();
  assert.equal(modal.custom_id, 'report_fire_modal'); assert.equal(modal.title, 'Report a Fire Incident');
  const fields = modal.components.map(row => row.components[0]);
  assert.deepEqual(fields.map(f => f.custom_id), ['location_input', 'description_input', 'image_url_input', 'reporter_name']);
  assert.deepEqual(fields.map(f => f.required), [true, true, false, false]);
  assert.equal(fields[1].style, TextInputStyle.Paragraph); assert.equal(fields[0].style, TextInputStyle.Short);
});
test('registration updates only setup-report and preserves unrelated commands', async () => {
  const edited = [], created = [];
  const manager = { fetch: async () => new Collection([['1', { id: '1', name: 'unrelated', type: 1 }], ['2', { id: '2', name: 'setup-report', type: 1 }]]), edit: async (id, body) => edited.push({ id, body }), create: async body => created.push(body) };
  await registerReportCommand(manager); assert.equal(edited[0].id, '2'); assert.equal(created.length, 0);
  manager.fetch = async () => new Collection(); await registerReportCommand(manager); assert.equal(created[0].name, 'setup-report');
});
test('ordinary messages and unrelated interactions are not consumed', async () => {
  const subscriptions = [];
  attachReportInteractions({ on: (name, callback) => subscriptions.push([name, callback]) }, handler());
  assert.deepEqual(subscriptions.map(([name]) => name), [Events.InteractionCreate]);
  const unrelated = event('other'); await handler()(unrelated); assert.equal(unrelated.calls.length, 0);
});
test('non-admin setup and DMs get private errors; admin panel is public in current channel', async () => {
  const nonAdmin = event('command', {}, { memberPermissions: { has: () => false } });
  await handler()(nonAdmin); assert.equal(nonAdmin.calls[0][1].flags, MessageFlags.Ephemeral);
  const dm = event('button', {}, { inGuild: () => false }); await handler()(dm); assert.equal(dm.calls[0][1].flags, MessageFlags.Ephemeral);
  const admin = event('command'); await handler()(admin); assert.equal(admin.calls[0][0], 'reply'); assert.ok(admin.calls[0][1].embeds); assert.equal(admin.calls[0][1].flags, undefined);
});
test('report button opens the modal without a network call', async () => {
  const button = event('button'); await handler({ parseLocation: async () => assert.fail('No Gemini here') })(button);
  assert.equal(button.calls[0][0], 'modal'); assert.equal(button.calls[0][1].custom_id, 'report_fire_modal');
});
test('numeric coordinates skip Gemini; named places use Gemini and unique geocoding', async () => {
  assert.deepEqual(await resolveModalLocation('0, 0', { parseLocation: async () => assert.fail() }), { lat: 0, lon: 0, locationName: '0, 0' });
  assert.equal((await resolveModalLocation('(26.455, 87.27)', {})).lat, 26.455);
  await assert.rejects(resolveModalLocation('91, 200', {}), /Latitude/);
  const named = await resolveModalLocation('Biratnagar Nepal', { parseLocation: async raw => { assert.equal(raw, 'Biratnagar Nepal'); return 'Biratnagar, Nepal'; }, resolveLocation: async (_, name) => ({ lat: 26.455, lon: 87.27, locationName: name }) });
  assert.equal(named.locationName, 'Biratnagar, Nepal');
  await assert.rejects(resolveModalLocation('Ambiguous', { parseLocation: async () => 'Ambiguous', resolveLocation: async () => ({ lat: null, lon: null }) }), /uniquely/);
});
test('Gemini parses the location field even when it is not itself a fire description', async () => {
  const parse = createGeminiLocationParser({ generate: async () => JSON.stringify({ isFireReport: false, locationName: 'Biratnagar, Nepal' }) });
  assert.equal(await parse('Biratnagar Nepal'), 'Biratnagar, Nepal');
});

test('comma-formatted Gemini output searches the city and filters the supplied country', async () => {
  const parseLocation = createGeminiLocationParser({ generate: async () => JSON.stringify({ isFireReport: false, locationName: 'Biratnagar, Nepal' }) });
  const point = await resolveModalLocation('Biratnagar Nepal', { parseLocation, resolveLocation: (content, name) => resolveReportLocation(content, name, async url => {
    assert.equal(url.searchParams.get('name'), 'Biratnagar');
    return Response.json({ results: [{ name: 'Biratnagar', country: 'Nepal', latitude: 26.45505, longitude: 87.27007 }, { name: 'Biratnagar', country: 'India', latitude: 25, longitude: 87 }] });
  }) });
  assert.deepEqual(point, { lat: 26.45505, lon: 87.27007, locationName: 'Biratnagar, Nepal' });
});
test('modal acknowledges privately before network work and updates with actual weather status', async () => {
  const modal = event('modal', { ...validFields, reporter_name: 'Reporter', image_url_input: 'https://i.imgur.com/fixture.png' });
  let sent;
  await handler({ downloadImage: async url => { assert.equal(modal.calls[0][0], 'defer'); return { imageUrl: url, imageBase64: 'fixture' }; }, forward: async payload => { sent = payload; return { verificationStatus: 'weather_warning', weatherData: { temp: 34, humidity: 20, wind: 25 } }; } })(modal);
  assert.equal(modal.calls[0][1].flags, MessageFlags.Ephemeral); assert.equal(sent.author, 'Reporter'); assert.equal(sent.lat, 34); assert.equal(sent.lon, -116); assert.equal(sent.discordMessageId, modal.id);
  assert.equal(sent.imageUrl, 'https://i.imgur.com/fixture.png'); assert.equal(sent.content, 'Smoke fixture');
  assert.match(modal.calls.at(-1)[1].content, /Report Confirmed/); assert.match(modal.calls.at(-1)[1].content, /High Risk/); assert.match(modal.calls.at(-1)[1].content, /34°C/);
  assert.ok(modal.calls.every(([method]) => method !== 'reply'));
});
test('duplicate submissions are idempotent and blank optional author defaults to Discord name', async () => {
  let count = 0, author;
  const process = handler({ forward: async payload => { count++; author = payload.author; return { verificationStatus: 'pending' }; } });
  const modal = event('modal', validFields);
  await Promise.all([process(modal), process(modal)]); await process(modal);
  assert.equal(count, 1); assert.equal(author, 'Observer'); assert.match(modal.calls.at(-1)[1].content, /Pending verification/);
});
test('processing errors stay private and never claim that a failed report is live', async () => {
  const modal = event('modal', validFields);
  await handler({ forward: async () => { throw new BridgeError('API unavailable'); } })(modal);
  assert.equal(modal.calls.at(-1)[1].content, 'API unavailable'); assert.ok(!modal.calls.some(([, body]) => body.content?.includes('Report Confirmed')));
});

test('queued modals are acknowledged immediately and overflow receives a private response', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const process = handler({ maxQueue: 2, forward: async () => { entered(); await blocked; return { verificationStatus: 'pending' }; } });
  const first = event('modal', validFields), second = event('modal', validFields, { id: '1571531995589378270' }), third = event('modal', validFields, { id: '1571531995589378271' });
  const firstJob = process(first); await started;
  const secondJob = process(second);
  try {
    await Promise.resolve(); await Promise.resolve();
    assert.equal(second.calls[0][0], 'defer');
    await process(third); assert.equal(third.calls[0][1].flags, MessageFlags.Ephemeral); assert.match(third.calls[0][1].content, /queue is full/);
  } finally { release(); await Promise.all([firstJob, secondJob]); }
});
test('image links are downloaded as bounded raster data and unsafe targets never get fetched', async () => {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
  const result = await downloadReportImageUrl('https://imgur.com/abc123', async (url, init) => { assert.equal(url, 'https://i.imgur.com/abc123.jpg'); assert.equal(init.redirect, 'error'); return new Response(bytes, { headers: { 'content-type': 'image/png' } }); });
  assert.ok(result.imageBase64.startsWith('data:image/png;base64,'));
  for (const url of ['http://localhost/image.png', 'https://127.0.0.1/a', 'https://i.imgur.com.evil.invalid/a', 'https://imgur.com/a/album']) await assert.rejects(downloadReportImageUrl(url, async () => assert.fail('Unsafe fetch')));
  await assert.rejects(downloadReportImageUrl('https://i.imgur.com/abc123.jpg', async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })));
});
test('Discord status descriptions distinguish all four evidence types', () => {
  assert.match(verificationMessage({ verificationStatus: 'satellite_confirmed' }), /NASA FIRMS/);
  assert.match(verificationMessage({ verificationStatus: 'community_verified' }), /three community/);
  assert.match(verificationMessage({ verificationStatus: 'pending', weatherData: { temp: 8, humidity: 80, wind: 5 } }), /8°C, 80% RH/);
});
