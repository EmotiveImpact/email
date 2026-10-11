# Open-source register

Date checked: 11 October 2026

Target stack (revised mid-research): pnpm monorepo, Vite 8 + React 19 + TanStack Router SPA, Hono API on Node, Postgres + Drizzle, pg-boss, `@aws-sdk/client-sesv2`, Amazon SES. The product is closed-source and hosted, so only permissive licences (MIT, BSD, Apache-2.0, ISC, OFL) are built on. AGPL/GPL/SSPL/BSL and similar are studied for ideas only.

How checked: `npm view <pkg> license version time.modified peerDependencies`, and shallow no-checkout clones with `git show HEAD:LICENSE` and `git log -1`. "Last activity" is the npm `time.modified` date unless marked (commit). Rows marked "not verified" were not checked within the research cap.

Stack sanity check: `vite` 8.3.4 MIT (8 Oct 2026), `hono` 4.13.13 MIT (10 Oct 2026), `@tanstack/react-router` 1.170.42 MIT, peer React >=18 (10 Oct 2026).

## 1. UI component kit

| Project | Licence | Last activity | Verdict | Why |
|---|---|---|---|---|
| shadcn/ui (`shadcn` CLI 4.21.4) | MIT | 7 Oct 2026 | Build on | Copy-in components, Tailwind 4, has a Vite install path; pair with Base UI or Radix |
| `@base-ui/react` 1.9.0 | MIT | 9 Oct 2026 | Build on | Stable, peer React ^17-^19; use as shadcn's primitive layer for new work |
| `@radix-ui/react-*` (e.g. dialog 1.2.0) | MIT | 9 Oct 2026 | Build on (runner-up) | Peer React up to ^19, still published; fine if shadcn's Radix variant is chosen |
| `@base-ui-components/react` | MIT | Jul 2026, stuck at 1.0.0-rc.0 | Skip | Old package name; use `@base-ui/react` |

## 2. Dashboard charts

| Project | Licence | Last activity | Verdict | Why |
|---|---|---|---|---|
| Recharts 3.10.1 | MIT | 3 Oct 2026 | Build on | Peer React ^19, what shadcn charts wrap, enough for sends/opens/bounces over time |
| visx (`@visx/xychart` 4.0.0) | MIT | 11 Jun 2026 | Build on (runner-up) | Peer React ^19; lower level, use for bespoke views (funnels, heatmaps) |
| `@tremor/react` 3.18.7 | Apache-2.0 | 13 Jan 2025 | Skip (npm package) | Peer React ^18 only, no release since Vercel acquired Tremor |
| Tremor copy-paste components (`tremorlabs/tremor`) | Apache-2.0 | Commit 10 Oct 2025 | Study only | Licence would allow copying with NOTICE, but repo has been quiet for a year; shadcn charts cover the same ground |

## 3. Data tables

| Project | Licence | Last activity | Verdict | Why |
|---|---|---|---|---|
| `@tanstack/react-table` 9.2.8 | MIT | 8 Oct 2026 | Build on | Headless, peer React >=18, server-side pagination/sorting fits Drizzle queries |
| shadcn "Data Table" recipe | MIT | (with shadcn) | Build on (runner-up/companion) | Styled wrapper over TanStack Table; check it targets v9 APIs before copying |

## 4. Drag-and-drop email builder (email-safe HTML)

