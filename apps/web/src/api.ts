import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { EmailDoc } from '@platform/content/blocks';
import { endStudio, studioSession, tellHost, type StudioTheme } from './studio.ts';
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
  /** Why the reputation guard paused sending, when it did. */
  pausedReason: string | null;
  /** IANA time zone; flows send in the business's daytime. */
  timezone: string;
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
    const studio = studioSession();
    const headers = { 'content-type': 'application/json', ...(studio && { authorization: `Studio ${studio.sessionToken}` }), ...init?.headers };
    response = await fetch(`${BASE}${path}`, { credentials: studio ? 'omit' : 'include', ...init, headers });
  } catch {
    throw new ApiError('offline', 'Cannot reach the API. Is it running?', 0);
  }
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as { error?: { code: string; message: string }; code?: string; message?: string } | null;
  if (!response.ok) {
    // Our API nests errors under `error`; Better Auth puts code and message at the top level.
    const code = body?.error?.code ?? body?.code ?? 'error';
    const message = body?.error?.message ?? body?.message ?? `The API answered ${response.status}.`;
    if (code === 'studio_expired') {
      tellHost({ type: 'session-expired' });
      endStudio();
    }
    throw new ApiError(code, message, response.status);
  }
  return body as T;
}

// ---------------------------------------------------------------- who is signed in

export type Me = {
  user: { id: string; name: string; email: string | null };
  accountId: string | null;
  accounts: { id: string; name: string }[];
  /** Set when the app runs as an embedded studio inside a host app. */
  studio: { tenantId: string; origin: string; theme: StudioTheme; expiresAt: string } | null;
};

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
    mutationFn: (brand: Brand & { timezone?: string }) =>
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
  rhythm: Rhythm | null;
  appointments: Appointment[];
};

export type Rhythm = {
  contactId: string;
  visits: number;
  lastVisit: string | null;
  gapDays: number | null;
  dueAt: string | null;
  bookedAhead: boolean;
  nextVisit: string | null;
  lastService: string | null;
};

export type Appointment = {
  id: string;
  externalId: string;
  startsAt: string;
  service: string | null;
  staff: string | null;
  price: number | null;
  currency: string;
  status: 'booked' | 'completed' | 'cancelled' | 'no_show';
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

// ---------------------------------------------------------------- campaigns

export type { Block, BlockType, EmailDoc } from '@platform/content/blocks';

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent';
export type Audience = { total: number; noConsent: number; suppressed: number; eligible: number };
export type CampaignStats = {
  total: number;
  pending: number;
  delivered: number;
  bounced: number;
  complained: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
  /** Bookings made within five days of this email, and their value in pence. */
  bookings: number;
  revenue: number;
};

export type Campaign = {
  id: string;
  name: string;
  subject: string;
  segmentId: string | null;
  content: EmailDoc;
  status: CampaignStatus;
  scheduledAt: string | null;
  sentAt: string | null;
  recipients: number | null;
  skippedNoConsent: number | null;
  skippedSuppressed: number | null;
  createdAt: string;
  updatedAt: string;
  stats: CampaignStats | null;
};

export type CampaignDetail = Campaign & { problems: string[]; audience: Audience | null; sender: { from: string; own: boolean } };
export type CampaignPatch = Partial<Pick<Campaign, 'name' | 'subject' | 'segmentId' | 'content'>>;

const campaignPath = (tenant: string, id?: string) => `/app/tenants/${tenant}/campaigns${id ? `/${id}` : ''}`;

export const campaignsQuery = (tenant: string) =>
  queryOptions({ queryKey: ['campaigns', tenant], queryFn: () => request<Campaign[]>(campaignPath(tenant)) });

export const campaignQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['campaign', tenant, id],
    queryFn: () => request<CampaignDetail>(campaignPath(tenant, id)),
    // Results arrive over minutes while a campaign goes out.
    refetchInterval: (q) => (q.state.data?.status === 'sending' || q.state.data?.status === 'scheduled' ? 10_000 : false),
  });

export const audienceQuery = (tenant: string, segmentId: string | null) =>
  queryOptions({
    queryKey: ['audience', tenant, segmentId],
    queryFn: () => request<Audience>(`/app/tenants/${tenant}/audience${segmentId ? `?segment=${segmentId}` : ''}`),
  });

export const previewEmail = (tenant: string, content: EmailDoc) =>
  request<{ html: string }>(`${campaignPath(tenant)}/preview`, { method: 'POST', body: JSON.stringify({ content }) });

