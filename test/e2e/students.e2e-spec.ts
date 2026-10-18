import type { PGlite } from '@electric-sql/pglite';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthAdmin } from '../../src/accounts/auth-admin.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { TokenVerifier, type VerifiedToken } from '../../src/auth/token-verifier.js';
import { Database } from '../../src/database/database.js';
import { PgliteAuthAdmin, PgliteDatabase, createTestDb, createUser, seedTest } from '../helpers/db.js';

class FakeVerifier extends TokenVerifier {
  users = new Map<string, VerifiedToken>();
  async verify(token: string) {
    return this.users.get(token) ?? null;
  }
}

let app: NestExpressApplication;
let http: Parameters<typeof request>[0];
let pglite: PGlite;
const verifier = new FakeVerifier();

/** Bearer header for an existing auth user (the fake verifier accepts it). */
async function signIn(email: string, session = 'a'): Promise<{ Authorization: string }> {
  const row = (await pglite.query<{ id: string }>('select id from auth.users where email = $1', [email])).rows[0]!;
  const token = `token-${session}-${row.id}`;
  verifier.users.set(token, { userId: row.id, email });
  return { Authorization: `Bearer ${token}` };
}

function signUp(account_type: 'student' | 'teacher', name: string, email: string) {
  return request(http).post('/v1/auth/signup').send({ account_type, display_name: name, email, password: 'a-long-password' });
}

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DISABLE_RATE_LIMIT: 'true',
    DATABASE_URL: 'postgresql://unused@localhost/unused',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_key_000000',
    EXPIRY_WORKER_ENABLED: 'false',
  });
  pglite = await createTestDb();
  await createUser(pglite, 'admin@example.com', true);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Database)
    .useValue(new PgliteDatabase(pglite))
    .overrideProvider(TokenVerifier)
    .useValue(verifier)
    .overrideProvider(AuthAdmin)
    .useValue(new PgliteAuthAdmin(pglite))
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app);
  await app.init();
  http = app.getHttpServer();
});

afterAll(async () => {
  await app?.close();
});

