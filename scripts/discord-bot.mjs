import { Client, Events, GatewayIntentBits, ChannelType, PermissionFlagsBits } from 'discord.js';
import { pathToFileURL } from 'node:url';
import { loadCommunityEnv } from '../server/community-env.mjs';
import { BridgeError, parseUserInput, resolveModalLocation, forwardDiscordReport } from './discord-bridge.mjs';
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
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_SYNC_SECRET) throw new BridgeError('Set DISCORD_BOT_TOKEN and DISCORD_SYNC_SECRET in the server environment or ignored local .env.');
  const parseLocation = async input => (input || '').trim();
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
      const [discord, geocoding] = await Promise.allSettled([
        connect(),
        resolveModalLocation('Biratnagar, Nepal', { parseLocation }),
      ]);
      const report = {
        discord: discord.status === 'fulfilled' ? { status: 'verified', channelId: discord.value.id } : { status: 'blocked', reason: discord.reason.message },
        geocoding: geocoding.status === 'fulfilled' ? { status: 'verified', location: geocoding.value } : { status: 'blocked', reason: geocoding.reason.message },
        messagesSent: 0,
      };
      console.log(JSON.stringify(report, null, 2));
      return discord.status === 'fulfilled' && geocoding.status === 'fulfilled';
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
