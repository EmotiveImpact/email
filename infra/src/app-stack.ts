import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import { APP_SECRET_KEYS, type BaseStack } from './base-stack.ts';
import type { PlatformConfig } from './config.ts';

export const CONFIGURATION_SET = 'platform-events';

/**
 * The running platform: the web service behind an HTTPS load balancer, the job worker, the picture
 * bucket behind CloudFront, and SES's configuration set reporting deliveries back to the app.
 * Both services run the same image (D90) with a different ROLE.
 */
export class AppStack extends Stack {
  /** Named rather than looked up, so the app builds without AWS credentials (tests and CI). */
  override get availabilityZones() {
    return [`${this.region}a`, `${this.region}b`];
  }

  constructor(scope: Construct, id: string, config: PlatformConfig, base: BaseStack, props?: StackProps) {
    super(scope, id, props);
    const url = `https://${config.domain}`;

    // Public subnets only: the database is Neon (reached over the internet with TLS) and AWS APIs are
    // public, so a NAT gateway would cost about £30 a month for nothing. Containers take traffic only
    // from the load balancer.
    const vpc = new ec2.Vpc(this, 'Network', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, containerInsightsV2: ecs.ContainerInsights.ENABLED });

    // ---------------------------------------------------------------- pictures
    const assets = new s3.Bucket(this, 'Pictures', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const pictures = new cloudfront.Distribution(this, 'PictureCdn', {
      comment: 'Pictures used in emails and the design canvas',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(assets),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        // The canvas draws pictures into a <canvas> and saves the result, which needs CORS.
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
      },
    });

