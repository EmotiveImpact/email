/** One email ready to leave the platform. */
export type OutgoingEmail = {
  messageId: string;
  from: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  html?: string | null;
  text?: string | null;
  headers: Record<string, string>;
  /** SES tenant to send through, when the tenant has one. */
  sesTenant?: string | null;
  tags: Record<string, string>;
};

/** Anything that can hand an email to a mail provider. */
export interface Transport {
  readonly name: string;
  /** Returns the provider's message id. Throws to signal a retryable failure. */
  send(email: OutgoingEmail): Promise<{ providerMessageId: string }>;
}

/** A provider refused the message for good (bad address, rejected content). Not retried. */
export class PermanentSendError extends Error {
  override name = 'PermanentSendError';
}

/** Errors the API shows to callers, with a stable code and an HTTP status. */
export class PlatformError extends Error {
  override name = 'PlatformError';
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    /** For a 429, the seconds to wait (sent as Retry-After). */
    readonly details: { retryAfter?: number } = {},
  ) {
    super(message);
  }
}
