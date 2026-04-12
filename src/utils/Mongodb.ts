import { MongoClient, Collection, Db } from 'mongodb';
import dotenv from 'dotenv';

// 환경 변수 로드
dotenv.config();

const MONGODB_URI = process.env.mongodb;

// 문서 타입 인터페이스 정의
interface WsInsertDocument {
  user_id: string;
  teamName: string;
  notifications?: boolean; // 알림 설정 필드 추가
}

// 알림 히스토리 인터페이스 정의
interface NotificationHistoryItem {
  id: string;
  userId: string;
  type: 'lineup' | 'gametime' | 'cancel' | 'result'; // 취소 및 결과 알림 타입 추가
  gameId: string;
  teamCode: string;
  sentAt: Date;
  expiresAt: Date;
}

// MongoDB 연결
let client: MongoClient;
let db: Db;
let wsInsertCollection: Collection<WsInsertDocument>;
let isConnected = false;

// 연결 초기화
async function connect() {
  if (!MONGODB_URI) {
    throw new Error('MongoDB URI가 환경 변수에 없습니다');
  }
  
  // 이미 연결된 경우 다시 연결하지 않음
  if (isConnected) {
    console.log("이미 MongoDB에 연결되어 있습니다.");
    return;
  }
  
  try {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('hitbot');
    
    // 컬렉션 초기화
    wsInsertCollection = db.collection<WsInsertDocument>('kbouser');
    
    // 알림 히스토리 컬렉션이 존재하지 않으면 생성
    try {
      const collections = await db.listCollections({ name: 'notificationHistory' }).toArray();
      if (collections.length === 0) {
        await db.createCollection('notificationHistory');
        console.log("알림 히스토리 컬렉션이 생성되었습니다.");
      }
    } catch (err) {
      console.error("알림 히스토리 컬렉션 확인 실패:", err);
    }
    
    const notificationCollection = db.collection('notificationHistory');
    
    // 알림 히스토리 인덱스 생성 (만료일 기준 자동 삭제)
    try {
      const indexes = await notificationCollection.indexes();
      const hasExpireIndex = indexes.some(idx => idx.name === 'expiresAt_ttl');
      if (!hasExpireIndex) {
        await notificationCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expiresAt_ttl' });
        console.log("알림 히스토리 TTL 인덱스가 생성되었습니다.");
      }
    } catch (indexErr) {
      console.error("알림 히스토리 인덱스 생성 실패:", indexErr);
    }
    
    isConnected = true;
    console.log("mongodb 연결되었습니다.");
  } catch (error) {
    console.error(`MongoDB 연결실패되었습니다.\n${error}`);
    throw error;
  }
}

// 자동 연결 제거 - index.ts에서만 호출하도록 함
// connect().catch(console.error);

// 연결 확인 헬퍼 함수
function ensureConnected() {
  if (!isConnected) {
    throw new Error('데이터베이스 연결이 설정되지 않았습니다');
  }
}

// Python 버전과 일치하는 정적 메서드가 있는 WsInsert 클래스 내보내기
export class kboUser {
  static async kbouserInsert(
    user_id: string,
    teamName: string,
    notifications: boolean = true // 기본값으로 알림 활성화
  ) {
    ensureConnected();
    return await wsInsertCollection.insertOne({
      user_id,
      teamName,
      notifications
    });
  }

  static async kbouser_View(user_id: string) {
    ensureConnected();
    return await wsInsertCollection.findOne({ user_id });
  }

  static async kbouser_teamName_edit(user_id: string, teamName: string) {
    ensureConnected();
    return await wsInsertCollection.updateOne(
      { user_id },
      { $set: { teamName } }
    );
  }

  static async kbouser_notifications_toggle(user_id: string, notifications: boolean) {
    ensureConnected();
    return await wsInsertCollection.updateOne(
      { user_id },
      { $set: { notifications } }
    );
  }

  // 특정 팀의 알림을 받기를 원하는 사용자들 목록을 반환
  static async kbouser_get_team_subscribers(teamName: string) {
    ensureConnected();
    return await wsInsertCollection.find({
      teamName,
      notifications: true
    }).toArray();
  }

  // static async totalTimeout_edit(guild_id: number, totalTimeout: number) {
  //   ensureConnected();
  //   return await wsInsertCollection.updateOne(
  //     { guild_id },
  //     { $set: { totalTimeout } }
  //   );
  // }

  // static async additionalTimeout_edit(guild_id: number, additionalTimeout: number) {
  //   ensureConnected();
  //   return await wsInsertCollection.updateOne(
  //     { guild_id },
  //     { $set: { additionalTimeout } }
  //   );
  // }
}

// NotificationHistory 클래스 추가
export class NotificationHistory {
  // 새로운 알림 히스토리 추가
  static async addNotification(
    userId: string,
    gameId: string,
    teamCode: string,
    type: 'lineup' | 'gametime' | 'cancel' | 'result' // 타입 확장
  ): Promise<boolean> {
    ensureConnected();
    try {
      const notificationId = `${type}-${gameId}-${teamCode}-${userId}`;
      const now = new Date();
      // 알림은 하루가 지난 후 자동 삭제됨
      const expirationDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      
      const result = await db.collection('notificationHistory').updateOne(
        { id: notificationId },
        { 
          $setOnInsert: {
            id: notificationId,
            userId,
            gameId,
            teamCode,
            type,
            sentAt: now,
            expiresAt: expirationDate
          }
        },
        { upsert: true }
      );
      
      return result.upsertedCount > 0 || result.modifiedCount > 0;
    } catch (error) {
      console.error('알림 히스토리 추가 실패:', error);
      return false;
    }
  }

  // 알림이 이미 전송되었는지 확인
  static async hasNotificationBeenSent(
    userId: string | null,
    gameId: string,
    teamCode: string | null,
    type: 'lineup' | 'gametime' | 'cancel' | 'result' // 타입 확장
  ): Promise<boolean> {
    ensureConnected();
    try {
      const notificationId = `${type}-${gameId}-${teamCode}-${userId}`;
      const result = await db.collection('notificationHistory').findOne({ id: notificationId });
      return !!result;
    } catch (error) {
      console.error('알림 히스토리 조회 실패:', error);
      return false;
    }
  }

  // 특정 게임의 특정 팀에 대한 모든 알림 조회
  static async getNotificationsForGame(
    gameId: string, 
    teamCode: string,
    type: 'lineup' | 'gametime' | 'cancel' | 'result' // 타입 확장
  ): Promise<string[]> {
    ensureConnected();
    try {
      const notifications = await db.collection('notificationHistory').find({
        gameId,
        teamCode,
        type
      }).toArray();
      
      return notifications.map(n => n.userId);
    } catch (error) {
      console.error('게임 알림 히스토리 조회 실패:', error);
      return [];
    }
  }

  // 오늘의 모든 알림 히스토리 조회
  static async getTodaysNotifications(): Promise<NotificationHistoryItem[]> {
    ensureConnected();
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const notifications = await db.collection('notificationHistory').find({
        sentAt: { $gte: today }
      }).toArray();
      
      // 명시적으로 인터페이스에 맞게 매핑하여 타입 안전성 보장
      return notifications.map(doc => ({
        id: doc.id,
        userId: doc.userId,
        type: doc.type as 'lineup' | 'gametime' | 'cancel' | 'result', // 타입 확장
        gameId: doc.gameId,
        teamCode: doc.teamCode,
        sentAt: doc.sentAt,
        expiresAt: doc.expiresAt
      }));
    } catch (error) {
      console.error('오늘의 알림 히스토리 조회 실패:', error);
      return [];
    }
  }
}

export { client, db, connect };
