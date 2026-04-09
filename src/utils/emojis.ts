import { Client } from 'discord.js';

let appEmojiCache: any = null;
let savedClient: Client | null = null;

export async function fetchAppEmojis(client: Client): Promise<void> {
    savedClient = client;
    if (!appEmojiCache) {
        try {
            appEmojiCache = await client.application?.emojis.fetch();
            console.log(`[Emoji Cache] 가져온 애플리케이션 이모지 개수: ${appEmojiCache?.size || 0}`);
            if (appEmojiCache && appEmojiCache.size > 0) {
                appEmojiCache.forEach((e: any) => console.log(` - ${e.name} (<:${e.name}:${e.id}>)`));
            }
        } catch (error) {
            console.error("[Emoji Cache] 애플리케이션 이모지 가져오기 실패:", error);
        }
    }
}

export function getAppEmojiTextSync(emojiName: string): string {
    if (!emojiName) return '';

    // 1. 애플리케이션 이모지에서 찾기
    if (appEmojiCache) {
        const appEmoji = appEmojiCache.find((entry: any) => entry.name?.toLowerCase() === emojiName.toLowerCase());
        if (appEmoji) return appEmoji.toString ? appEmoji.toString() : `${appEmoji}`;
    }

    // 2. 서버(길드) 이모지에서 찾기 (폴백)
    if (savedClient && savedClient.emojis.cache) {
        const guildEmoji = savedClient.emojis.cache.find(entry => entry.name?.toLowerCase() === emojiName.toLowerCase());
        if (guildEmoji) return guildEmoji.toString ? guildEmoji.toString() : `${guildEmoji}`;
    }

    return '';
}

export async function getAppEmojiText(client: Client, emojiName: string): Promise<string> {
    if (!emojiName) return '';

    try {
        if (!appEmojiCache) {
            appEmojiCache = await client.application?.emojis.fetch();
        }

        if (!appEmojiCache) return '';

        const emoji = appEmojiCache.find((entry: any) => entry.name === emojiName);
        return emoji ? `${emoji}` : '';
    } catch {
        return '';
    }
}
