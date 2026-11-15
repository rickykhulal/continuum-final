// Single-process JSON store. Community data never enters the scientific bundle.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { satelliteCrossCheck, highRiskWeather, HUMAN_CONFIRMATION_THRESHOLD } from './community-integrations.mjs';
import { decodeCommunityImage, normalizeCommunityImageUrl } from './community-image.mjs';

export class CommunityValidationError extends Error {}

function text(value, label, max, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) {
    throw new CommunityValidationError(`${label} must be ${required ? '1' : '0'}–${max} characters.`);
  }
  return value.trim();
}

function location(input) {
  const lat = input.lat ?? null, lon = input.lon ?? null;
  const locationName = text(input.locationName, 'Location name', 160);
  if (lat === null && lon === null) return { lat, lon, locationName };
  if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90
      || typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw new CommunityValidationError('Provide both latitude (−90 to 90) and longitude (−180 to 180), or leave the location empty.');
  }
  return { lat, lon, locationName };
}

function normalize(post) {
  const pollOptions = Array.isArray(post.pollOptions) ? post.pollOptions
    : (post.options ?? []).map((value, i) => ({ text: value, votes: Number(post.votes?.[i] ?? 0) }));
  const verificationVotes = Object.keys(post._verificationVoters ?? {}).length;
  const satellite = post.verificationStatus === 'satellite_confirmed' && post.satelliteMatch;
  return { ...post, source: post.source === 'discord' ? 'discord' : 'web',
    locationName: post.locationName ?? '', lat: post.lat ?? null, lon: post.lon ?? null,
    verificationStatus: satellite ? 'satellite_confirmed' : verificationVotes >= HUMAN_CONFIRMATION_THRESHOLD && post.type === 'anomaly' ? 'community_verified' : highRiskWeather(post.weatherData) ? 'weather_warning' : 'pending',
    weatherData: post.weatherData ?? null, verificationVotes, _verificationVoters: post._verificationVoters ?? {},
    imageBase64: post.imageBase64 ?? '', pollOptions, _voters: post._voters ?? {} };
}

function publicPost(post, voterId) {
  const { _voters, _verificationVoters, options: _options, votes: _votes, ...safe } = normalize(post);
  return { ...safe, verified: safe.verificationStatus === 'satellite_confirmed',
    options: safe.pollOptions.map(o => o.text), votes: Object.fromEntries(safe.pollOptions.map((o, i) => [i, o.votes])),
    hasVerificationVote: !!(voterId && Object.hasOwn(_verificationVoters, voterId)),
    selectedOption: voterId && Object.hasOwn(_voters, voterId) ? _voters[voterId] : null };
}