| Project | Licence | Last activity | Verdict | Why |
|---|---|---|---|---|
| Maily (`@maily-to/core`, `@maily-to/render`) | MIT (repo `license` file) | 2.0.0-beta.7 on 11 Jun 2026; commit 21 Jul 2026 | Build on | v2 beta peers React ^19.2 and Tiptap 3, renders through React Email + juice; block editor rather than column grid |
| GrapesJS 0.23.6 + `grapesjs-mjml` 1.0.8 | BSD-3-Clause | 25 Aug 2026 / 13 Mar 2026 | Build on (runner-up) | Framework-agnostic so no React peer issue; true drag-and-drop with MJML output; heavier to theme |
| `grapesjs-preset-newsletter` 1.0.2 | BSD-3-Clause | 9 Jun 2023 | Skip | Unmaintained for over three years; use `grapesjs-mjml` instead |
| Easy Email (`easy-email-editor` 4.17.1) | MIT | 10 Jun 2026; commit 13 Aug 2026 ("update demo") | Skip | Peer React ^18.2 only (core, editor and extensions), Arco UI, react-final-form; a paid "Easy Email Pro" now sits alongside |
| EmailBuilder.js (`@usewaypoint/email-builder` 0.0.9) | MIT | 9 Jan 2026 (previous release Jun 2024); commit 9 Feb 2026 | Study only | Peer React ^16-^18, 0.0.x, near-dormant; good JSON document model to learn from |
| Unlayer `react-email-editor` 2.1.3 | MIT wrapper | 4 Oct 2026 | Skip | Wrapper only: loads Unlayer's proprietary hosted editor, paid plans for white-label |
| Dittofeed `packages/emailo` | MIT | Commit 3 Oct 2026 | Study only | Tiptap email editor inside Dittofeed; useful second reference next to Maily |

## 5. Email rendering

| Project | Licence | Last activity | Verdict | Why |
|---|---|---|---|---|
| React Email (`react-email` 6.11.1, `@react-email/components` 1.0.12, `@react-email/render` 2.1.0) | MIT | 6 Oct 2026 | Build on | Peer React ^19, renders on the Hono server; Maily already depends on it |
| MJML 5.4.1 | MIT | 10 Sep 2026 (6.0.0-alpha.1 on 9 Oct 2026) | Build on (runner-up) | Most robust Outlook output; needed if the GrapesJS route is taken; pin 5.x until 6 is stable |

## 6. Flow and journey canvas

| Project | Licence | Last activity | Verdict | Why |
|---|---|---|---|---|
| `@xyflow/react` (React Flow) 12.12.0 | MIT | 24 Sep 2026 | Build on | Peer React >=17, the standard node canvas; Dittofeed's journey UI is a reference |
| Runner-up | n/a | n/a | not verified | No serious permissive alternative checked within the cap; do not copy React Flow "Pro" examples, which sit under a separate subscription (from memory, recheck) |

## 7. Auth for a multi-tenant SaaS (Hono API + Vite SPA)

| Project | Licence | Last activity | Verdict | Why |
|---|---|---|---|---|
| Better Auth 1.7.7 | MIT | 30 Sep 2026 | Build on | Mounts as a Hono handler, Drizzle adapter, `organization` plugin for workspaces/roles/invites, React client works in an SPA; Vercel acquired it in 2026, licence still MIT |
| Auth.js (`@auth/core` 0.41.3 ISC + `@hono/auth-js` 1.1.1 MIT) | ISC / MIT | 20 Jul 2026 / 14 Feb 2026 | Study only (runner-up) | Works with Hono, but Auth.js was handed to the Better Auth team in Sept 2025 and has no organisation model |
| Supabase Auth (`@supabase/supabase-js` 2.117.3, `@supabase/auth-js`) | MIT (client libs) | 9 Oct 2026 | Skip | Separate hosted or self-run service with its own schema, overlaps with Drizzle-owned Postgres; server licence not verified |

## 8. Outbound webhook signing

| Project | Licence | Last activity | Verdict | Why |
|---|---|---|---|---|
| `standardwebhooks` 1.1.1 | MIT | 28 Aug 2026 | Build on | Reference implementation of the Standard Webhooks spec (`webhook-id`, `webhook-timestamp`, `webhook-signature`), small, sign and verify |
| `svix` 2.8.0 | MIT | 8 Oct 2026 | Study only (runner-up) | Same signature scheme, but it is the client for Svix's hosted service; useful if delivery is ever outsourced |

## 9. Postgres job queue

