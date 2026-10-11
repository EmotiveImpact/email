import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Brand } from './theme.ts';

/** Empty: the app serves /app and /auth from its own origin (Vite proxies them in development). */
const BASE = import.meta.env.VITE_API_URL ?? '';

export type Tenant = {
  /** Internal id, used in the app's URLs. */
  id: string;
  /** The id the sending app uses for this business. */
  externalId: string;
  /** Which app the business belongs to (Saleane, Caleane, Direct). */
  app: string | null;
  name: string;
  fromEmail: string | null;
  replyTo: string | null;
  status: 'active' | 'paused';
  brand: Brand;
};

export type MessageStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'delivery_delayed'
  | 'bounced'
  | 'complained'
  | 'rejected'
  | 'failed'
  | 'suppressed';

export type Message = {
  id: string;
  stream: 'transactional' | 'marketing';
  to: string;
  from: string;
  subject: string;
  status: MessageStatus;
  reason: string | null;
  tags: Record<string, string>;
  createdAt: string;
  sentAt: string | null;
};

export type Activity = {
  stats: Partial<Record<MessageStatus, number>>;
  daily: { day: string; total: number; delivered: number }[];
  messages: Message[];
};

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  } catch {
    throw new ApiError('offline', 'Cannot reach the API. Is it running?', 0);
  }
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as { error?: { code: string; message: string }; code?: string; message?: string } | null;
  if (!response.ok) {
    // Our API nests errors under `error`; Better Auth puts code and message at the top level.
    const code = body?.error?.code ?? body?.code ?? 'error';
    const message = body?.error?.message ?? body?.message ?? `The API answered ${response.status}.`;
    throw new ApiError(code, message, response.status);
  }
  return body as T;
}

// ---------------------------------------------------------------- who is signed in

export type Me = { user: { id: string; name: string; email: string }; accountId: string | null; accounts: { id: string; name: string }[] };

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: () => request<Me>('/app/me'),
  staleTime: 60_000,
  retry: false,
});

export const auth = {
  signIn: (email: string, password: string) => request('/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email, password }) }),
  signUp: (name: string, email: string, password: string) => request('/auth/sign-up/email', { method: 'POST', body: JSON.stringify({ name, email, password }) }),
  signOut: () => request('/auth/sign-out', { method: 'POST', body: '{}' }),
  createAccount: (name: string) => request<{ id: string }>('/app/accounts', { method: 'POST', body: JSON.stringify({ name }) }),
  switchAccount: (id: string) => request('/app/accounts/' + encodeURIComponent(id) + '/switch', { method: 'POST' }),
  createTenant: (name: string, fromEmail?: string) => request<Tenant>('/app/tenants', { method: 'POST', body: JSON.stringify({ name, fromEmail }) }),
};

// ---------------------------------------------------------------- businesses and sending

export const tenantsQuery = queryOptions({
  queryKey: ['tenants'],
  queryFn: () => request<Tenant[]>('/app/tenants'),
});

export const activityQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['activity', tenant],
    queryFn: () => request<Activity>(`/app/tenants/${encodeURIComponent(tenant)}/activity`),
    refetchInterval: 15_000,
  });

export type Show = 'all' | 'arrived' | 'held' | 'problems';

/** Which statuses each Sending filter covers. Mirrors SHOW in the API. */
export const SHOW: Record<Exclude<Show, 'all'>, MessageStatus[]> = {
  arrived: ['queued', 'sending', 'sent', 'delivered', 'delivery_delayed'],
  held: ['suppressed'],
  problems: ['bounced', 'complained', 'rejected', 'failed'],
};

export const messagesQuery = (tenant: string, show: Show) =>
  queryOptions({
    queryKey: ['messages', tenant, show],
    queryFn: () => request<Message[]>(`/app/tenants/${encodeURIComponent(tenant)}/messages?show=${show}`),
    refetchInterval: 15_000,
  });