export function useCreateCampaign(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CampaignPatch = {}) => request<Campaign>(campaignPath(tenant), { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['campaigns', tenant] }),
  });
}

/** Saves, schedules and so on all answer with the fresh campaign, which goes straight into the cache. */
function useCampaignAction<I>(tenant: string, id: string, call: (input: I) => Promise<CampaignDetail>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (fresh) => {
      client.setQueryData(['campaign', tenant, id], fresh);
      void client.invalidateQueries({ queryKey: ['campaigns', tenant] });
    },
  });
}

export const useSaveCampaign = (tenant: string, id: string) =>
  useCampaignAction(tenant, id, (patch: CampaignPatch) => request<CampaignDetail>(campaignPath(tenant, id), { method: 'PUT', body: JSON.stringify(patch) }));

export const useScheduleCampaign = (tenant: string, id: string) =>
  useCampaignAction(tenant, id, (at: string | null) =>
    request<CampaignDetail>(`${campaignPath(tenant, id)}/schedule`, { method: 'POST', body: JSON.stringify(at ? { at } : {}) }),
  );

export const useUnscheduleCampaign = (tenant: string, id: string) =>
  useCampaignAction(tenant, id, (_: void) => request<CampaignDetail>(`${campaignPath(tenant, id)}/unschedule`, { method: 'POST', body: '{}' }));

export function useSendTest(tenant: string, id: string) {
  return useMutation({
    mutationFn: (to: string) => request<{ to: string }>(`${campaignPath(tenant, id)}/test`, { method: 'POST', body: JSON.stringify({ to }) }),
  });
}

export function useDeleteCampaign(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request<void>(campaignPath(tenant, id), { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['campaigns', tenant] }),
  });
}

// ---------------------------------------------------------------- sending domain

export type DnsRecord = { type: 'CNAME' | 'TXT' | 'MX'; name: string; value: string };
export type Domain = {
  id: string;
  domain: string;
  status: 'pending' | 'verified' | 'failed';
  records: DnsRecord[];
  dmarc: boolean;
  dmarcRecord: DnsRecord;
  checkedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
};
export type SendingSetup = {
  domains: Domain[];
  reputation: { sent: number; bounced: number; complained: number; bounceRate: number; complaintRate: number };
  sender: { from: string; replyTo: string | null; own: boolean };
};

export const sendingQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['sending-setup', tenant],
    queryFn: () => request<SendingSetup>(`/app/tenants/${tenant}/sending`),
    // While a domain waits for DNS, look again now and then.
    refetchInterval: (q) => (q.state.data?.domains.some((d) => d.status === 'pending') ? 30_000 : false),
  });

function useSendingAction<I, O>(tenant: string, call: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['sending-setup', tenant] });
      void client.invalidateQueries({ queryKey: ['tenants'] });
    },
  });
}

export const useAddDomain = (tenant: string) =>
  useSendingAction(tenant, (input: { domain: string; localPart: string }) =>
    request<Domain>(`/app/tenants/${tenant}/domains`, { method: 'POST', body: JSON.stringify(input) }),
  );
export const useCheckDomain = (tenant: string) =>
  useSendingAction(tenant, (id: string) => request<Domain>(`/app/tenants/${tenant}/domains/${id}/check`, { method: 'POST', body: '{}' }));
export const useRemoveDomain = (tenant: string) =>
  useSendingAction(tenant, (id: string) => request<void>(`/app/tenants/${tenant}/domains/${id}`, { method: 'DELETE' }));
export const useResumeSending = (tenant: string) =>
  useSendingAction(tenant, (_: void) => request<Tenant>(`/app/tenants/${tenant}/resume`, { method: 'POST', body: '{}' }));

// ---------------------------------------------------------------- diary and flows

export type Diary = {
  connected: boolean;
  timezone: string;
  days: { day: string; open: number; booked: number }[];
  dueCount: number;
  due: (Rhythm & { contact: Pick<Contact, 'id' | 'email' | 'firstName' | 'lastName'> })[];
};

export const diaryQuery = (tenant: string) =>
  queryOptions({ queryKey: ['diary', tenant], queryFn: () => request<Diary>(`/app/tenants/${tenant}/diary`), refetchInterval: 60_000 });

export type FlowKind = 'welcome' | 'rebook' | 'fill_slots' | 'winback';
export type FlowStats = { sent: number; opened: number; clicked: number; bookings: number; revenue: number };

