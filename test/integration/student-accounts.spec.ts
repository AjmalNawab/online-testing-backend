import type { PGlite } from '@electric-sql/pglite';
import { createAttemptStore, type AttemptStore } from '../../src/attempts/attempt-store.js';
import * as workflow from '../../src/attempts/attempt-workflow.js';
import { AppError } from '../../src/common/errors.js';
import { asRole, createTestDb, createUser, pgliteRpc, seedTest } from '../helpers/db.js';

let db: PGlite;
let store: AttemptStore;
let ayesha: string;
let bilal: string;

const failure = async (fn: () => Promise<unknown>) =>
  fn().then(
    () => null,
    (e: Error) => (e instanceof AppError ? e.code : e.message),
  );

beforeEach(async () => {
  db = await createTestDb();
  store = createAttemptStore(pgliteRpc(db));
  ayesha = await createUser(db, 'ayesha@example.com');
  bilal = await createUser(db, 'bilal@example.com');
});

describe('attempts by signed-in students', () => {
  it('links the attempt to the account', async () => {
    const { shareToken } = await seedTest(db);
    const { attempt } = await workflow.startAttempt(store, shareToken, 'Ayesha', {}, ayesha);
    expect(attempt.student_id).toBe(ayesha);
  });

  it('counts max attempts per account, whatever name is used', async () => {
    const { shareToken } = await seedTest(db, { max_attempts: 1 });
    await workflow.startAttempt(store, shareToken, 'Ayesha', {}, ayesha);
    expect(await failure(() => workflow.startAttempt(store, shareToken, 'Someone else', {}, ayesha))).toBe('MAX_ATTEMPTS_REACHED');
    // Another account with the same name is a different student.
    await workflow.startAttempt(store, shareToken, 'Ayesha', {}, bilal);
  });

  it('a guest with the same name as an account holder does not collide', async () => {
    const { shareToken } = await seedTest(db, { max_attempts: 1 });
    await workflow.startAttempt(store, shareToken, 'Ayesha', {});
    const { attempt } = await workflow.startAttempt(store, shareToken, 'Ayesha', {}, ayesha);
    expect(attempt.attempt_number).toBe(1);
  });

  it('tests that require an account reject guests', async () => {
    const { shareToken, testId } = await seedTest(db);
    await db.query('update public.tests set require_student_account = true where id = $1', [testId]);
    expect(await failure(() => workflow.startAttempt(store, shareToken, 'Guest', {}))).toBe('STUDENT_ACCOUNT_REQUIRED');
    await workflow.startAttempt(store, shareToken, 'Ayesha', {}, ayesha);
  });
});

describe('owner-only access', () => {
  it('only the owner can load the result of an attempt', async () => {
    const { shareToken } = await seedTest(db);
    const { attempt, token } = await workflow.startAttempt(store, shareToken, 'Ayesha', {}, ayesha);
    await workflow.submitStudentAttempt(store, attempt.id, token, 'manual');

    const mine = await workflow.getStudentResult(store, attempt.id, { studentId: ayesha });
    expect(mine.attempt.id).toBe(attempt.id);
    expect(await failure(() => workflow.getStudentResult(store, attempt.id, { studentId: bilal }))).toBe('ATTEMPT_NOT_FOUND');
  });

  it('resuming issues a new secret and retires the old one', async () => {
    const { shareToken } = await seedTest(db);
    const { attempt, token } = await workflow.startAttempt(store, shareToken, 'Ayesha', {}, ayesha);
    const fresh = await workflow.resumeOwnAttempt(store, ayesha, attempt.id);

    expect(fresh).not.toBe(token);
    expect((await workflow.getStudentAttemptState(store, attempt.id, fresh)).attempt.id).toBe(attempt.id);
    expect(await failure(() => workflow.getStudentAttemptState(store, attempt.id, token))).toBe('ATTEMPT_NOT_FOUND');
    expect(await failure(() => workflow.resumeOwnAttempt(store, bilal, attempt.id))).toBe('ATTEMPT_NOT_FOUND');
  });

  it('a submitted attempt cannot be resumed', async () => {
    const { shareToken } = await seedTest(db);
    const { attempt, token } = await workflow.startAttempt(store, shareToken, 'Ayesha', {}, ayesha);
    await workflow.submitStudentAttempt(store, attempt.id, token, 'manual');
    expect(await failure(() => workflow.resumeOwnAttempt(store, ayesha, attempt.id))).toBe('ATTEMPT_CLOSED');
  });
});

