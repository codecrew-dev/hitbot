import { Client, EmbedBuilder, User, ButtonBuilder, ActionRowBuilder, ButtonStyle, ComponentType, TextChannel } from 'discord.js';
import axios from 'axios';
import * as MongoDB from '../utils/Mongodb';
import { Scheduler } from '../utils/scheduler';

/**
 * KBO 알림 서비스 클래스
 * 사용자가 설정한 팀의 경기 정보 및 라인업 알림을 관리합니다
 */
export class KboNotificationService {
  private client: Client;
  private static instance: KboNotificationService;
  private isInitialized: boolean = false;
  private isRecoveryComplete: boolean = false; // 리부트 후 복구가 완료되었는지 여부
  // 실시간 중계 상태 추적을 위한 맵
  private liveRelaySubscriptions: Map<string, {
    userId: string,
    gameId: string,
    messageId: string,
    intervalId: NodeJS.Timeout,
    lastUpdate: Date,
    startTime: Date // 중계 시작 시간 추가
  }> = new Map();

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * 싱글톤 인스턴스를 반환합니다
   */
  static getInstance(client: Client): KboNotificationService {
    if (!KboNotificationService.instance) {
      KboNotificationService.instance = new KboNotificationService(client);
    }
    return KboNotificationService.instance;
  }

  /**
   * 알림 서비스를 초기화합니다.
   * 매일 새벽에 그날의 경기 일정을 확인하고 스케줄링합니다.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    console.log('KBO 알림 서비스 초기화 중...');

    // 먼저 데이터베이스에서 이미 전송된 알림 복구
    await this.recoverNotificationState();

    // 매일 새벽 1시에 그날의 경기 일정을 확인하는 작업 등록
    Scheduler.scheduleJob('daily-kbo-schedule-check', '0 1 * * *', () => {
      this.checkTodayGames();
    });

    // 경기 상태를 5분마다 확인하는 스케줄 등록 (경기 취소, 종료 확인용)
    Scheduler.scheduleInterval('game-status-monitor', 5, () => {
      this.monitorGameStatuses();
    });
    
    // 중계 상태 검사 및 정리 - 모든 진행 중인 중계를 확인하고 경기 종료 여부 확인
    Scheduler.scheduleInterval('relay-status-check', 10, () => {
      this.checkAllActiveRelays();
    });

    // 서비스 시작 시 바로 한 번 실행
    await this.checkTodayGames();

    this.isInitialized = true;
    console.log('KBO 알림 서비스가 초기화되었습니다.');
  }

  /**
   * 리부트 후 알림 상태를 복구합니다
   */
  private async recoverNotificationState(): Promise<void> {
    console.log('알림 상태 복구 중...');
    try {
      // 오늘 이미 전송된 알림 히스토리 가져오기
      const todayNotifications = await MongoDB.NotificationHistory.getTodaysNotifications();
      console.log(`${todayNotifications.length}개의 알림 기록을 DB에서 복원했습니다.`);
      
      this.isRecoveryComplete = true;
    } catch (error) {
      console.error('알림 상태 복구 실패:', error);
    }
  }

  /**
   * 오늘의 KBO 경기 일정을 확인하고 알림을 예약합니다
   */
  async checkTodayGames(): Promise<void> {
    console.log('오늘의 KBO 경기 일정을 확인합니다.');
    
    try {
      const today = new Date();
      const formattedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      
      // API에서 경기 일정 가져오기
      const url = `https://api-gw.sports.naver.com/schedule/games?fields=basic%2Cschedule%2Cbaseball&upperCategoryId=kbaseball&fromDate=${formattedDate}&toDate=${formattedDate}&size=500`;
      const response = await axios.get(url);
      const games = (response.data as any)?.result?.games.filter((game: any) => game.categoryId === "kbo") || [];
      
      if (!games || games.length === 0) {
        console.log(`${formattedDate}에 예정된 KBO 경기가 없습니다.`);
        return;
      }
      
      console.log(`${games.length}개의 KBO 경기 일정을 처리합니다.`);
      
      for (const game of games) {
        const homeTeamCode = game.homeTeamCode;
        const awayTeamCode = game.awayTeamCode;
        
        if (!homeTeamCode || !awayTeamCode || game.cancel) continue;

        // 경기 취소 알림이 이미 발송되었는지 확인
        const isCanceled = await MongoDB.NotificationHistory.hasNotificationBeenSent(
          null, 
          game.gameId, 
          null, 
          'cancel'
        );
        if (isCanceled) {
          console.log(`${game.gameId} 경기는 취소된 것으로 확인되어 알림을 건너뜁니다.`);
          continue;
        }
        
        const gameDateTime = new Date(game.gameDateTime);
        if (isNaN(gameDateTime.getTime())) continue;

        const notificationTime = new Date(gameDateTime);
        const lineupCheckTime = new Date(gameDateTime.getTime() - 30 * 60 * 1000);

        if (notificationTime.getTime() > Date.now()) {
          this.scheduleGameNotification(game.gameId, homeTeamCode, awayTeamCode, notificationTime, game);
        }

        if (lineupCheckTime.getTime() > Date.now()) {
          const lineupJobName = `lineup-check-${game.gameId}`;
          console.log(`${game.gameId} 경기의 라인업 확인 예약: ${lineupCheckTime}`);
          Scheduler.scheduleOnce(lineupJobName, lineupCheckTime, () => {
            this.startLineupCheck(game.gameId, game);
          });
        } else if (gameDateTime.getTime() > Date.now()) {
          this.startLineupCheck(game.gameId, game);
        }
      }
    } catch (error) {
      console.error('KBO 경기 일정 확인 중 오류 발생:', error);
    }
  }

  /**
   * 특정 경기의 라인업 확인을 시작합니다
   * 경기 시작 전까지 5분마다 계속 확인합니다
   */
  private async startLineupCheck(gameId: string, initialGameInfo: any): Promise<void> {
    console.log(`${gameId} 경기의 라인업 확인을 시작합니다.`);
    
    // 라인업 확인 함수 정의
    const checkLineup = async () => {
      try {
        // 최신 경기 정보 가져오기 (시간 변경 여부 확인을 위함)
        const updatedGameInfo = await this.getUpdatedGameInfo(gameId);
        
        if (!updatedGameInfo) {
          console.log(`${gameId} 경기 정보를 가져올 수 없습니다.`);
          this.stopLineupCheck(gameId);
          return;
        }
        
        // 경기가 취소되었는지 확인
        if (updatedGameInfo.cancel) {
          console.log(`${gameId} 경기가 취소되었습니다.`);
          this.stopLineupCheck(gameId);
          return;
        }
        
        // 경기가 이미 시작되었는지 확인
        const currentTime = new Date();
        const updatedGameTime = new Date(updatedGameInfo.gameDateTime);
        
        if (updatedGameTime <= currentTime || updatedGameInfo.statusCode === "STARTED" || updatedGameInfo.statusCode === "RESULT") {
          console.log(`${gameId} 경기가 이미 시작되었거나 종료되었습니다.`);
          this.stopLineupCheck(gameId);
          return;
        }
        
        // 경기 시작까지 남은 시간 계산 (분)
        const minutesUntilGame = Math.round((updatedGameTime.getTime() - currentTime.getTime()) / (1000 * 60));
        console.log(`${gameId} 경기까지 약 ${minutesUntilGame}분 남았습니다. 라인업 확인 중...`);
        
        // 라인업 확인
        const result = await this.getKBOLineup(gameId);
        const lineupData = result.lineupData;
        
        // 완전한 라인업인지 확인
        const hasCompleteLineup = this.isCompleteLineup(lineupData);
        
        if (!hasCompleteLineup) {
          console.log(`${gameId} 경기의 라인업이 아직 완전하지 않습니다. 5분 후 다시 확인합니다.`);
          return; // 다음 스케줄된 실행에서 다시 확인
        }
        
        // 라인업이 완전히 발표된 경우, 해당 팀 팬들에게 알림
        const homeTeamCode = updatedGameInfo.homeTeamCode;
        const awayTeamCode = updatedGameInfo.awayTeamCode;
        
        if (homeTeamCode && lineupData[1]?.players?.length > 0) {
          await this.notifyTeamLineup(homeTeamCode, gameId, updatedGameInfo, lineupData[1], true);
        }
        
        if (awayTeamCode && lineupData[0]?.players?.length > 0) {
          await this.notifyTeamLineup(awayTeamCode, gameId, updatedGameInfo, lineupData[0], false);
        }
        
        console.log(`${gameId} 경기의 라인업 확인 및 알림 전송 완료. 라인업 확인 작업을 종료합니다.`);
        this.stopLineupCheck(gameId); // 라인업을 찾았으니 확인 작업 중지
        
      } catch (error) {
        console.error(`경기 ${gameId} 라인업 확인 중 오류:`, error);
        // 오류가 발생해도 계속 실행됨 (스케줄러에 의해)
      }
    };
    
    // 고유한 작업 이름 생성
    const jobName = `lineup-check-interval-${gameId}`;
    
    // 5분 간격으로 스케줄 작업 등록 (스케줄러 클래스 사용)
    Scheduler.scheduleJob(jobName, '*/5 * * * *', checkLineup);
    
    // 바로 한 번 실행
    checkLineup().catch(err => console.error(`초기 라인업 확인 실패 (${gameId}):`, err));
  }