export function useSaveBrand(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (brand: Brand) =>
      request<Tenant>(`/app/tenants/${encodeURIComponent(tenant)}/brand`, { method: 'PUT', body: JSON.stringify(brand) }),
    onSuccess: (updated) => client.setQueryData<Tenant[]>(['tenants'], (list) => list?.map((t) => (t.id === updated.id ? updated : t))),
  });
}

// ---------------------------------------------------------------- audience

export type Consent = 'granted' | 'withdrawn' | 'unknown';

export type Contact = {
  id: string;
  email: string;
  externalId: string | null;
  firstName: string | null;
  lastName: string | null;
  attributes: Record<string, unknown>;
  marketingConsent: Consent;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string | null;
};

export type ContactDetail = {
  contact: Contact;
  consents: { id: string; status: 'granted' | 'withdrawn'; source: string; recordedAt: string }[];
  events: { id: string; name: string; properties: Record<string, unknown>; occurredAt: string }[];
  messages: { id: string; subject: string; stream: Message['stream']; status: MessageStatus; createdAt: string }[];
  suppressions: { reason: string; stream: 'all' | 'marketing'; scope: string; createdAt: string }[];
};

export type Condition =
  | { type: 'consent'; is: Consent }
  | { type: 'attribute'; key: string; op: 'equals' | 'not_equals' | 'contains' | 'exists' | 'not_exists' | 'more_than' | 'less_than'; value?: string | number }
  | { type: 'event'; name: string; op: 'at_least' | 'none'; count?: number; withinDays?: number }
  | { type: 'last_event'; name: string; op: 'more_than_days_ago' | 'within_days'; days: number }
  | { type: 'added'; op: 'within_days' | 'more_than_days_ago'; days: number }
  | { type: 'email'; op: 'contains' | 'ends_with'; value: string };

export type SegmentDefinition = { match: 'all' | 'any'; conditions: Condition[] };
export type Segment = { id: string; name: string; definition: SegmentDefinition; size?: number; createdAt: string; updatedAt: string };

export type ContactFilter = { search?: string; consent?: Consent; segment?: string; offset?: number };

export const contactsQuery = (tenant: string, filter: ContactFilter) => {
  const params = new URLSearchParams();
  if (filter.search) params.set('search', filter.search);
  if (filter.consent) params.set('consent', filter.consent);
  if (filter.segment) params.set('segment', filter.segment);
  if (filter.offset) params.set('offset', String(filter.offset));
  return queryOptions({
    queryKey: ['contacts', tenant, filter],
    queryFn: () => request<{ total: number; contacts: Contact[] }>(`/app/tenants/${tenant}/contacts?${params}`),
  });
};

export const contactQuery = (tenant: string, contact: string) =>
  queryOptions({ queryKey: ['contact', tenant, contact], queryFn: () => request<ContactDetail>(`/app/tenants/${tenant}/contacts/${contact}`) });

export const segmentsQuery = (tenant: string) =>
  queryOptions({ queryKey: ['segments', tenant], queryFn: () => request<Segment[]>(`/app/tenants/${tenant}/segments`) });

export const vocabularyQuery = (tenant: string) =>
  queryOptions({ queryKey: ['vocabulary', tenant], queryFn: () => request<{ events: string[]; attributes: string[] }>(`/app/tenants/${tenant}/vocabulary`) });

export const previewSegment = (tenant: string, definition: SegmentDefinition) =>
  request<{ size: number; sample: Pick<Contact, 'id' | 'email' | 'firstName' | 'lastName'>[] }>(`/app/tenants/${tenant}/segments/preview`, {
    method: 'POST',
    body: JSON.stringify({ definition }),
  });

export function useAddContact(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; firstName?: string; lastName?: string; consent: boolean }) =>
      request<Contact>(`/app/tenants/${tenant}/contacts`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['contacts', tenant] }),
  });
}

export function useSaveSegment(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id?: string; name: string; definition: SegmentDefinition }) =>
      request<Segment>(id ? `/app/tenants/${tenant}/segments/${id}` : `/app/tenants/${tenant}/segments`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['segments', tenant] }),
  });
}

export function useDeleteSegment(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request<void>(`/app/tenants/${tenant}/segments/${id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['segments', tenant] }),
  });
}
