import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { RpcCaller } from "../../src/database/rpc.js";
import {
  Database,
  PG_TYPES,
  parseNumeric,
  parseTimestamptz,
  toDbError,
  type Queryable,
} from "../../src/database/database.js";
import { AppError, DbError } from "../../src/common/errors.js";
import { AuthAdmin, type NewAuthUser } from "../../src/accounts/auth-admin.js";

/**
 * Minimal stand-in for the pieces of Supabase the migrations rely on:
 * the anon/authenticated/service_role roles, Supabase's default grants,
 * and auth.users / auth.uid().
 */
const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  ), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

const MIGRATIONS_DIR = [
  path.resolve(import.meta.dirname, "../../supabase/migrations"),
  path.resolve(process.cwd(), "supabase/migrations"),
].find((dir) => existsSync(dir))!;

export function readMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
}

export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite({
    parsers: {
      [PG_TYPES.NUMERIC]: parseNumeric,
      [PG_TYPES.INT8]: parseNumeric,
      [PG_TYPES.TIMESTAMPTZ]: parseTimestamptz,
    },
  });
  await db.exec(SUPABASE_STUB);
  for (const sql of readMigrations()) {
    await db.exec(sql);
  }
  return db;
}

/** Runs `fn` as the given database role with the given JWT subject. */
export async function asRole<T>(
  db: PGlite,
  role: "anon" | "authenticated" | "service_role",
  userId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    userId ? JSON.stringify({ sub: userId, role }) : "",
  ]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role`);
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}

export async function createUser(db: PGlite, email: string, admin = false): Promise<string> {
  const res = await db.query<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [email]);
  const id = res.rows[0]!.id;
  if (admin) await db.query(`select public.promote_to_admin($1)`, [email]);
  return id;
}

/** Calls SQL functions the way supabase-js `rpc` does, as the service role. */
export function pgliteRpc(db: PGlite): RpcCaller {
  return async (fn, args) => {
    const keys = Object.keys(args);
    const isJson = (v: unknown) => v !== null && typeof v === "object";
    const params = keys.map((k) => (isJson(args[k]) ? JSON.stringify(args[k]) : args[k]));
    const named = keys.map((k, i) => `${k} => $${i + 1}${isJson(args[k]) ? "::jsonb" : ""}`).join(", ");
    await db.exec("set role service_role");
    try {
      const res = await db.query<{ r: unknown }>(`select public.${fn}(${named}) as r`, params);
      return res.rows[0]?.r ?? null;
    } catch (error) {
      const e = error as { message: string; code?: string };
      throw new DbError(e.message, e.code);
    } finally {
      await db.exec("reset role");
    }
  };
}


export interface SeedQuestion {
  question_type: string;
  prompt?: string;
  content?: Record<string, unknown>;
  answer_key?: Record<string, unknown>;
  grading_method?: string;
  marks?: number;
  negative_marks?: number;
}

export const SAMPLE_QUESTIONS: SeedQuestion[] = [
  {
    question_type: 'mcq_single',
    prompt: 'What is the capital of France?',
    content: { options: [{ id: 'a', text: 'Berlin' }, { id: 'b', text: 'Paris' }, { id: 'c', text: 'Rome' }] },
    answer_key: { correct: 'b' },
    marks: 2,
    negative_marks: 1,
  },
  { question_type: 'true_false', prompt: 'Water boils at 100°C at sea level.', answer_key: { correct: true }, marks: 1 },
  {
    question_type: 'fill_blank',
    prompt: '2 + 2 = ___',
    content: { blanks: 1 },
    answer_key: { blanks: [{ accepted: ['4', 'four'] }], case_sensitive: false },
    marks: 2,
  },
  {
    question_type: 'short_answer',
    prompt: 'Explain photosynthesis in one sentence.',
    content: { max_words: 50 },
    answer_key: { model_answer: 'Plants turn light, water and CO2 into sugar and oxygen.', key_points: ['light', 'sugar'] },
    grading_method: 'manual',
    marks: 5,
  },
];

let seedCounter = 0;

export async function seedSubject(db: PGlite, name = `Subject ${++seedCounter}`): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into public.subjects (name, slug) values ($1, public.slugify($1)) returning id`,
    [name],
  );
  return r.rows[0]!.id;
}