  /**
   * 라인업 데이터가 완전한지 확인합니다
   * (최소 9명 이상의 타자와 선발투수가 모두 발표되었는지 확인)
   */
  private isCompleteLineup(lineupData: any[]): boolean {
    // 라인업 데이터가 없으면 불완전한 것으로 간주
    if (!lineupData || lineupData.length < 2) {
      return false;
    }
    
    // 양 팀 모두 확인
    for (const teamLineup of lineupData) {
      // 선수 목록이 없거나 충분하지 않은 경우
      if (!teamLineup.players || teamLineup.players.length < 9) {
        return false;
      }
      
      // 투수와 타자 포지션 패턴
      const pitcherPattern = /투수|선발|선발투수|우투|좌투/;
      const batterPatterns = [
        /포수/, /1루/, /2루/, /3루/, /유격/, 
        /좌익/, /중견/, /우익/, /지명타자/
      ];
      
      // 선발 투수 확인
      const hasPitcher = teamLineup.players.some((player: string) => {
        return pitcherPattern.test(player);
      });
      
      // 최소한의 타자 포지션 확인 (최소 8명의 타자가 필요)
      let batterPositionsFound = 0;
      for (const pattern of batterPatterns) {
        if (teamLineup.players.some((player: string) => pattern.test(player))) {
          batterPositionsFound++;
        }
      }
      
      // 투수가 없거나 타자 포지션이 5개 미만인 경우 불완전한 라인업으로 간주
      if (!hasPitcher || batterPositionsFound < 5) {
        return false;
      }
    }
    
    // 모든 검사를 통과하면 완전한 라인업으로 간주
    return true;
  }

  /**
   * 라인업 확인 작업을 중지합니다
   */
  private stopLineupCheck(gameId: string): void {
    const jobName = `lineup-check-interval-${gameId}`;
    Scheduler.cancelJob(jobName);
    console.log(`${gameId} 경기의 라인업 확인 작업을 중지했습니다.`);
  }

  /**
   * 특정 팀의 팬들에게 라인업 알림을 보냅니다
   */
  private async notifyTeamLineup(
    teamCode: string,
    gameId: string,
    gameInfo: any,
    lineupData: any,
    isHomeTeam: boolean
  ): Promise<void> {
    try {
      // 실제 라인업 데이터를 로깅하여 디버깅
      console.log(`${teamCode} 팀 라인업 데이터:`, JSON.stringify(lineupData.players));
      
      // 라인업 데이터가 존재하는지 확인 (최소 9명의 선수가 있어야 함)
      if (!lineupData.players || lineupData.players.length < 9) {
        console.log(`${teamCode} 팀의 ${gameId} 경기 라인업 데이터가 부족합니다. 발견된 선수: ${lineupData.players?.length || 0}명`);
        return;
      }
      
      // 팀의 팬들 가져오기
      const teamFans = await this.getTeamFans(teamCode);
      
      if (teamFans.length === 0) {
        console.log(`${teamCode} 팀의 팬이 없습니다.`);
        return;
      }
      
      console.log(`${teamCode} 팀의 ${teamFans.length}명의 팬들에게 라인업 알림을 보냅니다.`);
      
      // 상대팀 정보
      const opponentTeamCode = isHomeTeam ? gameInfo.awayTeamCode : gameInfo.homeTeamCode;
      const opponentTeamName = isHomeTeam ? gameInfo.awayTeamName : gameInfo.homeTeamName;
      const myTeamName = isHomeTeam ? gameInfo.homeTeamName : gameInfo.awayTeamName;
      
      // 경기 시간 포맷팅
      const gameDateTime = new Date(gameInfo.gameDateTime);
      const formattedTime = `${gameDateTime.getHours().toString().padStart(2, '0')}:${gameDateTime.getMinutes().toString().padStart(2, '0')}`;
      
      // 상대팀 라인업 데이터 가져오기
      const opponentLineupIndex = isHomeTeam ? 0 : 1; // 홈팀이면 0(원정팀), 원정팀이면 1(홈팀)
      const result = await this.getKBOLineup(gameId);
      const opponentLineupData = result.lineupData[opponentLineupIndex];
      
      // 각 팬에게 DM 보내기
      for (const fan of teamFans) {
        try {
          const userId = fan.user_id;
          
          // 이미 알림을 보냈는지 확인
          const alreadySent = await MongoDB.NotificationHistory.hasNotificationBeenSent(
            userId, 
            gameId, 
            teamCode, 
            'lineup'
          );
          
          if (alreadySent) {
            console.log(`사용자 ${userId}에게 ${teamCode} 팀 라인업 알림이 이미 전송되었습니다.`);
            continue;
          }
          
          try {
            const user = await this.client.users.fetch(userId);
            
            // 라인업 알림 임베드 생성
            const embed = new EmbedBuilder()
              .setColor(this.getTeamColor(teamCode))
              .setTitle(`⚾ ${myTeamName} 라인업 발표!`)
              .setDescription(`${gameInfo.stadium || '경기장 미정'} (${formattedTime})`)
              .setThumbnail('https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png')
              .addFields({
                name: `📋 ${myTeamName} vs ${opponentTeamName}`,
                value: lineupData.players.join('\n') || "라인업 정보 없음",
                inline: false
              })
              .setFooter({ text: `경기 ID: ${gameId}` })
              .setTimestamp();
            
            // 상대팀 라인업 보기 버튼 추가
            const opponentLineupButton = new ButtonBuilder()
              .setCustomId(`opponent_lineup_${gameId}_${opponentTeamCode}`)
              .setLabel(`${opponentTeamName} 라인업 보기`)
              .setStyle(ButtonStyle.Primary)
              .setEmoji('👀');
            
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(opponentLineupButton);
            
            // 임베드와 버튼을 함께 전송
            const message = await user.send({ 
              embeds: [embed],
              components: [row]
            });
            
            // 버튼 클릭 이벤트 리스너 생성 (무기한 작동)
            const collector = message.createMessageComponentCollector({ 
              componentType: ComponentType.Button
            });
            
            collector.on('collect', async interaction => {
              if (interaction.customId === `opponent_lineup_${gameId}_${opponentTeamCode}`) {
                await interaction.deferUpdate();
                
                // 상대팀 라인업 임베드 생성
                const opponentEmbed = new EmbedBuilder()
                  .setColor(this.getTeamColor(opponentTeamCode))
                  .setTitle(`⚾ ${opponentTeamName} 라인업 정보`)
                  .setDescription(`${gameInfo.stadium || '경기장 미정'} (${formattedTime})`)
                  .setThumbnail('https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png')
                  .addFields({
                    name: `📋 ${opponentTeamName} 라인업`,
                    value: opponentLineupData && opponentLineupData.players ? 
                          opponentLineupData.players.join('\n') : 
                          "라인업 정보가 아직 발표되지 않았습니다.",
                    inline: false
                  })
                  .setFooter({ text: `경기 ID: ${gameId}` })
                  .setTimestamp();
                
                // 상대팀 라인업 정보 전송
                await interaction.followUp({ 
                  embeds: [opponentEmbed],
                  ephemeral: true
                });
              }
            });
            
            console.log(`${user.tag}님에게 ${teamCode} 팀 라인업 알림을 보냈습니다.`);
            
            // 알림 기록 저장
            await MongoDB.NotificationHistory.addNotification(userId, gameId, teamCode, 'lineup');
          } catch (error) {
            console.error(`사용자 ${userId}에게 DM 전송 실패:`, error);

            // DM 전송 실패 시 알림 설정 비활성화
            await MongoDB.kboUser.kbouser_notifications_toggle(userId, false);
            console.log(`사용자 ${userId}의 알림 설정이 비활성화되었습니다.`);

            // 공지 채널에 메시지 전송
            try {
              const channel = await this.client.channels.fetch('1279705542226481174');
              if (channel?.isTextBased()) {
                await (channel as TextChannel).send(`⚠️ 사용자 <@${userId}>에게 DM을 보낼 수 없습니다. 알림 설정이 비활성화되었습니다.`);
              }
            } catch (channelError) {
              console.error('공지 채널 메시지 전송 실패:', channelError);
            }
          }
        } catch (error) {
          console.error(`팬 ${fan.user_id}에게 DM 보내기 실패:`, error);
        }
      }
    } catch (error) {
      console.error(`팀 ${teamCode}의 팬들에게 라인업 알림 보내기 실패:`, error);
    }
  }

