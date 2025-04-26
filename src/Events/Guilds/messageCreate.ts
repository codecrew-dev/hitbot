import {
  Events,
  Message,
  Client,
  TextChannel,
  EmbedBuilder,
  Collection,
} from "discord.js";
import { Event } from "../../types";
import config from "../../config";

export default {
  name: Events.MessageCreate,
  async execute(message: Message, client: Client) {
    if (!message.content.startsWith(config.prefix) || message.author.bot)
      return;

    const args = message.content
      .slice(config.prefix.length)
      .trim()
      .split(/ +/g);
    const commandName = args.shift().toLowerCase();
    const command =
      client.commands.get(commandName) ||
      client.commands.find(
        (cmd) => cmd.aliases && cmd.aliases.includes(commandName)
      );

    if (!command) return;

    if (command.permissions) {
      const authorPermissions = (message.channel as TextChannel).permissionsFor(
        message.author
      );
      if (!authorPermissions || !authorPermissions.has(command.permissions)) {
        const blockingembed = new EmbedBuilder()
          .setTitle("⚠️ㅣ오류")
          .setDescription(
            "이 명령어를 사용하기 위한 권한이 없습니다.\n(해당 메시지는 2초후 제거됩니다.)"
          )
          .setColor(0xff4242)
          .setTimestamp();

        return message.reply({ embeds: [blockingembed] }).then((sent) => {
          setTimeout(() => {
            sent.delete();
          }, 2000);
        });
      }
    }

    const { cooldowns } = client;
    if (!cooldowns.has(command.name)) {
      cooldowns.set(command.name, new Collection());
    }

    const now = Date.now();
    const timestamps = cooldowns.get(command.name);
    const cooldownAmount = (command.cooldown || 1) * 1000;

    if (timestamps.has(message.author.id)) {
      const expirationTime = timestamps.get(message.author.id) + cooldownAmount;
      if (now < expirationTime) {
        const timeLeft = (expirationTime - now) / 1000;
        const timeLeftEmbed = new EmbedBuilder()
          .setColor(0xff4242)
          .setTitle("🕘ㅣ쿨타임 대기!")
          .setDescription(`${timeLeft.toFixed(1)}초 후에 다시 시도해주세요!`)
          .setTimestamp();

        return (message.channel as TextChannel)
          .send({ embeds: [timeLeftEmbed] })
          .then((sent) => {
            setTimeout(() => {
              sent.delete();
            }, 2000);
          });
      }
    }

    timestamps.set(message.author.id, now);
    setTimeout(() => timestamps.delete(message.author.id), cooldownAmount);

    try {
      command.execute(client, message, args);
    } catch (err) {
      console.log(err);
      const errorEmbed = new EmbedBuilder()
        .setTitle("⚠️ㅣ오류")
        .setDescription(`아래에서 오류를 확인해주세요\n\n${err}`)
        .setTimestamp()
        .setColor(0xff4242);

      return (message.channel as TextChannel).send({ embeds: [errorEmbed] });
    }
  },
} as Event;
