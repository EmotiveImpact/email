import { serve } from '@hono/node-server';
import { createApi } from './app.ts';
import { boot } from './runtime.ts';

const { db, engine, queue, transport, port } = await boot();

const api = createApi({
  engine,
  db,
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  sesTopicArn: process.env.SES_TOPIC_ARN,
  devDashboardAppId: process.env.NODE_ENV === 'production' ? undefined : process.env.DEV_DASHBOARD_APP_ID,
});

// The API and the queue worker share a process for now; split them when volume asks for it.
await queue.work((name, data) => engine.runJob(name, data));

serve({ fetch: api.fetch, port }, () => {
  console.log(`API on http://localhost:${port} · sending with "${transport.name}" transport`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await queue.stop();
    process.exit(0);
  });
}
