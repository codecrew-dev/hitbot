import {
  Events,
  Client,
  ChatInputCommandInteraction,
  ChannelType,
} from "discord.js";
import { Event } from "../../types";

export default {
  name: Events.InteractionCreate,
  async execute(interaction: ChatInputCommandInteraction, client: Client) {
    if (!interaction.isChatInputCommand()) return;
    const command = client.slashcommands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(client, interaction);
    } catch (err) {
      console.error(err);
    }
  },
} as Event;
