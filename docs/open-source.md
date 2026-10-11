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

## Watch-outs

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

## Sources

- npm registry (`npm view`) for all package licences, versions and dates
- Shallow clones: arikchakma/maily.to, zalify/easy-email, usewaypoint/email-builder-js, dittofeed/dittofeed, usesend/useSend, useplunk/plunk, tremorlabs/tremor, unlayer/react-email-editor
- https://www.better-auth.com/blog/authjs-joins-better-auth
- https://vercel.com/blog/vercel-acquires-better-auth
- https://vercel.com/blog/vercel-acquires-tremor
- https://dittofeed.com/pricing
- https://docs.dittofeed.com/guide/license
