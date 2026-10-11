import { useQuery } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import { appsQuery, useAddApp, useAddKey, useRevokeKey, useSetOrigins, type AccountApp } from '../api.ts';
import { useTenant } from '../components/Shell.tsx';
import { Button, Card, CardTitle, Notice, PageTitle } from '../components/ui.tsx';
import { inStudio } from '../studio.ts';

const input = 'h-9 w-full rounded-[10px] border border-rule-strong bg-paper px-2.5 font-[inherit] text-[13px] text-ink outline-none focus:border-ink';
const when = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre tabIndex={0} className="m-0 overflow-x-auto rounded-xl bg-[#141416] px-4 py-3.5 font-mono text-[12.5px] leading-relaxed text-[#E7E4DE]">{children}</pre>
      <button
        type="button"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(children).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="absolute top-2.5 right-2.5 flex size-7 cursor-pointer items-center justify-center rounded-md border-0 bg-white/10 text-white/70 hover:bg-white/20"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

export function Developers() {
  const tenant = useTenant();
  const sdk = `import { PlatformClient } from '@platform/sdk';

const email = new PlatformClient({ apiKey: process.env.PLATFORM_API_KEY! });

// Keep the business in step with your app.
await email.tenants.put('${tenant.externalId}', { name: '${tenant.name}', fromEmail: '${tenant.fromEmail ?? 'hello@example.com'}' });

// A booking reminder. The key makes retries safe: the same key never sends twice.
await email.emails.send({
  tenant: '${tenant.externalId}',
  to: 'ama@example.com',
  subject: 'See you Thursday at 10:00',
  html: '<p>Hi Ama, see you on Thursday.</p>',
  idempotencyKey: 'booking-1042-reminder',
});`;

  const curl = `curl -X POST "$API_URL/v1/emails" \\
  -H "Authorization: Bearer $PLATFORM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: booking-1042-reminder" \\
  -d '{"tenant":"${tenant.externalId}","to":"ama@example.com","subject":"See you Thursday","text":"Hi Ama"}'`;

  const consent = `// News needs recorded consent. Send it when a client ticks the box.
await email.contacts.upsert({
  tenant: '${tenant.externalId}',
  email: 'ama@example.com',
  firstName: 'Ama',
  consent: { marketing: 'granted', source: 'booking-form' },
});

// Tell us what happens in your app; flows will start from these.
await email.events.record({ tenant: '${tenant.externalId}', name: 'booking.created', email: 'ama@example.com' });`;

  const webhooks = `import { verifyWebhook } from '@platform/sdk';

// Standard Webhooks format, the same one Resend uses.
const event = verifyWebhook(rawBody, request.headers, process.env.PLATFORM_WEBHOOK_SECRET!);
if (event.type === 'email.bounced') markAddressBad(event.data.to);`;

  return (
    <>
      <PageTitle title="Developers" subtitle={`Send from your app as ${tenant.name}. This business’s id is “${tenant.externalId}”.`} />
      {!inStudio() && <AppsAndKeys />}
      <Card className="flex flex-col gap-3 px-5 py-5">
        <CardTitle aside="TypeScript">Send an email</CardTitle>
        <Code>{sdk}</Code>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex flex-col gap-3 px-5 py-5">
          <CardTitle>Contacts and events</CardTitle>
          <Code>{consent}</Code>
        </Card>
        <Card className="flex flex-col gap-3 px-5 py-5">
          <CardTitle>Hear what happened</CardTitle>
          <Code>{webhooks}</Code>
        </Card>
      </div>
      <Card className="flex flex-col gap-3 px-5 py-5">
        <CardTitle aside="Any language">Plain HTTP</CardTitle>
        <Code>{curl}</Code>
      </Card>
    </>
  );
}