describe('student sign-up and history', () => {
  it('creates an active student account', async () => {
    const res = await signUp('student', 'Ayesha Khan', 'Ayesha@Example.com').expect(201);
    expect(res.body).toEqual({ email: 'ayesha@example.com', account_type: 'student', status: 'active' });
    const me = await request(http).get('/v1/auth/me').set(await signIn('ayesha@example.com')).expect(200);
    expect(me.body).toMatchObject({ role: 'student', displayName: 'Ayesha Khan', accessRequest: null });
  });

  it('rejects a duplicate email', async () => {
    const res = await signUp('student', 'Again', 'ayesha@example.com').expect(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('records attempts under the account and shows them only to their owner', async () => {
    const { shareToken } = await seedTest(pglite, { title: 'Algebra basics' });
    const ayesha = await signIn('ayesha@example.com');

    const started = await request(http)
      .post(`/v1/public/tests/${shareToken}/attempts`)
      .set(ayesha)
      .send({ student_name: 'Typed name is ignored' })
      .expect(201);
    const { attempt_id, attempt_token } = started.body as { attempt_id: string; attempt_token: string };
    await request(http).post(`/v1/attempts/${attempt_id}/submit`).set('X-Attempt-Token', attempt_token).send({ type: 'manual' }).expect(200);

    const mine = await request(http).get('/v1/me/attempts').set(ayesha).expect(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({ id: attempt_id, test: { title: 'Algebra basics' }, status: 'submitted' });
    expect(mine.body[0].score).toMatchObject({ maximum: expect.any(Number), percentage: expect.any(Number) });

    const result = await request(http).get(`/v1/me/attempts/${attempt_id}/result`).set(ayesha).expect(200);
    expect(result.body.attempt).toMatchObject({ id: attempt_id, student_name: 'Ayesha Khan' });

    // Another student sees nothing of it.
    await signUp('student', 'Bilal', 'bilal@example.com').expect(201);
    const bilal = await signIn('bilal@example.com');
    expect((await request(http).get('/v1/me/attempts').set(bilal).expect(200)).body).toEqual([]);
    await request(http).get(`/v1/me/attempts/${attempt_id}/result`).set(bilal).expect(404);
    await request(http).post(`/v1/me/attempts/${attempt_id}/resume`).set(bilal).expect(404);
  });

  it('continues an in-progress attempt on another device', async () => {
    const { shareToken } = await seedTest(pglite);
    const ayesha = await signIn('ayesha@example.com');
    const started = await request(http).post(`/v1/public/tests/${shareToken}/attempts`).set(ayesha).send({ student_name: 'x' }).expect(201);

    const resumed = await request(http).post(`/v1/me/attempts/${started.body.attempt_id}/resume`).set(ayesha).expect(200);
    await request(http).get(`/v1/attempts/${started.body.attempt_id}`).set('X-Attempt-Token', resumed.body.attempt_token).expect(200);
    await request(http).get(`/v1/attempts/${started.body.attempt_id}`).set('X-Attempt-Token', started.body.attempt_token).expect(404);
  });

  it('claims guest attempts taken before signing up', async () => {
    const { shareToken } = await seedTest(pglite);
    const guest = await request(http).post(`/v1/public/tests/${shareToken}/attempts`).send({ student_name: 'Sara' }).expect(201);

    await signUp('student', 'Sara', 'sara@example.com').expect(201);
    const sara = await signIn('sara@example.com');
    const claim = { attempts: [{ attempt_id: guest.body.attempt_id, attempt_token: guest.body.attempt_token }] };
    expect((await request(http).post('/v1/me/attempts/claim').set(sara).send(claim).expect(200)).body).toEqual({ claimed: 1 });
    expect((await request(http).get('/v1/me/attempts').set(sara).expect(200)).body.map((a: { id: string }) => a.id)).toEqual([guest.body.attempt_id]);

    // Already claimed: another account gets nothing.
    expect((await request(http).post('/v1/me/attempts/claim').set(await signIn('bilal@example.com')).send(claim).expect(200)).body).toEqual({ claimed: 0 });
  });

  it('shows students their own progress only', async () => {
    const res = await request(http).get('/v1/me/progress').set(await signIn('ayesha@example.com')).expect(200);
    expect(res.body.students).toEqual([]);
    expect(res.body.student).toBe('Ayesha Khan');
    expect(res.body.totals.attempts).toBe(1);
  });

  it('student accounts cannot reach admin routes', async () => {
    const ayesha = await signIn('ayesha@example.com');
    await request(http).get('/v1/tests').set(ayesha).expect(403);
    await request(http).get('/v1/admin/access-requests').set(ayesha).expect(403);
  });
});

describe('tests that require a student account', () => {
  it('tells guests to sign in and lets students start', async () => {
    const { shareToken, testId } = await seedTest(pglite);
    await pglite.query('update public.tests set require_student_account = true where id = $1', [testId]);

    expect((await request(http).get(`/v1/public/tests/${shareToken}`).expect(200)).body.requires_account).toBe(true);
    const guest = await request(http).post(`/v1/public/tests/${shareToken}/attempts`).send({ student_name: 'Guest' }).expect(401);
    expect(guest.body.error.code).toBe('STUDENT_ACCOUNT_REQUIRED');
    await request(http).post(`/v1/public/tests/${shareToken}/attempts`).set(await signIn('ayesha@example.com')).send({ student_name: 'x' }).expect(201);
  });

  it('an invalid token is rejected rather than treated as a guest', async () => {
    const { shareToken } = await seedTest(pglite);
    await request(http)
      .post(`/v1/public/tests/${shareToken}/attempts`)
      .set('Authorization', 'Bearer not-a-valid-token-0000000000')
      .send({ student_name: 'x' })
      .expect(401);
  });
});

describe('teacher access requests', () => {
  it('a teacher signs up as pending and an admin approves them as a teacher', async () => {
    const res = await signUp('teacher', 'Mr Rahim', 'rahim@example.com').expect(201);
    expect(res.body.status).toBe('pending_approval');
    const rahim = await signIn('rahim@example.com');
    expect((await request(http).get('/v1/auth/me').set(rahim).expect(200)).body).toMatchObject({ role: 'student', accessRequest: 'pending' });
    await request(http).get('/v1/tests').set(rahim).expect(403);

    const admin = await signIn('admin@example.com');
    const pending = await request(http).get('/v1/admin/access-requests').set(admin).expect(200);
    expect(pending.body).toEqual([expect.objectContaining({ email: 'rahim@example.com', display_name: 'Mr Rahim' })]);

    await request(http).post(`/v1/admin/access-requests/${pending.body[0].id}/approve`).set(admin).expect(204);
    // A new session sees the new role at once (roles are cached for 15 s per token).
    const teacher = await signIn('rahim@example.com', 'b');
    expect((await request(http).get('/v1/auth/me').set(teacher).expect(200)).body.role).toBe('teacher');
    await request(http).get('/v1/tests').set(teacher).expect(200);
    await request(http).get('/v1/admin/access-requests').set(teacher).expect(403);
  });

  it('a rejected teacher stays a student', async () => {
    await signUp('teacher', 'Ms Zara', 'zara@example.com').expect(201);
    const admin = await signIn('admin@example.com');
    const pending = await request(http).get('/v1/admin/access-requests').set(admin).expect(200);
    const zara = pending.body.find((r: { email: string }) => r.email === 'zara@example.com');
    await request(http).post(`/v1/admin/access-requests/${zara.id}/reject`).set(admin).expect(204);
    await request(http).post(`/v1/admin/access-requests/${zara.id}/approve`).set(admin).expect(404);

    const me = await request(http).get('/v1/auth/me').set(await signIn('zara@example.com')).expect(200);
    expect(me.body).toMatchObject({ role: 'student', accessRequest: 'rejected' });
  });

  it('nobody can sign up as an admin directly', async () => {
    const res = await request(http)
      .post('/v1/auth/signup')
      .send({ account_type: 'admin', display_name: 'Eve', email: 'eve@example.com', password: 'a-long-password' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
