# Email platform

Email for appointment businesses, sent through Amazon SES. One engine serves three doors: an API your apps call, a campaign studio embedded inside those apps (Saleane, Caleane), and a standalone app.

- `docs/decisions.md` lists every real choice made so far, what else was considered, and when to revisit it.
- `docs/open-source.md` is the register of open-source projects checked, with licences and verdicts.

## What is here

| Path | What it is |
|---|---|
| `packages/db` | Postgres schema (Drizzle), migrations, ids |
| `packages/engine` | Sending: validation, consent and suppression rules, queue, SES transport, SES events, webhooks, unsubscribe |
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
pnpm db:seed          # a demo studio, sixty clients, a month of email, and two API keys
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

## SES setup

1. Verify the sending domain in SES (eu-west-2) and create a configuration set, `platform-events`.
2. Add an event destination to the set: SNS topic, events Send, Delivery, Bounce, Complaint, Reject, Delivery delay, Rendering failure.
3. Subscribe `https://<api>/ses/events` to the topic over HTTPS. The API confirms the subscription itself. Set `SES_TOPIC_ARN` to only accept that topic.

## Tests

```sh
pnpm test        # needs the platform_test database
pnpm typecheck
```

Engine and API tests run against a real Postgres, recreated for every test.
