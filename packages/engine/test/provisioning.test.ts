import { AlreadyExistsException } from '@aws-sdk/client-sesv2';
import { describe, expect, it } from 'vitest';
import { SesProvisioner } from '../src/index.ts';

/** Records what would be sent to SES; "exists" makes those commands answer as if already done. */
function fakeSes(exists: string[] = []) {
  const sent: { command: string; input: any }[] = [];
  const client = {
    send: async (command: any) => {
      const name = command.constructor.name as string;
      sent.push({ command: name, input: command.input });
      if (exists.includes(name)) throw new AlreadyExistsException({ message: 'exists', $metadata: {} });
      if (name === 'CreateEmailIdentityCommand') return { DkimAttributes: { Tokens: ['a', 'b', 'c'] } };
      return {};
    },
  };
  return { client: client as any, sent };
}

describe('SES provisioning', () => {
  const identity = (d: string) => `arn:aws:ses:eu-west-2:123:identity/${d}`;
  const configurationSet = 'arn:aws:ses:eu-west-2:123:configuration-set/platform-events';
  const arns = { identity, everyTenant: [configurationSet, identity('mail.platform.example')] };

  it('links the configuration set and platform address to every new tenant, since SES refuses tenant sends without them', async () => {
    const ses = fakeSes();
    await new SesProvisioner(ses.client, arns).ensureTenant('t_linden');
    expect(ses.sent).toEqual([
      { command: 'CreateTenantCommand', input: { TenantName: 't_linden' } },
      { command: 'CreateTenantResourceAssociationCommand', input: { TenantName: 't_linden', ResourceArn: configurationSet } },
      { command: 'CreateTenantResourceAssociationCommand', input: { TenantName: 't_linden', ResourceArn: identity('mail.platform.example') } },
    ]);
  });

  it('links domains to the tenant and treats repeats as done', async () => {
    const ses = fakeSes(['CreateTenantCommand', 'CreateTenantResourceAssociationCommand']);
    const provisioner = new SesProvisioner(ses.client, arns);
    await provisioner.ensureTenant('t_linden');
    const records = await provisioner.ensureDomain('linden.studio', 't_linden');
    expect(records).toHaveLength(3);
    expect(ses.sent.at(-1)).toEqual({
      command: 'CreateTenantResourceAssociationCommand',
      input: { TenantName: 't_linden', ResourceArn: identity('linden.studio') },
    });
  });

  it('builds the ARNs from the account, region, configuration set and platform address', async () => {
    const provisioner = SesProvisioner.fromEnv({
      AWS_REGION: 'eu-west-2',
      AWS_ACCOUNT_ID: '123',
      SES_CONFIGURATION_SET: 'platform-events',
      DEFAULT_FROM: 'Bookings <hello@Mail.Platform.example>',
    });
    expect((provisioner as any).arns.everyTenant).toEqual(arns.everyTenant);
    expect((provisioner as any).arns.identity('linden.studio')).toBe(identity('linden.studio'));
  });
});
