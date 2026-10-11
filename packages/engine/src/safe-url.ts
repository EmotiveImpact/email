/**
 * Webhook addresses come from customers, so the platform must never be made to post to its own
 * network: the cloud metadata service, the database, other containers, or localhost (D113).
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { PlatformError } from './types.ts';

const toInt = (ip: string) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
];

/** True for addresses that are not on the public internet. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = toInt(ip);
    return V4_BLOCKED.some(([base, bits]) => n >>> (32 - bits) === toInt(base) >>> (32 - bits));
  }
  if (kind === 6) {
    const v6 = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
  }
  return true;
}

export type ResolveHost = (host: string) => Promise<string[]>;
export const resolveHost: ResolveHost = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Throws unless `url` is https on a host whose every address is public. */
export async function assertPublicUrl(url: string, resolve: ResolveHost = resolveHost) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new PlatformError('invalid_request', 'Webhook addresses must start with https://.', 422);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new PlatformError('invalid_request', 'Webhook addresses must be on the public internet.', 422);
  }
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (!addresses.length) throw new PlatformError('invalid_request', `${host} could not be found.`, 422);
  if (addresses.some(isPrivateAddress)) throw new PlatformError('invalid_request', 'Webhook addresses must be on the public internet.', 422);
}
