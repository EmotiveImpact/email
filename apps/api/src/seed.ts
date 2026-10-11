/**
 * Creates a demo account with Saleane and Caleane as apps, a studio tenant in each, API keys,
 * and some sent email. Prints the keys and the DEV_DASHBOARD_APP_ID to put in .env.
 */
import { messages, newId } from '@platform/db';
import { boot } from './runtime.ts';

const { db, engine, queue, pool } = await boot();
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
// Thirty days of past sending, so Home and Sending look like a studio that has been live a while.
const linden = await engine.getTenant(saleane, 'linden');
const subjects = [
  ['transactional', 'Your appointment is confirmed'],
  ['transactional', 'See you tomorrow at 10:00'],
  ['transactional', 'Your receipt from Linden Studio'],
  ['marketing', 'Thursday has space for you'],
  ['marketing', 'Autumn treatments are here'],
] as const;
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const history: (typeof messages.$inferInsert)[] = [];
for (let daysAgo = 30; daysAgo >= 1; daysAgo--) {
  const weekend = new Date(Date.now() - daysAgo * 86_400_000).getUTCDay() % 6 === 0;
  const count = Math.round((weekend ? 6 : 14) + random() * 8 + (30 - daysAgo) * 0.35);
  for (let i = 0; i < count; i++) {
    const [stream, subject] = subjects[Math.floor(random() * subjects.length)]!;
    const roll = random();
    const status = roll < 0.012 ? 'bounced' : roll < 0.014 ? 'complained' : roll < 0.03 ? 'suppressed' : 'delivered';
    const at = new Date(Date.now() - daysAgo * 86_400_000 + random() * 36_000_000);
    history.push({
      id: newId('msg'),
      tenantId: linden.id,
      stream,
      to: `client${Math.floor(random() * 400)}@example.com`,
      from: 'Linden Studio <news@linden.example>',
      subject,
      text: 'Seeded history.',
      status,
      error: status === 'suppressed' ? (stream === 'marketing' ? 'no_marketing_consent' : 'hard_bounce') : null,
      createdAt: at,
      sentAt: status === 'suppressed' ? null : at,
    });
  }
}
await db.insert(messages).values(history);

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
