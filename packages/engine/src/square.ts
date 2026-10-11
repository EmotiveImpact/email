/**
 * Square Appointments, read only: the business's locations, bookings, customers, services and free
 * times, through Square's public API with the business's own OAuth grant (D132). Nothing here
 * writes to Square.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PlatformError } from './types.ts';

export type SquareConfig = {
  appId: string;
  appSecret: string;
  /** Signs Square's webhook notifications; without it, webhooks are refused and syncs run on the timer. */
  webhookSignatureKey?: string;
  environment: 'production' | 'sandbox';
};

/** The API version every call asks for, so Square's changes never arrive unannounced. */
export const SQUARE_VERSION = '2024-10-17';

/** Read-only scopes: locations, bookings across the team, booking settings, customers and services. */
export const SQUARE_SCOPES = ['MERCHANT_PROFILE_READ', 'APPOINTMENTS_READ', 'APPOINTMENTS_ALL_READ', 'APPOINTMENTS_BUSINESS_SETTINGS_READ', 'CUSTOMERS_READ', 'ITEMS_READ'];

export type SquareTokens = { accessToken: string; refreshToken: string | null; expiresAt: Date | null; merchantId: string };

export type SquareBooking = {
  id: string;
  status: 'PENDING' | 'ACCEPTED' | 'CANCELLED_BY_CUSTOMER' | 'CANCELLED_BY_SELLER' | 'DECLINED' | 'NO_SHOW' | string;
  start_at: string;
  created_at?: string;
  location_id?: string;
  customer_id?: string;
  appointment_segments?: { duration_minutes?: number; service_variation_id?: string; team_member_id?: string }[];
};

export type SquareAvailability = {
  start_at: string;
  location_id?: string;
  appointment_segments?: { duration_minutes?: number; service_variation_id?: string; team_member_id?: string }[];
};

export type SquareCustomer = {
  id: string;
  email_address?: string;
  given_name?: string;
  family_name?: string;
  phone_number?: string;
  /** "1990-03-14", or "0000-03-14" when the year was not given. */
  birthday?: string;
  /** True when the client unsubscribed from the business's marketing email in Square. */
  preferences?: { email_unsubscribed?: boolean };
};
export type SquareService = { id: string; name: string; price: number | null; currency: string | null; minutes: number | null };
export type SquareLocation = { id: string; name: string; status: string; timezone?: string };

const DAY = 86_400_000;

