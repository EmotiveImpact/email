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

## Stage 2

### D27. Sign-in runs inside our API with Better Auth
- **Picked:** Better Auth (MIT), mounted in the Hono API at `/auth`, storing users, sessions and logins in our own Postgres tables through Drizzle. Its organisations plugin is our "account": people belong to an account, and the account owns the apps and businesses.
- **Considered:** Neon Auth (Better Auth hosted by Neon, keeps its tables in a `neon_auth` schema), Clerk, Supabase Auth, Auth.js.
- **Why:** sign-in data sits next to everything else, in our migrations, on any Postgres host. Saleane's embedded studio will sign people in with tokens from Saleane, which is simplest when we run the sign-in code ourselves. Because Neon Auth is the same Better Auth underneath, moving to it later is small.
- **Revisit if:** we want hosted extras (social sign-in set-up, user management screens) without building them.

### D28. Neon hosts the database (London)
- **Picked:** Neon Postgres in AWS eu-west-2, next to SES.
- **Considered:** Supabase (earlier assumption), Amazon RDS.
- **Why:** plain Postgres, so nothing in the code changes. Neon adds a database branch per pull request for testing, and it scales down when idle, which keeps early costs low. Supabase's extras (its auth, storage, client library) are things we are not using.
- **Revisit if:** sending volume needs an always-on instance sized for heavy writes; RDS then.

### D29. An account is Better Auth's organisation
- **Picked:** Better Auth's organisation model is stored in our `accounts` table, so one account owns its people (members with roles), its apps (Saleane, Caleane, "Direct") and their businesses. Sign-in tables are named for what they hold (`users`, `sessions`, `logins`, `members`, `invitations`).
- **Considered:** a separate organisations table linked to accounts.
- **Why:** one idea, one table. Every account created from the app gets a "Direct" app, so a business with no software of its own sends the same way Saleane's studios do.

### D30. The web app and API share one origin
- **Picked:** the app calls `/app` and `/auth` on its own origin; Vite proxies them in development, and in production the same domain routes them to the API.
- **Why:** sign-in cookies stay first-party (no third-party cookie rules, no CORS preflights). The API still allows the app's origin with credentials if they are ever split.

