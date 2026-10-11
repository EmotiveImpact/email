import { createHmac } from 'node:crypto';
import { apps, campaigns, eq, sql, subscriptions } from '@platform/db';
import { afterEach, describe, expect, it } from 'vitest';
import { PLANS, StripePaymentProvider, type PaymentProvider } from '../src/index.ts';
import { setup } from '../src/testing.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const content = { preview: 'Space', blocks: [{ id: 'h', type: 'heading', text: 'Hello' }, { id: 'b', type: 'button', label: 'Book', url: 'https://linden.test/book' }] };

/** Linden Studio signed up with us directly, with `people` who said yes to news. */
async function direct(people = 3, paymentProvider?: PaymentProvider | null) {
  const ctx = await setup({ paymentProvider });
  close = ctx.close;
  await ctx.db.update(apps).set({ direct: true }).where(eq(apps.id, ctx.appId));
  await addPeople(ctx, people);
  return ctx;
}

async function addPeople({ db, tenant }: Awaited<ReturnType<typeof setup>>, n: number, from = 0) {
  if (!n) return;
  await db.execute(sql`
    insert into contacts (id, tenant_id, email, marketing_consent)
    select 'con_' || g, ${tenant.id}, 'person' || g || '@example.com', 'granted' from generate_series(${from + 1}::int, ${from + n}::int) g`);
}

/** Marketing emails already sent this month, so the allowance can be used up quickly. */
async function alreadySent({ db, tenant }: Awaited<ReturnType<typeof setup>>, n: number) {
  await db.execute(sql`
    insert into messages (id, tenant_id, stream, to_email, from_email, subject, status)
    select 'msg_old' || g, ${tenant.id}, 'marketing', 'old' || g || '@example.com', 'news@linden.test', 'Earlier', 'delivered' from generate_series(1, ${n}::int) g`);
}

describe('who pays', () => {
  it('leaves a business inside an app without limits, because the app pays', async () => {
    const ctx = await setup();
    close = ctx.close;
    const { engine, tenant } = ctx;
    await addPeople(ctx, 300);
    const allowance = await engine.allowance(tenant.id);
    expect(allowance).toMatchObject({ billed: 'app', contacts: 300, overContacts: false });
    expect(allowance.emailsLeft).toBe(Number.POSITIVE_INFINITY);
    expect(await engine.sendingProblem(tenant.id, 100_000)).toBeNull();
    await expect(engine.choosePlan(tenant.id, 'growth', { returnUrl: 'https://app.test/billing' })).rejects.toMatchObject({ code: 'not_billed_here' });
  });

  it('puts a business inside an app a customer made on a plan of its own', async () => {
    const ctx = await setup();
    close = ctx.close;
    const { engine, db, tenant } = ctx;
    // Only apps we set up (Saleane, Caleane) pay for their businesses; anyone can add an app.
    await db.update(apps).set({ partner: false }).where(eq(apps.id, ctx.appId));
    await addPeople(ctx, 300);
    const allowance = await engine.allowance(tenant.id);
    expect(allowance).toMatchObject({ billed: 'business', plan: { id: 'free' }, overContacts: true });
    expect(await engine.sendingProblem(tenant.id, 10)).toMatch(/Free plan/);
  });

  it('starts a direct business on the free plan and counts its marketing emails', async () => {
    const ctx = await direct(3);
    await alreadySent(ctx, 40);
    const summary = await ctx.engine.billingSummary(ctx.tenant.id);
    expect(summary).toMatchObject({ billed: 'business', plan: 'free', status: 'free', payments: 'sample', usage: { contacts: 3, emails: 40 } });
    expect(summary.plans.map((p) => p.id)).toEqual(['free', 'starter', 'growth', 'studio', 'scale']);
  });
});

