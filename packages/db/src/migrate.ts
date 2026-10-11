import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from './index.ts';

export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

export function migrateDb(db: Db) {
  return migrate(db, { migrationsFolder });
}

/** Any number; it only has to be the same in every copy of the app. */
const MIGRATION_LOCK = 727_274_001;

/**
 * Applies migrations while holding a Postgres advisory lock, so several copies of the app starting
 * at once (a rolling deploy) take turns instead of racing.
 */
export async function runMigrations(url: string): Promise<void> {
  const { db, pool } = createDb(url);
  const lock = await pool.connect();
  try {
    await lock.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await migrate(db, { migrationsFolder });
  } finally {
    await lock.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    lock.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL first.');
  await runMigrations(url);
  console.log('Migrations applied.');
}
