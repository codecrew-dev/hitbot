import {
  Events,
  Client,
  ChatInputCommandInteraction,
  ChannelType,
  ButtonInteraction,
} from "discord.js";
import { Event } from "../../types";
import { KboNotificationService } from "../../services/notificationService";

export default {
  name: Events.InteractionCreate,
  async execute(interaction: ChatInputCommandInteraction | ButtonInteraction, client: Client) {
    // 슬래시 커맨드 처리
    if (interaction.isChatInputCommand()) {
      const command = client.slashcommands.get(interaction.commandName);
      if (!command) return;

      try {
        await command.execute(client, interaction);
      } catch (err) {
        console.error(err);
      }
      return;
    }

    // 버튼 인터랙션 처리
    if (interaction.isButton()) {
      const customId = interaction.customId;
      
      // 실시간 중계 중지 버튼 처리
      if (customId.startsWith('stop_relay_')) {
        const gameId = customId.replace('stop_relay_', '');
        const kboNotificationService = KboNotificationService.getInstance(client);
        
        try {
          await interaction.deferUpdate();
          await kboNotificationService.stopLiveRelay(interaction.user.id, gameId, undefined, interaction);
          console.log(`사용자 ${interaction.user.id}가 ${gameId} 경기 중계를 버튼으로 중지했습니다.`);
        } catch (error) {
          console.error('실시간 중계 중지 버튼 처리 오류:', error);
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '중계 중지 중 오류가 발생했습니다.', ephemeral: true });
          }
        }
        return;
      }      // DM 중계 중지 버튼 처리
      if (customId.startsWith('stop_dmrelay_')) {
        const userId = customId.replace('stop_dmrelay_', '');
        
        try {
          // kbo.ts의 activeDmRelay에 접근
          const { getActiveDmRelay } = await import('../../Commands/SlashCommands/Baseball/kbo');
          
          await interaction.deferUpdate();
          
          // activeDmRelay에서 해당 사용자의 중계 정보 찾기 및 정리
          const activeDmRelay = getActiveDmRelay();
          if (activeDmRelay.has(userId)) {
            const relayInfo = activeDmRelay.get(userId);
            if (relayInfo) {
              clearInterval(relayInfo.intervalId);
              activeDmRelay.delete(userId);
            }
          }
          
          await interaction.editReply({
            content: '⚾ **실시간 DM 중계가 종료되었습니다.**',
            components: []
          });
          
          console.log(`사용자 ${userId}가 DM 중계를 버튼으로 중지했습니다.`);
        } catch (error) {
          console.error('DM 중계 중지 버튼 처리 오류:', error);
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'DM 중계 중지 중 오류가 발생했습니다.', ephemeral: true });
          }
        }
        return;
      }

      // 기타 버튼 인터랙션 (새로고침 등)은 해당 명령어에서 처리되므로 여기서는 무시
    }
  },
} as Event;
