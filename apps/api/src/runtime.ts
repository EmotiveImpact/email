import { createDb } from '@platform/db';
import { createEngine, LogTransport, PgBossQueue, SesTransport, type Transport } from '@platform/engine';

/** Builds the engine from environment variables. Shared by the server and the seed script. */
export async function boot(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Set DATABASE_URL (see .env.example).');
  const { db, pool } = createDb(databaseUrl);
  const transport: Transport = env.TRANSPORT === 'ses' ? SesTransport.fromEnv(env) : new LogTransport();
  const queue = await PgBossQueue.start(databaseUrl);
  const port = Number(env.PORT ?? 8787);
  const signingSecret = env.SIGNING_SECRET ?? (env.NODE_ENV === 'production' ? undefined : 'dev-only-signing-secret');
  if (!signingSecret) throw new Error('Set SIGNING_SECRET in production.');
  const engine = createEngine({
    db,
    transport,
    queue,
    config: {
      publicUrl: env.PUBLIC_URL ?? `http://localhost:${port}`,
      signingSecret,
      defaultFrom: env.DEFAULT_FROM ?? 'hello@example.com',
    },
  });
  return { db, pool, queue, engine, transport, port };
}