  /**
   * 최신 경기 정보를 가져옵니다 (경기 시간 변경 확인용)
   */
  private async getUpdatedGameInfo(gameId: string): Promise<any> {
    try {
      const today = new Date();
      const formattedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      
      // API에서 경기 일정 가져오기
      const url = `https://api-gw.sports.naver.com/schedule/games?fields=basic%2Cschedule%2Cbaseball&upperCategoryId=kbaseball&fromDate=${formattedDate}&toDate=${formattedDate}&size=500`;
      const response = await axios.get(url);
      const games = (response.data as any)?.result?.games.filter((game: any) => game.categoryId === "kbo") || [];
      
      // 해당 gameId의 경기 찾기
      const game = games.find((g: any) => g.gameId === gameId);
      return game || null;
      
    } catch (error) {
      console.error(`경기 정보 업데이트 확인 중 오류 발생:`, error);
      return null;
    }
  }

  /**
   * 특정 경기의 알림을 예약합니다
   */
  private async scheduleGameNotification(
    gameId: string,
    homeTeamCode: string,
    awayTeamCode: string,
    notificationTime: Date,
    gameInfo: any
  ): Promise<void> {
    const jobName = `game-notification-${gameId}`;
    
    console.log(`경기 알림 예약: ${gameId}, ${awayTeamCode} vs ${homeTeamCode}, 알림 시간: ${notificationTime}`);
    
    // 해당 시간에 알림을 보내는 작업 등록
    Scheduler.scheduleOnce(jobName, notificationTime, async () => {
      // 홈팀 팬들에게 알림
      await this.notifyTeamFans(homeTeamCode, gameInfo, true);
      
      // 원정팀 팬들에게 알림
      await this.notifyTeamFans(awayTeamCode, gameInfo, false);
    });
  }

  /**
   * 특정 팀의 팬들에게 경기 시작 알림을 보냅니다
   */
  private async notifyTeamFans(teamCode: string, gameInfo: any, isHomeTeam: boolean): Promise<void> {
    try {
      const gameId = gameInfo.gameId;
      
      // 팀의 팬들 가져오기
      const teamFans = await this.getTeamFans(teamCode);
      
      if (teamFans.length === 0) {
        console.log(`${teamCode} 팀의 팬이 없습니다.`);
        return;
      }
      
      console.log(`${teamCode} 팀의 ${teamFans.length}명의 팬들에게 경기 시작 알림을 보냅니다.`);
      
      // 상대팀 정보
      const opponentTeamCode = isHomeTeam ? gameInfo.awayTeamCode : gameInfo.homeTeamCode;
      const opponentTeamName = isHomeTeam ? gameInfo.awayTeamName : gameInfo.homeTeamName;
      const myTeamName = isHomeTeam ? gameInfo.homeTeamName : gameInfo.awayTeamName;
      
      // 경기 시간 포맷팅
      const gameDateTime = new Date(gameInfo.gameDateTime);
      const formattedTime = `${gameDateTime.getHours().toString().padStart(2, '0')}:${gameDateTime.getMinutes().toString().padStart(2, '0')}`;
      
      // 각 팬에게 DM 보내기
      for (const fan of teamFans) {
        try {
          const userId = fan.user_id;

          // 이미 알림을 보냈는지 확인
          const alreadySent = await MongoDB.NotificationHistory.hasNotificationBeenSent(
            userId, 
            gameId, 
            teamCode, 
            'gametime'
          );

          if (alreadySent) {
            console.log(`사용자 ${userId}에게 ${teamCode} 팀 경기 시작 알림이 이미 전송되었습니다.`);
            continue;
          }

          try {
            const user = await this.client.users.fetch(userId);

            // 경기 시작 알림 임베드 생성
            const embed = new EmbedBuilder()
              .setColor(this.getTeamColor(teamCode))
              .setTitle(`⚾ ${myTeamName} 경기가 시작되었습니다!`)
              .setDescription(`${myTeamName} vs ${opponentTeamName}\n${gameInfo.stadium || '경기장 미정'} (${formattedTime})`)
              .setThumbnail('https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png')
              .addFields({
                name: '📺 중계 정보',
                value: gameInfo.broadChannel ? gameInfo.broadChannel.replace(/\^/g, ', ') : '중계 정보 없음',
                inline: false
              })
              .setFooter({ text: `경기 ID: ${gameId}` })
              .setTimestamp();

            // 실시간 중계 구독 버튼 추가
            const subscribeButton = new ButtonBuilder()
              .setCustomId(`subscribe_relay_${gameId}`)
              .setLabel('실시간 중계 보기')
              .setStyle(ButtonStyle.Success)
              .setEmoji('📲');

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(subscribeButton);

            // 임베드와 버튼을 함께 전송
            const message = await user.send({ 
              embeds: [embed],
              components: [row]
            });

            console.log(`${user.tag}님에게 ${teamCode} 팀 경기 시작 알림을 보냈습니다.`);

            // 알림 기록 저장
            await MongoDB.NotificationHistory.addNotification(userId, gameId, teamCode, 'gametime');
          } catch (error) {
            console.error(`사용자 ${userId}에게 DM 전송 실패:`, error);

            // DM 전송 실패 시 알림 설정 비활성화
            await MongoDB.kboUser.kbouser_notifications_toggle(userId, false);
            console.log(`사용자 ${userId}의 알림 설정이 비활성화되었습니다.`);

            // 공지 채널에 메시지 전송
            try {
              const channel = await this.client.channels.fetch('1279705542226481174');
              if (channel?.isTextBased()) {
                await (channel as TextChannel).send(`⚠️ 사용자 <@${userId}>에게 DM을 보낼 수 없습니다. 알림 설정이 비활성화되었습니다.`);
              }
            } catch (channelError) {
              console.error('공지 채널 메시지 전송 실패:', channelError);
            }
          }
        } catch (error) {
          console.error(`팬 ${fan.user_id}에게 DM 보내기 실패:`, error);
        }
      }
      
    } catch (error) {
      console.error(`팀 ${teamCode}의 팬들에게 경기 시작 알림 보내기 실패:`, error);
    }
  }

