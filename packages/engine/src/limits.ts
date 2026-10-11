/**
 * Rate limits: a fixed-window counter per key, shared by every container through Postgres (D114).
 * One small upsert per request; old windows are simply overwritten.
 */
import { rateLimits, sql, type Db } from '@platform/db';
import { PlatformError } from './types.ts';

export type Limit = { limit: number; windowSeconds: number };

/** The limits the API applies. Generous for real use, tight enough to stop a script. */
export const LIMITS = {
  /** Every /v1 call, per API key. */
  apiKey: { limit: 1200, windowSeconds: 60 },
  /** Transactional emails per business (marketing is held to the plan instead). */
  transactional: { limit: 5000, windowSeconds: 3600 },
  /** Every /app call, per signed-in person or studio session. */
  dashboard: { limit: 600, windowSeconds: 60 },
  /** Sign-in attempts per IP address. */
  signIn: { limit: 20, windowSeconds: 600 },
  /** New accounts per IP address. */
  signUp: { limit: 5, windowSeconds: 3600 },
  /** Password reset emails per IP address. */
  reset: { limit: 5, windowSeconds: 3600 },
} satisfies Record<string, Limit>;

export function createLimits(db: Db) {
  /** Counts one hit. Throws `rate_limited` (429) with seconds to wait when over the limit. */
  async function hit(key: string, { limit, windowSeconds }: Limit, now = new Date()) {
    const start = new Date(Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000);
    const result = await db.execute<{ count: number }>(sql`
      insert into ${rateLimits} (key, window_start, count) values (${key}, ${start}, 1)
      on conflict (key) do update set
        count = case when ${rateLimits.windowStart} = excluded.window_start then ${rateLimits.count} + 1 else 1 end,
        window_start = excluded.window_start
      returning count`);
    const count = Number(result.rows[0]?.count ?? 0);
    if (count > limit) {
      const retryAfter = Math.max(1, Math.ceil((start.getTime() + windowSeconds * 1000 - now.getTime()) / 1000));
      throw new PlatformError('rate_limited', `Too many requests. Try again in ${retryAfter} seconds.`, 429, { retryAfter });
    }
    return { count, limit };
  }
  return { hit };
}
