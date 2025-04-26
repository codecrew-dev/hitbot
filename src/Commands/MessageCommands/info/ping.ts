import { SlashCommandBuilder, TextChannel } from "discord.js";
import { Command } from "../../../types";

export default {
  name: "핑",
  description: "핑을 보여줍니다.",
  aliases: ["vld", "ping"],
  execute: (client, message, args) => {
    message.reply(`퐁! ${client.ws.ping}`);
  },
} as Command;