  /**
   * 사용자를 위한 실시간 중계를 시작합니다
   */
  public async startLiveRelay(userId: string, gameId: string, teamName: string, opponentName: string): Promise<void> {
    try {
      // 이미 구독 중인지 확인
      if (this.isUserSubscribed(userId)) {
        const user = await this.client.users.fetch(userId);
        await user.send('❌ **이미 다른 실시간 중계를 구독하고 있습니다.**\n중복 구독을 할 수 없습니다. 진행 중인 중계를 먼저 종료해주세요.');
        return;
      }

      const subscriptionKey = `${userId}_${gameId}`;
      if (this.liveRelaySubscriptions.has(subscriptionKey)) {
        const user = await this.client.users.fetch(userId);
        await user.send('🔄 이미 이 경기의 실시간 중계를 구독하고 있습니다.');
        return;
      }

      const user = await this.client.users.fetch(userId);

      // 초기 경기 정보 가져오기
      const initialData = await this.getGameLiveData(gameId);
      if (!initialData) {
        await user.send('⚠️ 현재 경기 정보를 가져올 수 없습니다. 잠시 후 다시 시도해주세요.');
        return;
      }

      // 경기가 종료되었는지 확인
      if (this.isGameFinished(initialData)) {
        await user.send('🏁 이 경기는 이미 종료되었습니다.');
        return;
      }

      // 경기 정보 임베드 생성
      const gameInfo = { homeTeamName: teamName, awayTeamName: opponentName, gameId };
      const initialEmbed = this.createEnhancedLiveGameEmbed(initialData, teamName, opponentName, gameInfo);

      // 중계 중지 버튼 추가
      const stopButton = new ButtonBuilder()
        .setCustomId(`stop_relay_${gameId}`)
        .setLabel('중계 종료')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('⏹️');

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(stopButton);

      // 시작 메시지 전송
      const startMessage = await user.send({
        content: `⚾ **${teamName} vs ${opponentName}** 실시간 중계가 시작되었습니다.\n메시지는 10초마다 자동으로 업데이트됩니다.`,
        embeds: [initialEmbed],
        components: [row]
      });

      // 메시지 컴포넌트 수집기 생성
      const collector = startMessage.createMessageComponentCollector({
        componentType: ComponentType.Button
      });

      collector.on('collect', async interaction => {
        if (interaction.customId === `stop_relay_${gameId}`) {
          await interaction.deferUpdate();
          await this.stopLiveRelay(userId, gameId, undefined, interaction);
        }
      });

      // 10초마다 업데이트하는 인터벌 설정
      const intervalId = setInterval(async () => {
        try {
          await this.updateLiveRelay(userId, gameId, teamName, opponentName);
        } catch (error) {
          console.error(`실시간 중계 업데이트 실패 (${userId}, ${gameId}):`, error);
        }
      }, 10000);

      // 구독 정보 저장
      this.liveRelaySubscriptions.set(subscriptionKey, {
        userId,
        gameId,
        messageId: startMessage.id,
        intervalId,
        lastUpdate: new Date(),
        startTime: new Date()
      });

      console.log(`사용자 ${userId}가 게임 ${gameId} 실시간 중계를 구독했습니다.`);
    } catch (error) {
      console.error(`실시간 중계 시작 실패 (${userId}, ${gameId}):`, error);
      try {
        const user = await this.client.users.fetch(userId);
        await user.send('❌ 실시간 중계를 시작하는 중에 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
      } catch (e) {
        console.error('오류 메시지 전송 실패:', e);
      }
    }
  }

  /**
   * 실시간 중계 정보를 업데이트합니다
   */
  private async updateLiveRelay(userId: string, gameId: string, teamName: string, opponentName: string): Promise<void> {
    const subscriptionKey = `${userId}_${gameId}`;
    const subscription = this.liveRelaySubscriptions.get(subscriptionKey);

    if (!subscription) {
      console.log(`구독 정보를 찾을 수 없음 (${userId}, ${gameId})`);
      return;
    }

    try {
      const user = await this.client.users.fetch(userId);
      const message = await user.dmChannel?.messages.fetch(subscription.messageId);

      if (!message) {
        console.log(`메시지를 찾을 수 없음 (${userId}, ${gameId}, ${subscription.messageId})`);
        await this.stopLiveRelay(userId, gameId, "메시지를 더 이상 찾을 수 없어 중계를 종료합니다.");
        return;
      }

      // 최신 경기 데이터 가져오기
      const liveData = await this.getGameLiveData(gameId);

      if (!liveData) {
        console.log(`경기 정보를 가져올 수 없음 (${userId}, ${gameId})`);
        if (subscription.lastUpdate && (Date.now() - subscription.lastUpdate.getTime()) > 5 * 60 * 1000) {
          await this.stopLiveRelay(userId, gameId, "데이터를 더 이상 받을 수 없어 중계를 종료합니다.");
        }
        return;
      }

      // 경기가 종료되었는지 확인
      if (this.isGameFinished(liveData)) {
        const gameInfo = { homeTeamName: teamName, awayTeamName: opponentName, gameId };
        const finalEmbed = this.createEnhancedLiveGameEmbed(liveData, teamName, opponentName, gameInfo);

        try {
          const gameState = liveData.textRelayData?.currentGameState || {};
          const homeScore = gameState.homeScore || 0;
          const awayScore = gameState.awayScore || 0;

          await message.edit({
            content: `⚾ **${teamName} vs ${opponentName}** 경기가 종료되었습니다.\n최종 점수: ${teamName} ${homeScore} : ${awayScore} ${opponentName}`,
            embeds: [finalEmbed],
            components: []
          });
        } catch (e) {
          console.error(`경기 종료 메시지 전송 실패: ${e}`);
        }

        await this.stopLiveRelay(userId, gameId);
        return;
      }

      // 최신 임베드 생성
      const gameInfo = { homeTeamName: teamName, awayTeamName: opponentName, gameId };
      const updatedEmbed = this.createEnhancedLiveGameEmbed(liveData, teamName, opponentName, gameInfo);

      const stopButton = new ButtonBuilder()
        .setCustomId(`stop_relay_${gameId}`)
        .setLabel('중계 종료')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('⏹️');

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(stopButton);

      await message.edit({
        content: `⚾ **${teamName} vs ${opponentName}** 실시간 중계 \n(${new Date().toLocaleTimeString()} 업데이트)`,
        embeds: [updatedEmbed],
        components: [row]
      });

      subscription.lastUpdate = new Date();
      this.liveRelaySubscriptions.set(subscriptionKey, subscription);
    } catch (error) {
      console.error(`중계 업데이트 실패 (${userId}, ${gameId}):`, error);

      if (subscription.lastUpdate && (Date.now() - subscription.lastUpdate.getTime()) > 5 * 60 * 1000) {
        await this.stopLiveRelay(userId, gameId, "중계 업데이트에 실패하여 자동으로 중계를 종료합니다.");
      }
    }
  }

  /**
   * 실시간 중계를 중지합니다
   */
  public async stopLiveRelay(userId: string, gameId: string, customMessage?: string, buttonInteraction?: any): Promise<void> {
    const subscriptionKey = `${userId}_${gameId}`;
    const subscription = this.liveRelaySubscriptions.get(subscriptionKey);
    
    if (!subscription) {
      // 다른 사용자 ID로 검색해서 모든 구독 확인
      for (const [key, sub] of this.liveRelaySubscriptions.entries()) {
        if (sub.userId === userId) {
          // 다른 게임의 중계를 구독 중인 경우 그것을 종료
          clearInterval(sub.intervalId);
          this.liveRelaySubscriptions.delete(key);
          
          try {
            // 버튼 인터랙션이 있으면 인터랙션을 통해 메시지 업데이트
            if (buttonInteraction) {
              await buttonInteraction.update({
                content: `⚾ **실시간 DM 중계가 종료되었습니다.** (게임 ID: ${sub.gameId})`,
                embeds: [],
                components: []
              });
            } else {
              // 기존 방식으로 새 DM 전송
              const user = await this.client.users.fetch(userId);
              const message = customMessage || `## ⏹️ 실시간 중계 종료\n\n🛑 **경기 ID: ${sub.gameId}** 의 실시간 중계가 중지되었습니다.\n\n다시 보고 싶으시면 \`/kbo 중계\` 또는 \`/kbo dm중계\` 명령어를 사용해주세요.`;
              await user.send(message);
            }
          } catch (error) {
            console.error(`중계 종료 알림 전송 실패:`, error);
          }
          console.log(`사용자 ${userId}의 게임 ${sub.gameId} 실시간 중계를 중지했습니다.`);
          return;
        }
      }
      return;
    }

    // 인터벌 종료
    clearInterval(subscription.intervalId);
    this.liveRelaySubscriptions.delete(subscriptionKey);
    
    try {
      // 버튼 인터랙션이 있으면 인터랙션을 통해 메시지 업데이트
      if (buttonInteraction) {
        await buttonInteraction.update({
          content: `⚾ **실시간 DM 중계가 종료되었습니다.** (게임 ID: ${gameId})`,
          embeds: [],
          components: []
        });
      } else {
        // 기존 방식으로 새 DM 전송
        const user = await this.client.users.fetch(userId);
        const message = customMessage || `## ⏹️ 실시간 중계 종료\n\n🛑 **경기 ID: ${gameId}** 의 실시간 중계가 중지되었습니다.\n\n다시 보고 싶으시면 \`/kbo 중계\` 또는 \`/kbo dm중계\` 명령어를 사용해주세요.`;
        await user.send(message);
      }
    } catch (error) {
      console.error(`중계 중지 메시지 전송 실패 (${userId}, ${gameId}):`, error);
    }
    
    console.log(`사용자 ${userId}의 게임 ${gameId} 실시간 중계를 중지했습니다.`);
  }

  /**
   * 향상된 실시간 경기 임베드를 생성합니다
   * 더 많은 정보와 시각적 요소를 포함한 임베드를 반환합니다
   */
  private createEnhancedLiveGameEmbed(liveData: any, teamName: string, opponentName: string, gameInfo: any): EmbedBuilder {
    // 기본 임베드 설정
    const embed = new EmbedBuilder()
      .setTitle(`⚾ ${teamName} vs ${opponentName} 실시간 중계`)
      .setColor(0x1E90FF) // 기본 파란색
      .setTimestamp();

    if (!liveData?.textRelayData) {
      embed.setDescription('현재 실시간 중계 정보가 없습니다.');
      return embed;
    }

    // 경기 상태 정보
    const gameState = liveData.textRelayData.currentGameState || {};
    const inning = liveData.textRelayData.inn || '?';
    const isAwayTeam = liveData.textRelayData.homeOrAway === "0";
    
    // 스코어 정보
    const homeScore = gameState.homeScore || 0;
    const awayScore = gameState.awayScore || 0;
    
    // 볼카운트, 아웃카운트 정보
    const strikes = gameState.strike || 0;
    const balls = gameState.ball || 0;
    const outs = gameState.out || 0;
    
    // 주자 정보 - 이모지로 시각적 표현 향상
    const base1 = gameState.base1 && gameState.base1 !== "0" ? "🟡" : "⚪";
    const base2 = gameState.base2 && gameState.base2 !== "0" ? "🟡" : "⚪";
    const base3 = gameState.base3 && gameState.base3 !== "0" ? "🟡" : "⚪";
    
    // 현재 공/수 상태에 따른 메시지
    const attackTeam = isAwayTeam ? teamName : opponentName;
    const defenseTeam = isAwayTeam ? opponentName : teamName;
    
    // 이닝 표시 문구 개선
    let inningStr = `${inning}회${isAwayTeam ? '초' : '말'}`;
    if (gameState.statusCode === "RESULT" || gameState.statusCode === "FINAL") {
      inningStr = "경기 종료";
    }

    // 현재 타자 및 투수 정보 가져오기
    let currentBatter = "정보 없음";
    let currentPitcher = "정보 없음";
    let batterStats = "";
    let pitcherStats = "";
    
    // 현재 타자 정보
    if (gameState.batter) {
      const batterLineup = isAwayTeam 
        ? liveData.textRelayData.awayLineup?.batter 
        : liveData.textRelayData.homeLineup?.batter;
        
      if (batterLineup) {
        const batter = batterLineup.find((b: any) => b.pcode === gameState.batter);
        if (batter) {
          currentBatter = `${batter.name} (${batter.posName})`;
          // 타자 성적 정보 추가
          if (batter.hitType) {
            batterStats = `타율: ${batter.avg || '-.---'} | ${batter.hitType}`;
          }
        }
      }
    }
    
    // 현재 투수 정보
    if (gameState.pitcher) {
      const pitcherLineup = isAwayTeam 
        ? liveData.textRelayData.homeLineup?.pitcher 
        : liveData.textRelayData.awayLineup?.pitcher;
        
      if (pitcherLineup) {
        const pitcher = pitcherLineup.find((p: any) => p.pcode === gameState.pitcher);
        if (pitcher) {
          currentPitcher = `${pitcher.name}`;
          // 투수 성적 정보 추가
          pitcherStats = `ERA: ${pitcher.era || '-.--'} | ${pitcher.pitchCnt || 0}구`;
        }
      }
    }

    // 최근 플레이 정보 가져오기 - 최근 5개로 확장
    let recentPlays = "플레이 정보 없음";
    if (liveData.textRelayData.textRelays && liveData.textRelayData.textRelays.length > 0) {
      const allTexts: string[] = [];
      
      // 최대 5개의 최신 이벤트 가져오기
      const recentRelays = liveData.textRelayData.textRelays.slice(0, 5);
      
      for (const relay of recentRelays) {
        if (relay.textOptions && relay.textOptions.length > 0) {
          for (const option of relay.textOptions) {
            if (option.text) {
              allTexts.push(option.text);
            }
          }
        }
      }
      
      // 최근 3개의 플레이만 표시
      if (allTexts.length > 0) {
        recentPlays = allTexts.slice(0, 3).join('\n');
      }
    }

    // 이닝별 점수 추가 (표 형식)
    let inningScores = "";
    if (liveData.textRelayData.scoreBoard) {
      const homeTeamInnings = liveData.textRelayData.scoreBoard.home || [];
      const awayTeamInnings = liveData.textRelayData.scoreBoard.away || [];
      
      // 이닝 표시 (최대 9이닝까지, 추가 이닝은 ... 으로)
      inningScores += "이닝\t";
      for (let i = 1; i <= Math.min(9, Math.max(homeTeamInnings.length, awayTeamInnings.length)); i++) {
        inningScores += `${i}\t`;
      }
      if (Math.max(homeTeamInnings.length, awayTeamInnings.length) > 9) {
        inningScores += "...\t";
      }
      inningScores += "R\n";
      
      // 원정팀 이닝 스코어
      inningScores += `${opponentName}\t`;
      for (let i = 0; i < Math.min(9, awayTeamInnings.length); i++) {
        inningScores += `${awayTeamInnings[i] || 0}\t`;
      }
      if (awayTeamInnings.length > 9) {
        inningScores += "...\t";
      }
      inningScores += `${awayScore}\n`;
      
      // 홈팀 이닝 스코어
      inningScores += `${teamName}\t`;
      for (let i = 0; i < Math.min(9, homeTeamInnings.length); i++) {
        inningScores += `${homeTeamInnings[i] || 0}\t`;
      }
      if (homeTeamInnings.length > 9) {
        inningScores += "...\t";
      }
      inningScores += `${homeScore}`;
    }

    // 임베드에 정보 추가 (kbo.ts와 동일한 형식으로 변경)
    embed.setDescription(`${inning}회${isAwayTeam ? '초' : '말'} (${isAwayTeam ? opponentName : teamName} 공격) 진행 중`)
      .addFields(
        { name: '스코어', value: isAwayTeam 
          ? `${opponentName} ${awayScore} : ${homeScore} ${teamName}` 
          : `${teamName} ${homeScore} : ${awayScore} ${opponentName}`, 
        inline: false 
        },
        { name: '카운트', value: `\`${balls}\`B-\`${strikes}\`S-\`${outs}\`O`, inline: true },
        { name: '베이스 상황', value: `1루: ${base1} 2루: ${base2} 3루: ${base3}`, inline: true },
        { name: '현재 투수', value: currentPitcher, inline: true },
        { name: '현재 타자', value: currentBatter, inline: true },
        { name: '최근 플레이', value: recentPlays, inline: false },
      );
      
    // 경기 ID 표시
    if (gameInfo?.gameId) {
      embed.setFooter({ text: `경기 ID: ${gameInfo.gameId}` });
    }
      
    return embed;
  }

  /**
   * 경기가 종료되었는지 판단하는 개선된 함수
   */
  private isGameFinished(gameData: any): boolean {
    if (!gameData || !gameData.textRelayData) {
      return false;
    }

    // 1. 공식 상태 코드로 확인 (가장 신뢰할 수 있는 방법)
    if (gameData.textRelayData.statusCode === 'RESULT' || 
        gameData.textRelayData.statusCode === 'FINAL') {
      return true;
    }

    // 2. 텍스트에서 경기 종료 여부 확인
    const textRelays = gameData.textRelayData.textRelays;
    if (textRelays && textRelays.length > 0) {
      const lastRelays = textRelays.slice(-3); // 최근 3개 텍스트 확인
      
      for (const relay of lastRelays) {
        if (relay.textOptions && relay.textOptions.length > 0) {
          for (const option of relay.textOptions) {
            // 경기 종료를 나타내는 키워드 찾기
            const text = option.text || '';
            if (text.includes('경기종료') || 
                text.includes('경기 종료') || 
                text.includes('종료되었습니다') ||
                text.includes('승리팀') || 
                text.includes('승리했습니다')) {
              return true;
            }
          }
        }
      }
    }

    // 3. 이닝 정보와 스코어로 종료 여부 추정
    const inn = gameData.textRelayData.inn;
    // 9회 이상 진행되었고, 말이 끝났을 경우
    if (inn && parseInt(inn) >= 9) {
      const isAwayTeam = gameData.textRelayData.homeOrAway === "0";
      const homeScore = gameData.textRelayData.currentGameState?.homeScore || 0;
      const awayScore = gameData.textRelayData.currentGameState?.awayScore || 0;
      
      // 9회말이고 홈팀이 이기고 있으면 경기 종료로 간주
      if (!isAwayTeam && homeScore > awayScore) {
        return true;
      }
      ;
      // 9회말이 끝났는데 어웨이팀이 표시되면 경기가 종료된 것으로 간주
      if (isAwayTeam && parseInt(inn) > 9) {
        return true;
      }
    }

    return false;
  }

  /**
   * 모든 진행 중인 중계를 확인하고 경기 종료 여부를 확인합니다
   */
  private async checkAllActiveRelays(): Promise<void> {
    console.log(`활성화된 중계 ${this.liveRelaySubscriptions.size}개 상태 확인 중...`);
    
    for (const [key, subscription] of this.liveRelaySubscriptions.entries()) {
      try {
        // 경기 정보 확인
        const gameData = await this.getGameLiveData(subscription.gameId);
        if (!gameData) {
          console.log(`${subscription.gameId} 경기 데이터를 가져올 수 없습니다. 종료 검사 중...`);
          
          // 마지막 업데이트 시간 확인
          const lastUpdateTime = new Date(subscription.lastUpdate).getTime();
          const currentTime = Date.now();
          // 마지막 업데이트로부터 10분이 지났다면 경기가 종료되었다고 가정
          if (currentTime - lastUpdateTime > 10 * 60 * 1000) {
            console.log(`${subscription.gameId} 경기의 마지막 업데이트가 10분 이상 전입니다. 중계를 종료합니다.`);
            await this.stopLiveRelay(subscription.userId, subscription.gameId, 
              "경기 데이터를 더 이상 받을 수 없어 중계를 종료합니다. 경기가 종료되었을 가능성이 높습니다.");
          }
          continue;
        }
        
        // 경기 종료 확인
        if (this.isGameFinished(gameData)) {
          console.log(`${subscription.gameId} 경기가 종료되었습니다. 중계를 종료합니다.`);
          await this.stopLiveRelay(subscription.userId, subscription.gameId, 
            "경기가 종료되었습니다. 실시간 중계를 종료합니다.");
          continue;
        }
        
        // 시작 시간 기준으로 최대 중계 시간 초과 확인
        if (subscription.startTime) {
          const startTime = new Date(subscription.startTime).getTime();
          const currentTime = Date.now();
          // 4시간 초과 확인
          if (currentTime - startTime > 4 * 60 * 60 * 1000) {
            console.log(`${subscription.gameId} 경기 중계가 4시간을 초과했습니다. 중계를 종료합니다.`);
            await this.stopLiveRelay(subscription.userId, subscription.gameId, 
              "경기 중계 시간이 4시간을 초과하여 자동으로 중계를 종료합니다.");
          }
        }
        
      } catch (error) {
        console.error(`중계 상태 확인 중 오류 (${subscription.userId}, ${subscription.gameId}):`, error);
      }
    }
  }

  /**
   * 경기가 종료되었거나 취소되었을 때 모든 실시간 중계를 정리합니다
   */
  public async cleanupLiveRelaysForGame(gameId: string): Promise<void> {
    // 해당 게임의 모든 구독 찾기
    const subscriptions = Array.from(this.liveRelaySubscriptions.entries())
      .filter(([_, subscription]) => subscription.gameId === gameId);
    
    // 각 구독 중지
    for (const [key, subscription] of subscriptions) {
      await this.stopLiveRelay(subscription.userId, gameId,
        "경기가 종료되었거나 취소되어 실시간 중계를 종료합니다.");
    }
  }

  /**
   * 실시간 경기 데이터를 가져옵니다
   * (public 으로 변경)
   */
  public async getGameLiveData(gameId: string): Promise<any> {
    try {
      // 모든 이닝 정보를 가져오기 위해 이닝 파라미터 없이 호출
      const url = `https://api-gw.sports.naver.com/schedule/games/${gameId}/relay`;
      const response = await axios.get(url);
      
      // 타입 단언을 사용하여 result 속성에 안전하게 접근
      const data = response.data as { result?: any };
      return data.result || null;
    } catch (error) {
      console.error(`실시간 경기 정보 가져오기 실패: ${gameId}`, error);
      return null;
    }
  }

  /**
   * 실시간 경기 정보로 임베드를 생성합니다
   * (public 으로 변경)
   */
  public createLiveGameEmbed(liveData: any, myTeamName: string, opponentTeamName: string): EmbedBuilder {
    // 기본 임베드 설정
    const embed = new EmbedBuilder()
      .setTitle(`⚾ ${myTeamName} vs ${opponentTeamName} 실시간 중계`)
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
    embed.setDescription(`${inning}회${isAwayTeam ? '초' : '말'} (${isAwayTeam ? opponentTeamName : myTeamName} 공격) 진행 중`)
      .addFields(
        { name: '스코어', value: isAwayTeam 
          ? `${myTeamName} ${awayScore} : ${homeScore} ${opponentTeamName}` 
          : `${myTeamName} ${homeScore} : ${awayScore} ${opponentTeamName}`, 
      inline: false 
      },
        { name: '카운트', value: `${currentCount}`, inline: true },
        { name: '베이스 상황', value: `1루: ${base1} 2루: ${base2} 3루: ${base3}`, inline: true }
      );

    // 현재 투수와 타자 정보 추가
    embed.addFields(
      { name: '현재 투수', value: currentPitcher, inline: true },
      { name: '현재 타자', value: currentBatter, inline: true }
    );
    
    // 최근 플레이 정보 추가
    embed.addFields({ name: '최근 플레이', value: recentPlays, inline: false });
      
    return embed;
  }

  /**
   * 특정 팀의 팬 목록을 가져옵니다
   */
  private async getTeamFans(teamCode: string): Promise<any[]> {
    try {
      const client = MongoDB.client;
      if (!client) {
        throw new Error('MongoDB 클라이언트가 초기화되지 않았습니다.');
      }
      
      const db = client.db('hitbot');
      const collection = db.collection('kbouser');
      
      // 팀 코드와 일치하고 알림을 활성화한 사용자 찾기
      const fans = await collection.find({
        teamName: teamCode,
        notifications: true  // 알림을 활성화한 사용자만
      }).toArray();
      
      return fans;
    } catch (error) {
      console.error('팬 목록 가져오기 실패:', error);
      return [];
    }
  }

  /**
   * KBO 라인업을 가져오는 함수
   */
  async getKBOLineup(gameId: string): Promise<{ lineupData: any }> {
    const MAX_RETRIES = 3; // 최대 재시도 횟수
    const RETRY_DELAY = 5000; // 재시도 간격 (밀리초)

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const puppeteer = await import('puppeteer');
        const url = `https://m.sports.naver.com/game/${gameId}/lineup`;
        const browser = await puppeteer.default.launch({ 
          executablePath: '/usr/bin/chromium-browser',
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        console.log(`KBO 라인업 크롤링 시도 ${attempt}/${MAX_RETRIES}: ${url}`);

        await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 5000));

        try {
          await page.waitForSelector('.LineupTab_comp_lineup_tab__2yd4p, .Lineup_comp_lineup__35bwS', { timeout: 10000 });
        } catch (err) {
          console.log("라인업 셀렉터를 찾을 수 없음, 계속 진행");
        }

        const lineupData = await page.evaluate(() => {
          const teamAreas = document.querySelectorAll('.Lineup_lineup_area__2aNOv');
          if (!teamAreas || teamAreas.length === 0) return [];

          const result = [];

          teamAreas.forEach((team) => {
            try {
              const teamTitleElement = team.querySelector('.Lineup_lineup_title__1WigY');
              const teamNameWithImage = teamTitleElement?.textContent?.trim() || "";
              const teamNameMatch = teamNameWithImage.match(/(삼성|KIA|두산|NC|LG|SSG|키움|KT|롯데|한화).*/);
              let teamName = teamNameMatch ? teamNameMatch[0] : teamNameWithImage;
              teamName = teamName.replace('선발', '');

              const playerItems = team.querySelectorAll('.Lineup_lineup_item__32s4M');
              const players = Array.from(playerItems).map((playerItem) => {
                const nameElement = playerItem.querySelector('.Lineup_name__jV19m');
                const positionElement = playerItem.querySelector('.Lineup_position__265hb');
                const orderElement = playerItem.querySelector('.Lineup_order__1-EPy');
                const name = nameElement?.textContent?.trim() || "";
                const position = positionElement?.textContent?.trim() || "";
                const order = orderElement?.textContent?.trim() || "";

                if (order === "선발") {
                  return `[선발] ${name} (${position})`;
                }

                return `${order}. ${name} (${position})`;
              });

              result.push({ teamName, players });
            } catch (e) {
              console.log(`팀 정보 파싱 오류:`, e);
            }
          });

          return result;
        });

        await browser.close();

        return {
          lineupData: lineupData
        };

      } catch (error) {
        console.error(`KBO 라인업 크롤링 오류 (시도 ${attempt}/${MAX_RETRIES}):`, error);

        if (attempt < MAX_RETRIES) {
          console.log(`재시도 대기 중... (${RETRY_DELAY / 1000}초)`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        } else {
          console.error("최대 재시도 횟수를 초과했습니다.");
          return {
            lineupData: []
          };
        }
      }
    }

    return {
      lineupData: []
    };
  }

