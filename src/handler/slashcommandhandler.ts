import { Client, REST, Routes, SlashCommandBuilder } from "discord.js";
import config from "../config";
import fs from "fs";
import { getSourcePath, getFileExtension } from "../utils/pathResolver";

async function loadSlashCommands(client: Client) {
  const commands = [];
  const sourcePath = getSourcePath();
  const fileExtension = getFileExtension();
  
  // 해당 디렉토리가 존재하는지 확인
  if (!fs.existsSync(`${sourcePath}/Commands/SlashCommands`)) {
    console.error(`\x1b[31m[ERROR] SlashCommands 디렉토리를 찾을 수 없습니다: ${sourcePath}/Commands/SlashCommands\x1b[0m`);
    return;
  }

  const commandsCategoryFiles = fs.readdirSync(`${sourcePath}/Commands/SlashCommands`);

  for (const category of commandsCategoryFiles) {
    const commandsPath = `${sourcePath}/Commands/SlashCommands/${category}`;
    const commandsFiles = fs
      .readdirSync(commandsPath)
      .filter((file) => file.endsWith(fileExtension));
    
    for (const file of commandsFiles) {
      try {
        const command = require(`../Commands/SlashCommands/${category}/${file}`).default;
        client.slashcommands.set(command.data.name, command);
        commands.push(command.data.toJSON());
      } catch (error) {
        console.error(`\x1b[31m[ERROR] 슬래시 명령어 로딩 실패: ${file}\x1b[0m`, error);
      }
    }
  }

  if (commands.length > 0) {
    const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

    rest
      .put(Routes.applicationCommands(process.env.CLIENTID), {
        body: commands,
      })
      .then((command: SlashCommandBuilder[]) => {
        console.log(`${command.length}개의 슬래시 명령어를 푸쉬하였습니다.`);
      })
      .catch((err) => {
        console.log(err);
      });
  } else {
    console.log("푸쉬할 슬래시 명령어가 없습니다.");
  }
}

export default loadSlashCommands;
