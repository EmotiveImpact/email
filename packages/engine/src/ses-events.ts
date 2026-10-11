/**
 * Amazon SES event publishing → one normalised event.
 *
 * SES publishes to an SNS topic from a configuration set; SNS posts to our endpoint. The SES record
 * uses `eventType` (event publishing) or `notificationType` (older identity notifications); both
 * are accepted. Reference: SES developer guide, "Contents of event data that Amazon SES publishes
 * to Amazon SNS".
 */
export type SesEvent = {
  type:
    | 'send'
    | 'delivery'
    | 'delivery_delay'
    | 'bounce'
    | 'complaint'
    | 'reject'
    | 'rendering_failure'
    | 'open'
    | 'click'
    | 'subscription';
  providerMessageId: string;
  /** Our own id, from the `platform_message_id` tag, when SES passes tags through. */
  platformMessageId: string | null;
  occurredAt: Date;
  /** Only for bounces: true for permanent ("hard") bounces. */
  permanent: boolean;
  detail: Record<string, unknown>;
};

const TYPES: Record<string, SesEvent['type']> = {
  send: 'send',
  delivery: 'delivery',
  deliverydelay: 'delivery_delay',
  bounce: 'bounce',
  complaint: 'complaint',
  reject: 'reject',
  'rendering failure': 'rendering_failure',
  renderingfailure: 'rendering_failure',
  open: 'open',
  click: 'click',
  subscription: 'subscription',
};

type Json = Record<string, any>;

export function parseSesEvent(input: unknown): SesEvent | null {
  let record: Json | null = null;
  if (typeof input === 'string') {
    try {
      record = JSON.parse(input);
    } catch {
      return null;
    }
  } else if (input && typeof input === 'object') {
    record = input as Json;
  }
  // An SNS envelope that was not unwrapped yet.
  if (record && typeof record.Message === 'string' && record.Type) return parseSesEvent(record.Message);
  if (!record?.mail?.messageId) return null;

  const rawType = String(record.eventType ?? record.notificationType ?? '').toLowerCase();
  const type = TYPES[rawType];
  if (!type) return null;

  const section: Json =
    record[
      {
        send: 'send',
        delivery: 'delivery',
        delivery_delay: 'deliveryDelay',
        bounce: 'bounce',
        complaint: 'complaint',
        reject: 'reject',
        rendering_failure: 'failure',
        open: 'open',
        click: 'click',
        subscription: 'subscription',
      }[type]
    ] ?? {};

  const tag = record.mail.tags?.platform_message_id;
  const detail: Record<string, unknown> = {};
  if (type === 'bounce') {
    detail.bounceType = section.bounceType;
    detail.bounceSubType = section.bounceSubType;
    detail.diagnostic = section.bouncedRecipients?.[0]?.diagnosticCode;
  }
  if (type === 'complaint') detail.feedbackType = section.complaintFeedbackType;
  if (type === 'click') detail.link = section.link;
  if (type === 'open' || type === 'click') detail.userAgent = section.userAgent;
  if (type === 'delivery_delay') detail.delayType = section.delayType;
  if (type === 'reject') detail.reason = section.reason;
  if (type === 'rendering_failure') detail.error = section.errorMessage;

  const when = section.timestamp ?? record.mail.timestamp;
  return {
    type,
    providerMessageId: String(record.mail.messageId),
    platformMessageId: Array.isArray(tag) ? String(tag[0]) : typeof tag === 'string' ? tag : null,
    occurredAt: when ? new Date(when) : new Date(),
    permanent: type === 'bounce' && section.bounceType === 'Permanent',
    detail: Object.fromEntries(Object.entries(detail).filter(([, v]) => v !== undefined)),
  };
}