| Project | Licence | Last activity | Verdict | Why |
|---|---|---|---|---|
| pg-boss 12.37.1 | MIT | 8 Oct 2026 | Build on | Already chosen; queues, retries, singleton keys, cron; needs Node >=22.12 |
| graphile-worker 0.18.0 | MIT | 8 Sep 2026 | Build on (runner-up) | LISTEN/NOTIFY low latency and good throughput; still 0.x; needs Node >=22.18 |

## 10. Reference code (SES events, sending API, segments and journeys)

| Project | Licence | Last activity | Verdict | Why |
|---|---|---|---|---|
| Dittofeed | MIT (root LICENSE; all 9 packages declare `LicenseRef-LICENSE`) | Commit 3 Oct 2026 | Build on (with care) | No `ee/` or commercial folders in the public repo; enterprise features (multi-tenant advanced auth, white-labelling, embedded components) are sold separately and not present. Built on Temporal + ClickHouse, so port logic, not wholesale code |
| useSend | AGPL-3.0 | Commit 9 Sep 2026 | Study only | Resend-style API on SES with SES tenants; see `apps/web/src/app/api/ses_callback/route.ts`, `apps/web/src/server/aws/ses.ts`, `sns.ts` |
| Plunk | AGPL-3.0 | Commit 10 Oct 2026 | Study only | SNS event handling and workflows; see `apps/api/src/controllers/Webhooks.ts`, `apps/api/src/services/SESService.ts` |

Useful Dittofeed paths (MIT, copy with notice): `packages/backend-lib/src/segments*`, `packages/backend-lib/src/journeys/` (userWorkflow, bootstrap), `packages/backend-lib/src/destinations/amazonses.ts`. Before copying dashboard code, check `packages/dashboard/licenses/` (third-party notices for the Mantis template and a responsive HTML email template).

## 11. Command palette and icons

| Project | Licence | Last activity | Verdict | Why |
|---|---|---|---|---|
| cmdk 1.1.1 | MIT | Release 14 Mar 2025 | Build on | Peer React ^19, used by shadcn `Command`; quiet but stable |
| Runner-up palette | n/a | n/a | not verified | None checked within the cap |
| `lucide-react` 1.55.0 | ISC | 10 Oct 2026 | Build on | Peer React ^19, shadcn default icon set, tree-shakeable |
| Runner-up icons | n/a | n/a | not verified | None checked within the cap |

## Used in stage 1 (app shell)

Checked 11 October 2026 with `npm view <pkg> version license`.

| Project | Licence | Used for |
|---|---|---|
| `@fontsource/cal-sans` 5.3.0 | OFL-1.1 | Default heading font, self-hosted |
| `@fontsource-variable/inter` 5.3.0 | OFL-1.1 | Body text |
| `@fontsource-variable/geist` 5.3.0, `@fontsource-variable/newsreader` 5.3.0 | OFL-1.1 | The two other heading choices |
| `@tanstack/react-router` 1.170.42, `@tanstack/react-query` 5.104.1 | MIT | Routing and data loading |
| `tailwindcss` / `@tailwindcss/vite` 4.3.3 | MIT | Styling over the brand CSS variables |
| `lucide-react` 1.55.0 | ISC | Icons |
| `@vitejs/plugin-react` 6.1.2, `vite` 8.3.4 | MIT | Build |

Not yet pulled in: Recharts (the two charts so far are a few lines of SVG, see D20), shadcn/Base UI (added with the first dialogs and menus in stage 2), TanStack Table (added when Audience needs sorting and paging).

## Used in stage 2 (sign-in and audience)

| Project | Licence | Used for |
|---|---|---|
| `better-auth` 1.7.7 (checked 11 Oct 2026, published 30 Sep 2026) | MIT | Email and password sign-in, sessions, organisations, through its Drizzle adapter |
| Neon Auth (docs checked) | n/a, hosted | Considered: Better Auth hosted by Neon with the organisation plugin. Kept as a later option (D27) |
| Dittofeed segments | MIT | Studied for the rule shapes; we compile rules straight to Postgres instead of materialising them (D31) |


