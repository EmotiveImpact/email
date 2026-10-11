/**
 * Creates a demo account with Saleane and Caleane as apps, a studio tenant in each, API keys,
 * and some sent email. Prints the keys and the DEV_DASHBOARD_APP_ID to put in .env.
 */
import { boot } from './runtime.ts';

const { engine, queue, pool } = await boot();
const { appId: saleane } = await engine.createAccountWithApp({ account: 'Emotive Impact', app: 'Saleane' });
const { appId: caleane } = await engine.createAccountWithApp({ account: 'Emotive Impact (Caleane)', app: 'Caleane' });

await engine.upsertTenant(saleane, 'linden', { name: 'Linden Studio', fromEmail: 'news@linden.example', brand: { accent: '#D9481F', rail: 'pigment', headingFont: 'cal-sans' } });
await engine.upsertTenant(caleane, 'harbour-films', { name: 'Harbour Films', fromEmail: 'hello@harbourfilms.example', brand: { accent: '#4B4FD8', rail: 'light' } });

const saleaneKey = await engine.createApiKey(saleane, 'Saleane server');
const caleaneKey = await engine.createApiKey(caleane, 'Caleane server');
const app = await engine.authenticate(saleaneKey.key);

const clients = [
  ['ama@example.com', 'Ama', 'granted'],
  ['kofi@example.com', 'Kofi', 'granted'],
  ['maya@example.com', 'Maya', 'withdrawn'],
  ['lena@example.com', 'Lena', 'granted'],
] as const;
for (const [email, firstName, marketing] of clients) {
  await engine.upsertContact(app, { tenant: 'linden', email, firstName, consent: { marketing, source: 'seed' } });
}
for (const [email] of clients) {
  await engine.sendEmail(app, { tenant: 'linden', to: email, subject: 'Your facial is on Thursday at 10:00', text: 'See you then.' });
  await engine.sendEmail(app, { tenant: 'linden', stream: 'marketing', to: email, subject: 'Thursday has space for you', html: '<p>Three slots left this Thursday.</p>' });
}
await engine.recordEvent(app, { tenant: 'linden', name: 'booking.created', email: 'ama@example.com', properties: { treatment: 'Facial', slot: '2026-10-16T10:00:00Z' } });

console.log(`
Seeded. Add these to .env:
  DEV_DASHBOARD_APP_ID=${saleane}

API keys (shown once):
  Saleane: ${saleaneKey.key}
  Caleane: ${caleaneKey.key}
`);
await queue.stop();
await pool.end();
