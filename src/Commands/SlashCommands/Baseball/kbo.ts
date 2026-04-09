import { EmbedBuilder, SlashCommandBuilder, ChatInputCommandInteraction, Client, CacheType, AttachmentBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType } from "discord.js";
import { SlashCommand } from "../../../types";
import axios from "axios";
import os from "os";
import * as fs from 'fs';
import * as path from 'path';
import * as MongoDB from '../../../utils/Mongodb'
import { KboNotificationService } from "../../../services/notificationService";
import { log } from "console";

// 뉴스 아이템 인터페이스 정의
interface NewsItem {
    oid: string;
    aid: string;
    officeName: string;
    title: string;
    subContent: string;
    thumbnail: string | null;
    datetime: string;
    url: string | null;
    sectionName: string;
    type: string;
    totalCount: number;
}

// 뉴스 API 응답 인터페이스 정의 - 실제 구조에 맞게 수정
interface NewsApiResponse {
    list: NewsItem[];
    totalCount: number;
}

// 비디오 아이템 인터페이스 정의
interface VideoItem {
    masterVid: string;
    title: string;
    thumbnail: string;
    videoType: string;
    videoTypeName: string;
    seasonCode: string;
    seasonName: string;
    divisionCode: string;
    divisionName: string;
    upperCategoryId: string;
    categoryId: string;
    playTime: string;
    hit: number;
    produceDateTime: string;
    sportsVideoId: number;
}

// 비디오 API 응답 인터페이스 정의 - 두 가지 응답 구조 지원
interface VideoApiResponse {
    code: number;
    success: boolean;
    result: {
        videos?: VideoItem[];  // 팀/전체 영상 요청 시
        vodList?: VideoItem[]; // 경기 ID 요청 시
        topVodList?: VideoItem[]; // 경기 ID 요청 시 (핵심 영상)
    };
}

// 활성 DM 중계를 추적하기 위한 맵
// 키: 사용자 ID, 값: {gameId, intervalId, lastStateHash, messageId}
export const activeDmRelay = new Map<string, {
    gameId: string;
    intervalId: NodeJS.Timeout;
    lastStateHash: string; // 마지막 상태의 해시 (변경 사항 감지용)
    messageId: string | null; // 마지막으로 보낸 메시지 ID
    isGameEnded: boolean; // 경기 종료 여부 추가
}>();

// activeDmRelay 맵에 접근하기 위한 getter 함수
export function getActiveDmRelay() {
    return activeDmRelay;
}

// 사용자가 이미 실시간 중계를 받고 있는지 확인하는 함수
function isUserReceivingLiveRelay(userId: string): boolean {
    // 1. DM 중계 확인 (현재 파일 내 activeDmRelay)
    if (activeDmRelay.has(userId)) {
        return true;
    }
    
    // 2. KboNotificationService의 실시간 중계 확인
    const kboNotificationService = KboNotificationService.getInstance(null);
    return kboNotificationService.isUserSubscribed(userId);
}

// "종료종료" 명령어 처리 함수 - 메시지 내용을 검사해서 중계 종료 처리
async function handleTerminateCommand(interaction: ChatInputCommandInteraction) {
    // DM 중계 확인 및 종료
    if (activeDmRelay.has(interaction.user.id)) {
        const relayData = activeDmRelay.get(interaction.user.id);
        if (relayData) {
            stopDmLiveRelay(interaction.user.id);
            await interaction.reply({ content: "✅ 실시간 중계가 종료되었습니다.", ephemeral: true });
            return true;
        }
    }
    
    // KboNotificationService의 실시간 중계 확인 및 종료
    const kboNotificationService = KboNotificationService.getInstance(interaction.client);
    if (kboNotificationService.isUserSubscribed(interaction.user.id)) {
        kboNotificationService.unsubscribeUser(interaction.user.id);
        await interaction.reply({ content: "✅ 실시간 중계가 종료되었습니다.", ephemeral: true });
        return true;
    }
    
    return false;
}

