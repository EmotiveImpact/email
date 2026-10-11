import { createApi, createAuth } from '@platform/api';
import { setup } from '@platform/engine/testing';
import { afterEach, expect, it } from 'vitest';
import { PlatformApiError, PlatformClient, verifyWebhook } from '../src/index.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
});

it('talks to the API end to end, including webhook verification', async () => {
  const delivered: { body: string; headers: Record<string, string> }[] = [];
  const hookFetch = (async (_: string, init: RequestInit) => {
    delivered.push({ body: String(init.body), headers: init.headers as Record<string, string> });
    return new Response('ok');
  }) as unknown as typeof fetch;
  const ctx = await setup({ fetch: hookFetch });
  close = ctx.close;
  const webOrigin = 'http://localhost:5173';
  const auth = createAuth({ db: ctx.db, engine: ctx.engine, secret: 'test-secret-that-is-long-enough-1234', baseURL: webOrigin, webOrigin });
  const api = createApi({ engine: ctx.engine, db: ctx.db, webOrigin, auth });
  const client = new PlatformClient({ apiKey: ctx.key, baseUrl: 'https://api.test', fetch: ((url: string, init: RequestInit) => api.request(url, init)) as typeof fetch });

  const tenant = await client.tenants.put('caleane-studio', { name: 'Harbour Films', fromEmail: 'hello@harbour.test' });
  expect(tenant).toMatchObject({ id: 'caleane-studio', status: 'active' });
  await client.contacts.upsert({ tenant: 'caleane-studio', email: 'ama@example.com', consent: { marketing: 'granted', source: 'caleane:enquiry-form' } });
  const event = await client.events.record({ tenant: 'caleane-studio', name: 'project.completed', email: 'ama@example.com' });
  expect(event.matchedContact).toBe(true);

  const booking = await client.appointments.upsert({ tenant: 'caleane-studio', id: 'shoot-1', email: 'ama@example.com', startsAt: new Date(Date.now() + 86_400_000), service: 'Portrait session', price: 25000 });
  expect(booking).toMatchObject({ id: 'shoot-1', status: 'booked', currency: 'GBP' });
  const from = new Date();
  expect(await client.availability.set({ tenant: 'caleane-studio', from, to: new Date(from.getTime() + 7 * 86_400_000), slots: [] })).toEqual({ slots: 0 });

  const { secret } = await client.webhooks.create('https://caleane.test/hooks', ['email.sent']);
  const email = await client.emails.send({ tenant: 'caleane-studio', to: 'ama@example.com', subject: 'Your gallery is ready', text: 'Hi', idempotencyKey: 'gallery-1' });
  expect(email.status).toBe('queued');
  expect((await client.emails.send({ tenant: 'caleane-studio', to: 'ama@example.com', subject: 'x', text: 'x', idempotencyKey: 'gallery-1' })).id).toBe(email.id);

  await ctx.drain();
  expect((await client.emails.get(email.id)).status).toBe('sent');
  expect(verifyWebhook(delivered[0]!.body, delivered[0]!.headers, secret)).toMatchObject({ type: 'email.sent', data: { tenant: 'caleane-studio', emailId: email.id } });
  expect(() => verifyWebhook(delivered[0]!.body, delivered[0]!.headers, 'whsec_' + Buffer.from('wrong').toString('base64'))).toThrow();

  await expect(client.emails.send({ tenant: 'nobody', to: 'a@b.co', subject: 'x', text: 'x' })).rejects.toBeInstanceOf(PlatformApiError);

  expect(await client.studio.setOrigins(['https://app.caleane.test'])).toEqual({ origins: ['https://app.caleane.test'] });
  const studio = await client.studio.createSession({ tenant: 'caleane-studio', origin: 'https://app.caleane.test', user: { id: 'u1', email: 'owner@harbour.test' } });
  expect(studio.url).toMatch(/^http:\/\/localhost:5173\/embed\?page=campaigns#token=stl_/);
});
