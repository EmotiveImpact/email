/**
 * Plans and paying for them. A business that signed up with us directly is on a plan priced by the
 * people who said yes to its news, with a monthly email allowance. A business inside someone else's
 * app (a salon in Saleane) is paid for by that app, so it has no plan and no limits here.
 *
 * Payments sit behind a small interface. Stripe is used when its key is set; without one, a sample
 * provider switches plans straight away so the whole flow can be tried locally.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, apps, contacts, eq, gte, messages, sql, subscriptions, tenants, type Db, type PlanId } from '@platform/db';
import { PlatformError } from './types.ts';

export type Plan = {
  id: PlanId;
  name: string;
  /** Monthly price in pence. */
  price: number;
  /** People who said yes to news. */
  contacts: number;
  /** Marketing emails (campaigns and flows) a month. Booking confirmations do not count. */
  emails: number;
  /** One line for the plan card. */
  pitch: string;
};

/** Placeholder prices to revise (D84). Allowance is twelve emails a person a month, about three a week. */
export const PLANS: Plan[] = [
  { id: 'free', name: 'Free', price: 0, contacts: 250, emails: 2_500, pitch: 'Try every feature with your first clients.' },
  { id: 'starter', name: 'Starter', price: 1500, contacts: 1_000, emails: 12_000, pitch: 'For a solo practitioner or a small studio.' },
  { id: 'growth', name: 'Growth', price: 2900, contacts: 2_500, emails: 30_000, pitch: 'For a busy salon with a full team.' },
  { id: 'studio', name: 'Studio', price: 4900, contacts: 5_000, emails: 60_000, pitch: 'For established businesses with a big client list.' },
  { id: 'scale', name: 'Scale', price: 7900, contacts: 10_000, emails: 120_000, pitch: 'For several sites or a large regular base.' },
];

export const planById = (id: PlanId) => PLANS.find((p) => p.id === id) ?? PLANS[0]!;

/** Statuses where the paid plan's limits apply. Past due keeps them while Stripe retries the card. */
const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);

// ---------------------------------------------------------------- payment providers

export type CheckoutInput = {
  tenantId: string;
  plan: Plan;
  customerId?: string | null;
  email?: string;
  successUrl: string;
  cancelUrl: string;
};

/** The parts of a subscription we keep, whoever the provider is. */
export type SubscriptionState = {
  tenantId: string;
  plan: PlanId;
  status: string;
  customerId: string | null;
  subscriptionId: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
};

export interface PaymentProvider {
  readonly name: 'stripe' | 'sample';
  /** False for the sample provider: nobody is charged. */
  readonly real: boolean;
  /** Where to send the person to pay. The sample provider switches the plan and returns null. */
  checkout(input: CheckoutInput): Promise<{ url: string } | { state: SubscriptionState }>;
  /** Where to manage cards, invoices and cancelling. Null when the provider has no such page. */
  portal(customerId: string, returnUrl: string): Promise<string | null>;
}

/** Changes plans without taking money. Only for local work and demos (see runtime). */
export class SamplePaymentProvider implements PaymentProvider {
  readonly name = 'sample' as const;
  readonly real = false;
  async checkout(input: CheckoutInput) {
    const now = new Date();
    const state: SubscriptionState = {
      tenantId: input.tenantId,
      plan: input.plan.id,
      status: 'active',
      customerId: input.customerId ?? `cus_sample_${input.tenantId}`,
      subscriptionId: `sub_sample_${input.tenantId}`,
      periodStart: now,
      periodEnd: addMonth(now),
      cancelAtPeriodEnd: false,
    };
    return { state };
  }
  async portal() {
    return null;
  }
}

export const STRIPE_API_VERSION = '2026-09-30.endive';
const lookupKey = (plan: PlanId) => `plan_${plan}_monthly`;

type StripeSubscription = {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  metadata?: Record<string, string>;
  current_period_start?: number;
  current_period_end?: number;
  items: { data: { price: { lookup_key: string | null }; current_period_start?: number; current_period_end?: number }[] };
};

