import { createVerify } from 'node:crypto';

/**
 * Verifies that a message really came from Amazon SNS, following AWS's published steps:
 * check the certificate URL belongs to SNS, rebuild the canonical string, verify the RSA
 * signature (SHA1 for SignatureVersion 1, SHA256 for 2). Certificates are cached in memory.
 */
export type SnsMessage = {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
};

const CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const certs = new Map<string, string>();

export function isSnsUrl(value: string, path?: RegExp) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && CERT_HOST.test(url.hostname) && (!path || path.test(url.pathname));
  } catch {
    return false;
  }
}

function canonical(m: SnsMessage) {
  const keys =
    m.Type === 'Notification'
      ? (['Message', 'MessageId', ...(m.Subject !== undefined ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type'] as const)
      : (['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'] as const);
  return keys.map((k) => `${k}\n${(m as Record<string, string | undefined>)[k] ?? ''}\n`).join('');
}

export async function verifySnsMessage(m: SnsMessage, doFetch: typeof fetch = fetch): Promise<boolean> {
  if (!m || typeof m !== 'object' || !m.Signature || !m.SigningCertURL) return false;
  if (!isSnsUrl(m.SigningCertURL, /\.pem$/)) return false;
  let cert = certs.get(m.SigningCertURL);
  if (!cert) {
    const response = await doFetch(m.SigningCertURL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    cert = await response.text();
    certs.set(m.SigningCertURL, cert);
  }
  const algorithm = m.SignatureVersion === '2' ? 'RSA-SHA256' : m.SignatureVersion === '1' ? 'RSA-SHA1' : null;
  if (!algorithm) return false;
  return createVerify(algorithm).update(canonical(m), 'utf8').verify(cert, m.Signature, 'base64');
}

/** For tests: seed the certificate cache so no network call is made. */
export function primeSnsCertificate(url: string, pem: string) {
  certs.set(url, pem);
}
