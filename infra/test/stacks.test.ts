import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { AppStack, CONFIGURATION_SET } from '../src/app-stack.ts';
import { BaseStack } from '../src/base-stack.ts';
import { readConfig } from '../src/config.ts';

function build(context: Record<string, string> = {}) {
  const app = new App({ context: { domain: 'app.example.com', sendingDomain: 'mail.example.com', imageTag: 'abc123', ...context } });
  const config = readConfig(app);
  const env = { account: '123456789012', region: 'eu-west-2' };
  const base = new BaseStack(app, 'EmailBase', config, { env });
  const stack = new AppStack(app, 'EmailApp', config, base, { env });
  return { base: Template.fromStack(base), app: Template.fromStack(stack) };
}

const containerFor = (template: Template, role: 'web' | 'worker') => {
  const definitions = Object.values(template.findResources('AWS::ECS::TaskDefinition')) as any[];
  const container = definitions
    .map((d) => d.Properties.ContainerDefinitions[0])
    .find((c) => c.Environment.some((e: any) => e.Name === 'ROLE' && e.Value === role));
  expect(container, `a ${role} container`).toBeDefined();
  return {
    env: Object.fromEntries(container.Environment.map((e: any) => [e.Name, e.Value])),
    secrets: container.Secrets.map((s: any) => s.Name).sort(),
    container,
  };
};

describe('base stack', () => {
  const { base } = build();

  it('keeps images under fixed tags, so a running version can always be found again', () => {
    base.hasResourceProperties('AWS::ECR::Repository', { RepositoryName: 'email-platform', ImageTagMutability: 'IMMUTABLE' });
  });

  it('starts the secrets as placeholders and lets AWS make up the signing secrets', () => {
    const secrets = Object.values(base.findResources('AWS::SecretsManager::Secret')) as any[];
    expect(secrets).toHaveLength(3);
    const app = secrets.find((s) => s.Properties.Name === 'email-platform/app');
    expect(JSON.stringify(app.Properties.SecretString)).toContain('set-me');
    expect(secrets.filter((s) => s.Properties.GenerateSecretString)).toHaveLength(2);
  });

  it('lets only the production environment of the repository deploy', () => {
    base.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'email-platform-deploy',
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': 'repo:EmotiveImpact/email:environment:production',
              },
            },
          }),
        ],
      },
    });
  });

  it('reuses a GitHub sign-in provider when the account already has one', () => {
    const { base } = build({ githubOidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com' });
    expect(Object.keys(base.findResources('Custom::AWSCDKOpenIdConnectProvider'))).toHaveLength(0);
  });
});