/** Stripe over its REST API with plain fetch; Checkout to pay, the Billing Portal to manage. */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  readonly real = true;
  private prices = new Map<PlanId, string>();

  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, params: Record<string, string> = {}): Promise<T> {
    const body = new URLSearchParams(params).toString();
    const url = `https://api.stripe.com/v1${path}${method === 'GET' && body ? `?${body}` : ''}`;
    const res = await this.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        'stripe-version': STRIPE_API_VERSION,
        ...(method === 'POST' && { 'content-type': 'application/x-www-form-urlencoded' }),
      },
      body: method === 'POST' ? body : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) throw new PlatformError('payment_failed', json.error?.message ?? `Stripe answered ${res.status}.`, 502);
    return json;
  }

  /** Prices are made once in Stripe with lookup keys (plan_starter_monthly ...), so amounts live there. */
  private async priceFor(plan: PlanId) {
    const known = this.prices.get(plan);
    if (known) return known;
    const list = await this.call<{ data: { id: string }[] }>('GET', '/prices', { 'lookup_keys[]': lookupKey(plan), active: 'true' });
    const id = list.data[0]?.id;
    if (!id) throw new PlatformError('payment_failed', `No Stripe price with lookup key ${lookupKey(plan)}. Run the billing setup script.`, 500);
    this.prices.set(plan, id);
    return id;
  }

  async checkout(input: CheckoutInput) {
    const session = await this.call<{ url: string }>('POST', '/checkout/sessions', {
      mode: 'subscription',
      'line_items[0][price]': await this.priceFor(input.plan.id),
      'line_items[0][quantity]': '1',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.tenantId,
      'metadata[tenantId]': input.tenantId,
      'subscription_data[metadata][tenantId]': input.tenantId,
      allow_promotion_codes: 'true',
      ...(input.customerId ? { customer: input.customerId } : input.email ? { customer_email: input.email } : {}),
    });
    return { url: session.url };
  }

  async portal(customerId: string, returnUrl: string) {
    const session = await this.call<{ url: string }>('POST', '/billing_portal/sessions', { customer: customerId, return_url: returnUrl });
    return session.url;
  }

  /**
   * Checks the Stripe-Signature header (HMAC-SHA256 of "timestamp.body", five minutes' tolerance)
   * and returns the event. Throws when it does not match.
   */
  verify(body: string, header: string | undefined, now = Date.now()) {
    const parts = (header ?? '').split(',').map((p) => p.split('=') as [string, string]);
    const t = parts.find(([k]) => k === 't')?.[1];
    const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
    if (!t || !signatures.length) throw new PlatformError('unauthorised', 'Missing Stripe signature.', 400);
    if (Math.abs(now / 1000 - Number(t)) > 300) throw new PlatformError('unauthorised', 'Stripe signature is too old.', 400);
    const expected = Buffer.from(createHmac('sha256', this.webhookSecret).update(`${t}.${body}`).digest('hex'));
    const ok = signatures.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), expected));
    if (!ok) throw new PlatformError('unauthorised', 'Stripe signature does not match.', 400);
    return JSON.parse(body) as { id: string; type: string; data: { object: Record<string, unknown> } };
  }

  /** The subscription as Stripe has it now; webhooks can arrive out of order, so always re-read. */
  async subscription(id: string): Promise<SubscriptionState | null> {
    const sub = await this.call<StripeSubscription>('GET', `/subscriptions/${id}`);
    const tenantId = sub.metadata?.tenantId;
    if (!tenantId) return null;
    const item = sub.items.data[0];
    const plan = item?.price.lookup_key?.match(/^plan_(\w+)_monthly$/)?.[1] as PlanId | undefined;
    // Newer API versions keep the period on the item; older ones on the subscription.
    const start = item?.current_period_start ?? sub.current_period_start;
    const end = item?.current_period_end ?? sub.current_period_end;
    return {
      tenantId,
      plan: plan && PLANS.some((p) => p.id === plan) ? plan : 'free',
      status: sub.status,
      customerId: sub.customer,
      subscriptionId: sub.id,
      periodStart: start ? new Date(start * 1000) : null,
      periodEnd: end ? new Date(end * 1000) : null,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    };
  }
}

