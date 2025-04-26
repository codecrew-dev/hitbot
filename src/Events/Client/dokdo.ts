import { Events } from "discord.js";
import * as Dokdo from "dokdo";
import { client } from "../../index";

const DokdoHandler = new Dokdo.Client(client, {
  aliases: ["dokdo", "d", "dok", "독도", "ehreh"],
  prefix: "!",
  noPerm: (message) =>
    message.reply(":no_entry_sign: You have no permission to use dokdo."),
});

export default {
  name: Events.MessageCreate,
  execute: async (message) => {
    await DokdoHandler.run(message);
  },
};
