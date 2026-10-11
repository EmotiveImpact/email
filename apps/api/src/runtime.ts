import { createDb } from '@platform/db';
import { createAuth } from './auth.ts';
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
      sendRate: Number(env.SES_SEND_RATE ?? 10) || 10,
    },
  });
  const webOrigin = env.WEB_ORIGIN ?? 'http://localhost:5173';
  const authSecret = env.AUTH_SECRET ?? (env.NODE_ENV === 'production' ? undefined : 'dev-only-auth-secret-change-me-please');
  if (!authSecret) throw new Error('Set AUTH_SECRET in production.');
  // The web app serves /auth and /app from its own origin (proxied), so cookies stay first-party.
  const auth = createAuth({ db, engine, secret: authSecret, baseURL: env.AUTH_URL ?? webOrigin, webOrigin });
  return { db, pool, queue, engine, transport, port, auth, webOrigin };
}
