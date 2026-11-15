import OpenAI from 'openai';
import { decodeCommunityImage, MAX_IMAGE_BYTES, normalizeCommunityImageUrl } from '../server/community-image.mjs';

export class BridgeError extends Error {}
const normalize = text => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const validPoint = (lat, lon) => Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180;

export function createGroqAnalyzer({ apiKey, modelName = 'llama-3.1-8b-instant', generate, client } = {}) {
  const groq = client || (generate ? null : new OpenAI({
    apiKey: apiKey || process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  }));
  return async ({ content, imageBase64 } = {}) => {
    try {
      const image = decodeCommunityImage(imageBase64);
      const userText = content || (image ? 'Fire/smoke observation report.' : '');
      let rawJson;
      if (generate) {
        const genResult = await generate({ content: userText, imageBase64, image });
        rawJson = typeof genResult === 'string' ? genResult : genResult?.choices?.[0]?.message?.content;
      } else {
        const response = await groq.chat.completions.create({
          model: modelName,
          messages: [
            {
              role: 'system',
              content: 'You are an AI assistant for a fire reporting system. Analyze the user\'s text. Extract the location if mentioned. Respond ONLY with a valid JSON object matching this schema: { "isFireReport": boolean, "locationName": string | null }',
            },
            {
              role: 'user',
              content: userText || 'Smoke/fire observation',
            },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
        });
        rawJson = response?.choices?.[0]?.message?.content;
      }
      if (typeof rawJson !== 'string') throw new Error('Invalid model output');
      const parsed = JSON.parse(rawJson);
      if (typeof parsed?.isFireReport !== 'boolean' || !(parsed.locationName === null || (typeof parsed.locationName === 'string' && parsed.locationName.length <= 160))) {
        throw new Error('Invalid model output');
      }
      return { isFireReport: parsed.isFireReport, locationName: parsed.locationName?.trim() || '' };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('AI analysis unavailable. Please check the API key.');
    }
  };
}

export const createGeminiAnalyzer = createGroqAnalyzer;

export function explicitCoordinates(content) {
  const match = /\b(?:lat(?:itude)?)\s*[:=]?\s*(-?\d{1,2}(?:\.\d+)?)\s*[,; ]+\s*(?:lon(?:gitude)?|lng)\s*[:=]?\s*(-?\d{1,3}(?:\.\d+)?)/i.exec(content)
    || /\(\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*\)/.exec(content);
  if (!match) return null;
  const lat = Number(match[1]), lon = Number(match[2]);
  return validPoint(lat, lon) ? { lat, lon } : null;
}

export function createGroqLocationParser(options) {
  const analyze = createGroqAnalyzer(options);
  return async input => {
    try {
      const result = await analyze({ content: `Location field supplied by the reporter: ${input}` });
      if (!result.locationName) throw new BridgeError('Could not identify that location. Include the city and country, or enter latitude, longitude.');
      return result.locationName;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('AI analysis unavailable. Please check the API key.');
    }
  };
}

export const createGeminiLocationParser = createGroqLocationParser;

export async function resolveModalLocation(input, { parseLocation, resolveLocation = resolveReportLocation } = {}) {
  const raw = input.trim();
  const pair = raw.replace(/^\((.*)\)$/, '$1').match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))$/);
  if (pair) {
    const lat = Number(pair[1]), lon = Number(pair[2]);
    if (!validPoint(lat, lon)) throw new BridgeError('Latitude must be −90 to 90 and longitude −180 to 180.');
    return { lat, lon, locationName: `${lat}, ${lon}` };
  }
  const explicit = explicitCoordinates(raw);
  if (explicit) return { ...explicit, locationName: raw };
  const name = await parseLocation(raw);
  const point = await resolveLocation('', name);
  if (!validPoint(point.lat, point.lon)) throw new BridgeError('That location could not be resolved uniquely. Include the city and country, or enter latitude, longitude.');
  return point;
}

export async function downloadReportImageUrl(input, fetchImpl = fetch) {
  if (!input?.trim()) return { imageUrl: '', imageBase64: '' };
  let imageUrl;
  try { imageUrl = normalizeCommunityImageUrl(input); }
  catch (error) { throw new BridgeError(error.message); }
  try {
    const response = await fetchImpl(imageUrl, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    const mimeType = response.headers.get('content-type')?.split(';')[0].trim();
    if (!response.ok || !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType) || Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES || !response.body) throw new Error();
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > MAX_IMAGE_BYTES) throw new Error(); chunks.push(chunk); }
    const imageBase64 = `data:${mimeType};base64,${Buffer.concat(chunks).toString('base64')}`;
    decodeCommunityImage(imageBase64);
    return { imageUrl, imageBase64 };
  } catch { throw new BridgeError('Could not load that image. Use a direct PNG, JPEG or WebP link (up to 4 MiB), without redirects.'); }
}

export function verificationMessage(post) {
  const weather = post.weatherData;
  const readings = weather && [weather.temp, weather.humidity, weather.wind].every(Number.isFinite)
    ? ` Weather: ${weather.temp}°C, ${weather.humidity}% RH, ${weather.wind} km/h wind.` : '';
  if (post.verificationStatus === 'satellite_confirmed') return '✅ Satellite Confirmed: a nearby satellite detection was found in the stored NASA FIRMS window.';
  if (post.verificationStatus === 'community_verified') return `✅ Community Verified: three community confirmations.${readings}`;
  if (post.verificationStatus === 'weather_warning') return `🔥 No satellite signature found, but extreme hot, dry and windy weather was detected. Flagged as High Risk.${readings}`;
  return `⚠️ Pending verification.${readings}`;
}