    // ---------------------------------------------------------------- SES
    // Every delivery, bounce, complaint, open and click goes to SNS, which posts it to the app.
    const events = new sns.Topic(this, 'SesEvents', { displayName: 'SES events for the email platform' });
    const configurationSet = new ses.ConfigurationSet(this, 'SesConfigurationSet', {
      configurationSetName: CONFIGURATION_SET,
      reputationMetrics: true,
      sendingEnabled: true,
      // Never send again to an address that hard-bounced or complained, platform-wide.
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    configurationSet.addEventDestination('ToApp', {
      destination: ses.EventDestination.snsTopic(events),
      events: [
        ses.EmailSendingEvent.DELIVERY,
        ses.EmailSendingEvent.DELIVERY_DELAY,
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
        ses.EmailSendingEvent.RENDERING_FAILURE,
        ses.EmailSendingEvent.OPEN,
        ses.EmailSendingEvent.CLICK,
        ses.EmailSendingEvent.SUBSCRIPTION,
      ],
    });

    if (config.sendingDomain) {
      // The platform's own domain, signed with DKIM, with bounces handled on a subdomain so SPF aligns.
      const identity = new ses.EmailIdentity(this, 'SendingDomain', {
        identity: ses.Identity.domain(config.sendingDomain),
        configurationSet,
        mailFromDomain: `bounce.${config.sendingDomain}`,
      });
      const dkim = [
        [identity.dkimDnsTokenName1, identity.dkimDnsTokenValue1],
        [identity.dkimDnsTokenName2, identity.dkimDnsTokenValue2],
        [identity.dkimDnsTokenName3, identity.dkimDnsTokenValue3],
      ] as const;
      dkim.forEach(([name, value], i) => new CfnOutput(this, `DnsDkim${i + 1}`, { value: `CNAME ${name} -> ${value}` }));
      new CfnOutput(this, 'DnsMailFromMx', { value: `MX bounce.${config.sendingDomain} -> 10 feedback-smtp.${this.region}.amazonses.com` });
      new CfnOutput(this, 'DnsMailFromSpf', { value: `TXT bounce.${config.sendingDomain} -> "v=spf1 include:amazonses.com ~all"` });
      new CfnOutput(this, 'DnsDmarc', { value: `TXT _dmarc.${config.sendingDomain} -> "v=DMARC1; p=none; rua=mailto:dmarc@${config.sendingDomain}"` });
    }

    // ---------------------------------------------------------------- the containers
    const logGroup = new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    const image = ecs.ContainerImage.fromEcrRepository(base.repository, config.imageTag);
    const environment: Record<string, string> = {
      NODE_ENV: 'production',
      MIGRATE_ON_START: 'true',
      PUBLIC_URL: url,
      WEB_ORIGIN: url,
      TRANSPORT: 'ses',
      AWS_REGION: this.region,
      AWS_ACCOUNT_ID: this.account,
      SES_CONFIGURATION_SET: CONFIGURATION_SET,
      SES_SEND_RATE: String(config.sendRate),
      SES_TOPIC_ARN: events.topicArn,
      VERIFIED_DOMAINS_ONLY: 'true',
      ASSETS_BUCKET: assets.bucketName,
      ASSETS_PUBLIC_URL: `https://${pictures.distributionDomainName}`,
      ...(config.defaultFrom && { DEFAULT_FROM: config.defaultFrom }),
    };
    const secrets: Record<string, ecs.Secret> = {
      ...Object.fromEntries(APP_SECRET_KEYS.map((key) => [key, ecs.Secret.fromSecretsManager(base.appSecret, key)])),
      AUTH_SECRET: ecs.Secret.fromSecretsManager(base.authSecret),
      SIGNING_SECRET: ecs.Secret.fromSecretsManager(base.signingSecret),
    };

    const taskRole = new iam.Role(this, 'TaskRole', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });
    assets.grantReadWrite(taskRole);
    // Sending, plus setting businesses up as SES tenants with their own domains. Limited to this
    // account and region.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ses:SendEmail',
          'ses:SendRawEmail',
          'ses:CreateTenant',
          'ses:CreateTenantResourceAssociation',
          'ses:CreateEmailIdentity',
          'ses:GetEmailIdentity',
          'ses:TagResource',
        ],
        resources: [`arn:aws:ses:${this.region}:${this.account}:*`],
      }),
    );

    const task = (id: string, role: 'web' | 'worker') => {
      const definition = new ecs.FargateTaskDefinition(this, id, {
        cpu: 512,
        memoryLimitMiB: 1024,
        taskRole,
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      });
      definition.addContainer('app', {
        image,
        environment: { ...environment, ROLE: role },
        secrets,
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: role }),
        portMappings: role === 'web' ? [{ containerPort: 8787 }] : [],
        stopTimeout: Duration.seconds(30),
      });
      return definition;
    };

    const certificate = config.certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'Certificate', config.certificateArn)
      : new acm.Certificate(this, 'Certificate', { domainName: config.domain, validation: acm.CertificateValidation.fromDns() });

    const web = new patterns.ApplicationLoadBalancedFargateService(this, 'Web', {
      cluster,
      taskDefinition: task('WebTask', 'web'),
      desiredCount: config.webCount,
      publicLoadBalancer: true,
      assignPublicIp: true,
      taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      certificate,
      protocol: elb.ApplicationProtocol.HTTPS,
      sslPolicy: elb.SslPolicy.RECOMMENDED_TLS,
      redirectHTTP: true,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // A deploy that never gets healthy is rolled back to the last good one.
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: Duration.seconds(60),
    });
    web.targetGroup.configureHealthCheck({ path: '/health', healthyThresholdCount: 2, interval: Duration.seconds(15) });
    web.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '20');
    web.loadBalancer.setAttribute('routing.http.drop_invalid_header_fields.enabled', 'true');

    const worker = new ecs.FargateService(this, 'Worker', {
      cluster,
      taskDefinition: task('WorkerTask', 'worker'),
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      // The worker takes no traffic; it reaches out to Neon and AWS only.
      securityGroups: [new ec2.SecurityGroup(this, 'WorkerGroup', { vpc, allowAllOutbound: true, description: 'Job worker: outbound only' })],
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
    });

    // SNS asks the app to confirm the subscription, so it is added once the web service is up.
    const subscription = new sns.Subscription(this, 'SesEventsToApp', {
      topic: events,
      protocol: sns.SubscriptionProtocol.HTTPS,
      endpoint: `${url}/ses/events`,
    });
    subscription.node.addDependency(web.service);

    new CfnOutput(this, 'AppUrl', { value: url });
    new CfnOutput(this, 'DnsApp', { value: `CNAME ${config.domain} -> ${web.loadBalancer.loadBalancerDnsName}` });
    new CfnOutput(this, 'PicturesUrl', { value: `https://${pictures.distributionDomainName}` });
    new CfnOutput(this, 'SesEventsTopic', { value: events.topicArn });
    new CfnOutput(this, 'WorkerService', { value: worker.serviceName });
  }
}
