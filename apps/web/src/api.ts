import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Brand } from './theme.ts';

/** Empty in development: Vite proxies /app to the API. Set VITE_API_URL when they live apart. */
const BASE = import.meta.env.VITE_API_URL ?? '';

export type Tenant = {
  id: string;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  } catch {
    throw new ApiError('offline', 'Cannot reach the API. Is it running?', 0);
  }
  const body = (await response.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!response.ok) {
    throw new ApiError(body?.error?.code ?? 'error', body?.error?.message ?? `The API answered ${response.status}.`, response.status);
  }
  return body as T;
}

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
