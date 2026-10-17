import type { PGlite } from '@electric-sql/pglite';
import { asRole, createTestDb, createUser, seedTest } from '../helpers/db.js';

let db: PGlite;
let adminId: string;
let userId: string;

beforeAll(async () => {
  db = await createTestDb();
  adminId = await createUser(db, 'admin@example.com', true);
  userId = await createUser(db, 'student@example.com');
  await seedTest(db);
});

const fails = async (fn: () => Promise<unknown>) => {
  const error = await fn().then(
    () => null,
    (e: { message: string }) => e,
  );
  return error?.message ?? null;
};

describe('database security (RLS and privileges)', () => {
  it('new users get a student profile automatically', async () => {
    const r = await db.query<{ role: string }>('select role from public.profiles where id = $1', [userId]);
    expect(r.rows[0]!.role).toBe('student');
  });

  it('the anonymous key cannot read any table', async () => {
    for (const table of ['tests', 'questions', 'test_attempts', 'student_answers', 'subjects', 'profiles']) {
      const msg = await asRole(db, 'anon', null, () => fails(() => db.query(`select * from public.${table}`)));
      expect(msg, table).toMatch(/permission denied/);
    }
  });

  it('the anonymous key cannot call attempt functions', async () => {
    const msg = await asRole(db, 'anon', null, () =>
      fails(() => db.query(`select public.start_attempt('x', 'y', '{}'::jsonb, repeat('a', 64))`)),
    );
    expect(msg).toMatch(/permission denied/);
  });

  it('signed-in non-admins see no tests, questions or answer keys', async () => {
    const rows = await asRole(db, 'authenticated', userId, async () => {
      const tests = await db.query('select * from public.tests');
      const questions = await db.query('select * from public.questions');
      return tests.rows.length + questions.rows.length;
    });
    expect(rows).toBe(0);
  });

  it('signed-in users cannot call privileged functions', async () => {
    const msg = await asRole(db, 'authenticated', userId, () =>
      fails(() => db.query(`select public.list_expired_attempt_ids(10)`)),
    );
    expect(msg).toMatch(/permission denied/);
  });

  it('nobody but the service role can change a deadline or a score, admins included', async () => {
    const msg = await asRole(db, 'authenticated', adminId, () =>
      fails(() => db.query(`update public.test_attempts set deadline_at = now() + interval '1 day', final_score = 100`)),
    );
    expect(msg).toMatch(/permission denied/);
  });

  it('a user cannot promote themselves to admin', async () => {
    const msg = await asRole(db, 'authenticated', userId, () =>
      fails(() => db.query(`update public.profiles set role = 'admin' where id = $1`, [userId])),
    );
    expect(msg).toMatch(/permission denied/);
    const msg2 = await asRole(db, 'authenticated', userId, () =>
      fails(() => db.query(`select public.promote_to_admin('student@example.com')`)),
    );
    expect(msg2).toMatch(/permission denied/);
  });

  it('admins can read tests through RLS', async () => {
    const count = await asRole(db, 'authenticated', adminId, async () => (await db.query('select id from public.tests')).rows.length);
    expect(count).toBeGreaterThan(0);
  });

  it('admin-only functions verify the actor is an admin', async () => {
    const msg = await fails(() =>
      db.query(`select public.admin_set_test_status($1, gen_random_uuid(), 'published')`, [userId]),
    );
    expect(msg).toBe('FORBIDDEN');
  });

  it('a test cannot be published without questions', async () => {
    const { testId } = await seedTest(db, { status: 'draft' }, []);
    const msg = await fails(() => db.query(`select public.admin_set_test_status($1, $2, 'published')`, [adminId, testId]));
    expect(msg).toBe('TEST_HAS_NO_QUESTIONS');
  });

  it('questions are locked once a test has attempts', async () => {
    const { testId, shareToken } = await seedTest(db);
    await db.query(`select public.start_attempt($1, 'Sara', '{}'::jsonb, repeat('b', 64))`, [shareToken]);
    const test = (await db.query<{ t: Record<string, unknown> }>('select to_jsonb(t) as t from public.tests t where id = $1', [testId]))
      .rows[0]!.t;
    const msg = await fails(() =>
      db.query(`select public.admin_save_test($1, $2::jsonb, '[]'::jsonb)`, [adminId, JSON.stringify(test)]),
    );
    expect(msg).toBe('TEST_LOCKED');
    // Settings-only saves are still allowed.
    await expect(db.query(`select public.admin_save_test($1, $2::jsonb, null)`, [adminId, JSON.stringify(test)])).resolves.toBeTruthy();
  });

  it('a topic must belong to the test subject', async () => {
    const { testId } = await seedTest(db);
    const other = await db.query<{ id: string }>(
      `insert into public.subjects (name, slug) values ('Other', 'other') returning id`,
    );
    const topic = await db.query<{ id: string }>(
      `insert into public.topics (subject_id, name) values ($1, 'Unrelated') returning id`,
      [other.rows[0]!.id],
    );
    const msg = await fails(() => db.query('update public.tests set topic_id = $1 where id = $2', [topic.rows[0]!.id, testId]));
    expect(msg).toBe('TOPIC_SUBJECT_MISMATCH');
  });
});
