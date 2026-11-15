import { Client, Events, GatewayIntentBits, ChannelType, PermissionFlagsBits } from 'discord.js';
import { pathToFileURL } from 'node:url';
import { loadCommunityEnv } from '../server/community-env.mjs';
import { BridgeError, createGeminiAnalyzer, createGeminiLocationParser, resolveModalLocation, forwardDiscordReport } from './discord-bridge.mjs';
import { registerReportCommand, createDiscordInteractionHandler, attachReportInteractions } from './discord-interactions.mjs';

async function selectChannel(client, env) {
  let channel;
  if (env.DISCORD_REPORT_CHANNEL_ID) channel = await client.channels.fetch(env.DISCORD_REPORT_CHANNEL_ID);
  else {
    const matches = [];
    for (const guild of client.guilds.cache.values()) {
      if (env.DISCORD_GUILD_ID && guild.id !== env.DISCORD_GUILD_ID) continue;
      const channels = await guild.channels.fetch();
      matches.push(...channels.filter(c => c && c.name === (env.DISCORD_REPORT_CHANNEL_NAME || 'fire-reports') && c.type === ChannelType.GuildText).values());
    }
    if (matches.length !== 1) throw new BridgeError('Set DISCORD_REPORT_CHANNEL_ID to one channel, or make #fire-reports unique in the configured guild.');
    channel = matches[0];
  }
  if (!channel || channel.type !== ChannelType.GuildText || (env.DISCORD_GUILD_ID && channel.guildId !== env.DISCORD_GUILD_ID)) throw new BridgeError('The report channel must be an accessible server text channel.');
  const member = await channel.guild.members.fetchMe();
  if (!channel.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks])) throw new BridgeError('The bot needs View Channel, Send Messages, Read Message History, Attach Files and Embed Links in the report channel.');
  return channel;
}

export async function runBot({ checkOnly = false, env = process.env } = {}) {
  loadCommunityEnv(env);
  if (!env.DISCORD_BOT_TOKEN || !env.GEMINI_API_KEY || !env.DISCORD_SYNC_SECRET) throw new BridgeError('Set DISCORD_BOT_TOKEN, GEMINI_API_KEY and DISCORD_SYNC_SECRET in the server environment or ignored local .env.');
  const analyze = createGeminiAnalyzer({ apiKey: env.GEMINI_API_KEY, modelName: env.GEMINI_MODEL || 'gemini-3.8-flash' });
  const parseLocation = createGeminiLocationParser({ apiKey: env.GEMINI_API_KEY, modelName: env.GEMINI_MODEL || 'gemini-3.8-flash' });
  const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { timeout: 15000, retries: 1 } });
  client.on(Events.Error, () => console.error('Discord connection error. Check credentials, permissions and network.'));
  client.on(Events.ShardError, () => console.error('Discord gateway unavailable. Reconnecting.'));
  const connect = async () => {
    let timer;
    try {
      const ready = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new BridgeError('Discord connection timed out. Check the token and bot membership.')), 30000);
        client.once(Events.ClientReady, resolve);
      });
      await Promise.all([client.login(env.DISCORD_BOT_TOKEN), ready]);
      return await selectChannel(client, env);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('Discord login/channel access failed. Check the bot token, server invitation and channel permissions.');
    } finally { clearTimeout(timer); }
  };
  if (checkOnly) {
    try {
      // A harmless 1px fixture verifies image input too; it is never posted to either feed.
      const imageBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
      const [discord, gemini] = await Promise.allSettled([connect(), Promise.all([
        analyze({ content: 'Smoke reported near Biratnagar, Nepal. This is a connectivity test only; the attached pixel is a test image.', imageBase64 }),
        resolveModalLocation('Biratnagar Nepal', { parseLocation }),
      ])]);
      const report = {
        discord: discord.status === 'fulfilled' ? { status: 'verified', channelId: discord.value.id } : { status: 'blocked', reason: discord.reason.message },
        gemini: gemini.status === 'fulfilled' ? { status: 'verified', model: env.GEMINI_MODEL || 'gemini-3.8-flash', inputs: ['text', 'image', 'modal location'], location: gemini.value[1] } : { status: 'blocked', reason: gemini.reason.message },
        messagesSent: 0,
      };
      console.log(JSON.stringify(report, null, 2));
      return discord.status === 'fulfilled' && gemini.status === 'fulfilled';
    } finally { client.destroy(); }
  }
  let channel;
  try { channel = await connect(); } catch (error) { client.destroy(); throw error; }
  try { await registerReportCommand(channel.guild.commands); }
  catch { client.destroy(); throw new BridgeError('Could not register /setup-report. Invite the bot with bot and applications.commands scopes.'); }
  const handler = createDiscordInteractionHandler({ guildId: channel.guildId,
    parseLocation, log: text => console.log(text),
    forward: payload => forwardDiscordReport(payload, { apiUrl: env.COMMUNITY_API_URL || 'http://127.0.0.1:8787/api/v1', secret: env.DISCORD_SYNC_SECRET }) });
  attachReportInteractions(client, handler);
  console.log(`Continuum /setup-report registered in server ${channel.guildId}. Interaction-only reporting is ready; ordinary messages are ignored.`);
  if (!env.DISCORD_REPORT_CHANNEL_ID) console.log(`Set DISCORD_REPORT_CHANNEL_ID=${channel.id} in the API environment to enable web-to-Discord delivery without a webhook.`);
  const shutdown = () => { client.destroy(); process.exitCode = 0; };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBot({ checkOnly: process.argv.includes('--check') }).then(ok => { if (!ok) process.exitCode = 1; }).catch(error => {
    console.error(error instanceof BridgeError ? error.message : 'Discord bot could not start. Check integration settings.');
    process.exitCode = 1;
  });
}
