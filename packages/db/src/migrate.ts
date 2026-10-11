import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from './index.ts';

export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

export function migrateDb(db: Db) {
  return migrate(db, { migrationsFolder });
}

export async function runMigrations(url: string): Promise<void> {
  const { db, pool } = createDb(url);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL first.');
  await runMigrations(url);
  console.log('Migrations applied.');
}
