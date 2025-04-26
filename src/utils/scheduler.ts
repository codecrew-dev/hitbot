import schedule from 'node-schedule';

/**
 * 스케줄러 유틸리티 클래스
 * 특정 시간 또는 간격으로 작업을 실행하기 위한 함수들을 제공합니다.
 */
export class Scheduler {
  private static jobs: Map<string, schedule.Job> = new Map();
  private static jobsMetadata: Map<string, {
    type: 'once' | 'recurring',
    timestamp?: Date,
    cronExpression?: string,
    description?: string
  }> = new Map();

  /**
   * 특정 시간에 작업을 실행합니다
   * @param jobName 작업 식별자
   * @param cronExpression Cron 표현식 (예: '0 30 14 * * *' - 매일 14:30에 실행)
   * @param task 실행할 작업 함수
   * @param description 작업 설명 (선택)
   */
  static scheduleJob(jobName: string, cronExpression: string, task: () => void, description?: string): void {
    // 기존 작업이 있으면 취소
    this.cancelJob(jobName);
    
    // 새 작업 예약
    const job = schedule.scheduleJob(cronExpression, task);
    this.jobs.set(jobName, job);
    
    // 메타데이터 저장
    this.jobsMetadata.set(jobName, {
      type: 'recurring',
      cronExpression,
      description
    });
    
    console.log(`작업 예약됨: ${jobName}, 다음 실행: ${job.nextInvocation()}`);
  }

  /**
   * 특정 시간에 한 번만 실행되는 작업을 예약합니다
   * @param jobName 작업 식별자
   * @param date 실행할 시간
   * @param task 실행할 작업 함수
   * @param description 작업 설명 (선택)
   */
  static scheduleOnce(jobName: string, date: Date, task: () => void, description?: string): void {
    // 기존 작업이 있으면 취소
    this.cancelJob(jobName);
    
    // 날짜가 과거인지 확인
    if (date.getTime() <= Date.now()) {
      console.log(`스케줄링 실패: ${jobName}, 과거 시간으로 예약할 수 없습니다`);
      return;
    }
    
    // 한 번만 실행하는 작업 예약
    const job = schedule.scheduleJob(date, () => {
      task();
      this.jobs.delete(jobName); // 실행 후 작업 목록에서 제거
      this.jobsMetadata.delete(jobName); // 메타데이터도 제거
    });
    
    this.jobs.set(jobName, job);
    
    // 메타데이터 저장
    this.jobsMetadata.set(jobName, {
      type: 'once',
      timestamp: date,
      description
    });
    
    console.log(`일회성 작업 예약됨: ${jobName}, 실행 시간: ${date}`);
  }

  /**
   * 지정된 간격으로 반복 실행되는 작업을 예약합니다
   * @param jobName 작업 식별자
   * @param minutes 실행 간격(분)
   * @param task 실행할 작업 함수
   */
  static scheduleInterval(jobName: string, minutes: number, task: () => void): void {
    // 기존 작업이 있으면 취소
    this.cancelJob(jobName);
    
    // 분 단위로 Cron 표현식 생성
    const cronExpression = `*/${minutes} * * * *`;
    const job = schedule.scheduleJob(cronExpression, task);
    
    this.jobs.set(jobName, job);
    console.log(`주기적 작업 예약됨: ${jobName}, 간격: ${minutes}분, 다음 실행: ${job.nextInvocation()}`);
  }

  /**
   * 예약된 작업을 취소합니다
   * @param jobName 취소할 작업 식별자
   */
  static cancelJob(jobName: string): void {
    const job = this.jobs.get(jobName);
    if (job) {
      job.cancel();
      this.jobs.delete(jobName);
      this.jobsMetadata.delete(jobName);
      console.log(`작업 취소됨: ${jobName}`);
    }
  }

  /**
   * 모든 예약 작업을 취소합니다
   */
  static cancelAllJobs(): void {
    for (const [jobName, job] of this.jobs.entries()) {
      job.cancel();
      console.log(`작업 취소됨: ${jobName}`);
    }
    this.jobs.clear();
    this.jobsMetadata.clear();
    console.log('모든 작업이 취소되었습니다');
  }

  /**
   * 현재 스케줄된 모든 작업 목록을 반환합니다
   */
  static listJobs(): { name: string, nextRun: Date | null, type: string, description?: string }[] {
    return Array.from(this.jobs.entries()).map(([name, job]) => {
      const metadata = this.jobsMetadata.get(name) || { type: 'unknown' };
      return {
        name,
        nextRun: job.nextInvocation() || null,
        type: metadata.type,
        // 타입 안전하게 description 속성에 접근
        description: 'description' in metadata ? metadata.description : undefined
      };
    });
  }
}
