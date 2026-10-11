import {
  MessageRejected,
  SESv2Client,
  SendEmailCommand,
  type MessageHeader,
} from '@aws-sdk/client-sesv2';
import { PermanentSendError, type OutgoingEmail, type Transport } from './types.ts';

/** Keeps emails in memory instead of sending them. For local development and tests. */
export class LogTransport implements Transport {
  readonly name = 'log';
  readonly sent: OutgoingEmail[] = [];
  private counter = 0;

  async send(email: OutgoingEmail) {
    this.sent.push(email);
    this.counter += 1;
    return { providerMessageId: `log-${this.counter}-${email.messageId}` };
  }
}

// SES tag names and values allow only letters, numbers, underscores and dashes.
const tagSafe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);

/** Sends through Amazon SES v2, through the tenant's SES tenant when it has one. */
export class SesTransport implements Transport {
  readonly name = 'ses';

  constructor(
    private readonly client: SESv2Client,
    private readonly configurationSet?: string,
  ) {}

  static fromEnv(env: { AWS_REGION?: string; SES_CONFIGURATION_SET?: string }) {
    return new SesTransport(new SESv2Client({ region: env.AWS_REGION ?? 'eu-west-2' }), env.SES_CONFIGURATION_SET);
  }

  async send(email: OutgoingEmail) {
    const headers: MessageHeader[] = Object.entries(email.headers).map(([Name, Value]) => ({ Name, Value }));
    const tags = Object.entries({ ...email.tags, platform_message_id: email.messageId }).map(([Name, Value]) => ({
      Name: tagSafe(Name),
      Value: tagSafe(Value),
    }));
    try {
      const result = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: email.from,
          Destination: { ToAddresses: [email.to] },
          ReplyToAddresses: email.replyTo ? [email.replyTo] : undefined,
          Content: {
            Simple: {
              Subject: { Data: email.subject, Charset: 'UTF-8' },
              Body: {
                ...(email.html ? { Html: { Data: email.html, Charset: 'UTF-8' } } : {}),
                ...(email.text ? { Text: { Data: email.text, Charset: 'UTF-8' } } : {}),
              },
              Headers: headers.length ? headers : undefined,
            },
          },
          ConfigurationSetName: this.configurationSet,
          TenantName: email.sesTenant ?? undefined,
          EmailTags: tags,
        }),
      );
      if (!result.MessageId) throw new Error('SES returned no message id');
      return { providerMessageId: result.MessageId };
    } catch (error) {
      if (error instanceof MessageRejected) throw new PermanentSendError(error.message);
      throw error;
    }
  }
}
