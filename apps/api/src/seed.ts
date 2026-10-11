/**
 * Demo data: the Emotive Impact account with Saleane and Caleane as apps, a studio in each,
 * sixty salon clients with booking history, a month of sent email, and a person who can sign in.
 * Run it on an empty database (`pnpm db:migrate` first).
 */
import { members, messages, newId } from '@platform/db';
import { boot } from './runtime.ts';

const { db, engine, queue, pool, auth } = await boot();

const { accountId, appId: saleane } = await engine.createAccountWithApp({ account: 'Emotive Impact', app: 'Saleane' });
const caleane = (await engine.createApp(accountId, 'Caleane')).id;

const linden = await engine.upsertTenant(saleane, 'linden', {
  name: 'Linden Studio',
  fromEmail: 'news@linden.example',
  brand: { accent: '#D9481F', rail: 'pigment', headingFont: 'cal-sans' },
});
const harbour = await engine.upsertTenant(caleane, 'harbour-films', { name: 'Harbour Films', fromEmail: 'hello@harbourfilms.example', brand: { accent: '#4B4FD8', rail: 'light' } });

const saleaneKey = await engine.createApiKey(saleane, 'Saleane server');
const caleaneKey = await engine.createApiKey(caleane, 'Caleane server');
const app = await engine.authenticate(saleaneKey.key);

// ---------------------------------------------------------------- clients and their bookings

let seed = 7;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000 - random() * 36_000_000).toISOString();

const FIRST = ['Ama', 'Kofi', 'Maya', 'Lena', 'Priya', 'Tom', 'Grace', 'Sam', 'Chloe', 'Ade', 'Hannah', 'Leo', 'Zara', 'Ben', 'Ife', 'Ruth', 'Omar', 'Erin', 'Jade', 'Theo'];
const LAST = ['Mensah', 'Owusu', 'Patel', 'Clarke', 'Hughes', 'Okafor', 'Bennett', 'Shah', 'Evans', 'Adeyemi', 'Wright', 'Khan'];
const TREATMENTS = ['Facial', 'Massage', 'Brows', 'Nails', 'Lashes'] as const;
const STYLISTS = ['Maya', 'Jo', 'Priya'] as const;

for (let i = 0; i < 60; i++) {
  const firstName = FIRST[i % FIRST.length]!;
  const lastName = pick(LAST);
  const email = `${firstName}.${lastName}${i}@example.com`.toLowerCase();
  // Each client has a rhythm: some come every three weeks, some every couple of months.
  const rhythm = pick([21, 28, 35, 42, 56, 90]);
  const lastVisit = Math.floor(random() * rhythm * 1.8);
  const visits = 1 + Math.floor(random() * 8);
  const consent = random() < 0.72 ? 'granted' : random() < 0.5 ? 'withdrawn' : undefined;
  await engine.upsertContact(app, {
    tenant: 'linden',
    email,
    firstName,
    lastName,
    attributes: { treatment: pick(TREATMENTS), stylist: pick(STYLISTS), visits, spend: visits * (40 + Math.floor(random() * 50)) },
    ...(consent && { consent: { marketing: consent, source: random() < 0.6 ? 'saleane:booking-form' : 'saleane:front-desk' } }),
  });
  for (let v = 0; v < visits; v++) {
    await engine.recordEvent(app, { tenant: 'linden', name: 'booking.created', email, occurredAt: daysAgo(lastVisit + v * rhythm), properties: { treatment: pick(TREATMENTS) } });
  }
  if (random() < 0.15) await engine.recordEvent(app, { tenant: 'linden', name: 'booking.cancelled', email, occurredAt: daysAgo(Math.floor(random() * 60)) });
}
await engine.ensureStarterSegments(linden.id);
await engine.ensureStarterSegments(harbour.id);

// ---------------------------------------------------------------- a month of sending

const subjects = [
  ['transactional', 'Your appointment is confirmed'],
  ['transactional', 'See you tomorrow at 10:00'],
  ['transactional', 'Your receipt from Linden Studio'],
  ['marketing', 'Thursday has space for you'],
  ['marketing', 'Autumn treatments are here'],
] as const;
const history: (typeof messages.$inferInsert)[] = [];
for (let ago = 30; ago >= 1; ago--) {
  const weekend = new Date(Date.now() - ago * 86_400_000).getUTCDay() % 6 === 0;
  const count = Math.round((weekend ? 6 : 14) + random() * 8 + (30 - ago) * 0.35);
  for (let i = 0; i < count; i++) {
    const [stream, subject] = pick(subjects);
    const roll = random();
    const status = roll < 0.012 ? 'bounced' : roll < 0.014 ? 'complained' : roll < 0.03 ? 'suppressed' : 'delivered';
    const at = new Date(Date.now() - ago * 86_400_000 + random() * 36_000_000);
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
await engine.sendEmail(app, { tenant: 'linden', to: 'ama.mensah0@example.com', subject: 'Your facial is on Thursday at 10:00', text: 'See you then.' });

// ---------------------------------------------------------------- someone to sign in as

const email = 'demo@example.com';
const password = 'linden-demo-2026';
const { user } = await auth.api.signUpEmail({ body: { name: 'Edem', email, password } });
await db.insert(members).values({ id: newId('mem'), organizationId: accountId, userId: user.id, role: 'owner' });

console.log(`
Seeded. Sign in at http://localhost:5173 with
  ${email} / ${password}

API keys (shown once):
  Saleane: ${saleaneKey.key}
  Caleane: ${caleaneKey.key}
`);
await queue.stop();
await pool.end();