- Email builder is the weakest area. Easy Email still peers React ^18.2 and EmailBuilder.js peers up to React 18 with one release in two years; both would need forking for React 19. Maily is the only React 19 option, but v2 is beta (last beta June 2026), so pin the exact version and budget for fixes.
- `grapesjs-preset-newsletter` has not been released since June 2023. If GrapesJS is used, build on `grapesjs-mjml` and the core; GrapesJS "Studio SDK" is a separate commercial product, so stay on the BSD core.
- Unlayer's npm wrapper is MIT, but the editor it loads is proprietary and hosted by Unlayer.
- Tremor's npm package is effectively frozen on React 18 since the Vercel acquisition.
- TanStack Table is now v9; many shadcn and blog examples are v8 and will need adjusting.
- Auth.js is in maintenance under the Better Auth team. Better Auth is now owned by Vercel; licence is MIT today, so pin versions and recheck the licence on major upgrades.
- MJML 6 is in alpha; stay on 5.x for now.
- Dittofeed's enterprise features are absent from the public repo, so do not expect to find multi-tenant auth or white-labelling there.
- useSend and Plunk are AGPL-3.0: read their SES and SNS handling for ideas, but write our own code without copying.
- pg-boss and graphile-worker both require Node 22.12 or newer.

## Used in stage 3 (campaigns)

| Package (checked 11 Oct 2026) | Licence | What for |
|---|---|---|
| `@react-email/components` 1.0.12 | MIT | Email-safe building blocks (container, button, image, preview text) |
| `@react-email/render` 2.1.0 | MIT | HTML and plain text from the same blocks; plain text via `html-to-text` (MIT) |
| `@maily-to/core` 0.3.7 | MIT (per repo; npm field blank) | Considered. React 19 ready, but beta and heavy (Tiptap tree). Not used (D34) |
| `easy-email-editor` 4.17.1 | MIT | Considered. Still peers React ^18.2. Not used |
| `@usewaypoint/email-builder` 0.0.9 | MIT | Considered. Peers React up to 18. Its block list shaped ours |
| `grapesjs-mjml` 1.0.8 and `mjml` 5.4.1 | BSD-3-Clause, MIT | Kept as the route to a pro editor with columns (D34) |
| `@tiptap/react` 3.31.4 | MIT | Kept for a later rich-text toolbar (D35) |
| Listmonk campaign pacing | AGPL-3.0 | Studied only: rate-limited sending per campaign. Our pacing uses pg-boss `startAfter` (D38) |

## Used in stage 4 (embedded studio)

| Package (checked 11 Oct 2026) | Licence | What for |
|---|---|---|
| `iframe-resizer` and `@iframe-resizer/parent` 5.5.9 | GPL-3.0 (or commercial) | Considered for frame sizing. Licence rules it out; we post the height ourselves (D48) |
| `penpal` 8.0.1 | MIT | Kept for later, if hosts need to call into the studio (D48) |
| `post-robot` 8.0.32 (PayPal) | Not stated on npm | Considered. Last release August 2024, so not used |

## Used in stage 6 (diary and flows)

| Package or project (checked 11 Oct 2026) | Licence | What for |
|---|---|---|
| pg-boss `schedule` | MIT | Already in use; runs the hourly flow tick once across servers (D62) |
| Dittofeed journeys | MIT | Studied: segment-triggered journeys. We chose four fixed plays over a canvas (D57) |
| Mautic campaigns | GPL-3.0 | Studied only: campaign builder with conditions and waits (D57) |
| Cal.com availability | AGPL-3.0 (enterprise parts commercial) | Studied only: how free slots are worked out from opening hours and bookings. Our hosts send slots ready made (D55) |
| Easy!Appointments | GPL-3.0 | Studied only: a small salon booking system; a likely source of availability for an adapter (D55) |
| `@date-fns/tz` 1.5.0, `luxon` 3.7.2, `temporal-polyfill` 1.0.5 | MIT | Considered for time zones. `Intl` was enough (D60) |
| `rrule` 2.8.1 | BSD-3-Clause | Considered for opening hours. Not needed while hosts send free slots |
| `@calcom/embed-react` 1.5.3 | Own licence file | Not used |
| Klaviyo predictive analytics and attribution docs | Product docs | Principles only: predicted next order date and a five-day email window (D56, D61) |

