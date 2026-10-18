import type { PGlite } from '@electric-sql/pglite';
import { createAttemptStore } from '../../src/attempts/attempt-store.js';
import * as workflow from '../../src/attempts/attempt-workflow.js';
import { AppError } from '../../src/common/errors.js';
import { asRole, createTestDb, createUser, pgliteRpc, seedTest } from '../helpers/db.js';

let db: PGlite;
let ana: string;
let ben: string;
let sara: string;

const failure = (fn: () => Promise<unknown>) =>
  fn().then(
    () => null,
    (e: Error) => (e instanceof AppError ? e.code : e.message),
  );

async function teacher(email: string) {
  const id = await createUser(db, email);
  await db.query(`update public.profiles set role = 'teacher' where id = $1`, [id]);
  return id;
}

beforeEach(async () => {
  db = await createTestDb();
  ana = await teacher('ana@example.com');
  ben = await teacher('ben@example.com');
  sara = await createUser(db, 'sara@example.com');
});

describe('teacher access in the database', () => {
  it('a teacher creates tests but cannot change another teacher’s test', async () => {
    const subject = (await db.query<{ id: string }>(`insert into public.subjects (name, slug) values ('Maths', 'maths') returning id`)).rows[0]!.id;
    const payload = (extra: object) => JSON.stringify({ title: 'Quiz', subject_id: subject, duration_minutes: 5, passing_percentage: 50, share_token: 'share_token_for_ana_0001', ...extra });
    const id = (await db.query<{ id: string }>('select public.admin_save_test($1, $2::jsonb) as id', [ana, payload({})])).rows[0]!.id;

    expect(await failure(() => db.query('select public.admin_save_test($1, $2::jsonb)', [ben, payload({ id, title: 'Hijacked' })]))).toBe('FORBIDDEN');
    expect(await failure(() => db.query(`select public.admin_set_test_status($1, $2, 'archived')`, [ben, id]))).toBe('FORBIDDEN');
    expect(await failure(() => db.query('select public.admin_save_test($1, $2::jsonb)', [sara, payload({ share_token: 'share_token_for_sara_001' })]))).toBe('FORBIDDEN');
    await db.query('select public.admin_save_test($1, $2::jsonb)', [ana, payload({ id, title: 'Renamed' })]);
  });

  it('only the owner (or an admin) can review and release an attempt', async () => {
    const { shareToken, testId, questionIds } = await seedTest(db);
    await db.query('update public.tests set created_by = $1 where id = $2', [ana, testId]);
    const store = createAttemptStore(pgliteRpc(db));
    const { attempt, token } = await workflow.startAttempt(store, shareToken, 'Sara', {});
    await workflow.submitStudentAttempt(store, attempt.id, token, 'manual');

    expect(await failure(() => db.query(`select public.set_results_released($1, $2, true)`, [ben, attempt.id]))).toBe('FORBIDDEN');
    expect(await failure(() => db.query(`select public.review_answer($1, $2, $3, 0, null, 'manual')`, [ben, attempt.id, questionIds[0]]))).toBe('FORBIDDEN');
    await db.query(`select public.set_results_released($1, $2, true)`, [ana, attempt.id]);
  });

  it('class-only tests need membership of an assigned class', async () => {
    const { shareToken, testId } = await seedTest(db);
    await db.query('update public.tests set class_only = true, created_by = $1 where id = $2', [ana, testId]);
    const cls = (await db.query<{ id: string }>(`insert into public.classes (teacher_id, name, join_code) values ($1, 'G8', 'ABCD2345') returning id`, [ana])).rows[0]!.id;
    await db.query('insert into public.test_assignments (test_id, class_id) values ($1, $2)', [testId, cls]);
    const store = createAttemptStore(pgliteRpc(db));

    expect(await failure(() => workflow.startAttempt(store, shareToken, 'Sara', {}, sara))).toBe('NOT_IN_CLASS');
    await db.query('insert into public.class_members (class_id, student_id) values ($1, $2)', [cls, sara]);
    await workflow.startAttempt(store, shareToken, 'Sara', {}, sara);
    // Archiving the class closes the door again.
    await db.query('update public.classes set archived_at = now() where id = $1', [cls]);
    const omar = await createUser(db, 'omar@example.com');
    await db.query('insert into public.class_members (class_id, student_id) values ($1, $2)', [cls, omar]);
    expect(await failure(() => workflow.startAttempt(store, shareToken, 'Omar', {}, omar))).toBe('NOT_IN_CLASS');
  });

  it('the public and signed-in keys cannot touch classes', async () => {
    for (const table of ['classes', 'class_members', 'test_assignments']) {
      for (const r of ['anon', 'authenticated'] as const) {
        const msg = await asRole(db, r, sara, () => failure(() => db.query(`select * from public.${table}`)));
        expect(msg, `${r} ${table}`).toMatch(/permission denied/);
      }
    }
  });
});
