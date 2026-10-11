import { Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { PlatformConfig } from './config.ts';

/** Values set by hand after the first deploy; each starts as a placeholder (see docs/production.md). */
export const APP_SECRET_KEYS = ['DATABASE_URL', 'DIRECT_DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'OPENAI_API_KEY'] as const;

/**
 * The parts that must exist before the app can run: where images are kept, the secrets, and the
 * role GitHub uses to deploy. Deployed once by hand; after that the deploy workflow does the rest.
 */
export class BaseStack extends Stack {
  readonly repository: ecr.Repository;
  readonly appSecret: secrets.Secret;
  readonly authSecret: secrets.Secret;
  readonly signingSecret: secrets.Secret;
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, config: PlatformConfig, props?: StackProps) {
    super(scope, id, props);

    this.repository = new ecr.Repository(this, 'Images', {
      repositoryName: 'email-platform',
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [{ description: 'Keep the last 30 builds', maxImageCount: 30 }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Placeholders, so the stack deploys before Neon, Stripe or OpenAI exist. Empty optional keys
    // switch those features off; the database ones must be set before the app can start.
    this.appSecret = new secrets.Secret(this, 'AppSecret', {
      secretName: 'email-platform/app',
      description: 'Neon addresses and third-party keys. Set by hand; see docs/production.md.',
      secretObjectValue: Object.fromEntries(
        APP_SECRET_KEYS.map((key) => [key, SecretValue.unsafePlainText(key.endsWith('DATABASE_URL') ? 'set-me' : '')]),
      ),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Made up by AWS, so nobody has to invent or paste them.
    const generated = (id: string, secretName: string, description: string) =>
      new secrets.Secret(this, id, {
        secretName,
        description,
        generateSecretString: { passwordLength: 48, excludePunctuation: true },
        removalPolicy: RemovalPolicy.RETAIN,
      });
    this.authSecret = generated('AuthSecret', 'email-platform/auth-secret', 'Signs sign-in cookies.');
    this.signingSecret = generated('SigningSecret', 'email-platform/signing-secret', 'Signs unsubscribe links and studio sessions.');

    // GitHub Actions signs in to AWS with a short-lived token (no stored keys), and only from the
    // repository's "production" environment, where approvals can be required.
    const provider = config.githubOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHub', config.githubOidcProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GitHub', { url: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com'] });
    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'email-platform-deploy',
      description: 'Used by the GitHub deploy workflow.',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${config.githubRepo}:environment:production`,
        },
      }),
    });
    this.repository.grantPullPush(this.deployRole);
    // `cdk deploy` works through the roles `cdk bootstrap` made; the deploy role may only use those.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [`arn:aws:iam::${this.account}:role/cdk-*`] }),
    );
  }
}