describe('claiming guest attempts', () => {
  it('claims attempts proved by their secret, once', async () => {
    const { shareToken } = await seedTest(db);
    const a = await workflow.startAttempt(store, shareToken, 'Ayesha', {});
    const b = await workflow.startAttempt(store, shareToken, 'Ayesha', {});

    expect(await workflow.claimGuestAttempts(store, ayesha, [a.token, b.token])).toBe(2);
    // Already owned: nobody else can take them over, not even with the secret.
    expect(await workflow.claimGuestAttempts(store, bilal, [a.token])).toBe(0);
    const owner = await db.query<{ student_id: string }>('select student_id from public.test_attempts where id = $1', [a.attempt.id]);
    expect(owner.rows[0]!.student_id).toBe(ayesha);
  });

  it('ignores secrets that do not match an attempt', async () => {
    expect(await workflow.claimGuestAttempts(store, ayesha, ['A'.repeat(43)])).toBe(0);
  });
});

describe('administrator access requests', () => {
  const list = async (actor: string) =>
    (await db.query<{ r: { id: string }[] }>('select public.admin_list_access_requests($1) as r', [actor])).rows[0]!.r;
  const role = async (id: string) =>
    (await db.query<{ role: string; access_request: string | null }>('select role, access_request from public.profiles where id = $1', [id])).rows[0]!;

  it('an admin approves a pending request: the user becomes a teacher', async () => {
    const admin = await createUser(db, 'admin@example.com', true);
    await db.query('select public.request_admin_access($1)', [bilal]);
    expect((await list(admin)).map((r) => r.id)).toEqual([bilal]);

    await db.query('select public.admin_decide_access_request($1, $2, true)', [admin, bilal]);
    expect(await role(bilal)).toEqual({ role: 'teacher', access_request: null });
    expect(await list(admin)).toEqual([]);
  });

  it('a rejected request leaves a student account and cannot be decided twice', async () => {
    const admin = await createUser(db, 'admin@example.com', true);
    await db.query('select public.request_admin_access($1)', [bilal]);
    await db.query('select public.admin_decide_access_request($1, $2, false)', [admin, bilal]);
    expect(await role(bilal)).toEqual({ role: 'student', access_request: 'rejected' });
    expect(await failure(() => db.query('select public.admin_decide_access_request($1, $2, true)', [admin, bilal]))).toBe('REQUEST_NOT_FOUND');
  });

  it('non-admins cannot see or decide requests', async () => {
    await db.query('select public.request_admin_access($1)', [bilal]);
    expect(await failure(() => list(ayesha))).toBe('FORBIDDEN');
    expect(await failure(() => db.query('select public.admin_decide_access_request($1, $2, true)', [ayesha, bilal]))).toBe('FORBIDDEN');
    expect((await role(bilal)).role).toBe('student');
  });

  it('none of the new functions can be called with the public or signed-in keys', async () => {
    const calls = [
      `select public.request_admin_access('${ayesha}')`,
      `select public.claim_attempts('${ayesha}', '["x"]'::jsonb)`,
      `select public.get_student_attempt_bundle('${ayesha}', gen_random_uuid())`,
      `select public.rotate_attempt_token('${ayesha}', gen_random_uuid(), repeat('a', 64))`,
    ];
    for (const sql of calls) {
      for (const r of ['anon', 'authenticated'] as const) {
        const msg = await asRole(db, r, ayesha, () => failure(() => db.query(sql)));
        expect(msg, `${r}: ${sql}`).toMatch(/permission denied/);
      }
    }
  });
});
