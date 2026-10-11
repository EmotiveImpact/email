import { serve } from '@hono/node-server';
import { createApi } from './app.ts';
import { boot } from './runtime.ts';

const { db, engine, queue, transport, port, auth, webOrigin } = await boot();

const api = createApi({
  engine,
  db,
  webOrigin,
  auth,
  sesTopicArn: process.env.SES_TOPIC_ARN,
});

// The API and the queue worker share a process for now; split them when volume asks for it.
await queue.work((name, data) => engine.runJob(name, data));
// Flows check the diary every hour, a few minutes past, for every business with one switched on.
await queue.schedule('run-flows', '5 * * * *', {});

serve({ fetch: api.fetch, port }, () => {
  console.log(`API on http://localhost:${port} · sending with "${transport.name}" transport`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await queue.stop();
    process.exit(0);
  });
}
