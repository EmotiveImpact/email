# Decisions

One entry per real choice: what we picked, what else we considered, and why. Newest at the bottom of each section. Anything here can be revisited; the "Revisit if" line says when it would be worth it.

## Product

### D1. One platform, three doors
- **Picked:** a single engine with three ways in: the API and SDK, a campaign studio embedded inside apps (Saleane, Caleane), and a standalone app.
- **Considered:** separate products per app; a standalone Mailchimp-style app only.
- **Why:** both apps already duplicate email plumbing, and the same engine then serves third-party apps too.
- **Revisit if:** one door needs a different data model from the others.

### D2. Managed sending first, bring-your-own-AWS optional
- **Picked:** we own the SES account and give each business its own SES tenant.
- **Considered:** customers connect their own AWS account (BYOK) as the default.
- **Why:** SES tenant management pauses only the offending tenant, so one bad sender no longer risks everyone, and it is the only model that works when our own apps send for their studios.
- **Revisit if:** a large customer insists on its own AWS account (we add BYOK as an option, not a replacement).

### D3. One standard look, customisable per business
- **Picked:** Home v2 as the default (Ember accent, pigment rail, Cal Sans headings, Inter text). Each tenant can change accent, rail and heading font, stored on the tenant as `brand`.
- **Considered:** fully themeable white-label from day one; no customisation.
- **Why:** a strong default looks finished; three tokens are enough for a business to feel it is theirs, without a redesign.
- **Revisit if:** embedding partners need more (logo placement, radius, dark mode).

## Stack

### D4. Vite + React 19 for the app (not Next.js)
- **Picked:** Vite 8, React 19, TanStack Router, TanStack Query, Tailwind 4.
- **Considered:** Next.js App Router (first proposal).
- **Why:** Edem asked for Vite, and Saleane and Caleane both use Vite with React 19, so components and people move between the three easily. The app is a dashboard behind sign-in, so server rendering buys little.

### D5. Hono API on Node
- **Picked:** Hono 4 with `@hono/node-server`.
- **Considered:** Express, Fastify, Next.js route handlers.
- **Why:** small, typed, standards-based (`Request`/`Response`), and the same code runs on AWS Lambda next to SES if we move it there. Tests call `app.request()` with no network.

### D6. Postgres with Drizzle ORM
- **Picked:** Postgres 16, Drizzle ORM and drizzle-kit migrations.
- **Considered:** Prisma, Kysely, Supabase client.
- **Why:** SQL-shaped, light, no code generation step, and plain migrations we can read. Any Postgres host works (Supabase, Neon, RDS).

### D7. Queue on Postgres with pg-boss
- **Picked:** pg-boss 12.
- **Considered:** BullMQ (needs Redis), SQS (another AWS piece to run), graphile-worker.
- **Why:** no extra infrastructure; jobs live in the same database, with retries and backoff built in. The engine talks to a small `Queue` interface, so SQS can replace it later.
- **Revisit if:** sending volume makes Postgres the bottleneck.

### D8. TypeScript 6, not 7
- **Picked:** TypeScript 6.0.
- **Considered:** TypeScript 7 (the new native compiler, latest on npm).
- **Why:** Saleane is on 6; tooling around 7 is still settling.

## Engine behaviour

### D9. Every email is stored before it is sent
- **Picked:** `POST /v1/emails` stores the message, queues it and answers 202 straight away. A worker sends it.
- **Why:** the caller never waits on SES, retries are safe, and every email has a history.

### D10. Idempotency keys per tenant
- **Picked:** an optional `Idempotency-Key` header (or `idempotencyKey` field); the same key from the same tenant returns the first email instead of sending twice. Enforced by a unique index, so a race cannot double-send.

### D11. Suppression rules
- **Picked:**
  - permanent bounce: suppressed for **every** tenant (protects shared reputation);
  - complaint: marketing stops for **that** tenant and consent is withdrawn; reminders and receipts still go;
  - unsubscribe: marketing stops for that tenant only;
  - a new recorded opt-in lifts an earlier unsubscribe for that tenant.
- **Considered:** suppressing complaints for all mail.
- **Why:** a client who marks a newsletter as spam still needs their booking reminder.
- **Revisit if:** complaint rates on transactional mail climb.

### D12. Marketing needs recorded consent
- **Picked:** marketing email only goes to contacts whose latest consent is "granted". Consent history is append-only with its source and time.
- **Why:** UK GDPR and PECR; it also keeps complaint rates low.