## Used in stage 7 (exceptional UI)

| Package or project (checked 11 Oct 2026) | Licence | What for |
|---|---|---|
| `cmdk` 1.1.1 | MIT | Considered for the Cmd K palette. Built our own, about 150 lines (D69) |
| `kbar` 1.0.0 | MIT | Considered for the same; heavier than we need (D69) |
| `@uiw/react-heat-map` 2.3.4 | MIT | Considered for the week grid. It draws a year calendar; we need days by part of day (D66) |
| `@tremor/react` 3.18.7 | Apache-2.0 | Studied: KPI cards with a change pill and a split bar. Our cards are hand built on the same idea (D65) |
| `@visx/shape` 4.0.0 (Airbnb) | MIT | Considered for charts and sparklines. Our hand-drawn SVG in `charts.tsx` stays smaller |
| `@fontsource-variable/jetbrains-mono` 5.3.0 | OFL-1.1 (font), MIT (package) | The mono eyebrow labels |

## Used in stage 8 (pictures and the design canvas)

| Package or project (checked 11 Oct 2026) | Licence | What for |
|---|---|---|
| `konva` 10.7 | MIT | The design canvas: layers, transforms, export to PNG (D78) |
| `react-konva` 19.3.0 | MIT | React bindings for the canvas (D78) |
| `fabric` 7.4.0 | MIT | Considered for the canvas; heavier and less suited to React (D78) |
| `polotno` 4.15.3 | Commercial | Avoided: a ready-made design editor whose licence needs a paid key (D78) |
| `tldraw` 5.5.2 | tldraw licence | Avoided: production use needs a licence key (D78) |
| `@excalidraw/excalidraw` 0.18.1 | MIT | Considered; a whiteboard, not a layout tool for email headers |
| `use-image` 1.1.4 | MIT | Tried, then replaced by a ten-line hook that also handles cross-origin loading |
| `openai` 7.32.0 | Apache-2.0 | Considered; we call the images endpoint with plain `fetch` instead (D74) |
| `@fal-ai/client` 1.10.1 | MIT | A second provider (FLUX) that fits the `ImageGenerator` interface (D74) |
| `replicate` 1.4.0 | Apache-2.0 | Same, for open image models (D74) |
| `@aws-sdk/client-s3` 3.x | Apache-2.0 | Picture storage once `ASSETS_BUCKET` is set (D73) |

## Used in stage 9 (onboarding and billing)

| Package or project (checked 11 Oct 2026) | Licence | What for |
|---|---|---|
| `papaparse` 5.7.0 | MIT | Reading CSV exports in the browser (D87) |
| `react-dropzone` 20.1.3 | MIT | Considered for the drop area; native drag and drop is a few lines |
| `stripe` 23.0.0 | MIT | Considered; four REST calls with `fetch` keep it out (D85) |
| `@stripe/stripe-js` 10.0.0 | MIT | Not needed: Checkout and the portal are Stripe-hosted pages |
| Lago | AGPL-3.0 | Studied only: usage billing engine, more than two counters need (D85) |
| OpenMeter | Apache-2.0 | Considered for metering; not needed yet (D85) |
| Better Auth password reset | MIT | Already our sign-in; its reset flow is used as is (D89) |

## Used in stage 10 (production hosting)

