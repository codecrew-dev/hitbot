import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { SlashCommand } from "../../../types";
import os from "os";

export default {
    data: new SlashCommandBuilder()
        .setName("봇정보")
        .setDescription("봇 정보를 보여줍니다"),
    execute: (client, interaction) => {
        const cpuInfo = os.cpus()[0].model;
        const osInfo = `${os.type()} (${os.release()})`;
        const totalMemory = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2); // GB 단위로 변환
        const freeMemory = (os.freemem() / 1024 / 1024 / 1024).toFixed(2); // GB 단위로 변환
        const usedMemory = (parseFloat(totalMemory) - parseFloat(freeMemory)).toFixed(2); // 사용 중인 메모리
        const memoryUsage = ((parseFloat(usedMemory) / parseFloat(totalMemory)) * 100).toFixed(1); // 메모리 사용률

        const totalSeconds = Math.floor(client.uptime! / 1000);
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        const uptimeParts = [];
        if (days) uptimeParts.push(`${days}일`);
        if (hours) uptimeParts.push(`${hours}시간`);
        if (minutes) uptimeParts.push(`${minutes}분`);
        if (seconds) uptimeParts.push(`${seconds}초`);

        const embed = {
            title: `${client.user.username} 봇 정보`,
            color: 0x00FFA3,
            thumbnail: { url: client.user.displayAvatarURL() },
            fields: [
            { 
                name: "서버수",
                value: client.guilds.cache.size.toString(), 
                inline: true 
            },
            { 
                name: "유저",
                value: client.users.cache.size.toString(), 
                inline: true 
            },
            { 
                name: "샤드 정보", 
                value: client.shard ? `${client.shard.ids.length}개` : "없음", 
                inline: true 
            },
            { 
                name: "업타임", 
                value: uptimeParts.join(""),
                inline: true 
            },
            {
                name: "응답속도",
                value: `${client.ws.ping}ms`,
                inline: true,
            },
            {
                name: "개발자",
                value: "zetto06",
                inline: true,
            },
            {
                name: "시스템 정보",
                value: `\`\`\`yaml
Nodejs: ${process.version}
discord.js: ${require("discord.js").version}
CPU: ${cpuInfo}
OS: ${osInfo}
Memory: ${usedMemory}GB / ${totalMemory}GB (${memoryUsage}%)\`\`\``,
                inline: false,
            },
            ],
        };

    interaction.reply({ embeds: [embed] });
    },
} as SlashCommand;