describe('limits', () => {
  it('will not schedule a campaign the plan has no room for, and says what to do', async () => {
    const ctx = await direct(3);
    const { engine, tenant } = ctx;
    await alreadySent(ctx, PLANS[0]!.emails - 2);
    const draft = await engine.createCampaign(tenant.id, { subject: 'Hi', content });
    const detail = await engine.campaignDetail(tenant.id, draft.id);
    expect(detail.problems).toContain('This would send 3 emails, but 2 are left this month on the Free plan. Choose a bigger plan in Billing, or a smaller audience.');
    await expect(engine.scheduleCampaign(tenant.id, draft.id)).rejects.toMatchObject({ code: 'not_ready' });
  });

  it('stops sending when more people said yes than the plan covers', async () => {
    const ctx = await direct(251);
    expect(await ctx.engine.sendingProblem(ctx.tenant.id, 1)).toMatch(/^You have 251 people who said yes to news, more than the 250 on the Free plan/);
    expect(await ctx.engine.emailsLeft(ctx.tenant.id)).toBe(0);
  });

  it('checks again when the campaign goes, and puts it back to draft with the reason', async () => {
    const ctx = await direct(3);
    const { engine, tenant, db } = ctx;
    const draft = await engine.createCampaign(tenant.id, { subject: 'Hi', content });
    await engine.scheduleCampaign(tenant.id, draft.id);
    await alreadySent(ctx, PLANS[0]!.emails);
    await engine.processCampaign(draft.id);
    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, draft.id));
    expect(row).toMatchObject({ status: 'draft', scheduledAt: null });
    expect(row!.problem).toMatch(/^Not sent\. You have used this month's 2,500 emails on the Free plan/);
  });
});

describe('choosing a plan', () => {
  it('switches straight away with the sample provider, and back to free', async () => {
    const ctx = await direct(300);
    const { engine, tenant } = ctx;
    expect(await engine.choosePlan(tenant.id, 'starter', { returnUrl: 'https://app.test/billing' })).toEqual({ url: null });
    const allowance = await engine.allowance(tenant.id);
    expect(allowance).toMatchObject({ plan: { id: 'starter' }, status: 'active', overContacts: false, emailsLeft: 12_000 });

    await engine.choosePlan(tenant.id, 'free', { returnUrl: 'https://app.test/billing' });
    expect(await engine.allowance(tenant.id)).toMatchObject({ plan: { id: 'free' }, overContacts: true });
  });

  it('says so when payments are switched off', async () => {
    const ctx = await direct(1, null);
    expect(await ctx.engine.billingSummary(ctx.tenant.id)).toMatchObject({ payments: 'off' });
    await expect(ctx.engine.choosePlan(ctx.tenant.id, 'growth', { returnUrl: 'https://app.test/billing' })).rejects.toMatchObject({ code: 'billing_off', status: 503 });
  });
});