| Package or project (checked 11 Oct 2026) | Licence | What for |
|---|---|---|
| `aws-cdk-lib` 2.273.0 and `constructs` 10.8.1 | Apache-2.0 | The AWS setup as code (D92) |
| `aws-cdk` CLI 2.1145.0 | Apache-2.0 | Deploying it |
| `aws-actions/configure-aws-credentials` v6 | MIT | GitHub signs in to AWS without stored keys (D97) |
| `aws-actions/amazon-ecr-login` v2 | MIT | Pushing the image |
| `@hono/node-server` serve-static | MIT | Serving the built app from the API (D91) |
| `pg-boss` 12.37.1 | MIT | Already our queue; confirmed it works through Neon's pooler (D94) |
| `sst` 4.17.2 | MIT | Considered: friendlier than CDK, but runs on Pulumi and its own state; CDK keeps everything in CloudFormation |
| Kamal 2.12.0 | MIT | Considered: deploys containers to plain servers; we would then run our own load balancer and TLS |
| Coolify | Apache-2.0 | Considered: self-hosted platform; one more server to keep alive |
| Dittofeed's Helm and Docker setups | MIT | Studied: one image with roles, as here |

## Stage 11: strengthening and plugging in

| Project | Licence | Use |
|---|---|---|
| `date-fns-tz` | MIT | Considered for local diary time to UTC; the SDK's `zonedTime` uses the built-in `Intl` instead, so the SDK keeps one dependency |
| `@js-temporal/polyfill` | ISC | Considered for the same; too large for an SDK while Temporal is still arriving in Node |
| `standardwebhooks` | MIT | Already the SDK's only dependency; the guides keep it that way |
| Saleane's own `instantIn` | Ours | Used in the Saleane guide rather than adding anything |

## Stage 12: trust, inbox checks, plays and accessibility

| Project | Licence | Use |
|---|---|---|
| `request-filtering-agent` | MIT | Studied for blocking webhooks to private addresses. Not added: it had a bypass in 2025 (CVE-2025-57814), and our check is twenty lines we can test. Its address list informed ours |
| `ssrf-req-filter` | MIT | Studied for the same; works only as an http agent, and we post with `fetch` |
| `rate-limiter-flexible` | ISC | Considered for rate limits; has a Postgres store, but brings a table layout and options we do not need. Our fixed window in one table does the job (D114) |
| `hono-rate-limiter` | MIT | Considered; its stores are memory, Redis or Cloudflare, none shared across our containers without adding Redis |
| `axe-core` | MPL-2.0 | Used as a tool only, run from outside the repo against the dev app to find accessibility problems. Not shipped and not a dependency |
| `focus-trap` / `focus-trap-react` | MIT | Considered for keeping keyboard focus inside panels; a 40-line hook covers our five panels without a dependency |
| Gmail and Yahoo sender rules | Docs | Checked again for the inbox warnings and the visible unsubscribe fallback |

## Stage 13: walking the main journeys

| Project | Licence | Use |
|---|---|---|
| `chrono-node` | MIT | Considered for reading birthdays in any format; far more than a birthday column needs. A 20-line reader covers the formats spreadsheets use |
| `date-fns` `parse` | MIT | Considered for the same; needs the format known in advance, which an import does not have |
| Klaviyo Smart Sending | Docs | Checked how a leading tool spaces campaigns after other emails (16 hours by default), which shaped D127 |
| `axe-core` | MPL-2.0 | Run again from outside the repo after the fixes; tool only, not shipped |

## Stage 14: connecting booking systems