  /**
   * 팀 코드에 맞는 색상 코드를 반환합니다
   */
  private getTeamColor(teamCode: string): number {
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
    return teamColors[teamCode] || 0x1E90FF;
  }

  /**
   * 오늘의 모든 경기 상태를 확인하고 필요한 알림을 전송합니다
   * (경기 취소, 종료 등의 알림을 위한 모니터링)
   */
  private async monitorGameStatuses(): Promise<void> {
    try {
      const today = new Date();
      const formattedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      
      // API에서 경기 일정 가져오기
      const url = `https://api-gw.sports.naver.com/schedule/games?fields=basic%2Cschedule%2Cbaseball&upperCategoryId=kbaseball&fromDate=${formattedDate}&toDate=${formattedDate}&size=500`;
      const response = await axios.get(url);
      const games = (response.data as any)?.result?.games.filter((game: any) => game.categoryId === "kbo") || [];
      
      if (!games || games.length === 0) {
        return; // 오늘 예정된 경기가 없음
      }
      
      // 각 경기의 상태 확인
      for (const game of games) {
        const gameId = game.gameId;
        if (!gameId) continue;
        
        const homeTeamCode = game.homeTeamCode;
        const awayTeamCode = game.awayTeamCode;
        if (!homeTeamCode || !awayTeamCode) continue;
        
        // 경기가 취소되었는지 확인
        if (game.cancel) {
          await this.notifyCanceledGame(gameId, homeTeamCode, awayTeamCode, game);
          // 해당 게임의 모든 실시간 중계 정리
          await this.cleanupLiveRelaysForGame(gameId);
          continue;
        }
        
        // 경기가 종료되었는지 확인
        if (game.statusCode === "RESULT") {
          await this.notifyGameResult(gameId, homeTeamCode, awayTeamCode, game);
          // 해당 게임의 모든 실시간 중계 정리
          await this.cleanupLiveRelaysForGame(gameId);
        }
      }
    } catch (error) {
      console.error('경기 상태 모니터링 중 오류 발생:', error);
    }
  }