export type Flow = {
  id: string;
  kind: FlowKind;
  name: string;
  description: string;
  live: boolean;
  subject: string;
  content: EmailDoc;
  settings: Record<string, number>;
  fields: Record<string, { label: string; min: number; max: number }>;
  problems: string[];
  stats: FlowStats;
  /** People it would email if it ran now. */
  waiting: number;
  updatedAt: string;
};

export type FlowNext = {
  total: number;
  people: { firstName: string | null; lastName: string | null; email: string; lastService: string | null; lastVisit: string | null; dueAt: string | null }[];
  /** Fill quiet days only: the day it would offer and its free times. */
  fill: { day: string; open: number; times: string[] } | null;
};

export type FlowDetail = Flow & {
  next: FlowNext;
  recent: { email: string; firstName: string | null; lastName: string | null; reason: string; at: string; status: MessageStatus | null }[];
  sender: { from: string; own: boolean };
};

export type FlowPatch = Partial<Pick<Flow, 'subject' | 'content' | 'settings' | 'live'>>;

const flowPath = (tenant: string, id?: string) => `/app/tenants/${tenant}/flows${id ? `/${id}` : ''}`;

export const flowsQuery = (tenant: string) => queryOptions({ queryKey: ['flows', tenant], queryFn: () => request<Flow[]>(flowPath(tenant)) });

export const flowQuery = (tenant: string, id: string) =>
  queryOptions({ queryKey: ['flow', tenant, id], queryFn: () => request<FlowDetail>(flowPath(tenant, id)) });

export const previewFlow = (tenant: string, id: string, content: EmailDoc) =>
  request<{ html: string; slotDay: string }>(`${flowPath(tenant, id)}/preview`, { method: 'POST', body: JSON.stringify({ content }) });

function useFlowAction<I>(tenant: string, id: string, call: (input: I) => Promise<FlowDetail>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (fresh) => {
      client.setQueryData(['flow', tenant, id], fresh);
      void client.invalidateQueries({ queryKey: ['flows', tenant] });
      void client.invalidateQueries({ queryKey: ['overview', tenant] });
    },
  });
}

export const useSaveFlow = (tenant: string, id: string) =>
  useFlowAction(tenant, id, (patch: FlowPatch) => request<FlowDetail>(flowPath(tenant, id), { method: 'PUT', body: JSON.stringify(patch) }));

export const useResetFlow = (tenant: string, id: string) =>
  useFlowAction(tenant, id, (_: void) => request<FlowDetail>(`${flowPath(tenant, id)}/reset`, { method: 'POST', body: '{}' }));

/** Switches a flow on or off from the list. */
export function useToggleFlow(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, live }: { id: string; live: boolean }) => request<FlowDetail>(flowPath(tenant, id), { method: 'PUT', body: JSON.stringify({ live }) }),
    onSuccess: (fresh) => {
      client.setQueryData(['flow', tenant, fresh.id], fresh);
      void client.invalidateQueries({ queryKey: ['flows', tenant] });
      void client.invalidateQueries({ queryKey: ['overview', tenant] });
    },
  });
}

// ---------------------------------------------------------------- home

export type Opportunity = {
  kind: 'fill' | 'welcome' | 'rebook' | 'winback' | 'follow_up';
  title: string;
  detail: string;
  /** In pence, when every person or slot books. */
  value: number | null;
  note: string;
  action: { label: string; flowId?: string; campaignId?: string };
  people?: { initials: string[]; more: number };
};

export type Overview = {
  days: number;
  revenue: {
    revenue: number;
    bookings: number;
    previous: number;
    previousBookings: number;
    flows: number;
    campaigns: number;
    /** Percentage change on the period before, or null when there was nothing before. */
    change: number | null;
    daily: { revenue: number; bookings: number; previous: number; previousBookings: number }[];
  };
  week: {
    connected: boolean;
    timezone: string;
    parts: string[];
    days: { day: string; open: number; booked: number; parts: { open: number; booked: number }[] }[];
    quietest: { day: string; part: number; open: number; dayOpen: number } | null;
  };
  dueCount: number;
  opportunities: Opportunity[];
  flows: { id: string; kind: FlowKind; name: string; live: boolean; sent: number; daily: number[]; bookings: number; revenue: number }[];
};

export const overviewQuery = (tenant: string, days = 30) =>
  queryOptions({ queryKey: ['overview', tenant, days], queryFn: () => request<Overview>(`/app/tenants/${tenant}/overview?days=${days}`), refetchInterval: 60_000 });
