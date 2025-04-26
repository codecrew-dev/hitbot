import fs from "fs";
import { Client } from "discord.js";
import { getSourcePath, getFileExtension } from "../utils/pathResolver";

async function loadCommand(client: Client) {
  const sourcePath = getSourcePath();
  const fileExtension = getFileExtension();
  
  // 해당 디렉토리가 존재하는지 확인
  if (!fs.existsSync(`${sourcePath}/Commands/MessageCommands`)) {
    console.error(`\x1b[31m[ERROR] MessageCommands 디렉토리를 찾을 수 없습니다: ${sourcePath}/Commands/MessageCommands\x1b[0m`);
    return;
  }

  const commandFolder = fs.readdirSync(`${sourcePath}/Commands/MessageCommands`);
  for (const folder of commandFolder) {
    const commandFiles = fs
      .readdirSync(`${sourcePath}/Commands/MessageCommands/${folder}`)
      .filter((file) => file.endsWith(fileExtension));
    
    for (const file of commandFiles) {
      try {
        const command = require(`../Commands/MessageCommands/${folder}/${file}`).default;
        client.commands.set(command.name, command);
      } catch (error) {
        console.error(`\x1b[31m[ERROR] 명령어 로딩 실패: ${file}\x1b[0m`, error);
      }
    }
  }
  console.log(`${client.commands.size}개의 메시지 명령어를 푸쉬하였습니다.`);
}

export default loadCommand;
