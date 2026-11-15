import fs from 'node:fs';
import { parseEnv } from 'node:util';

// Load only integration settings, so old .env data-bundle settings cannot change the science API.
const KEYS = ['DISCORD_BOT_TOKEN', 'DISCORD_SYNC_SECRET', 'DISCORD_WEBHOOK_URL', 'GEMINI_API_KEY',
  'GEMINI_MODEL', 'DISCORD_REPORT_CHANNEL_ID', 'DISCORD_REPORT_CHANNEL_NAME', 'DISCORD_GUILD_ID', 'COMMUNITY_API_URL'];
export function loadCommunityEnv(env = process.env, file = new URL('../.env', import.meta.url)) {
  let parsed;
  try { parsed = parseEnv(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw new Error('Could not load local integration settings.'); }
  for (const key of KEYS) if (env[key] === undefined && parsed[key] !== undefined) env[key] = parsed[key];
}