  /**
   * 취소된 경기에 대한 알림을 팬들에게 보냅니다
   */
  private async notifyCanceledGame(
    gameId: string,
    homeTeamCode: string,
    awayTeamCode: string,
    gameInfo: any
  ): Promise<void> {
    try {
      // 홈팀 팬 알림
      await this.sendCancelNotificationToTeam(homeTeamCode, gameId, gameInfo, true);
      
      // 원정팀 팬 알림
      await this.sendCancelNotificationToTeam(awayTeamCode, gameId, gameInfo, false);
      
    } catch (error) {
      console.error(`취소된 경기 알림 전송 중 오류:`, error);
    }
  }

  /**
   * 특정 팀 팬들에게 경기 취소 알림을 보냅니다
   */
  private async sendCancelNotificationToTeam(
    teamCode: string,
    gameId: string,
    gameInfo: any,
    isHomeTeam: boolean
  ): Promise<void> {
    try {
      // 이미 취소 알림을 보냈는지 확인
      const sentUsers = await MongoDB.NotificationHistory.getNotificationsForGame(gameId, teamCode, 'cancel');
      if (sentUsers.length > 0) {
        // 이미 알림을 보냈으므로 중복해서 보내지 않음
        return;
      }
      
      // 팀의 팬 목록 가져오기
      const teamFans = await this.getTeamFans(teamCode);
      if (teamFans.length === 0) return;
      
      // 경기 정보
      const homeTeamName = gameInfo.homeTeamName;
      const awayTeamName = gameInfo.awayTeamName;
      const myTeamName = isHomeTeam ? homeTeamName : awayTeamName;
      const opponentTeamName = isHomeTeam ? awayTeamName : homeTeamName;
        
      console.log(`${teamCode} 팀 ${teamFans.length}명의 팬들에게 경기 취소 알림을 보냅니다.`);
      
      // 하이라이트 URL용 날짜 포맷팅
      const today = new Date();
      const formattedDate = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

      // 각 팬에게 DM 보내기
      for (const fan of teamFans) {
        const userId = fan.user_id;
        
        // 이미 알림을 보냈는지 한 번 더 확인 (개별 사용자 기준)
        const alreadySent = await MongoDB.NotificationHistory.hasNotificationBeenSent(
          userId,
          gameId,
          teamCode,
          'cancel'
        );
        
        if (alreadySent) {
          continue;
        }
        
        try {
          const user = await this.client.users.fetch(userId);
          
          // 취소 알림 임베드 생성
          const embed = new EmbedBuilder()
            .setColor(this.getTeamColor(teamCode))
            .setTitle(`⚾ ${myTeamName} 경기 취소 알림`)
            .setDescription(`${myTeamName} vs ${opponentTeamName} 경기가 취소되었습니다.`)
            .addFields({
              name: '취소 사유',
              value: gameInfo.cancelReason || '사유가 명시되지 않았습니다',
              inline: false
            })
            .setThumbnail('https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png')
            .setFooter({ text: `경기 ID: ${gameId}` })
            .setTimestamp();
          
          await user.send({ embeds: [embed] });
          console.log(`${user.tag}님에게 ${teamCode} 팀 경기 취소 알림을 보냈습니다.`);
          
          // 알림 기록 저장
          await MongoDB.NotificationHistory.addNotification(userId, gameId, teamCode, 'cancel');
        } catch (error) {
          console.error(`사용자 ${userId}에게 DM 전송 실패:`, error);

          // DM 전송 실패 시 알림 설정 비활성화
          await MongoDB.kboUser.kbouser_notifications_toggle(userId, false);
          console.log(`사용자 ${userId}의 알림 설정이 비활성화되었습니다.`);

          // 공지 채널에 메시지 전송
          try {
            const channel = await this.client.channels.fetch('1279705542226481174');
            if (channel?.isTextBased()) {
              await (channel as TextChannel).send(`⚠️ 사용자 <@${userId}>에게 DM을 보낼 수 없습니다. 알림 설정이 비활성화되었습니다.`);
            }
          } catch (channelError) {
            console.error('공지 채널 메시지 전송 실패:', channelError);
          }
        }
      }
    } catch (error) {
      console.error(`팀 ${teamCode} 팬들에게 경기 취소 알림 보내기 실패:`, error);
    }
  }

