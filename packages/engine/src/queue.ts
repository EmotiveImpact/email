import { PgBoss } from 'pg-boss';

export type Jobs = {
  'send-message': { messageId: string };
  'deliver-webhook': { deliveryId: string };
  'send-campaign': { campaignId: string };
};
export type JobName = keyof Jobs;
export const JOB_NAMES: JobName[] = ['send-message', 'deliver-webhook', 'send-campaign'];

export type EnqueueOptions = {
  /** Do not run before this time. Used to pace campaign sends and to schedule campaigns. */
  startAfter?: Date;
};

export interface Queue {
  enqueue<N extends JobName>(name: N, data: Jobs[N], options?: EnqueueOptions): Promise<void>;
  /** Many jobs of one kind in one round trip. */
  enqueueMany<N extends JobName>(name: N, jobs: { data: Jobs[N]; startAfter?: Date }[]): Promise<void>;
}

/** Collects jobs so tests (and scripts) can run them by hand with `drain`. */
export class MemoryQueue implements Queue {
  readonly jobs: { name: JobName; data: Jobs[JobName]; startAfter?: Date }[] = [];

  async enqueue<N extends JobName>(name: N, data: Jobs[N], options: EnqueueOptions = {}) {
    this.jobs.push({ name, data, startAfter: options.startAfter });
  }

  async enqueueMany<N extends JobName>(name: N, jobs: { data: Jobs[N]; startAfter?: Date }[]) {
    for (const job of jobs) this.jobs.push({ name, data: job.data, startAfter: job.startAfter });
  }

  /** Runs queued jobs (including ones queued while running) until none are left. */
  async drain(run: (name: JobName, data: Jobs[JobName]) => Promise<void>) {
    while (this.jobs.length) {
      const job = this.jobs.shift()!;
      await run(job.name, job.data);
    }
  }
}

/**
 * Durable queue on the same Postgres database, via pg-boss (MIT). No Redis or SQS to run.
 * Retries use exponential backoff; jobs that keep failing land in pg-boss's failed state.
 */
export class PgBossQueue implements Queue {
  private constructor(readonly boss: PgBoss) {}

  static async start(connectionString: string) {
    const boss = new PgBoss({ connectionString });
    boss.on('error', (error) => console.error('[queue]', error));
    await boss.start();
    for (const name of JOB_NAMES) {
      await boss.createQueue(name, { retryLimit: 8, retryDelay: 15, retryBackoff: true });
    }
    return new PgBossQueue(boss);
  }

  async enqueue<N extends JobName>(name: N, data: Jobs[N], options: EnqueueOptions = {}) {
    await this.boss.send(name, data, options.startAfter ? { startAfter: options.startAfter } : undefined);
  }

  async enqueueMany<N extends JobName>(name: N, jobs: { data: Jobs[N]; startAfter?: Date }[]) {
    for (let i = 0; i < jobs.length; i += 1000) await this.boss.insert(name, jobs.slice(i, i + 1000));
  }

  async work(run: (name: JobName, data: Jobs[JobName]) => Promise<void>, concurrency = 5) {
    for (const name of JOB_NAMES) {
      await this.boss.work<Jobs[typeof name]>(name, { batchSize: 1, localConcurrency: concurrency }, async (jobs) => {
        for (const job of jobs) await run(name, job.data);
      });
    }
  }

  stop() {
    return this.boss.stop({ graceful: true });
  }
}
