# Plugging Saleane in

How Saleane connects to the platform: its studios become businesses here, its clients and visits feed the flows, its owners open the campaign studio inside Saleane, and its emails send through our SES. Every change below is in the Saleane repository; nothing in Saleane has been changed yet. File and line references are from Saleane's `main` as checked on 2026-10-11.

The plan assumes the platform runs Saleane's marketing (D108): campaigns and flows happen in the embedded studio, and Saleane's own News and automatic nudges switch off for a studio once it is connected. Booking confirmations and reminders stay in Saleane and send through the platform.

## What maps to what

| Saleane | Platform | Notes |
|---|---|---|
| Organisation (`org.id`) | Tenant, external id = `org.id` | Name and time zone carry over; the address once, when the business is created |
| Client (`state.clients[]`) | Contact, `externalId` = client id | Clients with no email are left out; they cannot be emailed |
| `client.marketingConsent` | Consent, source `saleane` | Sent when it changes, so the record shows when |
| Appointment (`state.appointments[]`) | Appointment, `id` = appointment id | Times converted from local date and minutes with Saleane's own `instantIn` (`src/domain/operations.ts:555`) |
| Client removed by retention or on request | `contacts.erase` | Unsubscribes and bounces are kept |
| Outbox email | `emails.send`, idempotency key = outbox id | A retry never sends twice |

| Saleane status | Platform status |
|---|---|
| `confirmed`, `arrived` | `booked` |
| `completed` | `completed` |
| `cancelled` | `cancelled` |
| `no_show` | `no_show` |

## Steps for you (once)

1. In the platform, Developers, **Add an app** called Saleane. Give it a **New key** and copy it (it is shown once).
2. Under the Saleane app, **Sites that can show the studio inside them**: add Saleane's address, such as `https://app.saleane.com`.
3. In Saleane's environment set `PLATFORM_API_KEY` (the key), `PLATFORM_URL` (such as `https://app.<yourdomain>`) and `SALEANE_EMAIL_PROVIDER=platform`.

## 1. The client for the API

The SDK is two files with one dependency (`standardwebhooks`). Until it is published, copy `packages/sdk/src/index.ts` to `server/platform/sdk.ts` and `packages/sdk/src/browser.ts` to `src/platform/studio.ts` in Saleane.

```ts
// server/platform/client.ts
import { PlatformClient } from './sdk'

export const platform = process.env.PLATFORM_API_KEY
  ? new PlatformClient({ apiKey: process.env.PLATFORM_API_KEY, baseUrl: process.env.PLATFORM_URL! })
  : null
```

## 2. Keeping clients and visits in step

Saleane tells listeners about every saved change, inside the same transaction, with the record before and after (`ctx.onPersist`, `server/context.ts:449`). The Connections outbox already uses it (`server/connections.ts:325`). The platform sync does the same: it writes what changed to a small table in that transaction, and a timer sends it. A change is never lost if the platform is slow or down, and nothing waits on the network while the studio saves.

Add a migration to `server/database.ts` (next version number):