function addMonth(date: Date) {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

function monthStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// ---------------------------------------------------------------- plans, usage and limits

export type Allowance = {
  /** "business": this business pays us. "app": the app it lives in pays, so no limits here. */
  billed: 'business' | 'app';
  plan: Plan;
  status: string;
  periodStart: Date;
  periodEnd: Date;
  cancelAtPeriodEnd: boolean;
  contacts: number;
  emails: number;
  /** Emails left this period; Infinity when the app pays. */
  emailsLeft: number;
  overContacts: boolean;
};

export function createBilling({ db, provider }: { db: Db; provider: PaymentProvider | null }) {
  async function tenantRow(tenantId: string) {
    const [row] = await db
      .select({ tenant: tenants, direct: apps.direct, subscription: subscriptions })
      .from(tenants)
      .innerJoin(apps, eq(apps.id, tenants.appId))
      .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
      .where(eq(tenants.id, tenantId));
    if (!row) throw new PlatformError('not_found', 'No such business.', 404);
    return row;
  }

  async function allowance(tenantId: string, now = new Date()): Promise<Allowance> {
    const { direct, subscription } = await tenantRow(tenantId);
    const paid = subscription && PAID_STATUSES.has(subscription.status);
    const plan = planById(paid ? subscription.plan : 'free');
    // Paid plans count from the day the billing month started; everyone else by calendar month.
    let periodStart = paid && subscription.periodStart ? subscription.periodStart : monthStart(now);
    let periodEnd = paid && subscription.periodEnd ? subscription.periodEnd : addMonth(monthStart(now));
    if (periodEnd <= now) {
      // A renewal webhook is late: count from the natural next period rather than piling up usage.
      while (periodEnd <= now) [periodStart, periodEnd] = [periodEnd, addMonth(periodEnd)];
    }
    const [[people], [sent]] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), eq(contacts.marketingConsent, 'granted'))),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(eq(messages.tenantId, tenantId), eq(messages.stream, 'marketing'), gte(messages.createdAt, periodStart))),
    ]);
    const billed = direct ? 'business' : 'app';
    return {
      billed,
      plan,
      status: subscription?.status ?? 'free',
      periodStart,
      periodEnd,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      contacts: people!.n,
      emails: sent!.n,
      emailsLeft: billed === 'app' ? Number.POSITIVE_INFINITY : Math.max(0, plan.emails - sent!.n),
      overContacts: billed === 'business' && people!.n > plan.contacts,
    };
  }

  /** What stops `count` marketing emails going out now, in words to act on. Null when nothing does. */
  async function sendingProblem(tenantId: string, count: number) {
    const a = await allowance(tenantId);
    if (a.billed === 'app') return null;
    if (a.overContacts) {
      return `You have ${a.contacts.toLocaleString('en-GB')} people who said yes to news, more than the ${a.plan.contacts.toLocaleString('en-GB')} on the ${a.plan.name} plan. Choose a bigger plan in Billing to keep sending.`;
    }
    if (count > a.emailsLeft) {
      return a.emailsLeft === 0
        ? `You have used this month's ${a.plan.emails.toLocaleString('en-GB')} emails on the ${a.plan.name} plan. Choose a bigger plan in Billing, or wait until ${a.periodEnd.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}.`
        : `This would send ${count.toLocaleString('en-GB')} emails, but ${a.emailsLeft.toLocaleString('en-GB')} are left this month on the ${a.plan.name} plan. Choose a bigger plan in Billing, or a smaller audience.`;
    }
    return null;
  }

  /** How many marketing emails may go now; flows send up to this and pick the rest up later. */
  async function emailsLeft(tenantId: string) {
    const a = await allowance(tenantId);
    return a.overContacts ? 0 : a.emailsLeft;
  }

  async function save(state: SubscriptionState, providerName: 'stripe' | 'sample') {
    const values = { ...state, provider: providerName, updatedAt: new Date() };
    await db.insert(subscriptions).values(values).onConflictDoUpdate({ target: subscriptions.tenantId, set: values });
  }

  function requireDirect(row: Awaited<ReturnType<typeof tenantRow>>) {
    if (!row.direct) throw new PlatformError('not_billed_here', `${row.tenant.name} is paid for through the app it belongs to.`, 409);
  }

  /** Starts paying for a plan. Returns where to send the person, or null when it is already done. */
  async function choosePlan(tenantId: string, planId: PlanId, input: { email?: string; returnUrl: string }) {
    const row = await tenantRow(tenantId);
    requireDirect(row);
    if (!provider) throw new PlatformError('billing_off', 'Payments are not switched on yet. Get in touch and we will set up your plan.', 503);
    const plan = planById(planId);
    const current = row.subscription;
    const paying = current && PAID_STATUSES.has(current.status) && current.plan !== 'free';
    if (paying && provider.real) {
      // Changing or cancelling a live subscription happens in Stripe's portal, which handles proration.
      return { url: await provider.portal(current.customerId!, input.returnUrl) };
    }
    if (plan.id === 'free') {
      if (current) await save({ ...current, plan: 'free', status: 'canceled', cancelAtPeriodEnd: false }, current.provider);
      return { url: null };
    }
    const result = await provider.checkout({
      tenantId,
      plan,
      customerId: current?.customerId,
      email: input.email,
      successUrl: `${input.returnUrl}${input.returnUrl.includes('?') ? '&' : '?'}paid=1`,
      cancelUrl: input.returnUrl,
    });
    if ('state' in result) {
      await save(result.state, provider.name);
      return { url: null };
    }
    return { url: result.url };
  }

  async function billingPortal(tenantId: string, returnUrl: string) {
    const row = await tenantRow(tenantId);
    requireDirect(row);
    if (!provider || !row.subscription?.customerId) throw new PlatformError('not_found', 'There are no invoices yet.', 404);
    const url = await provider.portal(row.subscription.customerId, returnUrl);
    if (!url) throw new PlatformError('not_found', 'Invoices appear here once payments are switched on.', 404);
    return url;
  }

  /** A Stripe webhook. Re-reads the subscription so out-of-order events cannot leave a stale state. */
  async function stripeWebhook(body: string, signature: string | undefined) {
    if (!(provider instanceof StripePaymentProvider)) throw new PlatformError('not_found', 'Stripe is not set up.', 404);
    const event = provider.verify(body, signature);
    const object = event.data.object;
    const subscriptionId =
      event.type.startsWith('customer.subscription.') ? String(object.id) : typeof object.subscription === 'string' ? object.subscription : null;
    if (!subscriptionId) return { handled: false };
    const state = await provider.subscription(subscriptionId);
    if (!state) return { handled: false };
    const [exists] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, state.tenantId));
    if (!exists) return { handled: false };
    await save(state, 'stripe');
    return { handled: true };
  }

  async function billingSummary(tenantId: string) {
    const a = await allowance(tenantId);
    return {
      billed: a.billed,
      payments: provider ? (provider.real ? 'live' : 'sample') : 'off',
      plan: a.plan.id,
      status: a.status,
      periodStart: a.periodStart.toISOString(),
      periodEnd: a.periodEnd.toISOString(),
      cancelAtPeriodEnd: a.cancelAtPeriodEnd,
      usage: { contacts: a.contacts, emails: a.emails },
      plans: PLANS,
    };
  }

  return { allowance, sendingProblem, emailsLeft, choosePlan, billingPortal, stripeWebhook, billingSummary };
}
