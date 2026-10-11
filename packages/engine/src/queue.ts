import { PgBoss } from 'pg-boss';

export type Jobs = {
  'send-message': { messageId: string };
  'deliver-webhook': { deliveryId: string };
};
export type JobName = keyof Jobs;
export const JOB_NAMES: JobName[] = ['send-message', 'deliver-webhook'];

export interface Queue {
  enqueue<N extends JobName>(name: N, data: Jobs[N]): Promise<void>;
}

/** Collects jobs so tests (and scripts) can run them by hand with `drain`. */
export class MemoryQueue implements Queue {
  readonly jobs: { name: JobName; data: Jobs[JobName] }[] = [];

  async enqueue<N extends JobName>(name: N, data: Jobs[N]) {
    this.jobs.push({ name, data });
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

  async enqueue<N extends JobName>(name: N, data: Jobs[N]) {
    await this.boss.send(name, data);
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
