/**
 * Phorest, read only: branches, appointments, clients, services and free times, through Phorest's
 * third-party API with the login Phorest issues to each salon on request (D138). Nothing here
 * writes to Phorest.
 */
import { PlatformError } from './types.ts';

export type PhorestRegion = 'eu' | 'us';
export type PhorestLogin = { username: string; password: string; businessId: string; region: PhorestRegion };

export type PhorestBranch = { branchId: string; name: string; timeZone?: string; currencyCode?: string };
export type PhorestAppointment = {
  appointmentId: string;
  appointmentDate: string;
  startTime: string;
  endTime?: string;
  price?: number;
  serviceId?: string;
  serviceName?: string;
  clientId?: string;
  bookingId?: string;
  createdAt?: string;
  state?: 'BOOKED' | 'CHECKED_IN' | 'PAID' | string;
  activationState?: 'RESERVED' | 'ACTIVE' | 'CANCELED' | string;
  deleted?: boolean;
};
export type PhorestClient = {
  clientId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  mobile?: string;
  /** "1990-03-14". */
  birthDate?: string;
  emailMarketingConsent?: boolean;
  deleted?: boolean;
  banned?: boolean;
  archived?: boolean;
};
export type PhorestService = { serviceId: string; name: string; price?: number; duration?: number };
export type PhorestSlot = { startTime: string; endTime?: string };

const DAY = 86_400_000;
const PAGE = 200;

export const PHOREST_HOSTS: Record<PhorestRegion, string> = {
  eu: 'https://api-gateway-eu.phorest.com/third-party-api-server',
  us: 'https://api-gateway-us.phorest.com/third-party-api-server',
};

export class PhorestClientApi {
  constructor(
    private readonly login: PhorestLogin,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  private get business() {
    return `/api/business/${encodeURIComponent(this.login.businessId)}`;
  }

  async branches(): Promise<PhorestBranch[]> {
    return this.all<PhorestBranch>(`${this.business}/branch`, 'branches');
  }

  /** Every appointment on the branch's diary between two days. Phorest allows 31 days per call. */
  async appointments(branchId: string, from: Date, to: Date): Promise<PhorestAppointment[]> {
    const out: PhorestAppointment[] = [];
    for (let start = from.getTime(); start <= to.getTime(); start += 31 * DAY) {
      const end = Math.min(start + 30 * DAY, to.getTime());
      const query = new URLSearchParams({ from_date: day(start), to_date: day(end), fetch_canceled: 'true' });
      out.push(...(await this.all<PhorestAppointment>(`${this.business}/branch/${encodeURIComponent(branchId)}/appointment?${query}`, 'appointments')));
    }
    return out;
  }

  /** Clients by id, 100 per call. */
  async clients(ids: string[]): Promise<PhorestClient[]> {
    const out: PhorestClient[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const query = new URLSearchParams(ids.slice(i, i + 100).map((id): [string, string] => ['client_id', id]));
      out.push(...(await this.all<PhorestClient>(`${this.business}/client-batch?${query}`, 'clients')));
    }
    return out;
  }

  /** Clients changed since a moment, so a change of mind in Phorest reaches us without a new booking. */
  async clientsUpdatedSince(since: Date): Promise<PhorestClient[]> {
    // Phorest's documented format is yyyy-MM-dd'T'HH:mm:ss.SSZ, in UTC here.
    const query = new URLSearchParams({ updatedAfter: since.toISOString().replace(/\.(\d{2})\dZ$/, '.$1+0000') });
    return this.all<PhorestClient>(`${this.business}/client?${query}`, 'clients');
  }

  async services(branchId: string): Promise<PhorestService[]> {
    return this.all<PhorestService>(`${this.business}/branch/${encodeURIComponent(branchId)}/service`, 'services');
  }

  /** Free start times for one service, a week per call. */
  async availability(branchId: string, serviceId: string, from: Date, to: Date): Promise<PhorestSlot[]> {
    const out: PhorestSlot[] = [];
    for (let start = from.getTime(); start < to.getTime(); start += 7 * DAY) {
      const end = Math.min(start + 7 * DAY, to.getTime());
      const body = await this.call<{ data?: { startTime: string; clientSchedules?: { serviceSchedules?: { startTime: string; endTime?: string }[] }[] }[] }>(
        'POST',
        `${this.business}/branch/${encodeURIComponent(branchId)}/appointments/availability`,
        { startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString(), clientServiceSelections: [{ serviceSelections: [{ serviceId }] }] },
      );
      for (const slot of body.data ?? []) {
        const schedule = slot.clientSchedules?.[0]?.serviceSchedules?.[0];
        out.push({ startTime: slot.startTime, ...(schedule?.endTime && { endTime: schedule.endTime }) });
      }
    }
    return out;
  }

  /** A network failure or timeout reads as Phorest being out of reach, not as our own error. */
  private async reach(url: string, init: RequestInit) {
    try {
      return await this.doFetch(url, init);
    } catch {
      throw new PlatformError('phorest_unreachable', 'Phorest could not be reached just now. Try again in a few minutes.', 502);
    }
  }

  /** Every page of a list. */
  private async all<T>(path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; ; page++) {
      const join = path.includes('?') ? '&' : '?';
      const body = await this.call<{ _embedded?: Record<string, T[]>; page?: { totalPages?: number } }>('GET', `${path}${join}size=${PAGE}&page=${page}`);
      out.push(...(body._embedded?.[key] ?? []));
      if (page + 1 >= (body.page?.totalPages ?? 0)) return out;
    }
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.reach(`${PHOREST_HOSTS[this.login.region]}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${this.login.username}:${this.login.password}`).toString('base64')}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = response.statusText;
      try {
        detail = (JSON.parse(text) as { detail?: string }).detail ?? detail;
      } catch {
        // Not JSON; keep the status text.
      }
      // 502 either way: to our callers this is a problem with Phorest, not with their own sign-in.
      const code = response.status === 401 || response.status === 403 ? 'phorest_unauthorised' : response.status === 404 ? 'phorest_not_found' : 'phorest_error';
      throw new PlatformError(code, `Phorest said: ${detail}`, 502);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A wall-clock time in a time zone as an exact moment ("2026-10-27", "10:00:00", "Europe/London"). */
export function wallTime(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm, ss] = time.split(':').map(Number) as [number, number, number?];
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss ?? 0);
  const offsetAt = (at: number) => {
    const parts: Record<string, number> = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(at))
        .map((p) => [p.type, Number(p.value)]),
    );
    return Date.UTC(parts.year!, parts.month! - 1, parts.day, parts.hour, parts.minute, parts.second) - at;
  };
  // Guess with the offset at the wall time, then correct once in case the guess crossed a clock change.
  const first = wall - offsetAt(wall);
  return new Date(wall - offsetAt(first));
}

/** Phorest's appointment state as the platform's appointment status. */
export function phorestStatus(a: PhorestAppointment, startsAt: Date, now: Date): 'booked' | 'completed' | 'cancelled' {
  if (a.deleted || a.activationState === 'CANCELED') return 'cancelled';
  if (a.state === 'PAID' || a.state === 'CHECKED_IN') return 'completed';
  return startsAt < now ? 'completed' : 'booked';
}
