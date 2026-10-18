import pg from 'pg';
import { Database, PG_TYPES, parseNumeric, parseTimestamptz, toDbError, type Queryable } from './database.js';

pg.types.setTypeParser(PG_TYPES.NUMERIC, parseNumeric);
pg.types.setTypeParser(PG_TYPES.INT8, parseNumeric);
pg.types.setTypeParser(PG_TYPES.TIMESTAMPTZ, parseTimestamptz);

export class PgDatabase extends Database {
  private readonly pool: pg.Pool;

  constructor(connectionString: string, options: { max?: number; ssl?: boolean } = {}) {
    super();
    this.pool = new pg.Pool({
      connectionString,
      max: options.max ?? 10,
      idleTimeoutMillis: 30_000,
      // New connections can take a few seconds (TLS, distant region, IPv6); allow some slack.
      connectionTimeoutMillis: 15_000,
      // TCP keep-alive stops routers and NAT from silently dropping idle connections.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      statement_timeout: 30_000,
      ssl: options.ssl === false ? undefined : { rejectUnauthorized: false },
      application_name: 'online-test-backend',
    });
    // An idle client error must not crash the process.
    this.pool.on('error', () => undefined);
  }

  async query<T>(text: string, values?: unknown[]): Promise<T[]> {
    try {
      const res = await this.pool.query(text, values);
      return res.rows as T[];
    } catch (error) {
      throw toDbError(error);
    }
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: Queryable = {
      query: async <R>(text: string, values?: unknown[]) => {
        try {
          return (await client.query(text, values)).rows as R[];
        } catch (error) {
          throw toDbError(error);
        }
      },
    };
    try {
      await client.query('begin');
      const result = await fn(tx);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw toDbError(error);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