```ts
{
  version: NEXT,
  up: (connection) =>
    connection.exec(`
      CREATE TABLE IF NOT EXISTS platform_sync (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organisation_id TEXT NOT NULL,
        kind TEXT NOT NULL,          -- 'tenant' | 'contact' | 'erase' | 'appointment'
        record_id TEXT NOT NULL,
        body TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS platform_sync_due ON platform_sync (next_attempt_at, id);
    `),
}
```

Then the sync itself:

```ts
// server/platformSync.ts
import type { Context } from './context'
import type { BusinessState } from '../src/domain/model'
import { instantIn } from '../src/domain/operations'
import { platform } from './platform/client'
import { PlatformApiError } from './platform/sdk'

const STATUS = { confirmed: 'booked', arrived: 'booked', completed: 'completed', cancelled: 'cancelled', no_show: 'no_show' } as const

export function createPlatformSync(ctx: Context) {
  if (!platform) return { tick: async () => {} }
  const queue = (org: string, kind: string, recordId: string, body: unknown) =>
    ctx.db.run('INSERT INTO platform_sync (organisation_id, kind, record_id, body) VALUES (?,?,?,?)', org, kind, recordId, JSON.stringify(body))

  ctx.onPersist((org, before, after) => {
    const s = after
    if (before.organisation.name !== s.organisation.name || before.organisation.timeZone !== s.organisation.timeZone)
      queue(org.id, 'tenant', org.id, tenantBody(s))

    const was = new Map(before.clients.map((c) => [c.id, c]))
    for (const c of s.clients) {
      const old = was.get(c.id)
      was.delete(c.id)
      if (!c.email) continue
      if (old && old.email === c.email && old.name === c.name && old.marketingConsent === c.marketingConsent && old.birthday === c.birthday) continue
      const [firstName, ...rest] = c.name.trim().split(/\s+/)
      queue(org.id, 'contact', c.id, {
        tenant: org.id,
        email: c.email,
        externalId: c.id,
        firstName,
        lastName: rest.join(' ') || undefined,
        // "MM-DD", as Saleane stores it. The birthday flow sends a week before.
        ...(c.birthday ? { attributes: { birthday: c.birthday } } : {}),
        // Only when it is new or changed, so the platform records when consent was given or withdrawn.
        ...(!old || old.marketingConsent !== c.marketingConsent
          ? { consent: { marketing: c.marketingConsent ? 'granted' : 'withdrawn', source: 'saleane' } }
          : {}),
      })
    }
    // Clients that are gone were deleted (retention or a request to be forgotten).
    for (const gone of was.values()) if (gone.email) queue(org.id, 'erase', gone.id, { tenant: org.id, externalId: gone.id })

    const visits = new Map(before.appointments.map((a) => [a.id, a]))
    for (const a of s.appointments) {
      const old = visits.get(a.id)
      if (old && old.status === a.status && old.date === a.date && old.startMinutes === a.startMinutes && old.staffId === a.staffId && old.serviceId === a.serviceId) continue
      const body = appointmentBody(s, a)
      if (body) queue(org.id, 'appointment', a.id, { tenant: org.id, ...body })
    }
  })

  let running = false
  async function tick() {
    if (running) return
    running = true
    try {
      const due = ctx.db.all<{ id: number; organisation_id: string; kind: string; body: string; attempts: number }>(
        'SELECT * FROM platform_sync WHERE next_attempt_at <= ? ORDER BY id LIMIT 100', Date.now())
      for (const row of due) {
        try {
          const body = JSON.parse(row.body)
          if (row.kind === 'tenant') await platform!.tenants.put(row.organisation_id, body)
          if (row.kind === 'contact') await platform!.contacts.upsert(body)
          if (row.kind === 'erase') await platform!.contacts.erase(body)
          if (row.kind === 'appointment') await platform!.appointments.upsert(body)
          ctx.db.run('DELETE FROM platform_sync WHERE id = ?', row.id)
        } catch (error) {
          // A business the platform has not seen yet: create it and try again straight away.
          if (error instanceof PlatformApiError && error.code === 'tenant_not_found') {
            const org = ctx.systemOrg(row.organisation_id)
            // The address and review link go in only when the business is created, so later changes
            // made in the platform's Appearance settings are kept. Marketing email needs the address.
            const { address, reviewUrl } = org?.state.organisation ?? {}
            if (org) await platform!.tenants.put(row.organisation_id, { ...tenantBody(org.state), brand: { address, ...(reviewUrl ? { reviewUrl } : {}) } })
          }
          const wait = Math.min(60_000 * 2 ** row.attempts, 6 * 3_600_000)
          ctx.db.run('UPDATE platform_sync SET attempts = attempts + 1, next_attempt_at = ?, error = ? WHERE id = ?', Date.now() + wait, String(error), row.id)
        }
      }
    } finally {
      running = false
    }
  }
  return { tick }
}

export function tenantBody(s: BusinessState) {
  return { name: s.organisation.name, timezone: s.organisation.timeZone }
}

export function appointmentBody(s: BusinessState, a: BusinessState['appointments'][number]) {
  const client = s.clients.find((c) => c.id === a.clientId)
  if (!client?.email) return null
  const startsAt = instantIn(s.organisation.timeZone, a.date, a.startMinutes)
  return {
    id: a.id,
    contactExternalId: client.id,
    email: client.email,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + a.bookedDurationMinutes * 60_000).toISOString(),
    service: s.services.find((x) => x.id === a.serviceId)?.name,
    staff: s.staff.find((x) => x.id === a.staffId)?.name,
    price: a.bookedPriceMinor,
    currency: s.organisation.currency,
    status: STATUS[a.status],
    bookedAt: a.createdAt,
  }
}
```

`ctx.systemOrg` is Saleane's own way to read a studio outside a request (`server/context.ts:354`).

Start it next to Connections in `server/app.ts:138`:

```ts
const platformSync = createPlatformSync(ctx)
if (options.outboxIntervalMs) setInterval(() => void platformSync.tick(), 15_000).unref()
```

### Bringing in history

New changes flow from the listener. For visits from before the switch-on, run a one-off script per studio that sends them 500 at a time:

```ts
for (let i = 0; i < s.appointments.length; i += 500) {
  const chunk = s.appointments.slice(i, i + 500).map((a) => appointmentBody(s, a)).filter((x) => x !== null)
  await platform.contacts.upsert(...)          // clients first, as in the listener
  const { errors } = await platform.appointments.upsertMany(org.id, chunk)
  if (errors.length) console.warn(org.id, errors)
}
```

Send the clients before their visits. Rows that fail come back by index, and the rest are kept. Flows learn each client's rhythm from these visits, so the Due back flow works on day one.

Free times: the flows also work without them (they link to the booking page). When you want the Quiet days flow, send each studio's free slots for the next fortnight with `platform.availability.set` from the same timer, from whatever Saleane's online booking already uses to list times.

## 3. Sending Saleane's emails through the platform

Saleane picks its email sender from `SALEANE_EMAIL_PROVIDER` (`server/messaging/providers.ts:238`). Add `'platform'` to `EmailSenderName` in `server/messaging/emailSenders.ts:26`, and a branch:

```ts
} else if (emailName === 'platform') {
  need('PLATFORM_API_KEY', 'PLATFORM_URL')
  email = platformProvider()
}
```

The provider needs to know which studio is sending. In `server/messaging/outbox.ts`, where `send` builds `message` (around line 563), add `tenant: org.id`, and add `tenant?: string` to `OutgoingMessage` (`providers.ts:26`).

```ts
// server/messaging/platformSender.ts
import { platform } from '../platform/client'
import { PlatformApiError } from '../platform/sdk'
import type { MessageProvider } from './providers'

export function platformProvider(): MessageProvider {
  return {
    name: 'platform',
    live: true,
    channel: 'email',
    send: async (m) => {
      try {
        const sent = await platform!.emails.send({
          tenant: m.tenant!,
          to: m.to,
          subject: m.subject,
          text: m.body,
          html: m.html,
          stream: m.stream === 'broadcast' ? 'marketing' : 'transactional',
          // The outbox id, so a retry after a timeout returns the first email instead of a second.
          idempotencyKey: m.id,
        })
        return { outcome: 'accepted', providerRef: sent.id }
      } catch (error) {
        if (error instanceof PlatformApiError)
          return { outcome: 'failed', detail: error.message, retry: error.status === 429 || error.status >= 500 }
        // The idempotency key makes a retry safe even when we cannot tell whether it arrived.
        return { outcome: 'failed', detail: String(error), retry: true }
      }
    },
  }
}
```

The From address is the studio's own once they verify their domain in the platform (Email, Sending domains); until then it is the platform's shared address with the studio's name. Bounces and complaints are handled by the platform and stop future sends to that address for every studio.

## 4. The studio inside Saleane

A route in Saleane's server makes a short-lived link for the person opening Email; the page loads it in a frame. The link works once, within five minutes, and is tied to Saleane's address.

```ts
// server/routes/emailStudio.ts
import type { Context, Route } from '../context'
import { fail } from '../http'
import { platform } from '../platform/client'

export function emailStudioRoutes() {
  return async (ctx: Context, route: Route): Promise<boolean> => {
    const { request, method, path, reply } = route
    if (path[1] !== 'workspaces' || path[3] !== 'email-studio') return false
    if (method !== 'POST') fail(405, 'Use POST.')
    if (!platform) fail(404, 'Email is not connected.')
    const actor = ctx.actorFor(request, true)
    const org = ctx.orgFor(path[2], actor)
    if (org.role !== 'owner' && org.role !== 'manager') fail(403, 'Only owners and managers can open Email.')
    const session = await platform.studio.createSession({
      tenant: org.id,
      origin: process.env.SALEANE_ORIGIN ?? 'http://127.0.0.1:5173',
      user: { id: actor.id, name: actor.name, email: actor.email },
      page: 'campaigns',
    })
    reply(200, session)
    return true
  }
}
```

Add `emailStudioRoutes()` to the list in `server/app.ts:164`, next to `marketingRoutes(outbox)`.

On the page (the Marketing section, `src/App.tsx:172`):

```tsx
import { mountStudio } from './platform/studio'

function EmailStudio({ workspaceId }: { workspaceId: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let unmount = () => {}
    const open = async () => {
      unmount()
      const { url } = await api.post(`/api/workspaces/${workspaceId}/email-studio`)
      unmount = mountStudio(ref.current!, url, { onEvent: (e) => e.type === 'session-expired' && open() })
    }
    void open()
    return () => unmount()
  }, [workspaceId])
  return <div ref={ref} />
}
```

Saleane's Content Security Policy only allows frames from itself (`server/index.ts:87`). Add the platform:

```ts
const platformOrigin = process.env.PLATFORM_URL ? ` ${new URL(process.env.PLATFORM_URL).origin}` : ''
// ... frame-src 'self'${challenges}${platformOrigin}; ...
```

The studio takes Saleane's look if you pass `theme: { accent: '#…', headingFont: 'serif' }` to `createSession`.

## 5. Switching off the old marketing

Once a studio is connected, hide Saleane's News, birthday, miss-you and due-back settings for it and stop `marketingEmails` queueing them, so clients never get two of the same nudge. The Marketing results page (`server/routes/marketing.ts`) can stay for history.

Saleane's after-visit feedback email already links to the studio's review page (`organisation.reviewUrl`). Keep it, and leave the platform's **Ask for a review** flow off for Saleane studios, so nobody is asked twice. The platform's flow is for apps that have no feedback email of their own, such as Caleane.

## Checking it works

1. Book a visit in Saleane for a client with an email. Within 15 seconds it shows on the client's page in the platform (Audience, the client).
2. Open Marketing, Email. The studio appears inside Saleane with that studio's clients.
3. Send a test campaign to yourself. The email arrives from the studio's name.
4. Delete a test client in Saleane. The client disappears from the platform; their past emails show as erased.
