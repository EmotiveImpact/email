# Email platform

Email for appointment businesses, sent through Amazon SES. One engine serves three doors: an API your apps call, a campaign studio embedded inside those apps (Saleane, Caleane), and a standalone app.

- `docs/decisions.md` lists every real choice made so far, what else was considered, and when to revisit it.
- `docs/open-source.md` is the register of open-source projects checked, with licences and verdicts.

## What is here

| Path | What it is |
|---|---|
| `packages/db` | Postgres schema (Drizzle), migrations, ids |
| `packages/content` | Email content: the block format, the React Email renderer, merge tags |
| `packages/engine` | Sending: validation, consent and suppression rules, queue, SES transport, SES events, webhooks, unsubscribe, audience and segments, campaigns |
| `packages/sdk` | TypeScript client for the API and a webhook verifier |
| `apps/api` | Hono API: `/v1` for apps, `/ses/events` for SES, `/u/:token` unsubscribe pages, `/auth` sign-in (Better Auth), `/app` for the web app |
| `apps/web` | The app: Vite, React 19, TanStack Router and Query, Tailwind 4 |

## Run it locally

You need Node 22, pnpm 10 and Postgres 16.

```sh
createuser -s platform && psql -c "alter user platform password 'platform'"
createdb -O platform platform && createdb -O platform platform_test

pnpm install
cp .env.example .env
pnpm db:migrate
pnpm db:seed          # a demo studio, sixty clients, a month of email, three campaigns and two API keys
pnpm dev              # API on :8787, app on :5173
```

Sign in at http://localhost:5173 as `demo@example.com` with the password `linden-demo-2026`, or create a new login.

With `TRANSPORT=log` nothing leaves your machine: emails are stored and marked sent. Set `TRANSPORT=ses` with AWS credentials in the environment to send for real.

## Send an email

```ts
import { PlatformClient } from '@platform/sdk';

const email = new PlatformClient({ apiKey: process.env.PLATFORM_API_KEY!, baseUrl: 'http://localhost:8787' });
await email.emails.send({
  tenant: 'linden',
  to: 'ama@example.com',
  subject: 'See you Thursday at 10:00',
  html: '<p>See you then.</p>',
  idempotencyKey: 'booking-1042-reminder',
});
```

Marketing email (`stream: 'marketing'`) only goes to contacts with recorded consent, carries one-click unsubscribe headers, and is held back for anyone who unsubscribed or complained. Reminders and receipts (`transactional`, the default) still go.

## Send your diary

Flows need your bookings and free time. Send each booking when it is made or changes, and the free slots for the next fortnight whenever your diary changes:

```ts
await email.appointments.upsert({
  tenant: 'linden',
  id: booking.id, // your id; sending it again updates the booking
  email: client.email,
  startsAt: booking.start,
  service: 'Balayage',
  price: 9500, // pence
  status: 'booked', // or completed, cancelled, no_show
});

await email.availability.set({
  tenant: 'linden',
  from: today,
  to: inTwoWeeks,
  slots: freeSlots.map((s) => ({ startsAt: s.start, endsAt: s.end, staff: s.stylist })),
});
```

Give each business a booking link (`brand.bookingUrl`) and time zone (`timezone`, default Europe/London) with `email.tenants.put`, or in Appearance. Flows then run every hour: a thank-you after a first visit, due back, fill quiet days and we miss you. Owners switch them on under Flows. Free-time buttons open the booking link with `?at=<ISO time>`, so your booking page can preselect that slot.

## Put the studio inside your app

Allow your page's origin once, then create a session on your server whenever someone opens Email, and mount it in the page:

```ts
// server
await email.studio.setOrigins(['https://app.saleane.com']);
const { url } = await email.studio.createSession({
  tenant: 'linden',
  origin: 'https://app.saleane.com',
  user: { id: staff.id, name: staff.name, email: staff.email },
  theme: { accent: '#5E7D63', headingFont: 'serif', canvas: '#F6F1E7' },
});

// browser
import { mountStudio } from '@platform/sdk/browser';
mountStudio(document.getElementById('email')!, url, { onEvent: (e) => e.type === 'session-expired' && reopen() });
```

To try it locally, run `SALEANE_API_KEY=<key from db:seed> pnpm demo:host` and open http://localhost:3000, a stand-in for Saleane.

## SES setup

1. Verify the sending domain in SES (eu-west-2) and create a configuration set, `platform-events`.
2. Add an event destination to the set: SNS topic, events Send, Delivery, Bounce, Complaint, Reject, Delivery delay, Rendering failure, Open and Click. Open and click tracking also needs a custom tracking domain on the set (or SES's default one).
3. Set `SES_SEND_RATE` to the account's maximum send rate; campaigns pace themselves to it.
4. Set `AWS_ACCOUNT_ID` so each business's domain is linked to its own SES tenant. Businesses verify their domains on the Sending domain screen (or partners use `POST /v1/tenants/:id/domains`); until then they send from `DEFAULT_FROM` under their own name.
5. Subscribe `https://<api>/ses/events` to the topic over HTTPS. The API confirms the subscription itself. Set `SES_TOPIC_ARN` to only accept that topic.

## Tests

```sh
pnpm test        # needs the platform_test database
pnpm typecheck
```

Engine and API tests run against a real Postgres, recreated for every test.