/** The account's apps and their API keys. A key is shown once, when it is made. */
function AppsAndKeys() {
  const { data: apps, error } = useQuery(appsQuery());
  const addApp = useAddApp();
  const [adding, setAdding] = useState<string | null>(null);
  return (
    <Card className="flex flex-col gap-4 px-5 py-5">
      <CardTitle
        aside={
          adding === null && (
            <Button variant="secondary" onClick={() => setAdding('')}>
              <Plus size={14} /> Add an app
            </Button>
          )
        }
      >
        Apps and keys
      </CardTitle>
      <p className="m-0 -mt-2 text-[13px] leading-relaxed text-muted">
        Each app that sends for its businesses (Saleane, Caleane, your own booking site) gets its own keys. A key reaches every business of its app, so keep it on
        your server.
      </p>
      {error && <Notice tone="bad">{error.message}</Notice>}
      {addApp.isError && <Notice tone="bad">{addApp.error.message}</Notice>}
      {adding !== null && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addApp.mutate(adding, { onSuccess: () => setAdding(null) });
          }}
        >
          <input autoFocus value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="App name, such as Saleane" aria-label="App name" className={`${input} max-w-xs`} />
          <Button type="submit" disabled={!adding.trim() || addApp.isPending}>
            Add app
          </Button>
          <Button type="button" variant="secondary" onClick={() => setAdding(null)}>
            Cancel
          </Button>
        </form>
      )}
      <div className="flex flex-col divide-y divide-rule">
        {apps?.map((app) => (
          <AppRow key={app.id} app={app} />
        ))}
      </div>
    </Card>
  );
}

function AppRow({ app }: { app: AccountApp }) {
  const addKey = useAddKey();
  const revoke = useRevokeKey();
  const setOrigins = useSetOrigins();
  const [fresh, setFresh] = useState<string | null>(null);
  const [origins, setOriginsText] = useState(app.embedOrigins.join(', '));
  const changed = origins.trim() !== app.embedOrigins.join(', ');
  return (
    <section className="flex flex-col gap-3 py-4 first:pt-1 last:pb-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-[14px] font-semibold">{app.direct ? 'This account' : app.name}</span>
          <span className="text-xs text-muted">{app.direct ? 'Businesses that signed up here' : 'Businesses it adds through the API'}</span>
        </div>
        <Button variant="secondary" disabled={addKey.isPending} onClick={() => addKey.mutate({ appId: app.id, name: `${app.direct ? 'Server' : app.name} key` }, { onSuccess: ({ key }) => setFresh(key) })}>
          <KeyRound size={14} /> New key
        </Button>
      </div>
      {fresh && (
        <Notice>
          <span className="flex flex-col gap-2">
            <span>Copy this key now. It is not shown again.</span>
            <Code>{fresh}</Code>
          </span>
        </Notice>
      )}
      {(addKey.error ?? revoke.error ?? setOrigins.error) && <Notice tone="bad">{(addKey.error ?? revoke.error ?? setOrigins.error)!.message}</Notice>}
      {app.keys.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {app.keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-well px-3 py-2 text-[13px]">
              <span className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-medium">{k.name}</span>
                <code className="font-mono text-xs text-muted">{k.prefix}…</code>
                <span className="text-xs text-muted">
                  Made {when(k.createdAt)} · {k.lastUsedAt ? `last used ${when(k.lastUsedAt)}` : 'not used yet'}
                </span>
              </span>
              <button
                type="button"
                onClick={() => window.confirm(`Revoke “${k.name}”? Anything using it stops working straight away.`) && revoke.mutate(k.id)}
                className="cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-[var(--bad)] underline"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {!app.direct && (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const list = origins
              .split(/[\s,]+/)
              .map((o) => o.trim().replace(/\/$/, ''))
              .filter(Boolean);
            setOrigins.mutate({ appId: app.id, origins: list });
          }}
        >
          <label className="text-xs text-muted" htmlFor={`origins-${app.id}`}>
            Sites that can show the studio inside them
          </label>
          <div className="flex flex-wrap gap-2">
            <input id={`origins-${app.id}`} value={origins} onChange={(e) => setOriginsText(e.target.value)} placeholder="https://app.saleane.com" className={`${input} max-w-md`} />
            <Button type="submit" variant="secondary" disabled={!changed || setOrigins.isPending}>
              Save
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

