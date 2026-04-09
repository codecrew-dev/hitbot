import { Events, Client } from "discord.js";
import { Event } from "../../types";
import { KboNotificationService } from "../../services/notificationService";
import { fetchAppEmojis } from "../../utils/emojis";

export default {
  name: Events.ClientReady,
  async execute(client: Client) {
    console.log(`${client.user?.username}(으)로 로그인되었습니다.`);
    
    // 이모지 캐싱
    try {
      await fetchAppEmojis(client);
    } catch (error) {
      console.error("앱 이모지 캐싱 실패:", error);
    }

    // KBO 알림 서비스 초기화
    try {
      const kboNotificationService = KboNotificationService.getInstance(client);
      await kboNotificationService.initialize();
    } catch (error) {
      console.error("KBO 알림 서비스 초기화 실패:", error);
    }
  },
} as Event;
