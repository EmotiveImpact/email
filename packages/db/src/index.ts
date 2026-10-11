import { randomBytes } from 'node:crypto';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';

export * from './schema.ts';
// Query helpers come from here so every package shares one drizzle-orm instance.
export { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
export { schema };

export type Db = NodePgDatabase<typeof schema>;

export function createDb(url: string): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString: url, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * Prefixed, sortable-enough ids such as `msg_01k9x…`: a millisecond timestamp then 80 random bits,
 * in Crockford-style base32, so ids sort roughly by creation time and are safe in URLs.
 */
export function newId(prefix: string): string {
  let time = Date.now();
  let head = '';
  for (let i = 0; i < 10; i++) {
    head = ALPHABET[time % 32] + head;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(10);
  let tail = '';
  for (let i = 0; i < 16; i++) {
    const bit = i * 5;
    const byte = bit >> 3;
    const value = ((bytes[byte]! << 8) | (bytes[byte + 1] ?? 0)) >> (11 - (bit & 7));
    tail += ALPHABET[value & 31];
  }
  return `${prefix}_${head}${tail}`;
}
