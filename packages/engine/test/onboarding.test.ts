import { appointments, contacts, eq } from '@platform/db';
import { afterEach, describe, expect, it } from 'vitest';
import { setup } from '../src/testing.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function studio() {
  const ctx = await setup();
  close = ctx.close;
  return ctx;
}

describe('bringing in clients', () => {
  it('adds clients, skips rows without an email and records the owner’s confirmation as consent', async () => {
    const { engine, tenant, db } = await studio();
    const result = await engine.importClients(tenant.id, {
      consent: 'granted',
      clients: [
        { email: ' Ama@Example.com ', firstName: 'Ama', lastName: 'Mensah', phone: '07700 900123' },
        { email: 'kofi@example.com', firstName: 'Kofi' },
        { email: 'not an email', firstName: 'Nobody' },
        { firstName: 'No email' },
      ],
    });
    expect(result).toEqual({
      added: 2,
      updated: 0,
      consented: 2,
      skipped: [
        { row: 3, reason: 'No valid email address.' },
        { row: 4, reason: 'No valid email address.' },
      ],
    });
    const [ama] = await db.select().from(contacts).where(eq(contacts.email, 'ama@example.com'));
    expect(ama).toMatchObject({ firstName: 'Ama', lastName: 'Mensah', marketingConsent: 'granted', attributes: { phone: '07700 900123' } });
  });

  it('never overrides a person who said no, or a name the business already has', async () => {
    const { engine, tenant, app, db } = await studio();
    await engine.upsertContact(app, { tenant: 'linden', email: 'maya@example.com', firstName: 'Maya', consent: { marketing: 'withdrawn', source: 'unsubscribe-link' } });
    const result = await engine.importClients(tenant.id, { consent: 'granted', clients: [{ email: 'maya@example.com', firstName: 'M.' }, { email: 'new@example.com' }] });
    expect(result).toMatchObject({ added: 1, updated: 1, consented: 1 });
    const [maya] = await db.select().from(contacts).where(eq(contacts.email, 'maya@example.com'));
    expect(maya).toMatchObject({ firstName: 'Maya', marketingConsent: 'withdrawn' });
  });

  it('leaves consent unknown unless the owner confirms it', async () => {
    const { engine, tenant, db } = await studio();
    await engine.importClients(tenant.id, { consent: 'unknown', clients: [{ email: 'ama@example.com' }] });
    const [ama] = await db.select().from(contacts).where(eq(contacts.email, 'ama@example.com'));
    expect(ama!.marketingConsent).toBe('unknown');
  });
});

describe('bringing in visits', () => {
  it('turns past visits into a rhythm, once, however often the file is imported', async () => {
    const { engine, tenant, db } = await studio();
    const visits = [
      { email: 'ama@example.com', firstName: 'Ama', date: '2026-06-02T10:00:00Z', service: 'Facial', price: '£45.00' },
      { email: 'ama@example.com', date: '2026-07-01T10:00:00Z', service: 'Facial', price: 45 },
      { email: 'ama@example.com', date: '2026-07-29T10:00:00Z', service: 'Facial', price: '45' },
      { email: 'ama@example.com', date: 'next tuesday', service: 'Facial' },
    ];
    const first = await engine.importVisits(tenant.id, { visits });
    expect(first.saved).toBe(3);
    expect(first.skipped).toEqual([{ row: 4, reason: 'date: Use a date like 2026-07-01 or 01/07/2026.' }]);
    await engine.importVisits(tenant.id, { visits: visits.slice(0, 3) });

    const rows = await db.select().from(appointments).where(eq(appointments.tenantId, tenant.id));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'completed' && r.price === 4500)).toBe(true);
    const [rhythm] = await engine.rhythms(tenant.id, new Date('2026-08-10T10:00:00Z'));
    expect(rhythm).toMatchObject({ visits: 3, gapDays: 29, lastService: 'Facial' });
  });
});

describe('getting started', () => {
  it('lists the steps to a first booking from email, and ticks them off', async () => {
    const { engine, tenant } = await studio();
    const before = await engine.gettingStarted(tenant.id);
    expect(before.steps.map((s) => s.id)).toEqual(['details', 'clients', 'diary', 'domain', 'flow', 'email']);
    expect(before.done).toBe(0);
    await engine.importClients(tenant.id, { consent: 'granted', clients: [{ email: 'ama@example.com' }] });
    await engine.importVisits(tenant.id, { visits: [{ email: 'ama@example.com', date: '2026-07-01' }] });
    const after = await engine.gettingStarted(tenant.id);
    expect(after.steps.filter((s) => s.done).map((s) => s.id)).toEqual(['clients', 'diary']);
  });
});
