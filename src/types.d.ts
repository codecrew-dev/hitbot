import {
  Client,
  Collection,
  CommandInteraction,
  Events,
  Message,
  Permissions,
  PermissionsBitField,
  SlashCommandBuilder,
} from "discord.js";

export interface Event {
  name: Events;
  execute: (...args: any[]) => void;
}

export interface Command {
  name: string;
  description: string;
  aliases?: string[];
  permissions?: PermissionsBitField[];
  cooldown?: number;
  execute: (client: Client, message: Message, args: string[]) => void;
}

export interface SlashCommand {
  data: SlashCommandBuilder;
  execute: (client: Client, interaction: CommandInteraction) => void;
}

// Discord.js의 Client 클래스 확장
declare module "discord.js" {
  interface Client {
    commands: Collection<string, Command>;
    events: Collection<string, Event>;
    cooldowns: Collection<string, Collection<string, number>>;
    slashcommands: Collection<string, SlashCommand>;
  }
}

declare global {
  namespace NodeJS {
      interface ProcessEnv {
          TOKEN: string;
          CLIENTID: string;
          mongodb?: string;
      }
  }
}
