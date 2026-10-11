import { afterEach, describe, expect, it } from 'vitest';
import { parseDefinition, PlatformError, type SegmentDefinitionInput } from '../src/index.ts';
import { setup } from '../src/testing.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/** Four clients with different histories at Linden Studio. */
async function studio() {
  const ctx = await setup();
  close = ctx.close;
  const { engine, app } = ctx;
  const people = [
    { email: 'ama@example.com', firstName: 'Ama', consent: 'granted', attributes: { treatment: 'Facial', visits: 12 }, bookings: [10, 40, 80, 120] },
    { email: 'kofi@example.com', firstName: 'Kofi', consent: 'granted', attributes: { treatment: 'Massage', visits: 2 }, bookings: [60] },
    { email: 'maya@example.com', firstName: 'Maya', consent: 'withdrawn', attributes: { treatment: 'facial' }, bookings: [5, 20, 35] },
    { email: 'lena@studio.co.uk', firstName: 'Lena', consent: undefined, attributes: {}, bookings: [] },
  ] as const;
  for (const p of people) {
    await engine.upsertContact(app, {
      tenant: 'linden',
      email: p.email,
      firstName: p.firstName,
      attributes: p.attributes,
      ...(p.consent && { consent: { marketing: p.consent, source: 'test' } }),
    });
    for (const d of p.bookings) await engine.recordEvent(app, { tenant: 'linden', name: 'booking.created', email: p.email, occurredAt: daysAgo(d) });
  }
  const names = async (definition: SegmentDefinitionInput) =>
    (await engine.listContacts(ctx.tenant.id, { segment: parseDefinition(definition) })).contacts.map((c) => c.firstName).sort();
  return { ...ctx, names };
}

describe('segments', () => {
  it('picks contacts by consent, attribute and email', async () => {
    const { names } = await studio();
    expect(await names({ conditions: [{ type: 'consent', is: 'granted' }] })).toEqual(['Ama', 'Kofi']);
    expect(await names({ conditions: [{ type: 'consent', is: 'unknown' }] })).toEqual(['Lena']);
    // Case-insensitive match, so "facial" and "Facial" are the same treatment.
    expect(await names({ conditions: [{ type: 'attribute', key: 'treatment', op: 'equals', value: 'FACIAL' }] })).toEqual(['Ama', 'Maya']);
    expect(await names({ conditions: [{ type: 'attribute', key: 'visits', op: 'more_than', value: 5 }] })).toEqual(['Ama']);
    expect(await names({ conditions: [{ type: 'attribute', key: 'treatment', op: 'not_exists' }] })).toEqual(['Lena']);
    expect(await names({ conditions: [{ type: 'email', op: 'ends_with', value: '.co.uk' }] })).toEqual(['Lena']);
  });

  it('picks contacts by what they did and when', async () => {
    const { names } = await studio();
    const regulars = { type: 'event', name: 'booking.created', op: 'at_least', count: 3, withinDays: 180 } as const;
    expect(await names({ conditions: [regulars] })).toEqual(['Ama', 'Maya']);
    expect(await names({ conditions: [{ ...regulars, withinDays: 30 }] })).toEqual([]);
    expect(await names({ conditions: [{ type: 'event', name: 'booking.created', op: 'none' }] })).toEqual(['Lena']);
    expect(await names({ conditions: [{ type: 'last_event', name: 'booking.created', op: 'more_than_days_ago', days: 42 }] })).toEqual(['Kofi']);
    expect(await names({ conditions: [{ type: 'last_event', name: 'booking.created', op: 'within_days', days: 14 }] })).toEqual(['Ama', 'Maya']);
  });

  it('combines rules with all or any', async () => {
    const { names } = await studio();
    const granted = { type: 'consent', is: 'granted' } as const;
    const regular = { type: 'event', name: 'booking.created', op: 'at_least', count: 3 } as const;
    expect(await names({ match: 'all', conditions: [granted, regular] })).toEqual(['Ama']);
    expect(await names({ match: 'any', conditions: [granted, regular] })).toEqual(['Ama', 'Kofi', 'Maya']);
    expect(await names({ conditions: [] })).toEqual(['Ama', 'Kofi', 'Lena', 'Maya']);
  });

  it('treats odd input as data, not SQL', async () => {
    const { names } = await studio();
    expect(await names({ conditions: [{ type: 'attribute', key: "x') or true --", op: 'exists' }] })).toEqual([]);
    expect(await names({ conditions: [{ type: 'email', op: 'contains', value: '%' }] })).toEqual([]);
  });

  it('saves, counts and starts a business with useful segments', async () => {
    const { engine, tenant } = await studio();
    await engine.ensureStarterSegments(tenant.id);
    await engine.ensureStarterSegments(tenant.id);
    const list = await engine.listSegments(tenant.id);
    expect(list.map((s) => [s.name, s.size])).toEqual([
      ['Happy to hear news', 2],
      ['Regulars', 2],
      ['Due for a visit', 1],
      ['New this month', 4],
    ]);
    await expect(engine.saveSegment(tenant.id, { name: 'Bad', definition: { conditions: [{ type: 'nope' }] } })).rejects.toBeInstanceOf(PlatformError);
  });
});

describe('contacts', () => {
  it('searches, filters and shows one person in full', async () => {
    const { engine, tenant } = await studio();
    const found = await engine.listContacts(tenant.id, { search: 'ma' });
    expect(found.contacts.map((c) => c.firstName).sort()).toEqual(['Ama', 'Maya']);
    expect((await engine.listContacts(tenant.id, { consent: 'withdrawn' })).total).toBe(1);
    const ama = found.contacts.find((c) => c.firstName === 'Ama')!;
    expect(ama.lastActivityAt).not.toBeNull();
    const detail = await engine.contactDetail(tenant.id, ama.id);
    expect(detail.consents[0]).toMatchObject({ status: 'granted', source: 'test' });
    expect(detail.events).toHaveLength(4);
    expect(await engine.vocabulary(tenant.id)).toEqual({ events: ['booking.created'], attributes: ['treatment', 'visits'] });
  });

  it('keeps one business’s contacts away from another account', async () => {
    const { engine, tenant } = await studio();
    const other = await engine.createAccountWithApp({ account: 'Other', app: 'Other' });
    await expect(engine.tenantInAccount(other.accountId, tenant.id)).rejects.toMatchObject({ status: 404 });
  });
});