export class SquareClient {
  constructor(
    private readonly config: SquareConfig,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  get base() {
    return this.config.environment === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
  }

  /** Where to send the owner to grant read access. `state` comes back to the callback untouched. */
  authorizeUrl(state: string) {
    const url = new URL(`${this.base}/oauth2/authorize`);
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('scope', SQUARE_SCOPES.join(' '));
    url.searchParams.set('session', 'false');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<SquareTokens> {
    return this.token({ grant_type: 'authorization_code', code });
  }

  async refresh(refreshToken: string): Promise<SquareTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  private async token(grant: Record<string, string>): Promise<SquareTokens> {
    const body = await this.call<{ access_token: string; refresh_token?: string; expires_at?: string; merchant_id: string }>('POST', '/oauth2/token', null, {
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      ...grant,
    });
    return { accessToken: body.access_token, refreshToken: body.refresh_token ?? null, expiresAt: body.expires_at ? new Date(body.expires_at) : null, merchantId: body.merchant_id };
  }

  /** Withdraws the platform's access. Square answers success even if it was already withdrawn. */
  async revoke(accessToken: string) {
    await this.call('POST', '/oauth2/revoke', null, { client_id: this.config.appId, access_token: accessToken }, { authorization: `Client ${this.config.appSecret}` });
  }

  async locations(token: string): Promise<SquareLocation[]> {
    const body = await this.call<{ locations?: SquareLocation[] }>('GET', '/v2/locations', token);
    return body.locations ?? [];
  }

  /** Every booking starting in the window, across the whole team. Square allows 31 days per call. */
  async bookings(token: string, locationId: string, from: Date, to: Date): Promise<SquareBooking[]> {
    const out: SquareBooking[] = [];
    for (let start = from.getTime(); start < to.getTime(); start += 31 * DAY) {
      const end = Math.min(start + 31 * DAY, to.getTime());
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({ limit: '100', location_id: locationId, start_at_min: new Date(start).toISOString(), start_at_max: new Date(end).toISOString() });
        if (cursor) query.set('cursor', cursor);
        const body = await this.call<{ bookings?: SquareBooking[]; cursor?: string }>('GET', `/v2/bookings?${query}`, token);
        out.push(...(body.bookings ?? []));
        cursor = body.cursor;
      } while (cursor);
    }
    return out;
  }

  async customers(token: string, ids: string[]): Promise<Map<string, SquareCustomer>> {
    const out = new Map<string, SquareCustomer>();
    for (let i = 0; i < ids.length; i += 100) {
      const body = await this.call<{ responses?: Record<string, { customer?: SquareCustomer }> }>('POST', '/v2/customers/bulk-retrieve', token, { customer_ids: ids.slice(i, i + 100) });
      for (const [id, r] of Object.entries(body.responses ?? {})) if (r.customer) out.set(id, r.customer);
    }
    return out;
  }

  /** Services by their variation id, named after the item ("Gel manicure", not "Regular"). */
  async services(token: string, variationIds: string[]): Promise<Map<string, SquareService>> {
    const out = new Map<string, SquareService>();
    for (let i = 0; i < variationIds.length; i += 1000) {
      const body = await this.call<{
        objects?: { id: string; type: string; item_variation_data?: { item_id?: string; name?: string; price_money?: { amount?: number; currency?: string }; service_duration?: number } }[];
        related_objects?: { id: string; type: string; item_data?: { name?: string } }[];
      }>('POST', '/v2/catalog/batch-retrieve', token, { object_ids: variationIds.slice(i, i + 1000), include_related_objects: true });
      const items = new Map((body.related_objects ?? []).filter((o) => o.type === 'ITEM').map((o) => [o.id, o.item_data?.name]));
      for (const o of body.objects ?? []) {
        const v = o.item_variation_data;
        if (o.type !== 'ITEM_VARIATION' || !v) continue;
        const itemName = v.item_id ? items.get(v.item_id) : undefined;
        const name = itemName && v.name && v.name !== 'Regular' ? `${itemName} (${v.name})` : itemName ?? v.name ?? 'Appointment';
        out.set(o.id, {
          id: o.id,
          name,
          price: v.price_money?.amount ?? null,
          currency: v.price_money?.currency ?? null,
          minutes: v.service_duration ? Math.round(v.service_duration / 60_000) : null,
        });
      }
    }
    return out;
  }

  /** Free start times for one service, across the team. Square allows 1 to 32 days per call. */
  async availability(token: string, locationId: string, serviceId: string, from: Date, to: Date): Promise<SquareAvailability[]> {
    const body = await this.call<{ availabilities?: SquareAvailability[] }>('POST', '/v2/bookings/availability/search', token, {
      query: { filter: { start_at_range: { start_at: from.toISOString(), end_at: to.toISOString() }, location_id: locationId, segment_filters: [{ service_variation_id: serviceId }] } },
    });
    return body.availabilities ?? [];
  }

  /** True when a webhook really came from Square: HMAC-SHA256 of the notification URL and body. */
  verifyWebhook(notificationUrl: string, rawBody: string, signature: string | undefined) {
    if (!this.config.webhookSignatureKey || !signature) return false;
    const expected = Buffer.from(createHmac('sha256', this.config.webhookSignatureKey).update(notificationUrl + rawBody).digest('base64'));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private async call<T>(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await this.doFetch(`${this.base}${path}`, {
      method,
      headers: {
        'square-version': SQUARE_VERSION,
        accept: 'application/json',
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(token && { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    const json = text ? (JSON.parse(text) as T & { errors?: { code?: string; detail?: string }[] }) : ({} as T & { errors?: undefined });
    if (!response.ok) {
      const first = json.errors?.[0];
      // 502 either way: to our callers this is a problem with Square, not with their own sign-in.
      throw new PlatformError(response.status === 401 ? 'square_unauthorised' : 'square_error', `Square said: ${first?.detail ?? first?.code ?? response.statusText}`, 502);
    }
    return json;
  }
}

/** Square's booking status as the platform's appointment status. */
export function statusOf(booking: SquareBooking, now: Date): 'booked' | 'completed' | 'cancelled' | 'no_show' {
  if (booking.status === 'NO_SHOW') return 'no_show';
  if (booking.status === 'ACCEPTED' || booking.status === 'PENDING') return new Date(booking.start_at) < now && booking.status === 'ACCEPTED' ? 'completed' : 'booked';
  return 'cancelled';
}
