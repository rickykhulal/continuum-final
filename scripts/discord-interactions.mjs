import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType, Events } from 'discord.js';
import { BridgeError, resolveModalLocation, downloadReportImageUrl, verificationMessage } from './discord-bridge.mjs';

export const setupReportCommand = () => new SlashCommandBuilder().setName('setup-report')
  .setDescription('Post the Continuum incident reporting button in this channel.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator).toJSON();

export function reportPanel() {
  return { allowedMentions: { parse: [] }, embeds: [new EmbedBuilder().setColor(0xf07b32)
    .setTitle('🔥 Continuum Fire Report System')
    .setDescription('Click the button below to report a fire, smoke, or anomaly. Your report will be verified against NASA satellite data.')
    .setFooter({ text: 'Satellite matches, weather risk and community confirmations are shown separately.' })],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('report_fire_btn').setLabel('Report an Incident').setStyle(ButtonStyle.Primary))] };
}

export function reportModal() {
  const field = (id, label, style, required, max, placeholder) => new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max).setPlaceholder(placeholder));
  return new ModalBuilder().setCustomId('report_fire_modal').setTitle('Report a Fire Incident').addComponents(
    field('location_input', 'Location', TextInputStyle.Short, true, 160, 'e.g., Biratnagar, Nepal or Lat, Lon'),
    field('description_input', 'Description', TextInputStyle.Paragraph, true, 2000, 'Describe what you see...'),
    field('image_url_input', 'Image URL', TextInputStyle.Short, false, 2000, 'Paste an image link (Imgur, etc.)'),
    field('reporter_name', 'Your Name', TextInputStyle.Short, false, 60, 'Optional; defaults to your Discord name'),
  );
}

// Upsert just this guild command, preserving unrelated application commands.
export async function registerReportCommand(manager) {
  const commands = await manager.fetch();
  const existing = commands.find(command => command.name === 'setup-report' && command.type === 1);
  return existing ? manager.edit(existing.id, setupReportCommand()) : manager.create(setupReportCommand());
}

export function attachReportInteractions(client, handler) {
  client.on(Events.InteractionCreate, interaction => { void handler(interaction); });
}

export function createDiscordInteractionHandler({ guildId, parseLocation, forward, resolveLocation,
  downloadImage = downloadReportImageUrl, maxQueue = 5, log = () => {} }) {
  const inflight = new Set(), completed = new Set();
  let queued = 0, queue = Promise.resolve();
  const privateReply = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  const edit = (interaction, content) => interaction.editReply({ content, allowedMentions: { parse: [] } });
  return async interaction => {
    const setup = interaction.isChatInputCommand?.() && interaction.commandName === 'setup-report';
    const button = interaction.isButton?.() && interaction.customId === 'report_fire_btn';
    const modal = interaction.isModalSubmit?.() && interaction.customId === 'report_fire_modal';
    if (!setup && !button && !modal) return;
    try {
      if (!interaction.inGuild() || interaction.guildId !== guildId) { await privateReply(interaction, 'Use the report system in the configured Discord server.'); return; }
      if (setup) {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) { await privateReply(interaction, 'Only server administrators can run /setup-report.'); return; }
        if (interaction.channel?.type !== ChannelType.GuildText || !interaction.appPermissions?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
          await privateReply(interaction, 'Use a server text channel where the bot can send messages and embed links.'); return;
        }
        await interaction.reply(reportPanel()); return;
      }
      if (button) { await interaction.showModal(reportModal()); return; }
      if (inflight.has(interaction.id) || completed.has(interaction.id)) return;
      if (queued >= maxQueue) { await privateReply(interaction, 'The report queue is full. Please try again shortly.'); return; }
      inflight.add(interaction.id); queued++;
      try {
        // Acknowledge within Discord's 3-second deadline, before any queued/network work.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await edit(interaction, '✅ Your report has been submitted to Continuum. Checking satellite data...');
        const job = async () => {
          try {
            const field = (id, max, required = false) => {
              const value = interaction.fields.getTextInputValue(id)?.trim() || '';
              if (value.length > max || (required && !value)) throw new BridgeError('Please provide a location and description within the form limits.');
              return value;
            };
            const locationInput = field('location_input', 160, true), content = field('description_input', 2000, true);
            const imageInput = field('image_url_input', 2000), name = field('reporter_name', 60);
            const point = await resolveModalLocation(locationInput, { parseLocation, resolveLocation });
            const image = await downloadImage(imageInput);
            const author = name || (interaction.member?.displayName || interaction.user.globalName || interaction.user.username || 'Discord reporter').slice(0, 60);
            const post = await forward({ author, content, ...point, ...image, discordMessageId: interaction.id });
            completed.add(interaction.id); if (completed.size > 1000) completed.delete(completed.values().next().value);
            await edit(interaction, `✅ Report Confirmed! Your incident is now live on the web dashboard.\n${verificationMessage(post)}`);
          } catch (error) {
            await edit(interaction, error instanceof BridgeError ? error.message : 'The report could not be processed. Please try again.');
          }
        };
        const result = queue.then(job);
        queue = result.catch(() => {});
        await result;
      } finally { queued--; inflight.delete(interaction.id); }
    } catch {
      // Discord errors may contain interaction tokens; never print raw errors.
      log('A Discord interaction response could not be delivered.');
    }
  };
}