  /**
   * 경기 결과 알림을 팬들에게 보냅니다
   */
  private async notifyGameResult(
    gameId: string,
    homeTeamCode: string,
    awayTeamCode: string,
    gameInfo: any
  ): Promise<void> {
    try {
      // 홈팀 팬 알림
      await this.sendResultNotificationToTeam(homeTeamCode, gameId, gameInfo, true);
      
      // 원정팀 팬 알림
      await this.sendResultNotificationToTeam(awayTeamCode, gameId, gameInfo, false);
      
    } catch (error) {
      console.error(`경기 결과 알림 전송 중 오류:`, error);
    }
  }

  /**
   * 특정 팀 팬들에게 경기 결과 알림을 보냅니다
   */
  private async sendResultNotificationToTeam(
    teamCode: string,
    gameId: string,
    gameInfo: any,
    isHomeTeam: boolean
  ): Promise<void> {
    try {
      // 이미 결과 알림을 보냈는지 확인
      const sentUsers = await MongoDB.NotificationHistory.getNotificationsForGame(gameId, teamCode, 'result');
      if (sentUsers.length > 0) {
        // 이미 알림을 보냈으므로 중복해서 보내지 않음
        return;
      }
      
      // 팀의 팬 목록 가져오기
      const teamFans = await this.getTeamFans(teamCode);
      if (teamFans.length === 0) return;
      
      // 경기 정보
      const homeTeamName = gameInfo.homeTeamName;
      const awayTeamName = gameInfo.awayTeamName;
      const homeTeamScore = gameInfo.homeTeamScore || 0;
      const awayTeamScore = gameInfo.awayTeamScore || 0;
      const myTeamName = isHomeTeam ? homeTeamName : awayTeamName;
      const opponentTeamName = isHomeTeam ? awayTeamName : homeTeamName;
      
      // 승패 및 점수 정보
      const myTeamScore = isHomeTeam ? homeTeamScore : awayTeamScore;
      const opponentScore = isHomeTeam ? awayTeamScore : homeTeamScore;
      const isWin = myTeamScore > opponentScore;
      const isDraw = myTeamScore === opponentScore;
      let resultText, resultEmoji, embedColor;
      
      if (isWin) {
        resultText = "승리";
        resultEmoji = "🎉";
        embedColor = this.getTeamColor(teamCode); // 팀 색상 사용
      } else if (isDraw) {
        resultText = "무승부";
        resultEmoji = "🤝";
        embedColor = 0x808080; // 회색
      } else {
        resultText = "패배";
        resultEmoji = "💔";
        embedColor = 0x808080; // 회색
      }
      
      console.log(`${teamCode} 팀 ${teamFans.length}명의 팬들에게 경기 결과 알림을 보냅니다.`);
      
      // 각 팬에게 DM 보내기
      for (const fan of teamFans) {
        const userId = fan.user_id;
        
        // 이미 알림을 보냈는지 한 번 더 확인 (개별 사용자 기준)
        const alreadySent = await MongoDB.NotificationHistory.hasNotificationBeenSent(
          userId,
          gameId,
          teamCode,
          'result'
        );
        
        if (alreadySent) {
          continue;
        }
        
        try {
          const user = await this.client.users.fetch(userId);
          
            // 하이라이트 URL용 날짜 포맷팅
          const today = new Date();
          const formattedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

          // 결과 알림 임베드 생성
          const embed = new EmbedBuilder()
            .setColor(embedColor)
            .setTitle(`${resultEmoji} ${myTeamName} ${resultText} 알림`)
            .setDescription(`${myTeamName} vs ${opponentTeamName} 경기가 종료되었습니다.`)
            .addFields({
              name: '경기 결과',
              value: `${myTeamName} ${myTeamScore} : ${opponentScore} ${opponentTeamName}`,
              inline: false
            })
            .setThumbnail('https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/common/h2_logo.png')
            .setFooter({ text: `경기 ID: ${gameId}` })
            .setTimestamp();
          
          // 경기 주요 장면 하이라이트 링크 추가
            embed.addFields({
            name: '주요 장면',
            value: `[경기 하이라이트 보기](https://m.sports.naver.com/kbaseball/video?category=kbo&sort=date&date=${formattedDate}&tab=game&gameId=${gameId})`,
            inline: false
            });
          
          await user.send({ embeds: [embed] });
          console.log(`${user.tag}님에게 ${teamCode} 팀 경기 결과 알림을 보냈습니다.`);
          
          // 알림 기록 저장
          await MongoDB.NotificationHistory.addNotification(userId, gameId, teamCode, 'result');
        } catch (error) {
          console.error(`사용자 ${userId}에게 DM 전송 실패:`, error);

          // DM 전송 실패 시 알림 설정 비활성화
          await MongoDB.kboUser.kbouser_notifications_toggle(userId, false);
          console.log(`사용자 ${userId}의 알림 설정이 비활성화되었습니다.`);

          // 공지 채널에 메시지 전송
          try {
            const channel = await this.client.channels.fetch('1279705542226481174');
            if (channel?.isTextBased()) {
              await (channel as TextChannel).send(`⚠️ 사용자 <@${userId}>에게 DM을 보낼 수 없습니다. 알림 설정이 비활성화되었습니다.`);
            }
          } catch (channelError) {
            console.error('공지 채널 메시지 전송 실패:', channelError);
          }
        }
      }
    } catch (error) {
      console.error(`팀 ${teamCode} 팬들에게 경기 결과 알림 보내기 실패:`, error);
    }
  }

