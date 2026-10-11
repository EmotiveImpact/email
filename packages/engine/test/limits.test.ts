import { afterEach, expect, it } from 'vitest';
import { createLimits } from '../src/limits.ts';
import { setup } from '../src/testing.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

it('counts hits per key and window, and says how long to wait', async () => {
  const ctx = await setup();
  close = ctx.close;
  const { hit } = createLimits(ctx.db);
  const at = new Date('2026-10-11T12:00:10Z');
  const limit = { limit: 2, windowSeconds: 60 };
  await hit('ip:1', limit, at);
  await hit('ip:1', limit, at);
  await expect(hit('ip:1', limit, at)).rejects.toMatchObject({ code: 'rate_limited', status: 429, details: { retryAfter: 50 } });
  // Someone else, or the next minute, starts afresh.
  await expect(hit('ip:2', limit, at)).resolves.toMatchObject({ count: 1 });
  await expect(hit('ip:1', limit, new Date('2026-10-11T12:01:00Z'))).resolves.toMatchObject({ count: 1 });
});
