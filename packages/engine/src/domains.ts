/**
 * Sending domains: a business proves it owns a domain by publishing DKIM records, and from then on
 * mail goes out from its own address. Until then it goes from the platform's address, with replies
 * still reaching the business.
 */
import { resolveTxt as dnsResolveTxt } from 'node:dns/promises';
import { and, desc, domains, eq, newId, tenants, type Db, type DnsRecord } from '@platform/db';
import type { Provisioner } from './provisioning.ts';
import type { Queue } from './queue.ts';
import { PlatformError } from './types.ts';

type Tenant = typeof tenants.$inferSelect;
type Domain = typeof domains.$inferSelect;

export type DomainDeps = {
  db: Db;
  queue: Queue;
  provisioner: Provisioner;
  defaultFrom: string;
  /** When true, a business can only send from domains it has verified. On in production. */
  verifiedDomainsOnly: boolean;
  resolveTxt?: (name: string) => Promise<string[][]>;
  onVerified: (domain: Domain) => Promise<void>;
};

/** How long to keep checking DNS for a new domain before leaving it to the "Check now" button. */
const CHECK_FOR_HOURS = 72;
const CHECK_EVERY_MINUTES = 5;

const HOSTNAME = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const domainOf = (address: string | null | undefined) => address?.split('@')[1]?.replace(/>.*$/, '').trim().toLowerCase() ?? null;

/** What DMARC record to suggest: report-only to start with, which is safe for any domain. */
export const dmarcRecord = (domain: string): DnsRecord => ({ type: 'TXT', name: `_dmarc.${domain}`, value: 'v=DMARC1; p=none;' });

export function createDomains({ db, queue, provisioner, defaultFrom, verifiedDomainsOnly, resolveTxt = dnsResolveTxt, onVerified }: DomainDeps) {
  async function ensureSesTenant(tenant: Tenant) {
    if (tenant.sesTenant) return tenant.sesTenant;
    const name = `t-${tenant.id}`;
    await provisioner.ensureTenant(name);
    await db.update(tenants).set({ sesTenant: name }).where(eq(tenants.id, tenant.id));
    return name;
  }

  function view(row: Domain) {
    return { ...row, dmarcRecord: dmarcRecord(row.domain) };
  }

  async function listDomains(tenantId: string) {
    const rows = await db.select().from(domains).where(eq(domains.tenantId, tenantId)).orderBy(desc(domains.createdAt));
    return rows.map(view);
  }

  async function addDomain(tenantId: string, raw: unknown) {
    const domain = String(raw ?? '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/\.$/, '');
    if (!HOSTNAME.test(domain)) throw new PlatformError('invalid_request', 'Give a domain such as lindenstudio.co.uk.', 422);
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) throw new PlatformError('not_found', 'No such business.', 404);
    const [taken] = await db.select().from(domains).where(eq(domains.domain, domain));
    if (taken && taken.tenantId !== tenantId) {
      throw new PlatformError('domain_taken', `${domain} is already set up by another business. If it is yours, contact support.`, 409);
    }
    if (taken) return view(taken);

    const records = await provisioner.ensureDomain(domain, await ensureSesTenant(tenant));
    const [row] = await db.insert(domains).values({ id: newId('dom'), tenantId, domain, records }).returning();
    // The first check comes quickly; people often add the records straight away.
    await queue.enqueue('check-domain', { domainId: row!.id }, { startAfter: new Date(Date.now() + 60_000) });
    return view(row!);
  }

  async function hasDmarc(domain: string) {
    try {
      return (await resolveTxt(`_dmarc.${domain}`)).some((parts) => parts.join('').trim().toLowerCase().startsWith('v=dmarc1'));
    } catch {
      return false;
    }
  }

  /** Asks SES whether the domain is verified and looks for a DMARC record. Keeps checking for a while. */
  async function checkDomain(domainId: string, options: { reschedule?: boolean } = {}) {
    const [row] = await db.select().from(domains).where(eq(domains.id, domainId));
    if (!row) return null;
    const [status, dmarc] = await Promise.all([provisioner.domainStatus(row.domain), hasDmarc(row.domain)]);
    const verifiedNow = status === 'verified' && row.status !== 'verified';
    const [updated] = await db
      .update(domains)
      .set({ status, dmarc, checkedAt: new Date(), ...(verifiedNow && { verifiedAt: new Date() }) })
      .where(eq(domains.id, domainId))
      .returning();
    if (verifiedNow) await onVerified(updated!);
    const young = Date.now() - row.createdAt.getTime() < CHECK_FOR_HOURS * 3600_000;
    if (options.reschedule && status === 'pending' && young) {
      await queue.enqueue('check-domain', { domainId }, { startAfter: new Date(Date.now() + CHECK_EVERY_MINUTES * 60_000) });
    }
    return view(updated!);
  }

  async function checkTenantDomain(tenantId: string, domainId: string) {
    const [row] = await db
      .select()
      .from(domains)
      .where(and(eq(domains.id, domainId), eq(domains.tenantId, tenantId)));
    if (!row) throw new PlatformError('not_found', 'No such domain.', 404);
    return (await checkDomain(domainId))!;
  }

  async function removeDomain(tenantId: string, domainId: string) {
    const [row] = await db
      .delete(domains)
      .where(and(eq(domains.id, domainId), eq(domains.tenantId, tenantId)))
      .returning();
    if (!row) throw new PlatformError('not_found', 'No such domain.', 404);
  }

  async function verifiedDomain(tenantId: string, domain: string | null) {
    if (!domain) return false;
    const [row] = await db
      .select({ status: domains.status })
      .from(domains)
      .where(and(eq(domains.tenantId, tenantId), eq(domains.domain, domain)));
    return row?.status === 'verified';
  }

  const platformDomain = domainOf(defaultFrom);
  const display = (name: string) => name.replace(/["<>\\]/g, '').trim();

  /**
   * Who a business's email comes from. Its own address once the domain is verified; until then the
   * platform's address under the business's name, with replies going to the business.
   */
  async function senderFor(tenant: Tenant) {
    const own = tenant.fromEmail;
    if (own && (!verifiedDomainsOnly || (await verifiedDomain(tenant.id, domainOf(own))))) {
      return { from: `${display(tenant.name)} <${own}>`, replyTo: tenant.replyTo, own: true };
    }
    return { from: `${display(tenant.name)} <${defaultFrom}>`, replyTo: tenant.replyTo ?? own, own: false };
  }

  /** Refuses a from address on a domain the business has not verified. */
  async function assertCanSendFrom(tenant: Tenant, from: string) {
    if (!verifiedDomainsOnly) return;
    const domain = domainOf(from.includes('@') ? from : null);
    if (domain === platformDomain || (await verifiedDomain(tenant.id, domain))) return;
    throw new PlatformError(
      'domain_not_verified',
      `${domain ?? from} is not verified for this business. Add it with POST /v1/tenants/${tenant.externalId}/domains, or leave out "from".`,
      422,
    );
  }

  return { ensureSesTenant, listDomains, addDomain, checkDomain, checkTenantDomain, removeDomain, senderFor, assertCanSendFrom };
}
