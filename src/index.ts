import dotenv from "dotenv";
import { Client, Collection, GatewayIntentBits } from "discord.js";
import config from "./config";
import loadEvents from "./handler/eventHandler";
import loadCommand from "./handler/commandHandler";
import loadSlashCommands from "./handler/slashcommandhandler";
import { Command, Event, SlashCommand } from "./types";
import * as MongoDB from './utils/Mongodb';

dotenv.config();

// 타입 안전한 방식으로 모든 인텐트 사용
const client = new Client({ 
  intents: Object.values(GatewayIntentBits).filter(intent => typeof intent === 'number') 
}) as Client;

// 명시적으로 Collection 타입 지정
client.commands = new Collection<string, Command>();
client.events = new Collection<string, Event>();
client.cooldowns = new Collection<string, Collection<string, number>>();
client.slashcommands = new Collection<string, SlashCommand>();

MongoDB.connect().catch(console.error);

loadEvents(client);
loadCommand(client);
loadSlashCommands(client);

client.login(process.env.TOKEN);

export default client;
export { client };