### D13. Suppressed emails are stored, not rejected
- **Picked:** a blocked send returns 202 with `status: "suppressed"` and a `reason`.
- **Why:** the app can show staff exactly why a client did not get an email.

### D14. Statuses only move forward
- **Picked:** queued → sending → sent → delayed → delivered → bounced/complained/rejected/failed. A late "delivered" never hides an earlier bounce.

### D15. One-click unsubscribe (RFC 8058)
- **Picked:** marketing mail carries `List-Unsubscribe` and `List-Unsubscribe-Post`. The link page asks before unsubscribing on GET (so link scanners cannot unsubscribe people) and unsubscribes on POST (which is what Gmail and Yahoo's one-click sends). Tokens are HMAC-signed message ids.

### D16. SES events through SNS, verified
- **Picked:** SES configuration set → SNS topic → `POST /ses/events`. We verify the SNS signature ourselves (certificate must come from `sns.<region>.amazonaws.com`), optionally pin the topic ARN, and only confirm subscriptions to SNS URLs.
- **Considered:** EventBridge, Firehose.
- **Why:** SNS to HTTPS is the simplest path with no extra AWS code to deploy.

### D17. Outbound webhooks use Standard Webhooks
- **Picked:** the Standard Webhooks format (`webhook-id`, `webhook-timestamp`, `webhook-signature`), signed with the MIT `standardwebhooks` library, delivered and retried through the queue.
- **Why:** Saleane already verifies this exact format for Resend's webhooks, so it can reuse its verifier; any language has a library for it.

### D18. API keys are hashed
- **Picked:** keys look like `pk_live_…`, are shown once, and only their SHA-256 is stored, with a short prefix for display.

## App

### D19. Routes declared in code
- **Picked:** TanStack Router with routes written out in `router.tsx`.
- **Considered:** the file-based router plugin (generates a route tree at build time).
- **Why:** under ten routes, and no generated file to keep in step. Each route's loader fills the TanStack Query cache, so pages render with data and no spinners.
- **Revisit if:** the app passes about 25 routes.

### D20. Charts are hand-drawn SVG for now
- **Picked:** a small `AreaChart` component (smooth line, area fill, comparison line) that takes the accent from CSS.
- **Considered:** Recharts (in the register, MIT).
- **Why:** the Home chart is one line and one area; 40 lines of SVG beat a 100 kB dependency, and it matches the prototype exactly.
- **Revisit if:** we need tooltips, axes or several chart types (Reports, campaign results). Then Recharts.

### D21. Fonts are self-hosted
- **Picked:** Fontsource packages bundled with the app (Cal Sans, Inter, Geist, Newsreader, all OFL).
- **Considered:** loading from Google Fonts.
- **Why:** no request to Google from a logged-in dashboard (a Munich court ruled in 2022 that hot-linking Google Fonts passes visitors' IP addresses to Google without consent), and the fonts work offline and inside other apps.

### D22. Any accent colour stays readable
- **Picked:** five tuned presets plus "your own colour". For a custom colour we mix the tint, light and deep shades, and darken the text shade until it passes WCAG AA (4.5:1) on white. Buttons in the accent switch to dark text when the accent is pale.
- **Why:** a business can pick its brand yellow without making the app unreadable.

### D23. Appearance previews live across the whole app
- **Picked:** while the Appearance page is open, the shell shows the draft brand everywhere; leaving the page without saving drops it.
- **Why:** you judge a colour on the real Home page, not on a swatch.

### D24. Local dashboard without sign-in, until stage 2
- **Picked:** the API serves `/app/*` for one app (`DEV_DASHBOARD_APP_ID`) and only outside production. Sign-in (Better Auth with organisations) replaces it in stage 2.
- **Why:** lets the app shell be built and seen against real data now, without building auth twice.

### D25. Sending health shown against the real limits
- **Picked:** Home shows inbox, bounce and spam rates, measured on emails that actually left. Bounce: good under 2%, warning to 5% (where Amazon starts a review). Spam: good under 0.1%, warning to 0.3% (where Gmail and Yahoo start rejecting).
- **Why:** these are the numbers that get a sender suspended; a business should see them before Amazon does.

### D26. Sample diary until the diary sync exists
- **Picked:** Home has the "Your next 7 days" panel from day one, marked "Sample diary", with real data once Saleane's bookings flow in (stage 6).
- **Why:** the diary is the product's point of difference, so Home is shaped around it now rather than redesigned later.