export default {
    data: new SlashCommandBuilder()
        .setName("kbo")
        .setDescription("KBO 관련 명령어")
        .addSubcommand(subcommand =>
            subcommand
                .setName("팀설정")
                .setDescription("KBO 팀 설정을 합니다")
                .addStringOption(option =>
                    option
                        .setName("팀")
                        .setDescription("설정할 팀 이름")
                        .setRequired(true)
                        .addChoices([
                            { name: "두산", value: "OB" },
                            { name: "롯데", value: "LT" },
                            { name: "삼성", value: "SS" },
                            { name: "키움", value: "WO" },
                            { name: "한화", value: "HH" },
                            { name: "KIA", value: "HT" },
                            { name: "LG", value: "LG" },
                            { name: "NC", value: "NC" },
                            { name: "SSG", value: "SK" },
                            { name: "KT", value: "KT" }
                        ])
                )
                .addBooleanOption(option =>
                    option
                        .setName("알림")
                        .setDescription("경기 시간과 라인업 발표시 DM 알림을 받을지 여부")
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("일정")
                .setDescription("KBO 일정을 보여줍니다")
                .addStringOption(option => 
                    option
                        .setName("날짜")
                        .setDescription("조회할 날짜 (YYYYMMDD 형식)")
                        .setRequired(false)
                        .setAutocomplete(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("순위")
                .setDescription("KBO 순위를 보여줍니다")
                .addStringOption(option =>
                    option
                        .setName("유형")
                        .setDescription("조회할 순위 유형")
                        .setRequired(true)
                        .addChoices(
                            { name: "팀 순위", value: "team" },
                            { name: "투수 순위", value: "pitcher" },
                            { name: "타자 순위", value: "batter" },
                            { name: "시범경기 팀 순위", value: "pre_team" },
                            { name: "시범경기 투수 순위", value: "pre_pitcher" },
                            { name: "시범경기 타자 순위", value: "pre_batter" }
                        )
                )
                .addIntegerOption(option =>
                    option
                        .setName("연도")
                        .setDescription("조회할 연도 (1982-현재)")
                        .setRequired(false)
                        .setMinValue(1982)
                        .setMaxValue(new Date().getFullYear())
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("라인업")
                .setDescription("KBO 경기 라인업을 보여줍니다")
                .addStringOption(option =>
                    option
                        .setName("경기id")
                        .setDescription("경기 ID (예: 20250315SSHT02025)")
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("뉴스")
                .setDescription("KBO 관련 뉴스를 보여줍니다")
                .addStringOption(option =>
                    option
                        .setName("팀")
                        .setDescription("설정할 팀 이름")
                        .setRequired(false)
                        .addChoices([
                            { name: "kbo", value: "kbo" },
                            { name: "두산", value: "OB" },
                            { name: "롯데", value: "LT" },
                            { name: "삼성", value: "SS" },
                            { name: "키움", value: "WO" },
                            { name: "한화", value: "HH" },
                            { name: "KIA", value: "HT" },
                            { name: "LG", value: "LG" },
                            { name: "NC", value: "NC" },
                            { name: "SSG", value: "SK" },
                            { name: "KT", value: "KT" }
                        ])
                )
                .addStringOption(option => 
                    option
                        .setName("날짜")
                        .setDescription("조회할 날짜 (YYYYMMDD 형식)")
                        .setRequired(false)
                        .setAutocomplete(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("영상")
                .setDescription("KBO 관련 영상을 보여줍니다")
                .addStringOption(option =>
                    option
                        .setName("팀")
                        .setDescription("설정할 팀 이름")
                        .setRequired(false)
                        .addChoices([
                            { name: "전체", value: "kbo" },
                            { name: "두산", value: "OB" },
                            { name: "롯데", value: "LT" },
                            { name: "삼성", value: "SS" },
                            { name: "키움", value: "WO" },
                            { name: "한화", value: "HH" },
                            { name: "KIA", value: "HT" },
                            { name: "LG", value: "LG" },
                            { name: "NC", value: "NC" },
                            { name: "SSG", value: "SK" },
                            { name: "KT", value: "KT" }
                        ])
                )
                .addStringOption(option =>
                    option
                        .setName("경기id")
                        .setDescription("경기 ID (예: 20250315SSHT02025)")
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("알림설정")
                .setDescription("KBO 알림 설정을 변경합니다")
                .addBooleanOption(option =>
                    option
                        .setName("활성화")
                        .setDescription("알림 기능을 활성화/비활성화합니다")
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("중계")
                .setDescription("KBO 실시간 경기 중계 정보를 보여줍니다")
                .addStringOption(option =>
                    option
                        .setName("경기id")
                        .setDescription("경기 ID (예: 20250315SSHT02025)")
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("dm중계")
                .setDescription("KBO 실시간 경기 중계를 DM으로 10초마다 받습니다")
                .addStringOption(option =>
                    option
                        .setName("경기id")
                        .setDescription("경기 ID (예: 20250315SSHT02025)")
                        .setRequired(false)
                )
        ),
    
    execute: async (client: Client<boolean>, interaction: ChatInputCommandInteraction<CacheType>) => {
        const subcommand = interaction.options.getSubcommand();
        
        if (subcommand === "일정") {
            await interaction.deferReply();
            
            try {
                const today = new Date();
                const dateOption = interaction.options.getString("날짜");
                let targetDate: string;

                const existingUser = await MongoDB.kboUser.kbouser_View(interaction.user.id);

                // 날짜 형식 변환 함수
                const formatDate = (date: Date): string => {
                    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
                };

                // 문자열 날짜를 Date 객체로 변환
                const parseDate = (dateStr: string): Date => {
                    const year = parseInt(dateStr.substring(0, 4));
                    const month = parseInt(dateStr.substring(4, 6)) - 1; // 월은 0부터 시작
                    const day = parseInt(dateStr.substring(6, 8));
                    return new Date(year, month, day);
                };
                
                if (dateOption) {
                    // YYYYMMDD 형식 체크 (8자리 숫자인지)
                    if (/^\d{8}$/.test(dateOption)) {
                        // YYYY-MM-DD 형식으로 변환
                        targetDate = `${dateOption.substring(0, 4)}-${dateOption.substring(4, 6)}-${dateOption.substring(6, 8)}`;
                    } else {
                        // 다른 형식이면 그대로 사용
                        targetDate = dateOption;
                    }
                    
                    // 특정 날짜가 지정된 경우, 기존 방식대로 해당 일자의 전체 경기 표시
                    const url = `https://api-gw.sports.naver.com/schedule/games?fields=basic%2Cschedule%2Cbaseball&upperCategoryId=kbaseball&fromDate=${targetDate}&toDate=${targetDate}&size=500`;
                    
                    const response = await axios.get(url);
                    const games = (response.data as any)?.result?.games.filter((game: any) => game.categoryId === "kbo") || [];
                    
                    if (!games || games.length === 0) {
                        return interaction.editReply(`${targetDate}에 예정된 KBO 경기가 없습니다.`);
                    }
                    
                    const embed = new EmbedBuilder()
                        .setColor(0x1E90FF)
                        .setTitle(`📅 KBO 경기 일정 (${targetDate})`)
                        .setTimestamp()
                        .setFooter({ text: `Powered by Naver Sports`})
                        .setThumbnail("https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png");
                    
                    displayGamesInEmbed(games, embed);
                    
                    return interaction.editReply({ embeds: [embed] });
                } else if (existingUser && existingUser.teamName) {
                    // 사용자가 팀을 설정했고, 특정 날짜가 지정되지 않은 경우 - 일주일 일정 표시
                    const startDate = today;
                    const endDate = new Date(today);
                    endDate.setDate(endDate.getDate() + 6); // 오늘부터 6일 후까지 (총 7일)
                    
                    const startDateStr = formatDate(startDate);
                    const endDateStr = formatDate(endDate);
                    
                    const url = `https://api-gw.sports.naver.com/schedule/games?fields=basic%2Cschedule%2Cbaseball&upperCategoryId=kbaseball&fromDate=${startDateStr}&toDate=${endDateStr}&size=500`;
                    
                    const response = await axios.get(url);
                    const allGames = (response.data as any)?.result?.games.filter((game: any) => game.categoryId === "kbo") || [];
                    
                    // 사용자 팀이 참여하는 경기만 필터링
                    const teamGames = allGames.filter((game: any) => {
                        const homeTeamCode = game.homeTeamCode || '';
                        const awayTeamCode = game.awayTeamCode || '';
                        return homeTeamCode === existingUser.teamName || awayTeamCode === existingUser.teamName;
                    });
                    
                    if (!teamGames || teamGames.length === 0) {
                        return interaction.editReply(`${getTeamDisplayName(existingUser.teamName)}의 향후 7일간 예정된 경기가 없습니다.`);
                    }
                    
                    // 날짜별로 그룹화
                    const gamesByDate: { [key: string]: any[] } = {};
                    teamGames.forEach(game => {
                        const gameDate = game.gameDateTime ? game.gameDateTime.split('T')[0] : null;
                        if (!gameDate) return;
                        
                        if (!gamesByDate[gameDate]) {
                            gamesByDate[gameDate] = [];
                        }
                        gamesByDate[gameDate].push(game);
                    });
                    
                    // 팀 색상 사용
                    const embed = new EmbedBuilder()
                        .setColor(getTeamColor(existingUser.teamName))
                        .setTitle(`📅 ${getTeamDisplayName(existingUser.teamName)} 주간 경기 일정`)
                        .setDescription(`${startDateStr} ~ ${endDateStr}`)
                        .setTimestamp()
                        .setFooter({ text: `Powered by Naver Sports`})
                        .setThumbnail("https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png");
                    
                    // 날짜별로 정렬하여 임베드에 추가
                    const sortedDates = Object.keys(gamesByDate).sort();
                    
                    for (const date of sortedDates) {
                        const gamesOnDate = gamesByDate[date];
                        const displayDate = date.replace(/-/g, '.');
                        
                        const fieldTitle = `📆 ${displayDate} 경기`;
                        let fieldContent = '';
                        
                        for (const game of gamesOnDate) {
                            const homeTeam = {
                                name: game.homeTeamName,
                                score: game.homeTeamScore,
                                code: game.homeTeamCode
                            };
                            const awayTeam = {
                                name: game.awayTeamName,
                                score: game.awayTeamScore,
                                code: game.awayTeamCode
                            };
                            
                            // 사용자 팀은 굵게 표시
                            if (homeTeam.code === existingUser.teamName) {
                                homeTeam.name = `**${homeTeam.name}**`;
                            }
                            if (awayTeam.code === existingUser.teamName) {
                                awayTeam.name = `**${awayTeam.name}**`;
                            }
                            
                            // 시간 포맷팅
                            const startTimeStr = game.gameDateTime || "";
                            const startTime = startTimeStr ? new Date(startTimeStr) : null;
                            const formattedTime = startTime ? 
                                `${startTime.getHours().toString().padStart(2, '0')}:${startTime.getMinutes().toString().padStart(2, '0')}` : 
                                "시간 미정";
                            
                            // 경기 상태 및 점수 표시
                            let status = "경기 예정";
                            let scoreText = "";
                            
                            if (game.cancel) {
                                status = "경기 취소";
                            } else if (game.statusCode) {
                                switch (game.statusCode) {
                                    case "BEFORE":
                                        status = "경기 예정";
                                        break;
                                    case "STARTED":
                                        status = game.statusInfo || "경기 중";
                                        break;
                                    case "RESULT":
                                        status = "경기 종료";
                                        break;
                                    default:
                                        status = game.statusInfo || "상태 정보 없음";
                                        break;
                                }
                            }
                            
                            // 점수 표시
                            if (!game.cancel && (game.statusCode === "STARTED" || game.statusCode === "RESULT") && 
                                homeTeam.score !== undefined && awayTeam.score !== undefined) {
                                scoreText = `${awayTeam.score} : ${homeTeam.score}`;
                            }
                            
                            // 선발 투수 정보
                            let starterInfo = "";
                            if (game.homeStarterName && game.awayStarterName) {
                                starterInfo = `\n선발: ${game.awayStarterName} vs ${game.homeStarterName}`;
                            }
                            
                            fieldContent += `⏰ ${formattedTime} | ${game.stadium || '장소 미정'}\n`;
                            fieldContent += `${awayTeam.name} vs ${homeTeam.name}\n`;
                            fieldContent += `${status}${scoreText ? ` (${scoreText})` : ''}${starterInfo}\n`;
                            
                            if (status !== "경기 종료" && status !== "경기 취소" && game.broadChannel) {
                                fieldContent += `📺 중계: ${game.broadChannel.replace(/\^/g, ', ')}\n`;
                            }
                            
                            fieldContent += `경기 ID: \`${game.gameId || '없음'}\`\n\n`;
                        }
                        
                        embed.addFields({
                            name: fieldTitle,
                            value: fieldContent,
                            inline: false
                        });
                    }
                    
                    return interaction.editReply({ embeds: [embed] });
                } else {
                    // 날짜 옵션이 없고 팀 설정도 없으면 오늘 날짜의 전체 경기 표시
                    targetDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
                    
                    const url = `https://api-gw.sports.naver.com/schedule/games?fields=basic%2Cschedule%2Cbaseball&upperCategoryId=kbaseball&fromDate=${targetDate}&toDate=${targetDate}&size=500`;
                    
                    const response = await axios.get(url);
                    const games = (response.data as any)?.result?.games.filter((game: any) => game.categoryId === "kbo") || [];
                    
                    if (!games || games.length === 0) {
                        return interaction.editReply(`${targetDate}에 예정된 KBO 경기가 없습니다.`);
                    }
                    
                    const embed = new EmbedBuilder()
                        .setColor(0x1E90FF)
                        .setTitle(`📅 KBO 경기 일정 (${targetDate})`)
                        .setTimestamp()
                        .setFooter({ text: `Powered by Naver Sports`})
                        .setThumbnail("https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png");
                    
                    displayGamesInEmbed(games, embed);
                    
                    return interaction.editReply({ embeds: [embed] });
                }
                
            } catch (error) {
                console.error("KBO 일정 조회 오류:", error);
                return interaction.editReply("KBO 일정을 불러오는 중 오류가 발생했습니다.");
            }
        }
        else if (subcommand === "순위") {
            await interaction.deferReply();
            
            try {
                // 연도 및 유형 옵션 처리
                const yearOption = interaction.options.getInteger("연도");
                const typeOption = interaction.options.getString("유형");
                const currentYear = new Date().getFullYear();
                const targetYear = yearOption || currentYear;
                
                // 순위 가져오기
                const standings = await getKBOStandings(targetYear, typeOption as string);
                
                if (!standings || standings.length === 0) {
                    return interaction.editReply(`${targetYear}년 KBO ${getTypeDisplayName(typeOption)} 정보를 불러올 수 없습니다.`);
                }
                
                // 임베드 생성
                const embed = new EmbedBuilder()
                    .setColor(0x1E90FF)
                    .setTitle(`⚾ KBO ${getTypeDisplayName(typeOption)} (${targetYear}년)`)
                    .setTimestamp()
                    .setFooter({ text: `Powered by Naver Sports` })
                    .setThumbnail("https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png");
                
                // 유형에 따른 필드 표시
                if (typeOption === "team" || typeOption === "pre_team") {
                    // 팀 순위 표시
                    standings.forEach((team: any) => {
                        embed.addFields({
                            name: `${team.rank}. ${team.team}`,
                            value: `⚾ ${team.games} 경기 | ${team.wins}승 | ${team.losses}패 | ${team.draws}무 \n`
                                + `📊 승률: ${team.winRate} | 📈 게임차: ${team.gameBehind} | 🔥 ${team.streak} \n`
                                + `👟 출루율: ${team.onBaseRate} | 💪 장타율: ${team.sluggingPct} | 🔄 ${team.last10Games}`,
                            inline: false
                        });
                    });
                } else if (typeOption === "pitcher" || typeOption === "pre_pitcher") {
                    // 투수 순위 표시 - 10위까지만
                    embed.setTitle(`⚾ KBO ${getTypeDisplayName(typeOption)} TOP 10 (${targetYear}년)`);
                    standings.slice(0, 10).forEach((pitcher: any) => {
                        embed.addFields({
                            name: `${pitcher.rank}. ${pitcher.name} (${pitcher.team})`,
                            value: `⚾ ${pitcher.era} 평균자책 | ${pitcher.wins}승 ${pitcher.losses}패 | ${pitcher.saves}세이브 ${pitcher.holds}홀드\n`
                                + `🎯 ${pitcher.inning} 이닝 | ${pitcher.strikeouts}삼진 | ${pitcher.hits}피안타 | ${pitcher.homeRuns}피홈런\n`
                                + `🔢 ${pitcher.runs}실점 | ${pitcher.walks}볼넷 | ${pitcher.hitByPitch}사구 | 승률 ${pitcher.winRate}`,
                            inline: false
                        });
                    });
                } else if (typeOption === "batter" || typeOption === "pre_batter") {
                    // 타자 순위 표시 - 10위까지만
                    embed.setTitle(`⚾ KBO ${getTypeDisplayName(typeOption)} TOP 10 (${targetYear}년)`);
                    standings.slice(0, 10).forEach((batter: any) => {
                        // 성적과 팀명 표시
                        let statsText = `🏆 타율: ${batter.battingAvg} | 💎 출루율: ${batter.onBaseRate} | 💪 장타율: ${batter.sluggingPct}\n`;
                        
                        // 타격 관련 성적
                        statsText += `👑 ${batter.hits}안타 (${batter.doubles}2타 ${batter.triples}3타 ${batter.homeRuns}홈런) | 💰 ${batter.rbis}타점\n`;
                        
                        // 출루 및 주루 성적
                        statsText += `🦿 ${batter.runs}득점 | 🏃 ${batter.stolenBases}도루 | 📝 ${batter.walks}볼넷 | ⚔️ ${batter.strikeouts}삼진\n`;
                        
                        // 기본 정보와 OPS
                        statsText += `👤 ${batter.games}경기 | ${batter.atBats}타수 | OPS: ${batter.ops || (parseFloat(batter.onBaseRate) + parseFloat(batter.sluggingPct)).toFixed(3)}`;
                        
                        embed.addFields({
                            name: `${batter.rank}. ${batter.name} (${batter.team})`,
                            value: statsText,
                            inline: false
                        });
                    });
                }
                
                return interaction.editReply({ embeds: [embed] });
                
            } catch (error) {
                console.error("KBO 순위 조회 오류:", error);
                return interaction.editReply("KBO 순위를 불러오는 중 오류가 발생했습니다.");
            }
        }
        else if (subcommand === "라인업") {
            await interaction.deferReply();
            
            try {
                const gameId = interaction.options.getString("경기id");
                
                if (gameId) {
                    // 기존 경기 ID가 제공된 경우의 처리
                    let gameDescription = "경기 라인업 정보";
                    if (gameId && gameId.length >= 8) {
                        const year = gameId.substring(0, 4);
                        const month = gameId.substring(4, 6);
                        const day = gameId.substring(6, 8);
                        gameDescription = `${year}년 ${month}월 ${day}일 경기 라인업 정보`;
                    }
                    
                    // 지정된 경기의 라인업 조회
                    const result = await getKBOLineup(gameId);
                    const lineupData = result.lineupData;
                    
                    if (!lineupData || lineupData.length === 0) {
                        return interaction.editReply("라인업 정보를 가져올 수 없습니다. 경기가 시작하지 않았거나 라인업이 공개되지 않았을 수 있습니다.");
                    }
                    
                    // 라인업 정보 표시를 위한 임베드 생성
                    const lineupEmbed = new EmbedBuilder()
                        .setColor(0x1E90FF)
                        .setTitle(`⚾ KBO 경기 라인업 (${lineupData[0]?.teamName || '원정팀'} vs ${lineupData[1]?.teamName || '홈팀'})`)
                        .setDescription(gameDescription)
                        .setTimestamp()
                        .setFooter({ text: "Powered by Naver Sports" })
                        .setThumbnail("https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png");
                    
                    // 양 팀 라인업 표시
                    if (lineupData[0]) {
                        let awayLineup = "";
                        lineupData[0].players.forEach((player: string, idx: number) => {
                            awayLineup += `${player}\n`;
                        });
                        
                        lineupEmbed.addFields({ 
                            name: `📋 ${lineupData[0].teamName} 라인업`,
                            value: awayLineup || "라인업 정보 없음",
                            inline: true
                        });
                    }
                    
                    if (lineupData[1]) {
                        let homeLineup = "";
                        lineupData[1].players.forEach((player: string, idx: number) => {
                            homeLineup += `${player}\n`;
                        });
                        
                        lineupEmbed.addFields({ 
                            name: `📋 ${lineupData[1].teamName} 라인업`,
                            value: homeLineup || "라인업 정보 없음",
                            inline: true
                        });
                    }
                    
                    return interaction.editReply({ embeds: [lineupEmbed] });
                } else {
                    // 경기 ID가 없는 경우 - 사용자가 설정한 팀의 오늘 경기 찾기
                    const existingUser = await MongoDB.kboUser.kbouser_View(interaction.user.id);
                    
                    if (!existingUser || !existingUser.teamName) {
                        return interaction.editReply("팀 설정이 되어있지 않습니다. `/kbo 팀설정` 명령어로 팀을 먼저 설정해주세요.");
                    }
                    
                    // 오늘 날짜 가져오기
                    const today = new Date();
                    const formattedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
                    
                    // 오늘 경기 일정 조회
                    const url = `https://api-gw.sports.naver.com/schedule/games?fields=basic%2Cschedule%2Cbaseball&upperCategoryId=kbaseball&fromDate=${formattedDate}&toDate=${formattedDate}&size=500`;
                    
                    const response = await axios.get(url);
                    const games = (response.data as any)?.result?.games.filter((game: any) => game.categoryId === "kbo") || [];
                    
                    // 사용자 팀이 참여하는 경기 찾기
                    const teamGame = games.find((game: any) => {
                        const homeTeamCode = game.homeTeamCode || '';
                        const awayTeamCode = game.awayTeamCode || '';
                        return homeTeamCode === existingUser.teamName || awayTeamCode === existingUser.teamName;
                    });
                    
                    if (!teamGame) {
                        return interaction.editReply(`${getTeamDisplayName(existingUser.teamName)}의 오늘 예정된 경기가 없습니다.`);
                    }
                    
                    // 발견된 경기의 ID로 라인업 조회
                    const todayGameId = teamGame.gameId;
                    console.log(`팀 ${existingUser.teamName}의 오늘 경기 ID: ${todayGameId}`);
                    
                    if (!todayGameId) {
                        return interaction.editReply(`${getTeamDisplayName(existingUser.teamName)}의 오늘 경기가 있지만, 경기 ID를 찾을 수 없습니다.`);
                    }
                    
                    // 라인업 조회
                    const result = await getKBOLineup(todayGameId);
                    const lineupData = result.lineupData;
                    
                    if (!lineupData || lineupData.length === 0) {
                        return interaction.editReply(`${getTeamDisplayName(existingUser.teamName)}의 오늘 경기 라인업이 아직 공개되지 않았습니다.`);
                    }
                    
                    const startTimeStr = teamGame.gameDateTime || "";
                    const startTime = startTimeStr ? new Date(startTimeStr) : null;
                    const formattedTime = startTime ? 
                                `${startTime.getHours().toString().padStart(2, '0')}:${startTime.getMinutes().toString().padStart(2, '0')}` : 
                                "시간 미정";
                    // 라인업 정보 표시를 위한 임베드 생성
                    const lineupEmbed = new EmbedBuilder()
                        .setColor(getTeamColor(existingUser.teamName))
                        .setTitle(`⚾ ${getTeamDisplayName(existingUser.teamName)} 오늘 경기 라인업`)
                        .setDescription(`${formattedDate.replace(/-/g, '.')} ${lineupData[0].teamName}vs ${lineupData[1].teamName} ${teamGame.stadium || '경기장 미정'} (${formattedTime || '시간 미정'})`)
                        .setTimestamp()
                        .setFooter({ text: "Powered by Naver Sports" })
                        .setThumbnail("https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png");
                    
                    // 양 팀 라인업 표시 - 사용자 팀을 강조
                    if (lineupData[0]) {
                        let awayLineup = "";
                        lineupData[0].players.forEach((player: string, idx: number) => {
                            // 사용자 팀인 경우 강조 표시
                            if (teamGame.awayTeamCode === existingUser.teamName) {
                                awayLineup += `**${player}**\n`;
                            } else {
                                awayLineup += `${player}\n`;
                            }
                        });
                        
                        lineupEmbed.addFields({ 
                            name: `📋 ${lineupData[0].teamName} 라인업${teamGame.awayTeamCode === existingUser.teamName ? ' (내 팀)' : ''}`,
                            value: awayLineup || "라인업 정보 없음",
                            inline: true
                        });
                    }
                    
                    if (lineupData[1]) {
                        let homeLineup = "";
                        lineupData[1].players.forEach((player: string, idx: number) => {
                            // 사용자 팀인 경우 강조 표시
                            if (teamGame.homeTeamCode === existingUser.teamName) {
                                homeLineup += `**${player}**\n`;
                            } else {
                                homeLineup += `${player}\n`;
                            }
                        });
                        
                        lineupEmbed.addFields({ 
                            name: `📋 ${lineupData[1].teamName} 라인업${teamGame.homeTeamCode === existingUser.teamName ? ' (내 팀)' : ''}`,
                            value: homeLineup || "라인업 정보 없음",
                            inline: true
                        });
                    }
                    
                    return interaction.editReply({ embeds: [lineupEmbed] });
                }
                
            } catch (error) {
                console.error("KBO 라인업 조회 오류:", error);
                return interaction.editReply("KBO 라인업을 불러오는 중 오류가 발생했습니다.");
            }
        }

        else if (subcommand === "뉴스") {
            await interaction.deferReply();
            
            try {
                // 사용자가 저장한 팀 정보 확인
                const existingUser = await MongoDB.kboUser.kbouser_View(interaction.user.id);
                
                // 명령어에서 팀 옵션을 받거나 저장된 팀 설정 사용, 기본값은 'kbo'(전체 뉴스)
                let team = interaction.options.getString("팀") || (existingUser ? existingUser.teamName : "kbo");
                
                // 날짜 옵션이 없으면 오늘 날짜로 설정 (YYYYMMDD 형식)
                const today = new Date();
                let dateOption = interaction.options.getString("날짜") || 
                    `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
                
                // 네이버 스포츠 뉴스 API URL 
                const url = `https://sports.news.naver.com/kbo/news/list?isphoto=N&type=team&team=${team}&date=${dateOption}`;
                
                // API 호출
                const response = await axios.get(url);
                const data = response.data as NewsApiResponse;
                
                // 뉴스가 없는 경우 처리 - 구조에 맞게 체크
                if (!data || !data.list || data.list.length === 0) {
                    return interaction.editReply(`${getTeamDisplayName(team)} 관련 최신 뉴스가 없습니다.`);
                }
                
                // 뉴스 목록 추출 - 실제 구조에 맞게 수정
                const newsList = data.list;
                
                // 임베드 생성
                const embed = new EmbedBuilder()
                    .setColor(getTeamColor(team))
                    .setTitle(`⚾ ${getTeamDisplayName(team)} 최신 뉴스`)
                    .setTimestamp()
                    .setFooter({ text: `Powered by Naver Sports` })
                    .setThumbnail("https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png");
                
                // 5개의 뉴스만 표시
                const maxNewsCount = Math.min(5, newsList.length);
                
                for (let i = 0; i < maxNewsCount; i++) {
                    const news = newsList[i];
                    
                    // 뉴스 URL 생성
                    const newsUrl = `https://sports.news.naver.com/news?oid=${news.oid}&aid=${news.aid}`;
                    
                    // 내용이 너무 길면 자르기
                    const content = news.subContent?.length > 100 
                        ? `${news.subContent.substring(0, 100)}...` 
                        : news.subContent || '내용 없음';
                    
                    embed.addFields({
                        name: `📰 ${news.title}`,
                        value: `${content}\n`
                            + `${news.officeName} | ${news.datetime}\n`
                            + `[기사 보기](${newsUrl})`,
                        inline: false
                    });
                    
                    // 첫 번째 뉴스의 썸네일을 임베드의 이미지로 설정
                    if (i === 0 && news.thumbnail) {
                        embed.setImage(news.thumbnail);
                    }
                }
                
                return interaction.editReply({ embeds: [embed] });
                
            } catch (error) {
                console.error("KBO 뉴스 조회 오류:", error);
                return interaction.editReply("KBO 뉴스를 불러오는 중 오류가 발생했습니다.");
            }
        }

        else if (subcommand === "팀설정") {
            await interaction.deferReply();
            const team = interaction.options.getString("팀");
            const notifications = interaction.options.getBoolean("알림") ?? true; // 기본값은 true
            
            if (!team) {
                return interaction.editReply("설정할 팀 이름을 선택해주세요.");
            }

            // 알림이 활성화되어 있는 경우 DM 권한 체크
            if (notifications) {
                try {
                    // 테스트 DM을 보내봄
                    await interaction.user.send("KBO 알림 서비스 DM 권한 테스트 메시지입니다. 이 메시지는 곧 삭제됩니다.").then(msg => msg.delete().catch(() => {}));
                } catch (error) {
                    // DM 보내기 실패
                    return interaction.editReply({
                        content: "❌ **DM 권한 오류**\n알림 기능을 사용하려면 서버 설정에서 '개인 메시지 허용'을 활성화해야 합니다. \n알림설정 false로 설정하면 DM 권한을 요구하지 않습니다.",
                    });
                }
            }
            
            // 사용자가 이미 팀 설정을 했는지 확인
            const existingUser = await MongoDB.kboUser.kbouser_View(interaction.user.id);
            
            // 임베드 생성
            const embed = new EmbedBuilder()
                .setTimestamp()
                .setFooter({ text: `KBO 팀 설정` })
                .setThumbnail("https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png");
            
            if (existingUser) {
                const displayTeamName = getTeamDisplayName(existingUser.teamName);

                if (existingUser.teamName === team) {
                    // 알림 설정만 변경
                    if (existingUser.notifications !== notifications) {
                        await MongoDB.kboUser.kbouser_notifications_toggle(interaction.user.id, notifications);
                        embed.setColor(getTeamColor(team))
                            .setTitle(`알림 설정 변경`)
                            .setDescription(`${interaction.user.globalName}님의 KBO 팀 알림 설정이 변경되었습니다.`)
                            .addFields({ 
                                name: `현재 설정된 팀`, 
                                value: `**${displayTeamName}**`,
                                inline: true 
                            })
                            .addFields({ 
                                name: `알림 설정`, 
                                value: notifications ? "✅ 활성화됨" : "❌ 비활성화됨",
                                inline: true 
                            });
                        
                        return interaction.editReply({ embeds: [embed] });
                    }
                    
                    // 이미 설정된 팀과 같은 경우
                    embed.setColor(getTeamColor(team))
                        .setTitle(`팀 변경 불가`)
                        .setDescription(`${interaction.user.globalName}님의 KBO 팀이 이미 **${displayTeamName}**로 설정되어 있습니다.`)
                        .addFields({ 
                            name: `현재 설정된 팀`, 
                            value: `**${displayTeamName}**`,
                            inline: true 
                        })
                        .addFields({ 
                            name: `알림 설정`, 
                            value: existingUser.notifications ? "✅ 활성화됨" : "❌ 비활성화됨",
                            inline: true 
                        });
                    
                    return interaction.editReply({ embeds: [embed] });
                }
                
                // 설정된 팀의 색상 사용
                embed.setColor(getTeamColor(team))
                    .setTitle(`kbo 팀 변경`)
                    .setDescription(`${interaction.user.globalName}님의 KBO 팀이 변경 되었습니다.`)
                    .addFields({ 
                        name: `현재 설정된 팀`, 
                        value: `**${displayTeamName}** → **${getTeamDisplayName(team)}**`,
                        inline: true 
                    })
                    .addFields({ 
                        name: `알림 설정`, 
                        value: notifications ? "✅ 활성화됨" : "❌ 비활성화됨",
                        inline: true 
                    });
                
                interaction.editReply({ embeds: [embed] });
                
                // 팀 변경 및 알림 설정 업데이트
                await MongoDB.kboUser.kbouser_teamName_edit(interaction.user.id, team);
                await MongoDB.kboUser.kbouser_notifications_toggle(interaction.user.id, notifications);
                
                // 알림이 활성화된 경우 DM으로 메시지 보내기
                if (notifications) {
                    try {
                        const dmEmbed = new EmbedBuilder()
                            .setColor(getTeamColor(team))
                            .setTitle(`⚾ ${getTeamDisplayName(team)} 팀 알림 설정 완료!`)
                            .setDescription(`${interaction.user.username}님, ${getTeamDisplayName(team)} 팀의 알림 설정이 활성화되었습니다.`)
                            .addFields({ 
                                name: `알림 정보`, 
                                value: `- 경기 시작 10분 전 알림\n- 라인업 발표시 알림`,
                                inline: false 
                            })
                            .setFooter({ text: `알림을 비활성화하려면 /kbo 알림설정 명령어를 사용하세요.` })
                            .setTimestamp()
                            .setThumbnail("https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png");
                            
                        await interaction.user.send({ embeds: [dmEmbed] });
                    } catch (error) {
                        console.error(`사용자 ${interaction.user.id}에게 DM 보내기 실패:`, error);
                        // DM 보내기 실패해도 계속 진행
                    }
                }
                
                return;
            }

            // MongoDB에 팀 설정 정보 저장 (알림 설정 포함)
            await MongoDB.kboUser.kbouserInsert(interaction.user.id, team, notifications);
            
            const displayTeamName = getTeamDisplayName(team);
            
            embed.setColor(getTeamColor(team))
                .setTitle(`팀 설정 완료`)
                .setDescription(`${interaction.user.globalName}님의 KBO 팀이 설정되었습니다.`)
                .addFields({ 
                    name: `설정된 KBO 팀`, 
                    value: `**${displayTeamName}**`,
                    inline: true 
                })
                .addFields({ 
                    name: `알림 설정`, 
                    value: notifications ? "✅ 활성화됨" : "❌ 비활성화됨",
                    inline: true 
                });
            
            interaction.editReply({ embeds: [embed] });
            
            // 알림이 활성화된 경우 DM으로 메시지 보내기
            if (notifications) {
                try {
                    const dmEmbed = new EmbedBuilder()
                        .setColor(getTeamColor(team))
                        .setTitle(`⚾ ${displayTeamName} 팀 알림 설정 완료!`)
                        .setDescription(`${interaction.user.username}님, ${displayTeamName} 팀의 알림 설정이 활성화되었습니다.`)
                        .addFields({ 
                            name: `알림 정보`, 
                            value: `- 경기 시작 10분 전 알림\n- 라인업 발표시 알림`,
                            inline: false 
                        })
                        .setFooter({ text: `알림을 비활성화하려면 /kbo 알림설정 명령어를 사용하세요.` })
                        .setTimestamp()
                        .setThumbnail("https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png");
                        
                    await interaction.user.send({ embeds: [dmEmbed] });
                } catch (error) {
                    console.error(`사용자 ${interaction.user.id}에게 DM 보내기 실패:`, error);
                    // DM 보내기 실패해도 계속 진행
                }
            }
            
            return;
        }
        else if (subcommand === "알림설정") {
            await interaction.deferReply();
            const notifications = interaction.options.getBoolean("활성화") ?? false;
            
            // 사용자 확인
            const existingUser = await MongoDB.kboUser.kbouser_View(interaction.user.id);
            
            if (!existingUser) {
                return interaction.editReply("먼저 `/kbo 팀설정` 명령어로 팀을 설정해주세요.");
            }
            
            // 알림 설정 업데이트
            await MongoDB.kboUser.kbouser_notifications_toggle(interaction.user.id, notifications);
            
            const displayTeamName = getTeamDisplayName(existingUser.teamName);
            
            // 알림이 활성화되어 있는 경우 DM 권한 체크
            if (notifications) {
                try {
                    // 테스트 DM을 보내봄
                    await interaction.user.send("KBO 알림 서비스 DM 권한 테스트 메시지입니다. 이 메시지는 곧 삭제됩니다.").then(msg => msg.delete().catch(() => {}));
                } catch (error) {
                    // DM 보내기 실패
                    return interaction.editReply({
                        content: "❌ **DM 권한 오류**\n알림 기능을 사용하려면 서버 설정에서 '개인 메시지 허용'을 활성화해야 합니다.",
                    });
                }
            }
            
            // 임베드 생성
            const embed = new EmbedBuilder()
                .setColor(getTeamColor(existingUser.teamName))
                .setTitle(`알림 설정 ${notifications ? '활성화' : '비활성화'}`)
                .setDescription(`${interaction.user.globalName}님의 ${displayTeamName} 팀 알림이 ${notifications ? '활성화' : '비활성화'}되었습니다.`)
                .addFields({ 
                    name: `설정된 팀`, 
                    value: `**${displayTeamName}**`,
                    inline: true 
                })
                .addFields({ 
                    name: `알림 상태`, 
                    value: notifications ? "✅ 활성화됨" : "❌ 비활성화됨",
                    inline: true 
                })
                .setFooter({ text: `KBO 팀 알림 설정` })
                .setTimestamp()
                .setThumbnail("https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png");
            
            interaction.editReply({ embeds: [embed] });
            
        }

        else if (subcommand === "영상") {
            await interaction.deferReply();
            
            try {
                const gameId = interaction.options.getString("경기id");
                
                // 사용자가 저장한 팀 정보 확인
                const existingUser = await MongoDB.kboUser.kbouser_View(interaction.user.id);
                
                // 경기ID가 있으면 경기 영상을 우선적으로 검색, 없으면 팀 영상 검색
                let url: string;
                let title: string;
                
                if (gameId) {
                    // 경기 영상 API
                    url = `https://api-gw.sports.naver.com/video/game/${gameId}?sort=date&page=1&pageSize=18`;
                    
                    // 경기 ID에서 날짜와 팀 정보 추출
                    let gameDate = "경기";
                    let teams = "";
                    
                    if (gameId.length >= 13) {
                        const year = gameId.substring(0, 4);
                        const month = gameId.substring(4, 6);
                        const day = gameId.substring(6, 8);
                        const awayTeam = gameId.substring(8, 10);
                        const homeTeam = gameId.substring(10, 12);
                        
                        gameDate = `${year}년 ${month}월 ${day}일 경기`;
                        teams = `${getTeamDisplayName(awayTeam)} vs ${getTeamDisplayName(homeTeam)}`;
                    }
                    
                    title = `⚾ ${teams} ${gameDate} 영상`;
                } else {
                    // 명령어에서 팀 옵션을 받거나 저장된 팀 설정 사용, 기본값은 'kbo'(전체 영상)
                    let team = interaction.options.getString("팀") || (existingUser ? existingUser.teamName : "kbo");
                    
                    if (team === "kbo") {
                        // 전체 영상 API
                        url = `https://api-gw.sports.naver.com/video/lists/total?upperCategoryId=kbaseball&categoryId=kbo&page=1&pageSize=10&sort=date&fields=videoList`;
                        title = `⚾ KBO 최신 영상`;
                    } else {
                        // 팀별 영상 API
                        url = `https://api-gw.sports.naver.com/video/lists/team?upperCategoryId=kbaseball&categoryId=kbo&page=1&pageSize=10&sort=date&teamCode=${team}&fields=videoList&withClub=true`;
                        title = `⚾ ${getTeamDisplayName(team)} 최신 영상`;
                    }
                }
                
                
                // API 호출
                const response = await axios.get(url);
                const data = response.data as VideoApiResponse;
                
                // 영상이 없는 경우 처리 - 경기ID와 일반 케이스 구분
                if (!data || !data.success) {
                    return interaction.editReply("영상을 불러오는 중 오류가 발생했습니다.");
                }
                
                let videoList: VideoItem[] = [];
                
                // 경기ID와 일반 검색의 응답 구조 차이를 처리
                if (gameId) {
                    // 경기 영상 응답 구조: vodList 배열에 영상 목록이 있음
                    if (data.result && data.result.vodList) {
                        videoList = data.result.vodList;
                    }
                } else {
                    // 일반 팀 영상 응답 구조: videos 배열에 영상 목록이 있음
                    if (data.result && data.result.videos) {
                        videoList = data.result.videos;
                    }
                }
                
                // 영상이 없는 경우
                if (!videoList || videoList.length === 0) {
                    if (gameId) {
                        return interaction.editReply(`해당 경기의 영상이 없습니다.`);
                    } else {
                        const team = interaction.options.getString("팀") || (existingUser ? existingUser.teamName : "kbo");
                        return interaction.editReply(`${team === "kbo" ? "KBO" : getTeamDisplayName(team)} 관련 최신 영상이 없습니다.`);
                    }
                }
                
                // 임베드 생성
                const embed = new EmbedBuilder()
                    .setColor(0x1E90FF)
                    .setTitle(title)
                    .setTimestamp()
                    .setFooter({ text: `Powered by Naver Sports` })
                    .setThumbnail("https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png");
                
                // 5개의 영상만 표시
                const maxVideoCount = Math.min(5, videoList.length);
                
                for (let i = 0; i < maxVideoCount; i++) {
                    const video = videoList[i];
                    
                    // 조회수 포맷팅
                    const viewCount = video.hit ? video.hit.toLocaleString('ko-KR') : "조회수 정보 없음";
                    
                    // 영상 URL 생성
                    const videoUrl = `https://sports.news.naver.com/video?id=${video.sportsVideoId}`;
                    
                    // 업로드 시간 포맷팅
                    const uploadDate = new Date(video.produceDateTime);
                    const formattedDate = `${uploadDate.getFullYear()}-${String(uploadDate.getMonth() + 1).padStart(2, '0')}-${String(uploadDate.getDate()).padStart(2, '0')}`;
                    
                    embed.addFields({
                        name: `🎬 ${video.title}`,
                        value: `🔹 ${video.seasonName || '전체'} | ${video.videoTypeName || '하이라이트'} | ${video.playTime || '00:00'}\n`
                            + `👀 조회수: ${viewCount} | 📅 ${formattedDate}\n`
                            + `[영상 보기](${videoUrl})`,
                        inline: false
                    });
                    
                    // 첫 번째 영상의 썸네일을 임베드의 이미지로 설정
                    if (i === 0 && video.thumbnail) {
                        embed.setImage(video.thumbnail);
                    }
                }
                
                return interaction.editReply({ embeds: [embed] });
                
            } catch (error) {
                console.error("KBO 영상 조회 오류:", error);
                return interaction.editReply("KBO 영상을 불러오는 중 오류가 발생했습니다.");
            }
        }
        else if (subcommand === "중계") {
            await interaction.deferReply();
            
            try {
                // "종료종료" 명령어 처리
                const message = interaction.options.getString("경기id");
                if (message === "종료종료") {
                    return await handleTerminateCommand(interaction);
                }
                
                // 사용자가 이미 중계 받고 있는지 확인
                if (isUserReceivingLiveRelay(interaction.user.id)) {
                    return interaction.editReply("❌ **이미 실시간 중계를 받고 계십니다.**\n현재 중계를 종료하려면 `/kbo 중계 경기id:종료종료` 명령어를 사용해주세요.");
                }

                const gameId = message;
                
                if (gameId) {
                    // 특정 경기 ID가 제공된 경우
                    // 경기 기본 정보 가져오기
                    const today = new Date();
                    const formattedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
                    
                    const scheduleUrl = `https://api-gw.sports.naver.com/schedule/games?fields=basic%2Cschedule%2Cbaseball&upperCategoryId=kbaseball&fromDate=${formattedDate}&toDate=${formattedDate}&size=500`;
                    const scheduleResponse = await axios.get(scheduleUrl);
                    const games = (scheduleResponse.data as any)?.result?.games || [];
                    
                    // 해당 경기 정보 찾기
                    const targetGame = games.find((game: any) => game.gameId === gameId);
                    
                    if (!targetGame) {
                        return interaction.editReply(`ID: ${gameId}에 해당하는 경기 정보를 찾을 수 없습니다.`);
                    }
                    
                    // 경기 상태 확인
                    if (targetGame.cancel) {
                        return interaction.editReply(`이 경기는 취소되었습니다. 사유: ${targetGame.cancelReason || '사유 미상'}`);
                    }
                    
                    // 경기가 종료되었는지 확인 - 명확하게 체크
                    const isGameEnded = targetGame.statusCode === "RESULT" || targetGame.statusCode === "ENDED"; 
                    if (isGameEnded) {
                        return interaction.editReply(`이 경기는 이미 종료되었습니다. 결과: ${targetGame.homeTeamName} ${targetGame.homeTeamScore} : ${targetGame.awayTeamScore} ${targetGame.awayTeamName}`);
                    }
                    
                    if (targetGame.statusCode !== "STARTED" && !isGameEnded) {
                        return interaction.editReply(`이 경기는 아직 시작되지 않았습니다. 시작 예정 시간: ${targetGame.gameDateTime.substring(11, 16)}`);
                    }
                    
                    await showLiveGameInfo(interaction, gameId);
                } else {
                    // 경기 ID가 없는 경우 - 사용자가 설정한 팀의 오늘 경기 찾기
                    const existingUser = await MongoDB.kboUser.kbouser_View(interaction.user.id);
                    
                    if (!existingUser || !existingUser.teamName) {
                        return interaction.editReply("팀 설정이 되어있지 않습니다. `/kbo 팀설정` 명령어로 팀을 먼저 설정해주세요.");
                    }
                    
                    // 오늘 날짜 가져오기
                    const today = new Date();
                    const formattedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
                    
                    // 오늘 경기 일정 조회
                    const url = `https://api-gw.sports.naver.com/schedule/games?fields=basic%2Cschedule%2Cbaseball&upperCategoryId=kbaseball&fromDate=${formattedDate}&toDate=${formattedDate}&size=500`;
                    
                    const response = await axios.get(url);
                    const games = (response.data as any)?.result?.games.filter((game: any) => game.categoryId === "kbo") || [];
                    
                    // 사용자 팀이 참여하는 경기 찾기
                    const teamGame = games.find((game: any) => {
                        const homeTeamCode = game.homeTeamCode || '';
                        const awayTeamCode = game.awayTeamCode || '';
                        return homeTeamCode === existingUser.teamName || awayTeamCode === existingUser.teamName;
                    });
                    
                    if (!teamGame) {
                        return interaction.editReply(`${getTeamDisplayName(existingUser.teamName)}의 오늘 예정된 경기가 없습니다.`);
                    }
                    
                    // 발견된 경기의 ID로 실시간 중계 정보 조회
                    const todayGameId = teamGame.gameId;
                    if (!todayGameId) {
                        return interaction.editReply(`${getTeamDisplayName(existingUser.teamName)}의 오늘 경기가 있지만, 경기 ID를 찾을 수 없습니다.`);
                    }
                    
                    console.log(`팀 ${existingUser.teamName}의 오늘 경기 ID: ${todayGameId}로 실시간 중계 조회`);
                    
                    // 실시간 중계 정보 조회
                    await showLiveGameInfo(interaction, todayGameId);
                }
            } catch (error) {
                console.error("KBO 실시간 중계 조회 오류:", error);
                return interaction.editReply("KBO 실시간 중계 정보를 불러오는 중 오류가 발생했습니다.");
            }
        }
        else if (subcommand === "dm중계") {
            await interaction.deferReply({ ephemeral: true });
            
            try {
                // "종료종료" 명령어 처리
                const message = interaction.options.getString("경기id");
                if (message === "종료종료") {
                    return await handleTerminateCommand(interaction);
                }
                
                // 사용자가 이미 중계 받고 있는지 확인
                if (isUserReceivingLiveRelay(interaction.user.id)) {
                    return interaction.editReply({
                        content: "❌ **이미 실시간 중계를 받고 계십니다.**\n현재 중계를 종료하려면 `/kbo dm중계 경기id:종료종료` 명령어를 사용해주세요.",
                    });
                }
                
                const gameId = message;
                
                if (gameId) {
                    // 특정 경기 ID가 제공된 경우
                    await startDmLiveRelay(interaction, gameId);
                } else {
                    // 경기 ID가 없는 경우 - 사용자가 설정한 팀의 오늘 경기 찾기
                    const existingUser = await MongoDB.kboUser.kbouser_View(interaction.user.id);
                    
                    if (!existingUser || !existingUser.teamName) {
                        return interaction.editReply("팀 설정이 되어있지 않습니다. `/kbo 팀설정` 명령어로 팀을 먼저 설정해주세요.");
                    }
                    
                    // 오늘 날짜 가져오기
                    const today = new Date();
                    const formattedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
                    
                    // 오늘 경기 일정 조회
                    const url = `https://api-gw.sports.naver.com/schedule/games?fields=basic%2Cschedule%2Cbaseball&upperCategoryId=kbaseball&fromDate=${formattedDate}&toDate=${formattedDate}&size=500`;
                    
                    const response = await axios.get(url);
                    const games = (response.data as any)?.result?.games.filter((game: any) => game.categoryId === "kbo") || [];
                    
                    // 사용자 팀이 참여하는 경기 찾기
                    const teamGame = games.find((game: any) => {
                        const homeTeamCode = game.homeTeamCode || '';
                        const awayTeamCode = game.awayTeamCode || '';
                        return homeTeamCode === existingUser.teamName || awayTeamCode === existingUser.teamName;
                    });
                    
                    if (!teamGame) {
                        return interaction.editReply(`${getTeamDisplayName(existingUser.teamName)}의 오늘 예정된 경기가 없습니다.`);
                    }
                    
                    // 발견된 경기의 ID로 DM 실시간 중계 정보 시작
                    const todayGameId = teamGame.gameId;
                    console.log(`팀 ${existingUser.teamName}의 오늘 경기 ID: ${todayGameId}로 DM 실시간 중계 시작`);
                    
                    // DM 실시간 중계 시작
                    await startDmLiveRelay(interaction, todayGameId);
                }
            } catch (error) {
                console.error("KBO DM 실시간 중계 시작 오류:", error);
                return interaction.editReply("KBO DM 실시간 중계를 시작하는 중 오류가 발생했습니다.");
            }
        }
    }
} as unknown as SlashCommand;

// 유형 표시 이름 가져오는 함수
function getTypeDisplayName(type: string | null) {
    switch(type) {
        case "team": return "팀 순위";
        case "pitcher": return "투수 순위";
        case "batter": return "타자 순위";
        case "pre_team": return "시범경기 팀 순위";
        case "pre_pitcher": return "시범경기 투수 순위";
        case "pre_batter": return "시범경기 타자 순위";
        default: return "팀 순위";
    }
}

// 팀 코드별 색상을 반환하는 함수
function getTeamColor(teamCode: string): number {
    const teamColors: { [key: string]: number } = {
        'OB': 0x131230, // 두산 네이비
        'LT': 0xF37321, // 롯데 오렌지
        'SS': 0x1428A0, // 삼성 블루
        'WO': 0xC70125, // 키움 레드
        'HH': 0xFF6600, // 한화 오렌지
        'HT': 0xEA0029, // KIA 레드
        'LG': 0xC30452, // LG 마젠타
        'NC': 0x315288, // NC 네이비블루
        'SK': 0xFF0000, // SSG 레드
        'KT': 0x202020  // KT 블랙
    };
    
    return teamColors[teamCode] || 0x1E90FF; // 기본값으로 밝은 파란색 반환
}

// 팀 이모지 아이디를 반환하는 함수
function getTeamEmoji(teamCode: string): string {
    const emojiMap: { [key: string]: string } = {
        'OB': '<:OB:1491656506314199061>', // 두산
        'LT': '<:LT:1491655954897567774>', // 롯데
        'SS': '<:SS:1491656512542871572>', // 삼성
        'WO': '<:WO:1491656514245492886>', // 키움
        'HH': '<:HH:1491656494134067270>', // 한화
        'HT': '<:HT:1491656508008693790>', // KIA
        'LG': '<:LG:1491656515957030912>', // LG
        'NC': '<:NC:1491656495862120468>', // NC
        'SK': '<:SK:1491656509317320786>', // SSG
        'KT': '<:KT:1491656510894505994>'  // KT
    };
    return emojiMap[teamCode] || '';
}

// 팀 코드를 표시 이름으로 변환하는 함수
function getTeamDisplayName(teamCode: string, withEmoji: boolean = true) {
    const teamMap: { [key: string]: string } = {
        'OB': '두산',
        'LT': '롯데',
        'SS': '삼성',
        'WO': '키움',
        'HH': '한화',
        'HT': 'KIA',
        'LG': 'LG',
        'NC': 'NC',
        'SK': 'SSG',
        'KT': 'KT'
    };
    const name = teamMap[teamCode] || teamCode;
    if (withEmoji) {
        const emoji = getTeamEmoji(teamCode);
        return emoji ? `${emoji} ${name}` : name;
    }
    return name;
}

// KBO 순위 가져오는 함수 (API 기반)
async function getKBOStandings(year = new Date().getFullYear(), type: string = "team") {
    const isPreseason = type.startsWith("pre_");
    const actualType = type.replace("pre_", "");
    
    if (actualType === "team") {
        return await getKBOTeamStandingsFromAPI(year, isPreseason);
    } else if (actualType === "pitcher") {
        return await getKBOPitchersFromAPI(year, isPreseason);
    } else if (actualType === "batter") {
        return await getKBOBattersFromAPI(year, isPreseason);
    }
    return [];
}

// 네이버 스포츠 KBO 팀 순위 API에서 데이터 가져오기
async function getKBOTeamStandingsFromAPI(year = new Date().getFullYear(), isPreseason: boolean = false) {
    let url = `https://api-gw.sports.naver.com/statistics/categories/kbo/seasons/${year}/teams`;
    if (isPreseason) {
        url += `?gameType=PRESEASON`;
    }
    
    try {
        console.log(`KBO 팀 순위 API 호출: ${url}`);
        
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        if (!response.ok) {
            throw new Error(`API 응답 오류: ${response.status}`);
        }

        const data = await response.json();
        
        if (!data.success || !data.result?.seasonTeamStats) {
            throw new Error('API 응답 데이터 구조가 올바르지 않습니다.');
        }        // API 데이터를 기존 형식에 맞게 변환
        const teamStats = data.result.seasonTeamStats;
        const formattedData = teamStats.map((team: any) => ({
            rank: team.ranking.toString(),
            team: getTeamDisplayName(team.teamId), // teamId를 표시명으로 변환
            games: team.gameCount.toString(),
            wins: team.winGameCount.toString(),
            losses: team.loseGameCount.toString(),
            draws: team.drawnGameCount.toString(),
            winRate: team.wra.toFixed(3),
            gameBehind: team.gameBehind.toString(),
            streak: team.continuousGameResult || "",
            onBaseRate: team.offenseObp?.toFixed(3) || "",
            sluggingPct: team.offenseSlg?.toFixed(3) || "",
            last10Games: convertGameResultToKorean(team.lastFiveGames || "")
        }));        console.log(`API에서 ${formattedData.length}개의 팀 데이터를 가져왔습니다.`);
        return formattedData;    } catch (error) {
        console.error(`KBO ${year}년 팀 순위 API 호출 오류:`, error);
        
        // API 실패 시 빈 배열 반환
        return [];
    }
}

// 네이버 스포츠 KBO 투수 순위 API에서 데이터 가져오기
async function getKBOPitchersFromAPI(year = new Date().getFullYear(), isPreseason: boolean = false) {
    let url = `https://api-gw.sports.naver.com/statistics/categories/kbo/seasons/${year}/players?sortField=pitcherEra&sortDirection=asc&playerType=PITCHER`;
    if (isPreseason) {
        url += `&gameType=PRESEASON`;
    }
    
    try {
        console.log(`KBO 투수 순위 API 호출: ${url}`);
        
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        if (!response.ok) {
            throw new Error(`API 응답 오류: ${response.status}`);
        }

        const data = await response.json();
          if (!data.success || !data.result?.seasonPlayerStats) {
            throw new Error('API 응답 데이터 구조가 올바르지 않습니다.');
        }

        // API 데이터를 기존 형식에 맞게 변환
        const players = data.result.seasonPlayerStats;
        const formattedData = players.slice(0, 30).map((player: any, index: number) => ({
            rank: (index + 1).toString(),
            name: player.playerName || "",
            team: getTeamDisplayName(player.teamId) || "", // teamId를 표시명으로 변환
            era: player.pitcherEra?.toFixed(2) || "",
            games: player.pitcherGameCount?.toString() || "",
            inning: player.pitcherInning?.toString() || "",
            wins: player.pitcherWin?.toString() || "",
            losses: player.pitcherLose?.toString() || "",
            saves: player.pitcherSave?.toString() || "",
            holds: player.pitcherHold?.toString() || "",
            strikeouts: player.pitcherKk?.toString() || "",
            hits: player.pitcherHit?.toString() || "",
            homeRuns: player.pitcherHr?.toString() || "",
            runs: player.pitcherR?.toString() || "",
            walks: player.pitcherBb?.toString() || "",
            hitByPitch: player.pitcherHp?.toString() || "",
            winRate: player.pitcherWra?.toFixed(3) || ""
        }));console.log(`API에서 ${formattedData.length}개의 투수 데이터를 가져왔습니다.`);
        return formattedData;

    } catch (error) {
        console.error(`KBO ${year}년 투수 순위 API 호출 오류:`, error);
        
        // API 실패 시 빈 배열 반환
        return [];
    }
}

// 네이버 스포츠 KBO 타자 순위 API에서 데이터 가져오기
async function getKBOBattersFromAPI(year = new Date().getFullYear(), isPreseason: boolean = false) {
    let url = `https://api-gw.sports.naver.com/statistics/categories/kbo/seasons/${year}/players?sortField=hitterHra&sortDirection=desc&playerType=HITTER`;
    if (isPreseason) {
        url += `&gameType=PRESEASON`;
    }
    
    try {
        console.log(`KBO 타자 순위 API 호출: ${url}`);
        
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        if (!response.ok) {
            throw new Error(`API 응답 오류: ${response.status}`);
        }

        const data = await response.json();
          if (!data.success || !data.result?.seasonPlayerStats) {
            throw new Error('API 응답 데이터 구조가 올바르지 않습니다.');
        }

        // API 데이터를 기존 형식에 맞게 변환
        const players = data.result.seasonPlayerStats;
        const formattedData = players.slice(0, 30).map((player: any, index: number) => {
            // OPS 계산
            const onBaseRate = player.hitterObp || 0;
            const sluggingPct = player.hitterSlg || 0;
            const ops = (onBaseRate + sluggingPct).toFixed(3);
            
            return {
                rank: (index + 1).toString(),
                name: player.playerName || "",
                team: getTeamDisplayName(player.teamId) || "", // teamId를 표시명으로 변환
                battingAvg: player.hitterHra?.toFixed(3) || "",
                games: player.hitterGameCount?.toString() || "",
                atBats: player.hitterAb?.toString() || "",
                hits: player.hitterHit?.toString() || "",
                doubles: player.hitterH2?.toString() || "",
                triples: player.hitterH3?.toString() || "",
                homeRuns: player.hitterHr?.toString() || "",
                rbis: player.hitterRbi?.toString() || "",
                runs: player.hitterRun?.toString() || "",
                stolenBases: player.hitterSb?.toString() || "",
                walks: player.hitterBb?.toString() || "",
                strikeouts: player.hitterKk?.toString() || "",
                onBaseRate: onBaseRate.toFixed(3) || "",
                sluggingPct: sluggingPct.toFixed(3) || "",
                ops: ops
            };
        });console.log(`API에서 ${formattedData.length}개의 타자 데이터를 가져왔습니다.`);
        return formattedData;

    } catch (error) {
        console.error(`KBO ${year}년 타자 순위 API 호출 오류:`, error);
        
        // API 실패 시 빈 배열 반환
        return [];
    }
}



// KBO 라인업 가져오는 함수
async function getKBOLineup(gameId: string, returnHtml: boolean = false) {
    try {
        const url = `https://api-gw.sports.naver.com/schedule/games/${gameId}/preview`;
        
        // returnHtml 파라미터는 하위 호환성을 위해 남겨둠 (본 함수에서는 무시됨)
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });
        const data = response.data;
        
        if (!data || !data.success || !data.result || !data.result.previewData) {
            return { lineupData: [], html: "" };
        }
        
        const previewData = data.result.previewData;
        const gameInfo = previewData.gameInfo;
        const awayLineup = previewData.awayTeamLineUp?.fullLineUp || [];
        const homeLineup = previewData.homeTeamLineUp?.fullLineUp || [];
        
        const lineupData = [];
        
        // 원정팀 처리
        if (awayLineup.length > 0) {
            const players = awayLineup.map((player: any) => {
                if (player.positionName === "선발투수") {
                    return `[선발] ${player.playerName} (${player.positionName})`;
                }
                return `${player.batorder ? player.batorder + '. ' : ''}${player.playerName} (${player.positionName})`;
            });
            lineupData.push({ teamName: gameInfo.aName, players });
        }
        
        // 홈팀 처리
        if (homeLineup.length > 0) {
            const players = homeLineup.map((player: any) => {
                if (player.positionName === "선발투수") {
                    return `[선발] ${player.playerName} (${player.positionName})`;
                }
                return `${player.batorder ? player.batorder + '. ' : ''}${player.playerName} (${player.positionName})`;
            });
            lineupData.push({ teamName: gameInfo.hName, players });
        }
        
        return {
            lineupData: lineupData,
            html: ""
        };
        
    } catch (error) {
        console.error("KBO 라인업 API 호출 오류:", error);
        return {
            lineupData: [],
            html: ""
        };
    }
}
// 게임 목록을 임베드에 표시하는 헬퍼 함수 추가 (코드 중복 방지)
function displayGamesInEmbed(games: any[], embed: EmbedBuilder) {
    games.forEach((game: any) => {
        const homeTeam = {
            name: game.homeTeamName,
            score: game.homeTeamScore,
            emblemUrl: game.homeTeamEmblemUrl
        };
        const awayTeam = {
            name: game.awayTeamName,
            score: game.awayTeamScore,
            emblemUrl: game.awayTeamEmblemUrl
        };
        
        // 시간 포맷팅
        const startTimeStr = game.gameDateTime || "";
        const startTime = startTimeStr ? new Date(startTimeStr) : null;
        const formattedTime = startTime ? 
            `${startTime.getHours().toString().padStart(2, '0')}:${startTime.getMinutes().toString().padStart(2, '0')}` : 
            "시간 미정";
        
        // 상태 및 점수 처리
        let status = "경기 예정";
        let scoreText = "";
        
        if (game.cancel) {
            status = "경기 취소";
        } else if (game.statusCode) {
            switch (game.statusCode) {
                case "BEFORE":
                    status = "경기 예정";
                    break;
                case "STARTED":
                    status = game.statusInfo || "경기 중";
                    break;
                case "RESULT":
                    status = "경기 종료";
                    break;
                default:
                    status = game.statusInfo || "상태 정보 없음";
                    break;
            }
        }
        
        // 점수 표시 조건
        if (!game.cancel && (game.statusCode === "STARTED" || game.statusCode === "RESULT") && homeTeam.score !== undefined && awayTeam.score !== undefined) {
            scoreText = `${awayTeam.score} : ${homeTeam.score}`;
        }
        
        let teamDisplay = `**${awayTeam.name || '팀 정보 없음'}** vs **${homeTeam.name || '팀 정보 없음'}**`;
        if (status === "경기 종료" && homeTeam.score !== undefined && awayTeam.score !== undefined) {
            const homeScore = parseInt(homeTeam.score);
            const awayScore = parseInt(awayTeam.score);
            if (homeScore > awayScore) {
                teamDisplay = `**${awayTeam.name}** (패) vs **${homeTeam.name}** (승)`;
            } else if (awayScore > homeScore) {
                teamDisplay = `**${awayTeam.name}** (승) vs **${homeTeam.name}** (패)`;
            } else {
                teamDisplay = `**${awayTeam.name}** vs **${homeTeam.name}** (무)`;
            }
        }

        // 선발투수 정보 추가
        let starterInfo = "";
        if (game.homeStarterName && game.awayStarterName) {
            starterInfo = `\n선발:${game.awayStarterName} vs ${game.homeStarterName}`;
        }

        embed.addFields({
            name: `🏟️ ${formattedTime} | ${game.stadium || '장소 미정'}`,
            value: `${teamDisplay}\n${status}${scoreText ? ` ${scoreText}` : ''}${starterInfo}${(status !== "경기 종료" && status !== "경기 취소" && game.broadChannel) ? `\n📺 중계 채널: ${game.broadChannel.replace(/\^/g, ', ')}` : ''}\n-# 경기 ID: ${game.gameId ? `\`${game.gameId}\`` : '경기 ID 없음'}`,
            inline: false
        });
    });
}

// 실시간 중계 정보를 보여주는 함수
async function showLiveGameInfo(interaction: ChatInputCommandInteraction, gameId: string) {
    // 경기 기본 정보 가져오기
    const today = new Date();
    const formattedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    
    const scheduleUrl = `https://api-gw.sports.naver.com/schedule/games?fields=basic%2Cschedule%2Cbaseball&upperCategoryId=kbaseball&fromDate=${formattedDate}&toDate=${formattedDate}&size=500`;
    const scheduleResponse = await axios.get(scheduleUrl);
    const games = (scheduleResponse.data as any)?.result?.games || [];
    
    // 해당 경기 정보 찾기
    const targetGame = games.find((game: any) => game.gameId === gameId);
    
    if (!targetGame) {
        return interaction.editReply(`ID: ${gameId}에 해당하는 경기 정보를 찾을 수 없습니다.`);
    }
    
    // 경기 상태 확인
    if (targetGame.cancel) {
        return interaction.editReply(`이 경기는 취소되었습니다. 사유: ${targetGame.cancelReason || '사유 미상'}`);
    }
    
    if (targetGame.statusCode !== "STARTED" && targetGame.statusCode !== "RESULT") {
        return interaction.editReply(`이 경기는 아직 시작되지 않았습니다. 시작 예정 시간: ${targetGame.gameDateTime.substring(11, 16)}`);
    }
    
    // KBO 알림 서비스 인스턴스 가져오기
    const kboNotificationService = KboNotificationService.getInstance(interaction.client);
    
    // 실시간 경기 정보 가져오기
    const liveData = await kboNotificationService.getGameLiveData(gameId);
    if (!liveData) {
        return interaction.editReply('현재 경기 정보를 가져올 수 없습니다.');
    }
    
    const homeTeamName = targetGame.homeTeamName;
    const awayTeamName = targetGame.awayTeamName;
    
    // 경기 정보 임베드 생성
    const liveEmbed = kboNotificationService.createLiveGameEmbed(liveData, homeTeamName, awayTeamName);
    
    // 수동 새로고침 버튼 추가
    const refreshButton = new ButtonBuilder()
        .setCustomId(`refresh_${gameId}`)
        .setLabel('새로고침')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🔄');
    
    // DM 중계 버튼 추가
    const dmRelayButton = new ButtonBuilder()
        .setCustomId(`dmrelay_${gameId}`)
        .setLabel('DM 중계 시작')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📱');
    
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(refreshButton, dmRelayButton);
    
    const response = await interaction.editReply({
        embeds: [liveEmbed],
        components: [row]
    });
    
    // 버튼 클릭 이벤트 리스너 (2분 동안 유효)
    const collector = response.createMessageComponentCollector({ 
        componentType: ComponentType.Button,
        time: 2 * 60 * 1000 // 2분
    });
    
    collector.on('collect', async buttonInteraction => {
        if (buttonInteraction.customId === `refresh_${gameId}`) {
            await buttonInteraction.deferUpdate();
            
            // 실시간 경기 정보 다시 가져오기
            const refreshedLiveData = await kboNotificationService.getGameLiveData(gameId);
            if (!refreshedLiveData) {
                await buttonInteraction.followUp({ 
                    content: '현재 경기 정보를 가져올 수 없습니다.',
                    ephemeral: true
                });
                return;
            }
            
            // 업데이트된 경기 정보 임베드 생성
            const refreshedEmbed = createEnhancedLiveGameEmbed(refreshedLiveData, homeTeamName, awayTeamName, targetGame);
            
            // 임베드 업데이트
            await interaction.editReply({
                embeds: [refreshedEmbed],
                components: [row]
            });
            
            // 새로고침 알림
            await buttonInteraction.followUp({ 
                content: '✅ 경기 정보가 새로고침 되었습니다.',
                ephemeral: true
            });
        } else if (buttonInteraction.customId === `dmrelay_${gameId}`) {
            // 이미 진행 중인 중계가 있는지 확인 (수정된 부분)
            if (isUserReceivingLiveRelay(buttonInteraction.user.id)) {
                await buttonInteraction.reply({
                    content: "❌ **이미 실시간 중계를 받고 계십니다.**\n현재 중계를 종료하려면 `/kbo dm중계 경기id:종료종료` 명령어를 사용해주세요.",
                    ephemeral: true
                });
                return;
            }
            
            await buttonInteraction.deferReply({ ephemeral: true });
            
            // DM 중계 시작
            await startDmLiveRelay(buttonInteraction as any, gameId);
        }
    });
    
    collector.on('end', () => {
        // 시간이 지나면 버튼 비활성화
        const disabledRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                refreshButton.setDisabled(true).setLabel('새로고침 (만료됨)'),
                dmRelayButton.setDisabled(true).setLabel('DM 중계 (만료됨)')
            );
        
        interaction.editReply({
            components: [disabledRow]
        }).catch(() => console.log('버튼 비활성화 실패'));
    });
}

// DM 실시간 중계를 시작하는 함수
async function startDmLiveRelay(interaction: any, gameId: string) {
    try {
        // 경기 기본 정보 가져오기
        const today = new Date();
        const formattedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        
        const scheduleUrl = `https://api-gw.sports.naver.com/schedule/games?fields=basic%2Cschedule%2Cbaseball&upperCategoryId=kbaseball&fromDate=${formattedDate}&toDate=${formattedDate}&size=500`;
        const scheduleResponse = await axios.get(scheduleUrl);
        const games = (scheduleResponse.data as any)?.result?.games || [];
        
        // 해당 경기 정보 찾기
        const targetGame = games.find((game: any) => game.gameId === gameId);
        
        if (!targetGame) {
            return interaction.editReply(`ID: ${gameId}에 해당하는 경기 정보를 찾을 수 없습니다.`);
        }
        
        // 경기 상태 확인
        if (targetGame.cancel) {
            return interaction.editReply(`이 경기는 취소되었습니다. 사유: ${targetGame.cancelReason || '사유 미상'}`);
        }
        
        // 경기가 종료되었는지 확인 - 명확하게 체크
        const isGameEnded = targetGame.statusCode === "RESULT" || targetGame.statusCode === "ENDED"; 
        if (isGameEnded) {
            return interaction.editReply(`이 경기는 이미 종료되었습니다. 결과: ${targetGame.homeTeamName} ${targetGame.homeTeamScore} : ${targetGame.awayTeamScore} ${targetGame.awayTeamName}`);
        }
        
        if (targetGame.statusCode !== "STARTED" && !isGameEnded) {
            return interaction.editReply(`이 경기는 아직 시작되지 않았습니다. 시작 예정 시간: ${targetGame.gameDateTime.substring(11, 16)}`);
        }
        
        // KBO 알림 서비스 인스턴스 가져오기
        const kboNotificationService = KboNotificationService.getInstance(interaction.client);
        
        // 실시간 경기 정보 가져오기
        const liveData = await kboNotificationService.getGameLiveData(gameId);
        if (!liveData) {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.reply({ content: '현재 경기 정보를 가져올 수 없습니다.', ephemeral: true });
            }
            return;
        }
        
        const homeTeamName = targetGame.homeTeamName;
        const awayTeamName = targetGame.awayTeamName;
        
        // 중계 종료 버튼 생성
        const stopButton = new ButtonBuilder()
            .setCustomId(`stop_dmrelay_${interaction.user.id}`)
            .setLabel('DM 중계 종료')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('⏹️');
        
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(stopButton);
        
        // DM으로 첫 메시지 전송
        try {
            // 경기 정보 임베드 생성 - 디버그 로그 추가
            console.log(`${gameId} 경기 DM 중계 시작: 데이터 확인`);
            
            // 경기 정보 임베드 생성 - 향상된 임베드 함수 사용
            const liveEmbed = createEnhancedLiveGameEmbed(liveData, homeTeamName, awayTeamName, targetGame);
            
            // DM 보내기
            const dmMessage = await interaction.user.send({ 
                content: `⚾ **${homeTeamName} vs ${awayTeamName}** 실시간 중계가 시작되었습니다.\n메시지는 10초마다 자동으로 업데이트됩니다.`, 
                embeds: [liveEmbed],
                components: [row]
            });
            
            // 첫 상태의 해시값 생성 (상태 변경 감지용)
            const initialStateHash = createStateHash(liveData);
            
            // 10초마다 업데이트하는 인터벌 설정
            const intervalId = setInterval(async () => {
                try {
                    // 경기 정보 갱신
                    const updatedLiveData = await kboNotificationService.getGameLiveData(gameId);
                    if (!updatedLiveData) {
                        console.log(`${gameId} 경기 정보를 가져올 수 없음`);
                        return;
                    }
                    
                    // 변경 사항이 있는지 확인
                    const newStateHash = createStateHash(updatedLiveData);
                    const relayData = activeDmRelay.get(interaction.user.id);
                    
                    if (relayData && relayData.lastStateHash !== newStateHash) {
                        
                        // 경기 정보 임베드 갱신 - 향상된 임베드 생성 함수 확실히 사용
                        const updatedEmbed = createEnhancedLiveGameEmbed(updatedLiveData, homeTeamName, awayTeamName, targetGame);
                        
                        // 메시지 수정으로 DM 업데이트 (새 메시지 전송 대신)
                        await dmMessage.edit({
                            content: `⚾ **${homeTeamName} vs ${awayTeamName}** 실시간 중계 \n(${new Date().toLocaleTimeString()} 업데이트)`,
                            embeds: [updatedEmbed],
                            components: [row]
                        });
                        
                        // 경기가 종료된 경우 상태 변수 업데이트
                        const isNowEnded = updatedLiveData.statusCode === "RESULT" || updatedLiveData.statusCode === "CANCEL" || updatedLiveData.statusCode === "ENDED";
                        
                        // 상태 업데이트
                        activeDmRelay.set(interaction.user.id, {
                            gameId,
                            intervalId,
                            lastStateHash: newStateHash,
                            messageId: dmMessage.id,
                            isGameEnded: isNowEnded
                        });
                    }
                    
                    // 경기가 종료된 경우 중계 중단
                    if (updatedLiveData.statusCode === "RESULT" || updatedLiveData.statusCode === "CANCEL" || updatedLiveData.statusCode === "ENDED") {
                        console.log(`${gameId} 경기가 종료되어 DM 중계 종료`);
                        
                        // 종료 메시지 만들기
                        let endMessage = `⚾ **${homeTeamName} vs ${awayTeamName}** 경기가 종료되어 실시간 중계를 마칩니다.`;
                        
                        // 점수 정보 추가
                        const gameState = updatedLiveData.textRelayData?.currentGameState || {};
                        if (gameState.homeScore !== undefined && gameState.awayScore !== undefined) {
                            endMessage += `\n최종 점수: ${awayTeamName} ${gameState.awayScore} : ${gameState.homeScore} ${homeTeamName}`;
                        }
                        
                        await dmMessage.edit({
                            content: endMessage,
                            components: []
                        });
                        
                        // 중계 종료 처리
                        stopDmLiveRelay(interaction.user.id);
                    }
                    // ...existing code...
                    if (updatedLiveData.textRelayData?.textRelays) {
                        const recentPlay = updatedLiveData.textRelayData.textRelays[0]?.textOptions?.[0]?.text || "";
                        if (recentPlay.includes("승리투수")) {
                            console.log(`${gameId} 경기 종료 메시지 감지: ${recentPlay}`);
                            
                            // 종료 메시지 만들기
                            let endMessage = `⚾ **${homeTeamName} vs ${awayTeamName}** 경기가 종료되었습니다.\n${recentPlay}`;
                            
                            // 점수 정보 추가
                            const gameState = updatedLiveData.textRelayData?.currentGameState || {};
                            if (gameState.homeScore !== undefined && gameState.awayScore !== undefined) {
                                endMessage += `\n최종 점수: ${awayTeamName} ${gameState.awayScore} : ${gameState.homeScore} ${homeTeamName}`;
                            }
                            
                            await dmMessage.edit({
                                content: endMessage,
                                components: []
                            });
                            
                            // 중계 종료 처리
                            stopDmLiveRelay(interaction.user.id);
                            return;
                        }
                    }
                    // ...existing code...
                } catch (error) {
                    console.error(`DM 중계 업데이트 중 오류:`, error);
                }
            }, 10000); // 10초마다
            
            // 활성 DM 중계 맵에 저장
            activeDmRelay.set(interaction.user.id, {
                gameId,
                intervalId,
                lastStateHash: initialStateHash,
                messageId: dmMessage.id,
                isGameEnded: false
            });
            
            // 버튼 클릭 이벤트 리스너
            const collector = dmMessage.createMessageComponentCollector({ 
                componentType: ComponentType.Button,
                time: 3 * 60 * 60 * 1000 // 3시간 동안 유효 (경기 최대 시간 고려)
            });
            
            collector.on('collect', async buttonInteraction => {
                if (buttonInteraction.customId === `stop_dmrelay_${interaction.user.id}`) {
                    stopDmLiveRelay(interaction.user.id);
                    await buttonInteraction.update({
                        content: `⚾ **${homeTeamName} vs ${awayTeamName}** 실시간 DM 중계가 종료되었습니다.`,
                        components: []
                    });
                }
            });
            
            // 서버 응답
            return interaction.editReply(`✅ **${homeTeamName} vs ${awayTeamName}** 경기의 실시간 중계 DM이 시작되었습니다. DM을 확인해주세요.`);
        } catch (error) {
            console.error("DM 전송 실패:", error);
            // 더 자세한 에러 로깅
            if (error instanceof Error) {
                console.error("에러 상세 정보:", error.message, error.stack);
            }
            if (!interaction.deferred && !interaction.replied) {
                await interaction.reply("DM을 보낼 수 없습니다. 개인 메시지 설정을 확인해주세요.");
            } else {
                await interaction.editReply("DM을 보낼 수 없습니다. 개인 메시지 설정을 확인해주세요.");
            }
            return;
        }
    } catch (error) {
        console.error("DM 실시간 중계 시작 오류:", error);
        if (!interaction.deferred && !interaction.replied) {
            await interaction.reply("DM 실시간 중계를 시작하는 중 오류가 발생했습니다.");
        } else {
            await interaction.editReply("DM 실시간 중계를 시작하는 중 오류가 발생했습니다.");
        }
    }
}

// 향상된 실시간 게임 임베드 생성 함수
function createEnhancedLiveGameEmbed(liveData: any, homeTeamName: string, opponentTeamName: string, gameInfo: any): EmbedBuilder {
    // 디버그: 데이터 구조 확인을 위한 로깅
    
    // 기본 임베드 설정
    const embed = new EmbedBuilder()
        .setTitle(`⚾ ${homeTeamName} vs ${opponentTeamName} 실시간 중계`)
        .setColor(0x1E90FF) // 기본 파란색
        .setTimestamp();

    if (!liveData.textRelayData) {
        embed.setDescription('현재 실시간 중계 정보가 없습니다.');
        return embed;
    }

    // 경기 상태 정보
    const gameState = liveData.textRelayData.currentGameState || {};
    const inning = liveData.textRelayData.inn || '0';
    const isAwayTeam = liveData.textRelayData.homeOrAway === "0"; // 명확한 비교로 수정
    
    // 스코어 정보
    const homeScore = gameState.homeScore || 0;
    const awayScore = gameState.awayScore || 0;
    
    // 볼카운트, 아웃카운트 정보
    const strikes = gameState.strike || 0;
    const balls = gameState.ball || 0;
    const outs = gameState.out || 0;
    
    // 주자 정보 수정 - "0"이 아닌 모든 값을 주자가 있는 것으로 간주
    const base1 = gameState.base1 && gameState.base1 !== "0" ? "🟡" : "⚪";
    const base2 = gameState.base2 && gameState.base2 !== "0" ? "🟡" : "⚪";
    const base3 = gameState.base3 && gameState.base3 !== "0" ? "🟡" : "⚪";

    // 현재 타자 및 투수 정보 가져오기
    let currentBatter = "정보 없음";
    let currentPitcher = "정보 없음";
    let currentCount = "";
    
    // 현재 타자 정보
    if (gameState.batter) {
        const batterLineup = isAwayTeam 
            ? liveData.textRelayData.awayLineup?.batter 
            : liveData.textRelayData.homeLineup?.batter;
            
        if (batterLineup) {
            const batter = batterLineup.find((b: any) => b.pcode === gameState.batter);
            if (batter) {
                currentBatter = `${batter.name} (${batter.posName})`;
            }
        }
    }
    
    // 현재 투수 정보 (투구수 표시 제거)
    if (gameState.pitcher) {
        const pitcherLineup = isAwayTeam 
            ? liveData.textRelayData.homeLineup?.pitcher 
            : liveData.textRelayData.awayLineup?.pitcher;
            
        if (pitcherLineup) {
            const pitcher = pitcherLineup.find((p: any) => p.pcode === gameState.pitcher);
            if (pitcher) {
                // 투구수 표시 제거하고 이름만 표시
                currentPitcher = pitcher.name;
            }
        }
    }

    // 볼카운트 정보 구성
    currentCount = `\`${balls}\`B-\`${strikes}\`S-\`${outs}\`O`;

    // 최근 플레이 정보 가져오기
    let recentPlays = "플레이 정보 없음";
    if (liveData.textRelayData.textRelays && 
        Array.isArray(liveData.textRelayData.textRelays) && 
        liveData.textRelayData.textRelays.length > 0) {
        
        const textOptions = liveData.textRelayData.textRelays[0].textOptions;
        if (textOptions && textOptions.length > 0) {
            // 가장 최근 3개 플레이만 표시
            recentPlays = textOptions
              .slice(-3)
              .map((option: any) => option.text)
              .join('\n');
        }
    }

    // 임베드에 정보 추가
    embed.setDescription(`${inning}회${isAwayTeam ? '초' : '말'} (${isAwayTeam ? opponentTeamName : homeTeamName} 공격) 진행 중`)
      .addFields(
        { name: '스코어', value: isAwayTeam 
                            ? `${opponentTeamName} ${awayScore} : ${homeScore} ${homeTeamName}` 
                            : `${homeTeamName} ${homeScore} : ${awayScore} ${opponentTeamName}`, 
          inline: false 
        },
        { name: '카운트', value: `${currentCount}`, inline: true },
        { name: '베이스 상황', value: `1루: ${base1} 2루: ${base2} 3루: ${base3}`, inline: true  }
      );

    // 현재 투수와 타자 정보 추가
    embed.addFields(
        { name: '현재 투수', value: currentPitcher, inline: true },
        { name: '현재 타자', value: currentBatter, inline: true }
    );
    
    // 최근 플레이 정보 추가 (최근 투구 정보는 제거)
    embed.addFields({ name: '최근 플레이', value: recentPlays, inline: false });
      
    return embed;
}

// 투구 타입을 한글로 변환하는 함수
function translatePitchType(pitchType: string): string {
    const pitchTypes: { [key: string]: string } = {
        "FASTBALL": "직구",
        "FF": "포심 패스트볼",
        "FT": "투심 패스트볼",
        "FC": "커터 패스트볼",
        "SI": "싱커",
        "SLIDER": "슬라이더",
        "SL": "슬라이더",
        "CURVE": "커브",
        "CU": "커브",
        "CHANGE_UP": "체인지업",
        "CH": "체인지업",
        "SPLITTER": "스플리터",
        "FS": "스플리터",
        "FORKBALL": "포크볼",
        "FO": "포크볼",
        "KNUCKLE": "너클볼",
        "KN": "너클볼",
        "KNUCKLE_CURVE": "너클 커브",
        "KC": "너클 커브",
        "SINKER": "싱커",
        "CUTTER": "커터",
        "SLIDER_CURVE": "슬라이더 커브",
        "SCREWBALL": "스크루볼",
        "PALM BALL": "팜볼",
        "SUBMARINE": "잠수함",
        "TWO_SEAMER": "투심 패스트볼",
        "FOUR_SEAMER": "포심 패스트볼"
    };
    
    return pitchTypes[pitchType] || pitchType || "알 수 없음";
}

// 투구 결과를 한글로 변환하는 함수
function translatePitchResult(pitchResult: string): string {
    const pitchResults: { [key: string]: string } = {
        "STRIKE": "스트라이크",
        "BALL": "볼",
        "FOUL": "파울",
        "HIT": "안타",
        "HOMERUN": "홈런",
        "OUT": "아웃",
        "DOUBLE_PLAY": "병살타",
        "FIELDERS_CHOICE": "야수 선택",
        "SACRIFICE": "희생번트",
        "SACRIFICE_FLY": "희생플라이",
        "HIT_BY_PITCH": "몸에 맞는 볼",
        "ERROR": "실책",
        "BALK": "보크",
        "WILD_PITCH": "폭투",
        "PASSED_BALL": "패스트볼",
        "INTERFERENCE": "방해",
        "S": "스트라이크",
        "B": "볼",
        "F": "파울",
        "X": "아웃",
        "H": "안타",
        "E": "실책"
    };
    
    return pitchResults[pitchResult] || pitchResult || "결과 없음";
}

// 경기 상태의 해시값을 생성하는 함수 (상태 변경 감지용)
function createStateHash(liveData: any): string {
    if (!liveData || !liveData.textRelayData) return 'no-data';
    
    const gameState = liveData.textRelayData.currentGameState || {};
    const inning = liveData.textRelayData.inn || '0';
    const isAwayTeam = liveData.textRelayData.homeOrAway || '0';
    
    // 중요한 정보만 추출하여 해시 생성
    const key = `${inning}-${isAwayTeam}-${gameState.homeScore || 0}-${gameState.awayScore || 0}-${gameState.strike || 0}-${gameState.ball || 0}-${gameState.out || 0}-${gameState.base1 || 0}-${gameState.base2 || 0}-${gameState.base3 || 0}-${gameState.batter || ''}-${gameState.pitcher || ''}`;
    
    // 마지막 투구 정보도 포함해서 더 세밀한 업데이트 트리거링
    let pitchInfo = "";
    if (liveData.textRelayData.pitchResults && 
        Array.isArray(liveData.textRelayData.pitchResults) && 
        liveData.textRelayData.pitchResults.length > 0) {
        const lastPitch = liveData.textRelayData.pitchResults[0];
        if (lastPitch) {
            // 투구 번호, 유형, 속도, 결과를 모두 포함 - 유연한 필드명 처리
            const pitchType = lastPitch.stuff || lastPitch.pitchType || "";
            const pitchSpeed = lastPitch.speed || lastPitch.pitchSpeed || "";
            pitchInfo = `-${lastPitch.pitchNum || ""}-${pitchType}-${pitchSpeed}-${lastPitch.pitchResult || ""}`;
        }
    }
    
    // 텍스트 릴레이 데이터가 있으면 가장 최근 것 추가 - 철저한 null 체크
    try {
        if (liveData.textRelayData.textRelays && 
            Array.isArray(liveData.textRelayData.textRelays) && 
            liveData.textRelayData.textRelays.length > 0) {
            
            const firstRelay = liveData.textRelayData.textRelays[0];
            
            // textOptions가 배열인지 확인
            if (firstRelay && 
                firstRelay.textOptions && 
                Array.isArray(firstRelay.textOptions) && 
                firstRelay.textOptions.length > 0) {
                
                // 마지막 텍스트 옵션 가져오기
                const latestText = firstRelay.textOptions[firstRelay.textOptions.length - 1];
                if (latestText && latestText.text) {
                    return key + pitchInfo + '-' + latestText.text;
                }
            }
        }
    } catch (error) {
        console.error('텍스트 릴레이 데이터 처리 중 오류:', error);
    }
    
    return key + pitchInfo;
}

// DM 중계를 중지하는 함수
function stopDmLiveRelay(userId: string) {
    const relayData = activeDmRelay.get(userId);
    if (relayData) {
        clearInterval(relayData.intervalId);
        activeDmRelay.delete(userId);
        console.log(`사용자 ${userId}의 DM 중계가 종료되었습니다.`);
    }
}

// KBO 알림 서비스 확장 - 경기 시작 알림에 실시간 중계 버튼 추가
const originalKboNotificationService = KboNotificationService.getInstance;
KboNotificationService.getInstance = function(client: Client) {
    const service = originalKboNotificationService.call(this, client);
    
    // 원래 sendGameStartingNotification 함수 보존
    const originalSendGameStartingNotification = service.sendGameStartingNotification;
    
    // 함수 재정의 - 실시간 중계 버튼 추가
    service.sendGameStartingNotification = async function(userId: string, gameInfo: any) {
        try {
            const user = await client.users.fetch(userId);
            if (!user) return false;
            
            // 임베드 생성
            const embed = new EmbedBuilder()
                .setColor(getTeamColor(gameInfo.teamCode))
                .setTitle(`⚾ ${gameInfo.teamName} 경기 시작 알림`)
                .setDescription(`${gameInfo.teamName} vs ${gameInfo.opponentName} 경기가 곧 시작됩니다.`)
                .addFields(
                    { name: '경기 정보', value: `🏟️ ${gameInfo.stadium}\n⏰ ${gameInfo.startTime}\n📺 ${gameInfo.broadcast || '중계 정보 없음'}`, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: `KBO 알림 서비스` });
                
            // 실시간 중계 버튼 추가
            const liveButton = new ButtonBuilder()
                .setCustomId(`live_${gameInfo.gameId}`)
                .setLabel('실시간 중계 보기')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('📊');
                
            const dmRelayButton = new ButtonBuilder()
                .setCustomId(`dmrelay_${gameInfo.gameId}`)
                .setLabel('DM 실시간 중계 시작')
                .setStyle(ButtonStyle.Success)
                .setEmoji('📱');
                
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(liveButton, dmRelayButton);
            
            // DM 전송
            const message = await user.send({ embeds: [embed], components: [row] });
            
            // 버튼 클릭 이벤트 리스너
            const collector = message.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 3 * 60 * 60 * 1000 // 3시간 유효
            });
            
            collector.on('collect', async buttonInteraction => {
                if (buttonInteraction.customId === `live_${gameInfo.gameId}`) {
                    // 이미 진행 중인 중계가 있는지 확인 (추가된 부분)
                    if (isUserReceivingLiveRelay(buttonInteraction.user.id)) {
                        await buttonInteraction.reply({
                            content: "❌ **이미 실시간 중계를 받고 계십니다.**\n다른 실시간 중계를 시작하려면 먼저 진행 중인 중계를 종료해주세요.",
                            ephemeral: true
                        });
                        return;
                    }
                    
                    // 실시간 중계 정보 가져오기
                    const liveData = await this.getGameLiveData(gameInfo.gameId);
                    if (!liveData) {
                        await buttonInteraction.reply({
                            content: '현재 경기 정보를 가져올 수 없습니다.',
                            ephemeral: true
                        });
                        return;
                    }
                    
                    // 실시간 중계 임베드 생성
                    const liveEmbed = createEnhancedLiveGameEmbed(liveData, gameInfo.teamName, gameInfo.opponentName, gameInfo);
                    
                    // 새로고침 버튼
                    const refreshButton = new ButtonBuilder()
                        .setCustomId(`refresh_${gameInfo.gameId}`)
                        .setLabel('새로고침')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('🔄');
                        
                    const liveRow = new ActionRowBuilder<ButtonBuilder>().addComponents(refreshButton);
                    
                    // 답장으로 실시간 중계 정보 전송
                    await buttonInteraction.reply({ 
                        content: `⚾ ${gameInfo.teamName} vs ${gameInfo.opponentName} 실시간 중계 정보`,
                        embeds: [liveEmbed],
                        components: [liveRow]
                    });
                } else if (buttonInteraction.customId === `dmrelay_${gameInfo.gameId}`) {
                    // 이미 진행 중인 DM 중계가 있는지 확인
                    if (isUserReceivingLiveRelay(buttonInteraction.user.id)) {
                        await buttonInteraction.reply({
                            content: "❌ **이미 실시간 중계를 받고 계십니다.**\n현재 중계를 종료하려면 `/kbo dm중계 경기id:종료종료` 명령어를 사용해주세요.",
                            ephemeral: true
                        });
                        return;
                    }
                    
                    await buttonInteraction.deferReply({ ephemeral: true });
                    
                    // DM 중계 시작
                    await startDmLiveRelay(buttonInteraction as any, gameInfo.gameId);
                } else if (buttonInteraction.customId === `refresh_${gameInfo.gameId}`) {
                    await buttonInteraction.deferUpdate();
                    
                    // 실시간 경기 정보 다시 가져오기
                    const refreshedLiveData = await this.getGameLiveData(gameInfo.gameId);
                    if (!refreshedLiveData) {
                        await buttonInteraction.followUp({ 
                            content: '현재 경기 정보를 가져올 수 없습니다.',
                            ephemeral: true
                        });
                        return;
                    }
                    
                    // 업데이트된 경기 정보 임베드 생성
                    const refreshedEmbed = createEnhancedLiveGameEmbed(refreshedLiveData, gameInfo.teamName, gameInfo.opponentName, gameInfo);
                    
                    // 원래 메시지 찾기
                    const originalMessage = await buttonInteraction.fetchReply();
                    
                    // 임베드 업데이트
                    await originalMessage.edit({
                        embeds: [refreshedEmbed],
                        components: [buttonInteraction.message.components[0]]
                    });
                    
                    // 새로고침 알림
                    await buttonInteraction.followUp({ 
                        content: '✅ 경기 정보가 새로고침 되었습니다.',
                        ephemeral: true
                    });
                }
            });
            
            return true;
        } catch (error) {
            console.error('경기 시작 알림 전송 실패:', error);
            return false;
        }
    };
    
    return service;
};


// 경기 결과를 한국어로 변환하는 함수 (W=승, L=패, D=무)
function convertGameResultToKorean(gameResults: string): string {
    if (!gameResults) return "";
    
    return gameResults
        .replace(/W/g, "승")
        .replace(/L/g, "패")
        .replace(/D/g, "무");
}