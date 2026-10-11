import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { useTenant } from '../components/Shell.tsx';
import { Card, CardTitle, PageTitle } from '../components/ui.tsx';

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="m-0 overflow-x-auto rounded-xl bg-[#141416] px-4 py-3.5 font-mono text-[12.5px] leading-relaxed text-[#E7E4DE]">{children}</pre>
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
await email.tenants.put('${tenant.id}', { name: '${tenant.name}', fromEmail: '${tenant.fromEmail ?? 'hello@example.com'}' });

// A booking reminder. The key makes retries safe: the same key never sends twice.
await email.emails.send({
  tenant: '${tenant.id}',
  to: 'ama@example.com',
  subject: 'See you Thursday at 10:00',
  html: '<p>Hi Ama, see you on Thursday.</p>',
  idempotencyKey: 'booking-1042-reminder',
});`;

  const curl = `curl -X POST "$API_URL/v1/emails" \\
  -H "Authorization: Bearer $PLATFORM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: booking-1042-reminder" \\
  -d '{"tenant":"${tenant.id}","to":"ama@example.com","subject":"See you Thursday","text":"Hi Ama"}'`;

  const consent = `// News needs recorded consent. Send it when a client ticks the box.
await email.contacts.upsert({
  tenant: '${tenant.id}',
  email: 'ama@example.com',
  firstName: 'Ama',
  consent: { marketing: 'granted', source: 'booking-form' },
});

// Tell us what happens in your app; flows will start from these.
await email.events.record({ tenant: '${tenant.id}', name: 'booking.created', email: 'ama@example.com' });`;

  const webhooks = `import { verifyWebhook } from '@platform/sdk';

// Standard Webhooks format, the same one Resend uses.
const event = verifyWebhook(rawBody, request.headers, process.env.PLATFORM_WEBHOOK_SECRET!);
if (event.type === 'email.bounced') markAddressBad(event.data.to);`;

  return (
    <>
      <PageTitle title="Developers" subtitle={`Send from your app as ${tenant.name}. This business’s id is “${tenant.id}”.`} />
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
