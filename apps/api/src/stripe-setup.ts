/**
 * Creates the plans in Stripe once: a product and a monthly GBP price per paid plan, found later
 * by lookup key (plan_starter_monthly ...). Safe to run again; existing prices are left alone.
 * Changing a price means a new price in Stripe with the same lookup key (transfer_lookup_key).
 *
 *   STRIPE_SECRET_KEY=sk_... pnpm --filter @platform/api stripe:setup
 */
import { PLANS, STRIPE_API_VERSION } from '@platform/engine';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error('Set STRIPE_SECRET_KEY.');

async function stripe<T>(method: 'GET' | 'POST', path: string, params: Record<string, string>) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.stripe.com/v1${path}${method === 'GET' ? `?${body}` : ''}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'stripe-version': STRIPE_API_VERSION, 'content-type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? body : undefined,
  });
  const json = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `Stripe answered ${res.status}`);
  return json;
}

for (const plan of PLANS.filter((p) => p.price > 0)) {
  const lookup = `plan_${plan.id}_monthly`;
  const found = await stripe<{ data: { id: string }[] }>('GET', '/prices', { 'lookup_keys[]': lookup, active: 'true' });
  if (found.data.length) {
    console.log(`${plan.name}: already set up (${found.data[0]!.id})`);
    continue;
  }
  const product = await stripe<{ id: string }>('POST', '/products', {
    name: `${plan.name} plan`,
    description: `Up to ${plan.contacts.toLocaleString('en-GB')} people and ${plan.emails.toLocaleString('en-GB')} emails a month`,
    'metadata[plan]': plan.id,
  });
  const price = await stripe<{ id: string }>('POST', '/prices', {
    product: product.id,
    currency: 'gbp',
    unit_amount: String(plan.price),
    'recurring[interval]': 'month',
    lookup_key: lookup,
    'metadata[plan]': plan.id,
  });
  console.log(`${plan.name}: created ${price.id}`);
}