  /**
   * 경기의 상세 결과를 가져옵니다 (선택적으로 활용 가능)
   */
  private async getGameDetails(gameId: string): Promise<any> {
    try {
      const url = `https://api-gw.sports.naver.com/schedule/games/${gameId}/relay`;
      const response = await axios.get(url);
      // 타입 단언을 사용하여 result 속성에 안전하게 접근
      const data = response.data as { result?: any };
      return data.result || null;
    } catch (error) {
      console.error(`경기 상세 결과 가져오기 실패: ${gameId}`, error);
      return null;
    }
  }

  /**
   * 사용자가 이미 실시간 중계를 구독 중인지 확인합니다
   */
  public isUserSubscribed(userId: string): boolean {
    // 모든 구독에서 해당 사용자 ID 찾기
    for (const [key, subscription] of this.liveRelaySubscriptions.entries()) {
      if (subscription.userId === userId) {
        return true;
      }
    }
    return false;
  }

  /**
   * 사용자의 실시간 중계 구독을 취소합니다.
   * @param userId 구독을 취소할 사용자의 ID
   * @returns 구독 취소 성공 여부
   */
  unsubscribeUser(userId: string): boolean {
    let found = false;
    
    // 사용자의 모든 구독 찾기
    for (const [key, subscription] of this.liveRelaySubscriptions.entries()) {
      if (subscription.userId === userId) {
        // 인터벌 정리
        clearInterval(subscription.intervalId);
        
        // 구독 정보 삭제
        this.liveRelaySubscriptions.delete(key);
        
        found = true;
        console.log(`사용자 ${userId}의 실시간 중계 구독이 취소되었습니다.`);
      }
    }
    
    return found;
  }
}
