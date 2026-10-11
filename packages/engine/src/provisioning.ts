/**
 * Setting businesses up in SES: one SES tenant per business, so SES judges and pauses each one on
 * its own reputation, and one email identity per sending domain, signed with DKIM.
 */
import { createHash } from 'node:crypto';
import {
  AlreadyExistsException,
  CreateEmailIdentityCommand,
  CreateTenantCommand,
  CreateTenantResourceAssociationCommand,
  GetEmailIdentityCommand,
  NotFoundException,
  SESv2Client,
} from '@aws-sdk/client-sesv2';
import type { DnsRecord, DomainStatus } from '@platform/db';

export interface Provisioner {
  readonly name: string;
  /** Creates the SES tenant if it does not exist yet. */
  ensureTenant(tenant: string): Promise<void>;
  /** Creates the domain identity (or finds it) and returns the DKIM records to publish. */
  ensureDomain(domain: string, tenant: string | null): Promise<DnsRecord[]>;
  /** Whether SES can sign mail for the domain yet. */
  domainStatus(domain: string): Promise<DomainStatus>;
}

const dkimRecords = (domain: string, tokens: string[]): DnsRecord[] =>
  tokens.map((token) => ({ type: 'CNAME', name: `${token}._domainkey.${domain}`, value: `${token}.dkim.amazonses.com` }));

/**
 * For development and tests: makes believable records without AWS. Domains ending in .test or
 * .example count as verified straight away, so the whole flow can be tried locally.
 */
export class LocalProvisioner implements Provisioner {
  readonly name = 'local';
  readonly tenants = new Set<string>();

  async ensureTenant(tenant: string) {
    this.tenants.add(tenant);
  }

  async ensureDomain(domain: string) {
    const tokens = [1, 2, 3].map((n) => createHash('sha256').update(`${domain}:${n}`).digest('hex').slice(0, 32));
    return dkimRecords(domain, tokens);
  }

  async domainStatus(domain: string): Promise<DomainStatus> {
    return /\.(test|example)$/.test(domain) ? 'verified' : 'pending';
  }
}

export class SesProvisioner implements Provisioner {
  readonly name = 'ses';

  constructor(
    private readonly client: SESv2Client,
    /** Needed to link identities to SES tenants; without it, tenants are created but not linked. */
    private readonly identityArn?: (domain: string) => string,
  ) {}

  static fromEnv(env: { AWS_REGION?: string; AWS_ACCOUNT_ID?: string }) {
    const region = env.AWS_REGION ?? 'eu-west-2';
    const account = env.AWS_ACCOUNT_ID;
    return new SesProvisioner(new SESv2Client({ region }), account ? (d) => `arn:aws:ses:${region}:${account}:identity/${d}` : undefined);
  }

  async ensureTenant(tenant: string) {
    try {
      await this.client.send(new CreateTenantCommand({ TenantName: tenant }));
    } catch (error) {
      if (!(error instanceof AlreadyExistsException)) throw error;
    }
  }

  async ensureDomain(domain: string, tenant: string | null) {
    let tokens: string[] = [];
    try {
      const created = await this.client.send(new CreateEmailIdentityCommand({ EmailIdentity: domain }));
      tokens = created.DkimAttributes?.Tokens ?? [];
    } catch (error) {
      if (!(error instanceof AlreadyExistsException)) throw error;
      const existing = await this.client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
      tokens = existing.DkimAttributes?.Tokens ?? [];
    }
    if (tenant && this.identityArn) {
      try {
        await this.client.send(new CreateTenantResourceAssociationCommand({ TenantName: tenant, ResourceArn: this.identityArn(domain) }));
      } catch (error) {
        if (!(error instanceof AlreadyExistsException)) throw error;
      }
    }
    return dkimRecords(domain, tokens);
  }

  async domainStatus(domain: string): Promise<DomainStatus> {
    try {
      const identity = await this.client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
      if (identity.VerifiedForSendingStatus) return 'verified';
      return identity.DkimAttributes?.Status === 'FAILED' ? 'failed' : 'pending';
    } catch (error) {
      if (error instanceof NotFoundException) return 'failed';
      throw error;
    }
  }
}
