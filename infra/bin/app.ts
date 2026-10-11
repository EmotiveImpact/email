import { App, Tags } from 'aws-cdk-lib';
import { AppStack } from '../src/app-stack.ts';
import { BaseStack } from '../src/base-stack.ts';
import { readConfig } from '../src/config.ts';

const app = new App();
const config = readConfig(app);
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region };

const base = new BaseStack(app, 'EmailBase', config, { env, description: 'Email platform: images, secrets and the deploy role' });
new AppStack(app, 'EmailApp', config, base, { env, description: 'Email platform: web, worker, pictures and SES' });
Tags.of(app).add('project', 'email-platform');
