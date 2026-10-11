import type { App } from 'aws-cdk-lib';

/**
 * Everything that differs between one person's AWS account and another's, read from CDK context
 * (`-c domain=app.example.com`) so nothing about Edem's account is written into the repository.
 */
export interface PlatformConfig {
  /** London: next to Neon's London database and inside the UK for customers' data. */
  region: string;
  /** Where the app is served, such as app.example.com. HTTPS only. */
  domain: string;
  /** An ACM certificate already issued for `domain`. Without one, the stack requests it (DNS check). */
  certificateArn?: string;
  /** The platform's own sending domain, such as mail.example.com. Businesses send from it until they verify theirs. */
  sendingDomain?: string;
  /** The address the platform sends from. Defaults to hello@ the sending domain. */
  defaultFrom?: string;
  /** Emails a second the SES account allows once out of the sandbox. Campaigns pace to it. */
  sendRate: number;
  /** The image to run, tagged by the deploy workflow with the commit it was built from. */
  imageTag: string;
  /** How many web containers to keep running. One is enough to start; the worker always runs one. */
  webCount: number;
  /** The GitHub repository allowed to deploy, as owner/name. */
  githubRepo: string;
  /** An existing GitHub sign-in provider in the account, if one was set up before (only one is allowed). */
  githubOidcProviderArn?: string;
}

export function readConfig(app: App): PlatformConfig {
  const get = (key: string) => {
    const value = app.node.tryGetContext(key);
    return value === undefined || value === '' ? undefined : String(value);
  };
  const domain = get('domain') ?? 'app.example.com';
  const sendingDomain = get('sendingDomain');
  return {
    region: get('region') ?? 'eu-west-2',
    domain,
    certificateArn: get('certificateArn'),
    sendingDomain,
    defaultFrom: get('defaultFrom') ?? (sendingDomain ? `hello@${sendingDomain}` : undefined),
    sendRate: Number(get('sendRate') ?? 10) || 10,
    imageTag: get('imageTag') ?? 'latest',
    webCount: Number(get('webCount') ?? 1) || 1,
    githubRepo: get('githubRepo') ?? 'EmotiveImpact/email',
    githubOidcProviderArn: get('githubOidcProviderArn'),
  };
}