export async function seedTest(
  db: PGlite,
  overrides: Record<string, unknown> = {},
  questions: SeedQuestion[] = SAMPLE_QUESTIONS,
): Promise<{ testId: string; shareToken: string; questionIds: string[]; subjectId: string }> {
  const subjectId = (overrides.subject_id as string | undefined) ?? (await seedSubject(db));
  const shareToken = `share_token_${String(++seedCounter).padStart(12, '0')}`;
  const s = {
    title: 'General knowledge',
    duration_minutes: 15,
    passing_percentage: 50,
    status: 'published',
    negative_marking: false,
    partial_credit: true,
    result_release_policy: 'immediate',
    max_attempts: null,
    shuffle_questions: false,
    show_correct_answers: true,
    ...overrides,
  };
  const t = await db.query<{ id: string }>(
    `insert into public.tests (title, subject_id, duration_minutes, passing_percentage, share_token, negative_marking,
       partial_credit, result_release_policy, max_attempts, shuffle_questions, show_correct_answers)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [
      s.title, subjectId, s.duration_minutes, s.passing_percentage, shareToken, s.negative_marking, s.partial_credit,
      s.result_release_policy, s.max_attempts, s.shuffle_questions, s.show_correct_answers,
    ],
  );
  const testId = t.rows[0]!.id;
  const questionIds: string[] = [];
  for (const [i, q] of questions.entries()) {
    const r = await db.query<{ id: string }>(
      `insert into public.questions (test_id, position, question_type, prompt, content, answer_key, grading_method, marks, negative_marks)
       values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9) returning id`,
      [
        testId, i + 1, q.question_type, q.prompt ?? `Question ${i + 1}`, JSON.stringify(q.content ?? {}),
        JSON.stringify(q.answer_key ?? {}), q.grading_method ?? 'auto', q.marks ?? 1, q.negative_marks ?? 0,
      ],
    );
    questionIds.push(r.rows[0]!.id);
  }
  if (s.status !== 'draft') await db.query(`update public.tests set status = $1 where id = $2`, [s.status, testId]);
  return { testId, shareToken, questionIds, subjectId };
}

/** Moves an attempt's deadline `secondsAgo` into the past (simulates time passing). */
export async function expireAttempt(db: PGlite, attemptId: string, secondsAgo = 60): Promise<void> {
  await db.query(
    `update public.test_attempts
       set started_at = now() - make_interval(secs => $2 + 900), deadline_at = now() - make_interval(secs => $2)
     where id = $1`,
    [attemptId, secondsAgo],
  );
}

/** The backend's Database interface on top of PGlite (connects as superuser, like the backend's postgres role). */
export class PgliteDatabase extends Database {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly pglite: PGlite) {
    super();
  }

  async query<T>(text: string, values?: unknown[]): Promise<T[]> {
    try {
      return (await this.pglite.query<T>(text, values)).rows;
    } catch (error) {
      throw toDbError(error);
    }
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    // PGlite has a single connection: serialise transactions.
    const run = this.queue.then(() =>
      this.pglite.transaction(async (t) =>
        fn({
          query: async <R>(text: string, values?: unknown[]) => {
            try {
              return (await t.query<R>(text, values)).rows;
            } catch (error) {
              throw toDbError(error);
            }
          },
        }),
      ),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {}
}

/** Stand-in for the Supabase Auth admin API: writes straight to the stub auth.users table. */
export class PgliteAuthAdmin extends AuthAdmin {
  configured = true;
  readonly created: string[] = [];
  readonly deleted: string[] = [];

  constructor(private readonly pglite: PGlite) {
    super();
  }

  async createUser({ email, displayName }: NewAuthUser): Promise<string> {
    const existing = await this.pglite.query(`select 1 from auth.users where lower(email) = lower($1)`, [email]);
    if (existing.rows.length) throw new AppError("EMAIL_TAKEN", 409, "An account with this email already exists.");
    const res = await this.pglite.query<{ id: string }>(
      `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`,
      [email, JSON.stringify({ display_name: displayName })],
    );
    this.created.push(res.rows[0]!.id);
    return res.rows[0]!.id;
  }

  async deleteUser(id: string): Promise<void> {
    await this.pglite.query(`delete from auth.users where id = $1`, [id]);
    this.deleted.push(id);
  }
}