export async function resolveReportLocation(content, locationName, fetchImpl = fetch) {
  const point = explicitCoordinates(content);
  if (point) return { ...point, locationName };
  const unknown = { lat: null, lon: null, locationName };
  if (!locationName) return unknown;
  try {
    const pieces = locationName.split(',').map(part => part.trim()).filter(Boolean);
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.search = new URLSearchParams({ name: pieces[0], count: '5', language: 'en', format: 'json' }).toString();
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return unknown;
    const data = await response.json();
    if (!Array.isArray(data.results)) return unknown;
    const matches = data.results.filter(row => typeof row?.name === 'string' && validPoint(row.latitude, row.longitude)
      && normalize(row.name) === normalize(pieces[0]) && pieces.slice(1).every(part => [row.country, row.country_code, row.admin1, row.admin2].some(value => typeof value === 'string' && normalize(value) === normalize(part))));
    const unique = new Map(matches.map(row => [`${row.latitude}:${row.longitude}`, row]));
    if (unique.size !== 1) return unknown;
    const row = [...unique.values()][0];
    return { lat: row.latitude, lon: row.longitude, locationName: [row.name, row.country].filter(Boolean).join(', ').slice(0, 160) };
  } catch { return unknown; } // A named but unresolved place stays pending, never guessed.
}

export async function downloadReportImage(attachment, fetchImpl = fetch) {
  if (!attachment) return '';
  const mimeType = attachment.contentType?.split(';')[0];
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType) || attachment.size > MAX_IMAGE_BYTES) throw new BridgeError('Attach a PNG, JPEG or WebP image of at most 4 MiB.');
  try {
    const url = new URL(attachment.url);
    if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) || url.username || url.password || url.port || !/^\/(?:ephemeral-)?attachments\//.test(url.pathname)) throw new Error('Invalid attachment host');
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES || !response.body) throw new Error('Invalid attachment response');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length; if (size > MAX_IMAGE_BYTES) throw new Error('Image too large'); chunks.push(chunk);
    }
    const dataUrl = `data:${mimeType};base64,${Buffer.concat(chunks).toString('base64')}`;
    return decodeCommunityImage(dataUrl).dataUrl;
  } catch { throw new BridgeError('Could not download a valid Discord image of at most 4 MiB. Report was not forwarded.'); }
}

export async function forwardDiscordReport(payload, { apiUrl = 'http://127.0.0.1:8787/api/v1', secret, fetchImpl = fetch, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!secret?.trim()) throw new BridgeError('DISCORD_SYNC_SECRET is required.');
  let url;
  try {
    url = new URL(apiUrl);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = `${url.pathname.replace(/\/$/, '')}/community/discord-sync`;
  } catch { throw new BridgeError('COMMUNITY_API_URL must be an HTTPS API base or a local HTTP API base.'); }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', 'x-discord-secret': secret }, body: JSON.stringify(payload) });
      if (!response.ok) {
        if (response.status !== 429 && response.status < 500) throw new BridgeError(`Continuum rejected the report (HTTP ${response.status}). Check the bridge settings and report fields.`);
        throw new Error('Retryable response');
      }
      const result = await response.json();
      if (!result.success || !['pending', 'satellite_confirmed', 'weather_warning', 'community_verified'].includes(result.post?.verificationStatus)) throw new Error('Invalid response');
      return result.post;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (attempt === 2) throw new BridgeError('Continuum could not confirm receipt. The report may have been saved; retrying this message is safe.');
      await delay(500 * (attempt + 1));
    }
  }
}

export function createDiscordMessageHandler({ channelId, analyze, resolveLocation = resolveReportLocation, downloadImage = downloadReportImage, forward, log = () => {} }) {
  const inflight = new Set(), processed = new Set();
  const reply = async (message, content) => {
    try { await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } }); }
    catch { log('Discord reply could not be delivered.'); }
  };
  return async message => {
    if (message.channelId !== channelId || message.author?.bot || message.webhookId || inflight.has(message.id) || processed.has(message.id)) return;
    inflight.add(message.id);
    try {
      const attachments = [...(message.attachments?.values() ?? [])];
      const content = message.content?.trim() || '';
      if (!content && !attachments.length) return;
      if (content.length > 2000) throw new BridgeError('Please keep the report below 2,000 characters.');
      if (attachments.length > 1) throw new BridgeError('Please attach one image per report.');
      const imageBase64 = await downloadImage(attachments[0]);
      const analysis = await analyze({ content, imageBase64 });
      if (!analysis.isFireReport) { await reply(message, 'I could not identify a fire/smoke report. Nothing was forwarded; please describe the observation and location.'); return; }
      const location = await resolveLocation(content, analysis.locationName);
      const post = await forward({ author: (message.member?.displayName || message.author.globalName || message.author.username || 'Discord reporter').slice(0, 60),
        content: content || 'Image report submitted via Discord.', imageBase64, ...location, discordMessageId: message.id });
      processed.add(message.id); if (processed.size > 1000) processed.delete(processed.values().next().value);
      await reply(message, `✅ Report forwarded to Continuum Web. ${verificationMessage(post)}`);
      log('Discord report forwarded.');
    } catch (error) {
      const reason = error instanceof BridgeError ? error.message : 'Report processing failed. Please try again later.';
      await reply(message, reason); log(reason); // Never log raw SDK errors, message content, images, or credentials.
    } finally { inflight.delete(message.id); }
  };
}
