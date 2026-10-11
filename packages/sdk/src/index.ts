/**
 * TypeScript client for the platform API. No dependencies beyond `fetch` and the Standard
 * Webhooks verifier, so it runs in Node, Bun, Deno and edge runtimes.
 *
 *   const email = new PlatformClient({ apiKey: process.env.PLATFORM_API_KEY! });
 *   await email.emails.send({ tenant: 'linden', to: 'ama@example.com', subject: 'See you Thursday', text: '…' });
 */
import { Webhook } from 'standardwebhooks';

export type Stream = 'transactional' | 'marketing';
export type EmailStatus =
  | 'queued' | 'sending' | 'sent' | 'delivered' | 'delivery_delayed'
  | 'bounced' | 'complained' | 'rejected' | 'failed' | 'suppressed';

export type Email = {
  id: string;
  stream: Stream;
  to: string;
  from: string;
  subject: string;
  status: EmailStatus;
  /** Why a suppressed or failed email did not go, e.g. "unsubscribe" or "hard_bounce". */
  reason: string | null;
  tags: Record<string, string>;
  createdAt: string;
  sentAt: string | null;
};

export type SendEmail = {
  tenant: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
  stream?: Stream;
  tags?: Record<string, string>;
  /** Sending twice with the same key returns the first email instead of sending again. */
  idempotencyKey?: string;
};

export type Brand = { accent?: string; rail?: 'light' | 'pigment'; headingFont?: 'cal-sans' | 'geist' | 'serif'; logoUrl?: string };
export type Tenant = { id: string; name: string; fromEmail: string | null; replyTo: string | null; status: 'active' | 'paused'; brand: Brand };

export type Contact = {
  id: string;
  email: string;
  externalId: string | null;
  firstName: string | null;
  lastName: string | null;
  attributes: Record<string, unknown>;
  marketingConsent: 'granted' | 'withdrawn' | 'unknown';
};

export type WebhookEventType =
  | 'email.sent' | 'email.delivered' | 'email.delivery_delayed' | 'email.bounced' | 'email.complained'
  | 'email.rejected' | 'email.failed' | 'email.opened' | 'email.clicked' | 'contact.unsubscribed';

export type WebhookEvent = { type: WebhookEventType; createdAt: string; data: Record<string, unknown> & { tenant: string } };

export class PlatformApiError extends Error {
  override name = 'PlatformApiError';
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export class PlatformClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: { apiKey: string; baseUrl?: string; fetch?: typeof fetch }) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:8787').replace(/\/$/, '');
    this.doFetch = options.fetch ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json().catch(() => ({}))) as { error?: { code: string; message: string } };
    if (!response.ok) throw new PlatformApiError(response.status, json.error?.code ?? 'http_error', json.error?.message ?? `HTTP ${response.status}`);
    return json as T;
  }

  readonly emails = {
    send: ({ idempotencyKey, ...email }: SendEmail) =>
      this.call<Email>('POST', '/v1/emails', email, idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    get: (id: string) => this.call<Email>('GET', `/v1/emails/${encodeURIComponent(id)}`),
  };

  readonly tenants = {
    /** Creates or replaces a tenant (one business inside your app). */
    put: (id: string, tenant: { name: string; fromEmail?: string; replyTo?: string; brand?: Brand }) =>
      this.call<Tenant>('PUT', `/v1/tenants/${encodeURIComponent(id)}`, tenant),
  };

  readonly contacts = {
    upsert: (contact: {
      tenant: string;
      email: string;
      externalId?: string;
      firstName?: string;
      lastName?: string;
      attributes?: Record<string, unknown>;
      consent?: { marketing: 'granted' | 'withdrawn'; source: string; recordedAt?: string };
    }) => this.call<Contact>('PUT', '/v1/contacts', contact),
  };

  readonly events = {
    /** Tells the platform something happened in your app, e.g. "booking.created". */
    record: (event: { tenant: string; name: string; email?: string; contactExternalId?: string; properties?: Record<string, unknown>; occurredAt?: string }) =>
      this.call<{ id: string; name: string; matchedContact: boolean }>('POST', '/v1/events', event),
  };

  readonly webhooks = {
    create: (url: string, events: WebhookEventType[] = []) => this.call<{ id: string; secret: string; events: WebhookEventType[] }>('POST', '/v1/webhooks', { url, events }),
  };

  /**
   * The embedded campaign studio. Allow your app's origin once, then create a session on your
   * server each time someone opens Email, and load its `url` in an iframe (`mountStudio` from `@platform/sdk/browser`).
   */
  readonly studio = {
    setOrigins: (origins: string[]) => this.call<{ origins: string[] }>('PUT', '/v1/studio/origins', { origins }),
    createSession: (session: StudioSessionInput) => this.call<{ url: string; expiresAt: string }>('POST', '/v1/studio/sessions', session),
  };
}

export type StudioSessionInput = {
  /** Your id for the business. */
  tenant: string;
  /** The origin of the page that will show the studio, such as https://app.saleane.com. */
  origin: string;
  /** The person opening it. Their email is the default address for test sends. */
  user: { id: string; name?: string; email?: string };
  /** Your app's look, so the studio reads as part of it. */
  theme?: { accent?: string; headingFont?: 'cal-sans' | 'geist' | 'serif'; canvas?: string };
  page?: 'campaigns' | 'audience';
};

/** Checks a webhook really came from the platform and returns the event. Throws if not. */
export function verifyWebhook(body: string, headers: Record<string, string>, secret: string): WebhookEvent {
  return new Webhook(secret).verify(body, headers) as WebhookEvent;
}