export function createCommunityStore(directory = process.env.APP_DATA_PATH || path.join(process.cwd(), 'data')) {
  const dir = path.resolve(directory), file = path.join(dir, 'community.json');
  function ensure() {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '[]\n', 'utf8');
  }
  function read() {
    ensure();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : parsed?.posts;
    if (!Array.isArray(rows)) throw new Error('Invalid community store.');
    return rows.map(normalize);
  }
  function write(posts) {
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(posts, null, 2) + '\n', 'utf8'); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  ensure();
  return {
    getPosts({ voterId } = {}) {
      return read().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(p => publicPost(p, voterId));
    },
    createPost(input = {}, { source = 'web', liveBundle = null, discordMessageId = null, verification = null } = {}) {
      const posts = read();
      // A relay retry after a lost HTTP response must not create a duplicate report.
      if (source === 'discord' && discordMessageId) {
        if (typeof discordMessageId !== 'string' || !/^\d{10,25}$/.test(discordMessageId)) throw new CommunityValidationError('Invalid Discord message ID.');
        const existing = posts.find(post => post.source === 'discord' && post.discordMessageId === discordMessageId);
        if (existing) return publicPost(existing);
      }
      const content = text(input.content, 'Post content', source === 'discord' ? 2000 : 1000, true);
      const author = text(input.author, 'Name', 60) || 'Anonymous';
      const type = input.isAnomaly === true ? 'anomaly' : input.type ?? 'text';
      if (!['text', 'poll', 'anomaly'].includes(type)) throw new CommunityValidationError('Choose text, anomaly or poll.');
      const point = location(input);
      let imageBase64, imageUrl;
      try { imageBase64 = decodeCommunityImage(input.imageBase64)?.dataUrl ?? ''; imageUrl = normalizeCommunityImageUrl(input.imageUrl); }
      catch (error) { throw new CommunityValidationError(error.message); }
      let pollOptions = [];
      if (type === 'poll') {
        const options = input.pollOptions ?? input.options;
        if (!Array.isArray(options) || options.length < 2 || options.length > 6) throw new CommunityValidationError('Polls need 2–6 options.');
        pollOptions = options.map(option => ({ text: text(typeof option === 'string' ? option : option?.text, 'Poll option', 100, true), votes: 0 }));
        if (new Set(pollOptions.map(o => o.text.toLowerCase())).size !== pollOptions.length) throw new CommunityValidationError('Poll options must be different.');
      }
      const post = { id: crypto.randomUUID(), author, type, content, imageUrl, imageBase64, isAnomaly: type === 'anomaly',
        source: source === 'discord' ? 'discord' : 'web', ...point, ...(verification ?? satelliteCrossCheck(point.lat, point.lon, liveBundle)),
        ...(source === 'discord' && discordMessageId ? { discordMessageId } : {}),
        createdAt: new Date().toISOString(), pollOptions, _voters: {}, _verificationVoters: {} };
      posts.unshift(post); write(posts);
      return publicPost(post);
    },
    votePoll({ postId, optionIndex, voterId }) {
      if (!Number.isInteger(optionIndex)) throw new CommunityValidationError('Choose a valid poll option.');
      if (typeof voterId !== 'string' || !voterId) throw new CommunityValidationError('A voter identity is required.');
      const posts = read(), post = posts.find(p => p.id === postId);
      if (!post || post.type !== 'poll' || optionIndex < 0 || optionIndex >= post.pollOptions.length) return null;
      const previous = post._voters[voterId];
      if (previous !== optionIndex) {
        if (Number.isInteger(previous) && post.pollOptions[previous]) post.pollOptions[previous].votes = Math.max(0, post.pollOptions[previous].votes - 1);
        post.pollOptions[optionIndex].votes++;
        post._voters[voterId] = optionIndex;
        write(posts);
      }
      return publicPost(post, voterId);
    },
    upvoteReport({ postId, voterId }) {
      if (typeof voterId !== 'string' || !voterId) throw new CommunityValidationError('A voter identity is required.');
      const posts = read(), post = posts.find(p => p.id === postId);
      if (!post || post.type !== 'anomaly') return null;
      if (!['satellite_confirmed', 'community_verified'].includes(post.verificationStatus) && !Object.hasOwn(post._verificationVoters, voterId)) {
        post._verificationVoters[voterId] = true;
        Object.assign(post, normalize(post)); write(posts);
      }
      return publicPost(post, voterId);
    },
    verifyAnomaly({ postId }, liveBundle, verification = null) {
      const posts = read(), post = posts.find(p => p.id === postId);
      if (!post || post.type !== 'anomaly') return null;
      Object.assign(post, verification ?? { ...satelliteCrossCheck(post.lat, post.lon, liveBundle), weatherData: null, weatherObservedAt: null });
      Object.assign(post, normalize(post));
      write(posts);
      return publicPost(post);
    },
    getAnnouncements() {
      return read().filter(p => p.type === 'anomaly' && p.verificationStatus === 'satellite_confirmed')
        .map(p => ({ id: p.id, sourcePostId: p.id, author: p.author, content: p.content, imageUrl: '', createdAt: p.createdAt }));
    },
  };
}

const store = createCommunityStore();
export const getPosts = (...args) => store.getPosts(...args);
export const createPost = (...args) => store.createPost(...args);
export const votePoll = (...args) => store.votePoll(...args);
export const upvoteReport = (...args) => store.upvoteReport(...args);
export const verifyAnomaly = (...args) => store.verifyAnomaly(...args);
export const getAnnouncements = (...args) => store.getAnnouncements(...args);
