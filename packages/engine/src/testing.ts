/** Test helpers: a fresh, migrated Postgres database and an engine with in-memory queue and transport. */
import { createDb, sql } from '@platform/db';
import { migrateDb } from '@platform/db/migrate';
import { createEngine, LogTransport, MemoryQueue, type Transport } from './index.ts';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://platform:platform@localhost:5432/platform_test';

/** A fresh, migrated database and an engine wired to an in-memory queue and transport. */
export async function setup(options: { transport?: Transport; fetch?: typeof fetch } = {}) {
  const { db, pool } = createDb(TEST_DATABASE_URL);
  await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
  await migrateDb(db);
  const transport = options.transport ?? new LogTransport();
  const queue = new MemoryQueue();
  const engine = createEngine({
    db,
    transport,
    queue,
    fetch: options.fetch,
    config: { publicUrl: 'https://api.test', signingSecret: 'test-secret', defaultFrom: 'hello@platform.test' },
  });
  const { accountId, appId } = await engine.createAccountWithApp({ account: 'Emotive Impact', app: 'Saleane' });
  const { key } = await engine.createApiKey(appId, 'test');
  const app = await engine.authenticate(key);
  const tenant = await engine.upsertTenant(appId, 'linden', { name: 'Linden Studio', fromEmail: 'news@linden.test' });
  const drain = () => queue.drain((name, data) => engine.runJob(name, data));
  return { db, pool, engine, transport, queue, app, accountId, appId, tenant, key, drain, close: () => pool.end() };
}
