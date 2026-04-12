import fs from "fs";
import { Client } from "discord.js";
import { getSourcePath, getFileExtension, createImportPath } from "../utils/pathResolver";

async function loadEvents(client: Client) {
  const sourcePath = getSourcePath();
  const fileExtension = getFileExtension();
  
  // 해당 디렉토리가 존재하는지 확인
  if (!fs.existsSync(`${sourcePath}/Events`)) {
    console.error(`\x1b[31m[ERROR] Events 디렉토리를 찾을 수 없습니다: ${sourcePath}/Events\x1b[0m`);
    return;
  }

  const eventFolders = fs.readdirSync(`${sourcePath}/Events`);
  for (const folder of eventFolders) {
    const eventFiles = fs
      .readdirSync(`${sourcePath}/Events/${folder}`)
      .filter((file) => file.endsWith(fileExtension));
    
    for (const file of eventFiles) {
      try {
        const event = require(`../Events/${folder}/${file}`).default;
        if (event.once) {
          client.once(event.name, (...args: unknown[]) => event.execute(...args, client));
        } else {
          client.on(event.name, (...args: unknown[]) => event.execute(...args, client));
        }
        console.log(
          `\x1b[32m[LOGS] \x1b[33m[Events] \x1b[36m${event.name}\x1b[37m has been loaded.\x1b[0m`
        );
      } catch (error) {
        console.error(`\x1b[31m[ERROR] 이벤트 로딩 실패: ${file}\x1b[0m`, error);
      }
    }
  }
}

export default loadEvents;