### D31. Segments are rules, worked out when used
- **Picked:** a segment is saved as rules (consent, a detail, how often or when someone last did something, when they were added, their email), combined with all or any, and compiled to one SQL query each time it is counted or sent to.
- **Considered:** materialised membership tables updated by a background job (Dittofeed's approach, MIT, built on ClickHouse).
- **Why:** always current with no jobs to run, and Postgres handles studio-sized lists (thousands of people) in milliseconds with the event indexes. Every value is bound as a parameter, never spliced into SQL.
- **Revisit if:** a tenant passes about 100,000 contacts or segments need to trigger flows on entry; then materialise membership.

### D32. New businesses start with four segments
- **Picked:** "Happy to hear news", "Regulars" (3+ bookings in 180 days), "Due for a visit" (last booking over 42 days ago) and "New this month".
- **Why:** the first campaign should need no set-up. "Due for a visit" uses a fixed 42 days for now; stage 6 replaces it with each client's own rhythm from the diary.

### D33. Staff can add people, and their consent is recorded with who added it
- **Picked:** "Add person" records consent as `added-by:<staff email>` with the time, only when the tick box is ticked.
- **Why:** UK GDPR needs proof of consent; this shows who vouched for it.

## Stage 3: campaigns

### D34. Our own block editor, rendered with React Email
- **Picked:** an email is a short list of typed blocks (heading, text, button, image, divider, space) saved as JSON. The editor edits that list; React Email (MIT) turns it into HTML and plain text. One package, `@platform/content`, holds the blocks, the renderer and merge tags, and the API, the send job and the editor's preview all use it.
- **Considered:** Maily (React 19, but v2 is still beta and pulls in a large Tiptap tree), Easy Email (React 18 only), EmailBuilder.js (React 18 only, few releases), GrapesJS with MJML (BSD, but a heavy canvas that fights our look), Unlayer (hosted, proprietary editor behind an MIT wrapper).
- **Why:** appointment businesses send short, single-column emails. Six blocks cover them, every block renders safely in Outlook and Gmail, and owning the format means templates for the marketplace and flows later are plain data we control. The preview is the real send renderer, so what you see is what arrives.
- **Revisit if:** customers ask for columns, product grids or free-form layouts. Then add an MJML-backed "section" block, or adopt GrapesJS with `grapesjs-mjml` for a pro editor.

### D35. Light formatting instead of a rich-text editor
- **Picked:** text blocks take `**bold**`, `*italic*`, `[link](https://…)` and blank lines for paragraphs, parsed into React nodes (so everything else is escaped).
- **Considered:** Tiptap (MIT) for a toolbar editor.
- **Why:** no HTML from users reaches the email, so there is nothing to sanitise and no broken markup. It is fast to build and fine for owners who write a few lines.
- **Revisit if:** testing with salon owners shows the syntax trips them up; a small Tiptap toolbar can write the same format.

### D36. Render once, personalise per person
- **Picked:** a campaign renders once; `{{first_name|there}}` style merge tags are filled per recipient by string replacement, with values escaped for HTML. `{{unsubscribe_url}}` is filled at send time with each person's signed link.
- **Why:** rendering React once per recipient would cost seconds per thousand; replacement costs microseconds. Unknown tags (likely typos) block sending.

### D37. A campaign becomes one stored message per person
- **Picked:** sending expands the audience into rows in `messages` (with `campaign_id`), inserted 500 at a time, then queues one send job each. A unique index on campaign and recipient means a retried job never sends twice.
- **Why:** every email then has its own history, status, events and unsubscribe link, and campaign results are plain counts over messages. The send path is the same one the API uses.
- **Revisit if:** single campaigns pass about a million recipients; then expand lazily in batches as the queue drains.

### D38. Sends are paced to the SES account's rate
- **Picked:** each send job starts at `index / SES_SEND_RATE` seconds after the campaign starts (default 10 a second, set per environment).
- **Why:** SES throttles above the account's rate, and a smooth flow protects the shared sending reputation. pg-boss's `startAfter` does the waiting, so no extra scheduler.
- **Revisit if:** many tenants send at once; pacing should then be shared across campaigns (a token bucket per SES account).

### D39. Consent and suppression are checked twice
- **Picked:** the audience is filtered by consent and suppressions when the campaign expands, and each message is checked again just before it goes.
- **Why:** paced campaigns take a while; someone who unsubscribes from an earlier email in that window is held back, shown as "Not sent: they unsubscribed".

### D40. A campaign cannot go without a postal address
- **Picked:** "Review and send" blocks until the business adds a postal address in Appearance; the footer always has the address and an unsubscribe link, and the header carries one-click unsubscribe.
- **Why:** UK PECR and US CAN-SPAM expect the sender to be identifiable; Gmail and Yahoo require one-click unsubscribe for bulk senders. Making it impossible to forget beats a warning.

### D41. Drafts save themselves; only drafts can change
- **Picked:** the editor saves a moment after each change. Scheduled campaigns must be unscheduled to edit, and the send job checks the status again, so an unscheduled campaign's queued job does nothing.
- **Why:** nobody loses work, and nothing changes underneath a send in progress.

### D42. Headings load Cal Sans where inboxes allow
- **Picked:** emails declare Cal Sans from Google Fonts across a weight range and ask for bold headings.
- **Why:** Apple Mail and iOS show Cal Sans as designed; Gmail and Outlook ignore web fonts and fall back to a bold system face instead of a thin one.

## Stage 4: the studio inside Saleane and Caleane

### D43. The studio is the same app in an iframe
- **Picked:** a host app shows our campaign and audience screens in an iframe at `/embed`. It is the same web app and the same `/app` endpoints, with a slimmer frame (two tabs, no rail, business switcher or assistant).
- **Considered:** React components published as a package; a web component.
- **Why:** one codebase for both doors, nothing to version inside each host, and the host's own CSS cannot break ours. platform-direction.md planned iframe first.
- **Revisit if:** a host needs the studio mixed into its own pages (a campaign card on Saleane's dashboard). Then publish the pages as React components over the same API.

### D44. A one-time launch link, then a session token held in the tab
- **Picked:** the host's server calls `POST /v1/studio/sessions` with its API key, naming the business, the person and the page origin. It gets a URL whose fragment carries a launch token that works once, within five minutes. The studio swaps it for an eight-hour session token sent as `Authorization: Studio …`. Only hashes of both tokens are stored.
- **Considered:** signed JWTs with no database row; a cookie set inside the frame.
- **Why:** browsers block or partition third-party cookies, so a cookie in a frame is fragile; a header always works. A database row means a session can be ended at once (the person signs out of Saleane) and every session is auditable. The fragment keeps the token out of server and proxy logs.
- **Revisit if:** session lookups show up in latency; cache them briefly in memory.

### D45. A studio session reaches one business and nothing above it
- **Picked:** the same `/app` routes check that a studio session only touches its own business. Account settings, new businesses and the business's look are refused (the host owns those through the API).
- **Why:** one set of routes and tests, with the narrower rule enforced in one middleware.

### D46. Only origins the app allows may show the studio
- **Picked:** each app keeps a list of embed origins (`PUT /v1/studio/origins`); a session names the page origin and must match. The studio only posts messages to that origin, and the host helper only listens to the studio's origin.
- **Why:** stops someone else's page framing a business's studio. In production the page serving `/embed` should also send `Content-Security-Policy: frame-ancestors` with the app's origins, and every other page `frame-ancestors 'none'`; that comes with the deployment work.

### D47. The host's look, the business's emails
- **Picked:** a session carries the host's accent, heading font and page background (Saleane: sage, a serif, ivory). Emails keep the business's own brand.
- **Why:** inside Saleane the studio should read as part of Saleane, while the emails clients receive come from Linden Studio, not from Saleane.

### D48. Our own frame sizing instead of iframe-resizer
- **Picked:** the studio posts its content height; `mountStudio` in `@platform/sdk/browser` sets the frame height. About thirty lines.
- **Considered:** iframe-resizer (now GPL-3.0 or a paid licence from v5), Penpal (MIT, a full RPC layer).
- **Why:** we need four one-way events (ready, resize, session-expired, campaign.scheduled). Penpal is the step up if hosts need to call into the studio.

## Stage 5: sending domains and per-business protection

### D49. Every business is its own SES tenant from the start
- **Picked:** creating a business creates an SES tenant (`t-<id>`), and every email names it. Domains are linked to it when `AWS_ACCOUNT_ID` is set.
- **Why:** SES then measures and, if needed, pauses each business on its own reputation instead of the whole account (platform-direction.md section 4). Doing it from day one means no migration later.

### D50. Send from the platform address until the domain is verified
- **Picked:** a business with no verified domain sends as `Linden Studio <hello@platform>` with replies going to its own address. Once DKIM verifies, its own address takes over automatically. In production (`TRANSPORT=ses`) an explicit `from` on an unverified domain is refused.
- **Considered:** blocking all sending until a domain is verified.
- **Why:** a salon owner can send their first newsletter today and fix DNS later; nobody can send as a domain they do not own. Locally the rule is off, so the demo needs no DNS.

### D51. DKIM through SES Easy DKIM; DMARC checked and suggested, not required
- **Picked:** three CNAME records from SES, checked every five minutes for three days and on "Check now". We also look up `_dmarc` and suggest a report-only record (`p=none`).
- **Considered:** a custom MAIL FROM domain for SPF alignment.
- **Why:** DKIM alignment alone passes DMARC, and three CNAMEs is the least a salon owner can be asked to add. Gmail and Yahoo expect DMARC from bulk senders, so we nudge without blocking.
- **Revisit if:** customers need SPF alignment for strict receivers; add MAIL FROM records then.

### D52. A domain belongs to one business
- **Picked:** a domain can be set up by one business only; a second gets "already set up by another business".
- **Why:** SES identities are account-wide, so two businesses claiming one domain would sign each other's mail.

### D53. A reputation guard pauses one business before SES pauses everyone
- **Picked:** after each hard bounce or spam report we look at the business's last seven days. With at least 200 emails sent, more than 4% bounces or 0.2% spam reports pauses that business, says why in plain words, and sends a `tenant.paused` webhook. Queued email is held and goes again on "Resume sending".
- **Why:** SES reviews an account at 5% bounces or 0.1% complaints across everyone. One business with a bought list must not take Saleane's reminders down for every salon.
- **Revisit if:** the 0.2% complaint level proves too strict or loose with real data; it is a constant in `REPUTATION_LIMITS`.

### D54. Partners set up domains through the API too
- **Picked:** `GET/POST /v1/tenants/:id/domains`, `POST …/:domainId/check` and `DELETE`, plus `domain.verified` webhooks.
- **Why:** this is the Connect flow from platform-direction.md: a partner's own settings screen can show our DNS records without sending its customers to us.

## Stage 6: the diary, and flows that use it

### D55. The diary arrives through two plain API calls
- **Picked:** `PUT /v1/appointments` (one booking, keyed by the host's own id, sent again whenever it changes) and `PUT /v1/availability` (the free slots for a window, replacing what was there). Saleane and Caleane call them; so can any booking system.
- **Considered:** reading calendars (Google, iCal); reading Saleane's database directly.
- **Why:** the host already knows every booking and every gap. Replacing a whole window makes free time idempotent: the host never has to work out what changed.
- **Revisit if:** customers arrive on third-party booking systems (Fresha, Timely, Square). Write small adapters that call the same two endpoints.

### D56. A client's rhythm is the median gap between their own visits
- **Picked:** from two visits on, a client is due back at last visit plus the median gap between their visits (Postgres `percentile_cont`). A client with one visit uses a setting (six weeks by default). Shown on each contact as visits, usual gap, last visit and due date.
- **Considered:** an average per service; a learned prediction like Klaviyo's predicted next order date, which needs a large shop with hundreds of repeat buyers.
- **Why:** a salon has tens or hundreds of clients, not thousands, and the owner can check the maths by looking at the visits. The median ignores the one long holiday.
- **Revisit if:** gaps differ a lot by treatment (a colour every six weeks, a brow tidy every three). Then work the rhythm out per service.

### D57. Four ready-made flows instead of a journey canvas
- **Picked:** every business has four flows, off until switched on: a thank-you after a first visit, due back, fill quiet days, and we miss you. Each has a few number settings, its own email (same editor as campaigns) and its own results.
- **Considered:** a general journey builder in the style of Dittofeed (MIT) or Mautic (GPL).
- **Why:** these four plays are where an appointment business makes money from email, and a salon owner should not have to draw a graph to get them. The tables (`flows`, `flow_sends`) carry any later play.
- **Revisit if:** customers ask for a fifth play twice. Add it to the library; build a canvas only when plays need branching.

### D58. Each flow emails a client once per reason
- **Picked:** a send is recorded against a reason (`welcome`, `rebook:<last visit>`, `winback:<last visit>`, `fill:<day>`), unique per flow and client. Fill quiet days offers each day once.
- **Why:** the job runs every hour and can run twice; the unique row makes that harmless, and a client gets one nudge per lapse, not one per hour.

### D59. Guard rails before cleverness
- **Picked:** flows send between 9am and 7pm in the business's time zone, only to clients who said yes to news and are not suppressed, never within three days of any other marketing email (campaigns included), and fill quiet days emails at most a few clients per free slot (closest to due first). Time-sensitive flows go first in each run.
- **Why:** an automated email that lands at 2am, or three emails in a week, costs the business more than it earns, and too many offers for three slots makes clients feel misled.
- **Revisit if:** owners want weekend or evening sending; make the hours a business setting.

### D60. Free times are filled in when the email goes
- **Picked:** a "Free times" block shows up to six slots as buttons linking to the booking page with `?at=<time>`. Across several days it shows at most two a day first, so people see a choice of days. Times are formatted with the built-in `Intl` API in the business's time zone.
- **Considered:** `@date-fns/tz` (MIT), `luxon` (MIT), `temporal-polyfill` (MIT).
- **Why:** the slots are never out of date, and booking pages that ignore `at` still open. `Intl` covers what we need without a dependency.
- **Revisit if:** we start doing calendar arithmetic across daylight-saving changes; Temporal is the clean answer once Node ships it.

### D61. A booking counts for the email the client had just before it
- **Picked:** a booking is credited to the last marketing email (campaign or flow) the client received in the five days before they booked. Campaigns and flows show "Booked after this email" with the number of bookings and their value.
- **Considered:** crediting only after an open or a click; holdout groups.
- **Why:** salons care about bookings and money, not opens, and opens are unreliable. Five days matches the usual email window in tools like Klaviyo, and last-touch is easy to explain to an owner.
- **Revisit if:** we need to prove lift rather than show correlation. Hold back a small random group per flow and compare.

### D62. One hourly tick fans out per business
- **Picked:** pg-boss runs `run-flows` at five past every hour; it queues one job per business with a flow switched on.
- **Why:** pg-boss makes sure only one server sends each tick, and one slow business does not hold up the rest.

### D63. A host's sync keeps the business's own settings
- **Picked:** `PUT /v1/tenants/:id` without `brand` now leaves the brand alone. Businesses gain a time zone (IANA, default Europe/London) and a booking link.
- **Why:** before, Saleane syncing a business would wipe the logo and address the owner had set in Appearance.

### D64. Campaigns use the diary too
- **Picked:** campaigns can use `{{booking_url}}`, `{{last_service}}` and `{{weeks_since_visit}}`, and the Free times block, all filled per client at send time.
- **Why:** a one-off newsletter should be as personal as a flow.

## Stage 7: the exceptional UI pass

Mocks for every key screen, the design components and four palettes are on one canvas: https://claude.ai/artifact/NLutM5seB2e1i4ExusW2GY

### D65. Home leads with money booked from email
- **Picked:** the first number on Home is the money from bookings that followed an email (D61), against the period before, split into flows and campaigns. Emails sent moved into Sending health.
- **Considered:** emails sent and delivery rate first, as most email tools do.
- **Why:** an owner judges email by the chairs it fills. Volume is a means, not the result.
- **Revisit if:** a business has no diary connected; Home then shows the empty state and the week from a sample diary.

### D66. The week is split into four parts of the day
- **Picked:** Morning (before 12), Midday (12 to 2), Afternoon (2 to 5) and Evening (5 onwards), in the business's time zone. The part with the most free slots gets a ring, and the headline names it ("Thursday afternoon has 4 free slots").
- **Considered:** hourly columns; a GitHub-style calendar (`@uiw/react-heat-map`, MIT).
- **Why:** salons talk about a quiet afternoon, not a quiet 3pm. Seven by four fits a card and reads at a glance.

### D67. "Worth doing today" is ranked from real numbers only
- **Picked:** up to three suggestions: fill the quietest stretch (always first, because it expires), switch on flows that are off when people would get them, and follow up the best recent campaign. Value is the business's average price over six months times the slots or people, shown as "Up to". Actions open the flow to review before switching it on.
- **Why:** suggestions an owner can trust and act on in one tap. We show no benchmarks we cannot back with data yet; those come with the marketplace's aggregate stats.

### D68. The app sits on the canvas, cards float
- **Picked:** no white panel around pages; content sits on the warm canvas with cards that use a layered hairline shadow instead of a border. Mono eyebrow labels, Cal Sans for headings and big figures (proportional digits, since Cal Sans tabular digits look spaced), Inter tabular digits in tables. The rail has rounded corners. The assistant panel starts closed until it does something.
- **Why:** this is the look Edem approved in the mocks.

### D69. Search lives on Cmd K (Ctrl K)
- **Picked:** a palette that jumps to pages, flows, campaigns and clients (searched as you type), opened from the top bar or the shortcut.
- **Considered:** `cmdk` 1.1.1 (MIT), `kbar` 1.0.0 (MIT).
- **Why:** it is about 150 lines with our own data, and keeps one less dependency. Swap to `cmdk` if we add nested commands.

### D70. A flow is shown as a path
- **Picked:** Flows is a list beside the open flow. The flow shows When, Who, Email and Result as a chain, with its figures and a Next send card naming the day, its free times and the first clients in line. Editing moves to `/flows/:id/email`. Flow detail now returns `next` from the same code that sends.
- **Why:** owners see what a flow does and what it earned without reading settings.

### D71. Audience shows rhythm, not raw attributes
- **Picked:** each client row shows an avatar, their usual gap between visits and their next step (booked, due, overdue, away). The contacts list returns each person's rhythm.
- **Why:** "who should I be talking to" matters more than host attributes, which stay on the client's page.

### D72. The default palette is Edem's call
- **Picked:** four palettes in the mocks (Cobalt and Sand, Ink and Teal, Plum and Blush, Graphite and Lime). Colours are tokens in `theme.ts` and `styles.css`, so switching is one change. Building continues on the current tokens until Edem picks.

## Stage 8: pictures, generation and the design canvas

### D73. One picture library per business
- **Picked:** uploads, generated pictures and canvas designs live in one `assets` table and one Images page. Files sit behind an `AssetStore`: Postgres (`asset_blobs`, served at `/a/:key`) until `ASSETS_BUCKET` is set, then S3. Public links are long lived and cached as immutable.
- **Why:** emails need plain public image links that never change. Postgres keeps local and early hosting to one service; S3 takes over without code changes.

### D74. Image generation sits behind an interface, with a sample fallback
- **Picked:** an `ImageGenerator` interface. `OpenAIImageGenerator` (gpt-image-1, JPEG) runs when `OPENAI_API_KEY` is set; otherwise `SampleImageGenerator` makes soft gradients in the brand colours, and the app says they are samples.
- **Considered:** fal.ai FLUX (`@fal-ai/client`, MIT) and Replicate (Apache-2.0). Either fits the same interface.
- **Why:** the whole flow works and can be tested today with no key. Changing provider is one class.

### D75. Generated pictures never contain words
- **Picked:** every prompt ends with "No text, letters, numbers, logos or watermarks", wide pictures leave the left third quiet for a heading, and the brand and flat styles carry the accent colour.
- **Why:** generated lettering is often misspelt, cannot be edited, and screen readers cannot read it. Words go on top in the canvas, where they stay editable and become the alt text (D78).

### D76. Only PNG, JPEG and GIF, up to 5 MB, 40 generations a day
- **Picked:** WebP is turned away because Outlook for Windows cannot show it. Files over 5 MB return 413. Each business gets 40 generations a day (`IMAGES_PER_DAY`), counted from its library.
- **Why:** pictures must show in every inbox, and generation costs real money per picture.

### D77. Removing a picture never breaks a sent email
- **Picked:** removal hides a picture from the library but the file keeps serving. Saving a design writes a new file under a new key; the old one stays.
- **Why:** sent emails point at a fixed link forever. Overwriting or deleting would blank old emails and fight the immutable cache.

### D78. The design canvas is Konva, saved as layers plus a sharp PNG
- **Picked:** `konva` and `react-konva` (MIT). A design is a small JSON document (text, shape, image and shade layers, at most 40) saved with a PNG at twice the size for sharp phones. Three sizes (header 600 x 300, slim banner 600 x 200, square 600 x 600) and three templates built from the brand colours and the chosen photo. Undo and redo, snapping to the centre lines, arrow nudging. Stickers arrive on the right with words on them, since headings sit on the left. The alt text is taken from the design's words, or from the prompt for generated pictures.
- **Considered:** Fabric.js 7 (MIT, heavier and less React friendly), Polotno (commercial licence), tldraw (its own licence, needs a paid key in production), Excalidraw (MIT, a whiteboard rather than a layout tool).
- **Why:** Konva draws exactly what we export, works well with React, and the layer format is ours, so designs can later be re-rendered or edited by the assistant.

### D79. Pictures are made inside the email editor
- **Picked:** the image block opens a side panel with Generate, Your pictures and Upload, with a prompt suggested from the email's heading. "Design a header" opens the canvas with the chosen photo and "Add to email" drops the result straight into the block.
- **Why:** owners should never leave the email to find or make a picture.


### D80. The colours stay as they were for now
- **Picked:** Edem saw Midnight to Lilac in the app and asked to go back to the earlier look (Ember accent, dark rail with the warm glow) and keep building. Colour stays an open question for Edem; it is still one change in `theme.ts` and `styles.css` (D72).

## Stage 9: the standalone app, onboarding and billing

### D81. A business either pays us, or its app does
- **Picked:** each account has one "Direct" app (`apps.direct`). Businesses under it signed up with us and pay for a plan. Businesses under any other app (a salon inside Saleane) are paid for by that app, so they have no plan or limits here and cannot open Billing in the embedded studio.
- **Why:** the platform direction (section 5): Saleane resells email to its salons; a salon that signs up on its own pays us.

### D82. Plans are priced by people who said yes, with an email allowance
- **Picked:** a plan covers a number of people with marketing consent and twelve marketing emails per person a month (about three a week). Booking confirmations, reminders and test sends are never counted. Paid plans count from the Stripe billing date; free ones by calendar month.
- **Considered:** per-email pricing like Brevo; counting every contact like Mailchimp.
- **Why:** small businesses think in clients, not emails, and counting only people who said yes means clients kept for the diary cost nothing.

### D83. Limits stop sends before they start, and say what to do
- **Picked:** a campaign that would go over the allowance cannot be scheduled, with a sentence naming the numbers. It is checked again when it goes; if the plan has run out by then, it returns to draft with the reason shown on the campaign. Flows send up to what is left and pick up the rest when the month resets. Home shows a notice from 80% used. Going over the plan's people pauses marketing until the plan changes.
- **Why:** nobody should find out from a client that an email never went.

### D84. Prices are placeholders until Edem sets them
- **Picked:** Free (250 people, 2,500 emails), Starter £15 (1,000 / 12,000), Growth £29 (2,500 / 30,000), Studio £49 (5,000 / 60,000), Scale £79 (10,000 / 120,000), all in `PLANS` in `billing.ts` and created in Stripe by the setup script.
- **Reference (11 Oct 2026):** MailerLite's free plan is 250 subscribers and 2,500 emails, paid from $12; Mailchimp Essentials from $13 with 10x sends, Standard from $20 with 12x. Per-tier prices at 1,000 to 10,000 contacts were not readable from the pricing pages and need checking by hand. Klaviyo's page showed no prices to the fetcher.
- **Why:** the shape is what matters for building; the numbers are a business decision.

### D85. Stripe over plain fetch, with a sample provider locally
- **Picked:** Checkout for a first subscription, the Billing Portal for changes, cancelling and invoices. Prices live in Stripe under lookup keys (`plan_growth_monthly`), created once by `pnpm --filter @platform/api stripe:setup`. Webhooks at `/billing/stripe` are checked against the signature (HMAC, five minutes) and then the subscription is read back from Stripe, so events arriving out of order cannot leave a stale plan. API version pinned to `2026-09-30.endive`. Without Stripe keys, a sample provider switches plans for free in development; in production without keys, plans cannot change.
- **Considered:** the `stripe` SDK (MIT), which is fine but large for four calls; Lago (AGPL, study only) and OpenMeter (Apache-2.0) for metering, more than we need while usage is two counts.
- **Why:** the same pattern as image generation (D74): the whole flow works and is tested with no keys.

### D86. Sign-up is four short steps, and only the first is required
- **Picked:** business (name, booking page, postal address, send-from, where they take bookings), clients, past visits, plan. The business is created at step one; the rest can be skipped and resumed (the step is in the URL). Booking links without https:// are fixed for people. Time zone comes from the browser.
- **Why:** an owner should reach their Home in a minute, and the address and booking link are needed before any marketing email can go (D40).

### D87. Imports never put words in a client's mouth
- **Picked:** CSV parsed in the browser (`papaparse`, MIT), sent in batches of 500. Columns are guessed from common booking-system headers and shown for checking with the first row. UK dates are read day first. Consent is only recorded when the owner confirms people agreed, or from an opt-in column, and is stored as `import:owner-confirmed`. An import never overrides someone who said no or unsubscribed, and never overwrites a name the business already has. Each imported visit gets an id from email, date and service, so importing the same file twice changes nothing.
- **Why:** consent is the thing that keeps sending healthy (and legal under PECR); owners also re-import the same export more than once.

### D88. Home shows the way to a first booking from email
- **Picked:** a "Get set up" card with six steps (details, clients, visits, own domain, a flow on, first email), each linking to the place to do it, hideable per business.
- **Why:** it replaces a tour; the steps are the same ones that make the product earn.

### D89. Password reset by email
- **Picked:** Better Auth's reset flow: a link that lasts an hour, other devices signed out after the change. The platform's own emails go straight through the transport, not through any business.
- **Why:** a standalone app needs it on day one.