| Project | Licence | Use |
| --- | --- | --- |
| `square` (Square's Node SDK) | MIT | Considered; we call seven endpoints, and a 200-line client with a pinned API version keeps the image small and the calls easy to fake in tests |
| `simple-oauth2` | Apache-2.0 | Considered for the OAuth exchange; Square's token call is one POST |
| `arctic` | MIT | Considered for OAuth; has no Square provider |
| `@oslojs/crypto` | MIT | Considered for sealing tokens; Node's built-in AES-GCM does it |
| Square API docs (OAuth, Bookings, Customers, Catalog, webhooks) | Docs | Followed for scopes, the 31-day booking window, availability search and webhook signatures |
| Phorest developer docs | Docs | Checked for a second connector; access is per salon on request (D132) |
| Fresha and Timely | Docs | Checked; no self-serve public API found |
| Cal.com, Easy!Appointments | AGPL-3.0 / GPL-3.0 | Not used; booking apps rather than connectors (studied for D55) |

## Sources

- npm registry (`npm view`) for all package licences, versions and dates
- Shallow clones: arikchakma/maily.to, zalify/easy-email, usewaypoint/email-builder-js, dittofeed/dittofeed, usesend/useSend, useplunk/plunk, tremorlabs/tremor, unlayer/react-email-editor
- https://www.better-auth.com/blog/authjs-joins-better-auth
- https://vercel.com/blog/vercel-acquires-better-auth
- https://vercel.com/blog/vercel-acquires-tremor
- https://dittofeed.com/pricing
- https://docs.dittofeed.com/guide/license
- https://cal.com/blog/changing-to-agplv3-and-introducing-enterprise-edition
- https://docs.dittofeed.com/deployment/deployment
- https://contribute.mautic.org/about/what-is-mautic
- https://cdn.jsdelivr.net/gh/alextselegidis/easyappointments@main/README.md
- https://help.klaviyo.com/hc/en-us/articles/360020919731
- https://help.klaviyo.com/hc/en-us/articles/115005248128-Understanding-message-conversion-tracking
- https://github.com/pacocoursey/cmdk
- https://npmjs.com/package/@uiw/react-heat-map
- https://npmjs.com/package/@tremor/react
- https://awesome.cube.dev/tools/visx
- https://konvajs.org/docs/react/index.html
- https://polotno.com/docs/pricing
- https://tldraw.dev/community/license
- https://platform.openai.com/docs/guides/image-generation
- https://www.mailerlite.com/pricing
- https://www.brevo.com/pricing/
- https://mailchimp.com/en-gb/pricing/marketing/
- https://docs.stripe.com/api/versioning
- https://docs.stripe.com/webhooks/signature
- https://docs.stripe.com/billing/subscriptions/webhooks
- https://www.getlago.com/blog/open-source-licensing-and-why-lago-chose-agplv3
- https://pkg.go.dev/github.com/openmeterio/openmeter@v1.0.0-beta.149
- https://www.better-auth.com/docs/authentication/email-password
- https://aws.amazon.com/ses/pricing/
- https://docs.aws.amazon.com/ses/latest/dg/tenants.html
- https://dev.classmethod.jp/en/articles/ses-pricing-plans-price-list-api-sesv2-api/
- https://neon.com/pricing
- https://neon.com/docs/connect/connection-pooling
- https://github.com/timgit/pg-boss
- https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html
- https://github.com/aws-actions/configure-aws-credentials
- https://docs.aws.amazon.com/cdk/v2/guide/home.html
- https://support.google.com/a/answer/81126 (Gmail sender guidelines)
- https://github.com/azu/request-filtering-agent
- https://advisories.gitlab.com/pkg/npm/request-filtering-agent/CVE-2025-57814/
- https://github.com/y-mehta/ssrf-req-filter
- https://classic.yarnpkg.com/en/package/rate-limiter-flexible
- https://npmjs.com/package/hono-rate-limiter
- https://licenses.dev/npm/axe-core/4.7.0
- https://npmjs.com/package/focus-trap-react
- https://help.klaviyo.com/hc/en-us/articles/360004059711
- https://snyk.io/advisor/npm-package/chrono-node
- https://developer.squareup.com/docs/oauth-api/overview
- https://developer.squareup.com/reference/square/bookings-api
- https://developer.squareup.com/docs/webhooks/step3validate
- https://developer.phorest.com/
- https://www.npmjs.com/package/square
