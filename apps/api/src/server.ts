import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { apps } from '@platform/db';
import { runMigrations } from '@platform/db/migrate';
import { createApi } from './app.ts';
import { boot } from './runtime.ts';
import { site } from './web.ts';

/**
 * ROLE=all (default) runs the API and the job worker in one process. In production they can run as
 * separate services from the same image: ROLE=web answers requests, ROLE=worker sends and runs flows.
 */
const role = (process.env.ROLE ?? 'all') as 'all' | 'web' | 'worker';
if (process.env.MIGRATE_ON_START === 'true') {
  // Neon's pooled address cannot hold the migration lock, so migrations use the direct one when given.
  await runMigrations(process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL!);
  console.log('Migrations applied.');
}

const { db, engine, queue, transport, port, auth, webOrigin } = await boot();

if (role !== 'web') {
  await queue.work((name, data) => engine.runJob(name, data));
  // Flows check the diary every hour, a few minutes past, for every business with one switched on.
  await queue.schedule('run-flows', '5 * * * *', {});
}

let server: ReturnType<typeof serve> | null = null;
if (role !== 'worker') {
  const api = createApi({ engine, db, webOrigin, auth, sesTopicArn: process.env.SES_TOPIC_ARN });
  // In production the built web app is served from here too (one origin, D30).
  const dist = process.env.WEB_DIST || fileURLToPath(new URL('../../web/dist', import.meta.url));
  const root = site(api, {
    https: webOrigin.startsWith('https://'),
    dist: process.env.NODE_ENV === 'production' && existsSync(dist) ? dist : undefined,
    embedOrigins: async () => (await db.select({ origins: apps.embedOrigins }).from(apps)).flatMap((a) => a.origins),
  });
  server = serve({ fetch: root.fetch, port }, () => {
    console.log(`API on http://localhost:${port} · ${role} · sending with "${transport.name}" transport`);
  });
} else {
  console.log(`Worker running · sending with "${transport.name}" transport`);
}

// A deploy sends SIGTERM: stop taking requests, let running jobs finish, then exit.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    server?.close();
    await queue.stop();
    process.exit(0);
  });
}
