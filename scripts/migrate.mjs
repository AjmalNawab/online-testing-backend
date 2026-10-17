// Applies pending SQL files from supabase/migrations to DATABASE_URL, in order,
// each in its own transaction. Applied versions are recorded in
// supabase_migrations.schema_migrations, the same table the Supabase CLI uses.
//   npm run db:push
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const dir = path.resolve(import.meta.dirname, '../supabase/migrations');
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (see .env.example).');
  process.exit(1);
}
const ssl = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl });

await client.connect();
try {
  await client.query(`create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)`);
  const applied = new Set((await client.query('select version from supabase_migrations.schema_migrations')).rows.map((r) => r.version));
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  let count = 0;
  for (const file of files) {
    const [, version, name] = /^(\d+)_(.+)\.sql$/.exec(file);
    if (applied.has(version)) continue;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    process.stdout.write(`Applying ${file} … `);
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into supabase_migrations.schema_migrations (version, statements, name) values ($1, $2, $3)', [version, [sql], name]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      console.log('failed');
      throw error;
    }
    console.log('done');
    count++;
  }
  console.log(count ? `${count} migration(s) applied.` : 'Database is up to date.');
} finally {
  await client.end();
}