describe('Stripe', () => {
  const secret = 'whsec_test';
  const sign = (body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

  function fakeStripe(tenant: { id: string }) {
    const calls: { method: string; url: string; body: URLSearchParams }[] = [];
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ method: init?.method ?? 'GET', url: u, body: new URLSearchParams(String(init?.body ?? '')) });
      if (u.includes('/prices?')) return Response.json({ data: [{ id: 'price_growth' }] });
      if (u.endsWith('/checkout/sessions')) return Response.json({ url: 'https://checkout.stripe.test/c/1' });
      if (u.endsWith('/billing_portal/sessions')) return Response.json({ url: 'https://billing.stripe.test/p/1' });
      if (u.endsWith('/subscriptions/sub_1')) {
        return Response.json({
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          cancel_at_period_end: false,
          metadata: { tenantId: tenant.id },
          items: { data: [{ price: { lookup_key: 'plan_growth_monthly' }, current_period_start: 1_760_000_000, current_period_end: 1_762_600_000 }] },
        });
      }
      return Response.json({ error: { message: 'Not found' } }, { status: 404 });
    }) as typeof globalThis.fetch;
    return { calls, provider: new StripePaymentProvider('sk_test', secret, fetch) };
  }

  it('sends people to Checkout for the plan, then keeps the subscription from webhooks', async () => {
    const current = { id: '' };
    const { calls, provider } = fakeStripe(current);
    const ctx = await direct(3, provider);
    const { engine, tenant, db } = ctx;
    current.id = tenant.id;

    const { url } = await engine.choosePlan(tenant.id, 'growth', { email: 'edem@linden.test', returnUrl: 'https://app.test/billing' });
    expect(url).toBe('https://checkout.stripe.test/c/1');
    const checkout = calls.find((c) => c.url.endsWith('/checkout/sessions'))!;
    expect(Object.fromEntries(checkout.body)).toMatchObject({
      mode: 'subscription',
      'line_items[0][price]': 'price_growth',
      customer_email: 'edem@linden.test',
      'subscription_data[metadata][tenantId]': tenant.id,
      success_url: 'https://app.test/billing?paid=1',
    });

    const body = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: { id: 'sub_1' } } });
    await expect(engine.stripeWebhook(body, 't=1,v1=bad')).rejects.toMatchObject({ code: 'unauthorised' });
    await expect(engine.stripeWebhook(body, sign(body, Math.floor(Date.now() / 1000) - 600))).rejects.toThrow('too old');
    expect(await engine.stripeWebhook(body, sign(body))).toEqual({ handled: true });

    const [saved] = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenant.id));
    expect(saved).toMatchObject({ plan: 'growth', status: 'active', provider: 'stripe', customerId: 'cus_1', subscriptionId: 'sub_1' });
    expect(saved!.periodEnd).toEqual(new Date(1_762_600_000 * 1000));

    // Once paying, changes and cancelling go through Stripe's own page.
    expect(await engine.choosePlan(tenant.id, 'studio', { returnUrl: 'https://app.test/billing' })).toEqual({ url: 'https://billing.stripe.test/p/1' });
  });
});

describe('generated pictures', () => {
  it('counts them against the plan each month, since each one costs money', async () => {
    const ctx = await direct(3);
    const free = PLANS.find((p) => p.id === 'free')!;
    // Pictures made earlier this month, straight into the library.
    await ctx.db.execute(sql`
      insert into assets (id, tenant_id, kind, name, key, content_type, bytes, width, height)
      select 'ast_old' || g, ${ctx.tenant.id}, 'generated', 'Earlier', 'old' || g, 'image/png', 10, 1, 1 from generate_series(1, ${free.pictures - 1}::int) g`);

    expect(await ctx.engine.imageSettings(ctx.tenant.id)).toMatchObject({ per: 'month', limit: free.pictures, left: 1 });
    await expect(ctx.engine.generateImages(ctx.tenant.id, { prompt: 'Dried flowers', count: 2 })).rejects.toThrow('1 more picture this month');
    await ctx.engine.generateImages(ctx.tenant.id, { prompt: 'Dried flowers', count: 1 });
    await expect(ctx.engine.generateImages(ctx.tenant.id, { prompt: 'Dried flowers', count: 1 })).rejects.toThrow(/all the pictures for this month\. More on \d+ \w+, or choose a bigger plan/);
    expect((await ctx.engine.billingSummary(ctx.tenant.id)).usage.pictures).toBe(free.pictures);

    // A bigger plan lifts the limit straight away.
    await ctx.engine.choosePlan(ctx.tenant.id, 'starter', { returnUrl: 'https://app.test/billing' });
    expect(await ctx.engine.imageSettings(ctx.tenant.id)).toMatchObject({ per: 'month', left: 30 });
  });

  it('leaves only the daily cap for a business whose app pays', async () => {
    const ctx = await setup();
    close = ctx.close;
    expect(await ctx.engine.imageSettings(ctx.tenant.id)).toMatchObject({ per: 'day', limit: 40, left: 40 });
  });
});