describe('app stack', () => {
  const { app } = build();

  it('runs one web service behind HTTPS and one worker, from the same image', () => {
    app.resourceCountIs('AWS::ECS::Service', 2);
    const web = containerFor(app, 'web');
    const worker = containerFor(app, 'worker');
    expect(JSON.stringify(web.container.Image)).toContain(':abc123');
    expect(web.container.Image).toEqual(worker.container.Image);
    app.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Port: 443, Protocol: 'HTTPS' });
    app.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: 'redirect', RedirectConfig: Match.objectLike({ Protocol: 'HTTPS', Port: '443' }) })],
    });
    app.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { HealthCheckPath: '/health' });
  });

  it('gives both containers the production settings and every secret', () => {
    for (const role of ['web', 'worker'] as const) {
      const { env, secrets } = containerFor(app, role);
      expect(env).toMatchObject({
        NODE_ENV: 'production',
        MIGRATE_ON_START: 'true',
        TRANSPORT: 'ses',
        PUBLIC_URL: 'https://app.example.com',
        WEB_ORIGIN: 'https://app.example.com',
        SES_CONFIGURATION_SET: CONFIGURATION_SET,
        DEFAULT_FROM: 'hello@mail.example.com',
        VERIFIED_DOMAINS_ONLY: 'true',
      });
      expect(env.AWS_ACCOUNT_ID).toBe('123456789012');
      expect(secrets).toEqual(
        [
          'AUTH_SECRET',
          'DATABASE_URL',
          'DIRECT_DATABASE_URL',
          'OPENAI_API_KEY',
          'SIGNING_SECRET',
          'SQUARE_APP_ID',
          'SQUARE_APP_SECRET',
          'SQUARE_WEBHOOK_SIGNATURE_KEY',
          'STRIPE_SECRET_KEY',
          'STRIPE_WEBHOOK_SECRET',
        ].sort(),
      );
    }
  });

  it('rolls a deploy back when the new version never gets healthy', () => {
    const services = Object.values(app.findResources('AWS::ECS::Service')) as any[];
    for (const service of services) {
      expect(service.Properties.DeploymentConfiguration.DeploymentCircuitBreaker).toEqual({ Enable: true, Rollback: true });
    }
  });

  it('sends SES events to the app, but only once the web service exists', () => {
    app.hasResourceProperties('AWS::SES::ConfigurationSet', {
      Name: CONFIGURATION_SET,
      SuppressionOptions: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
    });
    app.hasResourceProperties('AWS::SES::ConfigurationSetEventDestination', {
      EventDestination: Match.objectLike({ Enabled: true, MatchingEventTypes: Match.arrayWith(['delivery', 'bounce', 'complaint', 'open', 'click']) }),
    });
    const subscriptions = app.findResources('AWS::SNS::Subscription');
    const [subscription] = Object.values(subscriptions) as any[];
    expect(subscription.Properties).toMatchObject({ Protocol: 'https', Endpoint: 'https://app.example.com/ses/events' });
    const webService = Object.keys(app.findResources('AWS::ECS::Service')).find((id) => id.startsWith('Web'));
    expect(subscription.DependsOn).toContain(webService);
  });

  it('signs the platform domain with DKIM and handles bounces on a subdomain', () => {
    app.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'mail.example.com',
      MailFromAttributes: { MailFromDomain: 'bounce.mail.example.com' },
    });
    app.hasOutput('DnsMailFromMx', { Value: 'MX bounce.mail.example.com -> 10 feedback-smtp.eu-west-2.amazonses.com' });
  });

  it('keeps pictures private in S3 and serves them through CloudFront with CORS for the canvas', () => {
    app.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    app.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https', ResponseHeadersPolicyId: Match.anyValue() }),
      }),
    });
  });

  it('lets the app use SES only in its own account and region', () => {
    const policies = Object.values(app.findResources('AWS::IAM::Policy')) as any[];
    const ses = policies.flatMap((p) => p.Properties.PolicyDocument.Statement).find((s: any) => [s.Action].flat().includes('ses:SendEmail'));
    expect(ses.Resource).toBe('arn:aws:ses:eu-west-2:123456789012:*');
    expect(ses.Action).toEqual(expect.arrayContaining(['ses:CreateTenant', 'ses:CreateTenantResourceAssociation']));
  });

  it('pays for no NAT gateway: containers sit in public subnets and only the load balancer reaches the web', () => {
    app.resourceCountIs('AWS::EC2::NatGateway', 0);
    const services = Object.values(app.findResources('AWS::ECS::Service')) as any[];
    for (const service of services) expect(service.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp).toBe('ENABLED');
    // The web containers' group admits traffic from the load balancer's group and nothing else.
    const ingress = Object.values(app.findResources('AWS::EC2::SecurityGroupIngress')) as any[];
    expect(ingress.length).toBeGreaterThan(0);
    for (const rule of ingress) expect(rule.Properties.SourceSecurityGroupId).toBeDefined();
  });

  it('uses an existing certificate when given one', () => {
    const { app } = build({ certificateArn: 'arn:aws:acm:eu-west-2:123456789012:certificate/abc' });
    app.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    app.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Certificates: [{ CertificateArn: 'arn:aws:acm:eu-west-2:123456789012:certificate/abc' }],
    });
  });
});
