import { DbError } from '../common/errors.js';
import { buildRpcQuery, type RpcCaller } from './rpc.js';

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<T[]>;
}

/**
 * Minimal database interface used across the backend. Implemented with `pg`
 * in production and with an in-process Postgres (PGlite) in tests, so both
 * run exactly the same SQL.
 */
export abstract class Database implements Queryable {
  abstract query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<T[]>;
  abstract transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  abstract close(): Promise<void>;

  async one<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<T | null> {
    const rows = await this.query<T>(text, values);
    return rows[0] ?? null;
  }

  readonly rpc: RpcCaller = async (fn, args) => {
    const { text, values } = buildRpcQuery(fn, args);
    const rows = await this.query<{ r: unknown }>(text, values);
    return rows[0]?.r ?? null;
  };
}

/** Wraps driver errors so only the SQL state and our own exception codes travel upward. */
export function toDbError(error: unknown): DbError {
  if (error instanceof DbError) return error;
  const e = error as { message?: string; code?: string };
  return new DbError(e?.message ?? 'Database error', e?.code);
}

/** Type parsers shared by both drivers: numeric → number, bigint → number, timestamptz → ISO string. */
export const PG_TYPES = { NUMERIC: 1700, INT8: 20, TIMESTAMPTZ: 1184, TIMESTAMP: 1114 } as const;
export const parseNumeric = (v: string) => (v === null ? null : Number(v));
export const parseTimestamptz = (v: string) => (v === null ? null : new Date(v).toISOString());
