import type { PGlite } from '@electric-sql/pglite';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthAdmin } from '../../src/accounts/auth-admin.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { TokenVerifier, type VerifiedToken } from '../../src/auth/token-verifier.js';
import { Database } from '../../src/database/database.js';
import { PgliteAuthAdmin, PgliteDatabase, createTestDb, createUser } from '../helpers/db.js';

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
type Headers = { Authorization: string };
const as: Record<'admin' | 'ana' | 'ben' | 'sara' | 'omar', Headers> = {} as never;
const ids: Record<string, string> = {};

async function user(key: keyof typeof as, email: string, name: string, role: 'admin' | 'teacher' | 'student') {
  const id = await createUser(pglite, email, role === 'admin');
  await pglite.query('update public.profiles set display_name = $2, role = $3 where id = $1', [id, name, role]);
  const token = `token-${key}-0000000000000000`;
  verifier.users.set(token, { userId: id, email });
  as[key] = { Authorization: `Bearer ${token}` };
  ids[key] = id;
}

const mcq = {
  question_type: 'mcq_single',
  prompt: 'What is 2 + 2?',
  content: { options: [{ id: 'a', text: '3' }, { id: 'b', text: '4' }] },
  answer_key: { correct: 'b' },
  grading_method: 'auto',
  marks: 1,
};

async function publishedTest(teacher: Headers, title: string, extra: Record<string, unknown> = {}) {
  const subject = await request(http).post('/v1/subjects').set(teacher).send({ name: `${title} subject` }).expect(201);
  const created = await request(http)
    .post('/v1/tests')
    .set(teacher)
    .send({ settings: { title, subject_id: subject.body.id, duration_minutes: 10, ...extra }, questions: [mcq] })
    .expect(201);
  await request(http).post(`/v1/tests/${created.body.id}/publish`).set(teacher).expect(200);
  return created.body as { id: string; share_token: string; settings: Record<string, unknown> };
}

async function takeTest(student: Headers | null, shareToken: string, expectStatus = 201) {
  const req = request(http).post(`/v1/public/tests/${shareToken}/attempts`);
  if (student) req.set(student);
  const res = await req.send({ student_name: 'Guest' }).expect(expectStatus);
  return res.body as { attempt_id: string; attempt_token: string; error?: { code: string } };
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
  await user('admin', 'admin@school.test', 'Head Admin', 'admin');
  await user('ana', 'ana@school.test', 'Ana Teacher', 'teacher');
  await user('ben', 'ben@school.test', 'Ben Teacher', 'teacher');
  await user('sara', 'sara@school.test', 'Sara Student', 'student');
  await user('omar', 'omar@school.test', 'Omar Student', 'student');

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

describe('teachers only see their own work', () => {
  let anaTest: { id: string; share_token: string };
  let attemptId: string;

  beforeAll(async () => {
    anaTest = await publishedTest(as.ana, 'Ana algebra');
    const attempt = await takeTest(as.sara, anaTest.share_token);
    attemptId = attempt.attempt_id;
    await request(http).post(`/v1/attempts/${attemptId}/submit`).set('X-Attempt-Token', attempt.attempt_token).send({ type: 'manual' }).expect(200);
  });

  it('tests', async () => {
    const anaList = await request(http).get('/v1/tests').set(as.ana).expect(200);
    expect(anaList.body.items.map((t: { title: string }) => t.title)).toEqual(['Ana algebra']);
    expect((await request(http).get('/v1/tests').set(as.ben).expect(200)).body.items).toEqual([]);

    await request(http).get(`/v1/tests/${anaTest.id}`).set(as.ben).expect(404);
    await request(http).post(`/v1/tests/${anaTest.id}/unpublish`).set(as.ben).expect(404);
    await request(http).post(`/v1/tests/${anaTest.id}/duplicate`).set(as.ben).expect(404);
    await request(http).get(`/v1/tests/${anaTest.id}/preview`).set(as.ben).expect(404);
    await request(http).delete(`/v1/tests/${anaTest.id}`).set(as.ben).expect(404);

    const adminList = await request(http).get('/v1/tests').set(as.admin).expect(200);
    expect(adminList.body.items).toEqual([expect.objectContaining({ title: 'Ana algebra', owner: 'Ana Teacher' })]);
  });

  it('results, reviews and reports', async () => {
    expect((await request(http).get('/v1/admin/attempts').set(as.ana).expect(200)).body.total).toBe(1);
    expect((await request(http).get('/v1/admin/attempts').set(as.ben).expect(200)).body.total).toBe(0);
    await request(http).get(`/v1/admin/attempts/${attemptId}`).set(as.ben).expect(404);
    await request(http).post(`/v1/admin/attempts/${attemptId}/release`).set(as.ben).send({ released: true }).expect(404);
    await request(http).delete(`/v1/admin/attempts/${attemptId}`).set(as.ben).expect(404);

    expect((await request(http).get('/v1/reports/dashboard').set(as.ben).expect(200)).body.attempts.total).toBe(0);
    expect((await request(http).get('/v1/reports/dashboard').set(as.ana).expect(200)).body.attempts.total).toBe(1);
    expect((await request(http).get('/v1/reports/progress').set(as.ben).expect(200)).body.students).toEqual([]);
    const csv = await request(http).get('/v1/reports/results.csv').set(as.ben).expect(200);
    expect(csv.text).not.toContain('Ana algebra');
  });

  it('AI features on someone else’s test', async () => {
    await request(http)
      .post('/v1/ai/regenerate-question')
      .set(as.ben)
      .send({ test_id: anaTest.id, question_type: 'mcq_single', marks: 1 })
      .expect(404);
  });

  it('admin-only areas stay closed to teachers', async () => {
    await request(http).get('/v1/admin/staff').set(as.ana).expect(403);
    await request(http).get('/v1/admin/access-requests').set(as.ana).expect(403);
    await request(http).get('/v1/admin/admins').set(as.ana).expect(403);
  });
});

describe('classes and assigned tests', () => {
  let classId: string;
  let code: string;
  let test: { id: string; share_token: string; settings: Record<string, unknown> };

  it('a teacher creates a class with a join code', async () => {
    const res = await request(http).post('/v1/classes').set(as.ana).send({ name: 'Grade 8 Science' }).expect(201);
    expect(res.body).toMatchObject({ name: 'Grade 8 Science', member_count: 0, teacher: { name: 'Ana Teacher' } });
    expect(res.body.join_code).toMatch(/^[A-Z0-9]{8}$/);
    classId = res.body.id;
    code = res.body.join_code;

    await request(http).get(`/v1/classes/${classId}`).set(as.ben).expect(404);
    expect((await request(http).get('/v1/classes').set(as.ben).expect(200)).body).toEqual([]);
    expect((await request(http).get('/v1/classes').set(as.admin).expect(200)).body).toHaveLength(1);
  });

  it('students join with the code (any case, with a dash)', async () => {
    const pretty = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    const res = await request(http).post('/v1/me/classes/join').set(as.sara).send({ code: pretty }).expect(200);
    expect(res.body).toMatchObject({ id: classId, name: 'Grade 8 Science', teacher_name: 'Ana Teacher' });
    // Joining twice is harmless.
    await request(http).post('/v1/me/classes/join').set(as.sara).send({ code }).expect(200);

    const bad = await request(http).post('/v1/me/classes/join').set(as.omar).send({ code: 'ZZZZ-ZZZZ' }).expect(404);
    expect(bad.body.error.code).toBe('CLASS_NOT_FOUND');
    const teacher = await request(http).post('/v1/me/classes/join').set(as.ben).send({ code }).expect(403);
    expect(teacher.body.error.code).toBe('ONLY_STUDENTS_JOIN');
  });

  it('teachers add and remove students by email', async () => {
    const missing = await request(http).post(`/v1/classes/${classId}/members`).set(as.ana).send({ email: 'ben@school.test' }).expect(404);
    expect(missing.body.error.code).toBe('STUDENT_NOT_FOUND');
    const added = await request(http).post(`/v1/classes/${classId}/members`).set(as.ana).send({ email: 'omar@school.test' }).expect(200);
    expect(added.body.members.map((m: { display_name: string }) => m.display_name)).toEqual(['Omar Student', 'Sara Student']);
    const removed = await request(http).delete(`/v1/classes/${classId}/members/${ids.omar}`).set(as.ana).expect(200);
    expect(removed.body.member_count).toBe(1);
    await request(http).post(`/v1/classes/${classId}/members`).set(as.ben).send({ email: 'omar@school.test' }).expect(404);
  });

  it('resetting the code retires the old one', async () => {
    const res = await request(http).post(`/v1/classes/${classId}/reset-code`).set(as.ana).expect(200);
    expect(res.body.join_code).not.toBe(code);
    await request(http).post('/v1/me/classes/join').set(as.omar).send({ code }).expect(404);
    code = res.body.join_code;
  });

  it('assigned tests appear for class members and track progress', async () => {
    test = await publishedTest(as.ana, 'Ana physics quiz');
    const due = '2030-01-15T09:00:00.000Z';
    const assigned = await request(http).post(`/v1/tests/${test.id}/assignments`).set(as.ana).send({ class_id: classId, due_at: due }).expect(200);
    expect(assigned.body).toEqual([expect.objectContaining({ class_name: 'Grade 8 Science', member_count: 1, submitted_count: 0 })]);

    // Ben can neither assign Ana's test nor use Ana's class.
    await request(http).post(`/v1/tests/${test.id}/assignments`).set(as.ben).send({ class_id: classId }).expect(404);
    const benTest = await publishedTest(as.ben, 'Ben test');
    await request(http).post(`/v1/tests/${benTest.id}/assignments`).set(as.ben).send({ class_id: classId }).expect(404);

    const todo = await request(http).get('/v1/me/assignments').set(as.sara).expect(200);
    expect(todo.body).toEqual([expect.objectContaining({ title: 'Ana physics quiz', class_name: 'Grade 8 Science', state: 'not_started' })]);
    expect(new Date(todo.body[0].due_at).toISOString()).toBe(due);
    expect((await request(http).get('/v1/me/assignments').set(as.omar).expect(200)).body).toEqual([]);

    const attempt = await takeTest(as.sara, test.share_token);
    expect((await request(http).get('/v1/me/assignments').set(as.sara).expect(200)).body[0].state).toBe('in_progress');
    await request(http).post(`/v1/attempts/${attempt.attempt_id}/submit`).set('X-Attempt-Token', attempt.attempt_token).send({ type: 'manual' }).expect(200);
    const done = (await request(http).get('/v1/me/assignments').set(as.sara).expect(200)).body[0];
    expect(done).toMatchObject({ state: 'submitted', latest_attempt_id: attempt.attempt_id });

    const detail = await request(http).get(`/v1/classes/${classId}`).set(as.ana).expect(200);
    expect(detail.body.assignments).toEqual([expect.objectContaining({ title: 'Ana physics quiz', submitted_count: 1 })]);
  });

  it('class-only tests admit class members only', async () => {
    const updated = await request(http)
      .put(`/v1/tests/${test.id}`)
      .set(as.ana)
      .send({ settings: { ...test.settings, class_only: true }, questions: null })
      .expect(200);
    expect(updated.body.settings.class_only).toBe(true);

    await takeTest(as.sara, test.share_token);
    expect((await takeTest(as.omar, test.share_token, 403)).error?.code).toBe('NOT_IN_CLASS');
    expect((await takeTest(null, test.share_token, 401)).error?.code).toBe('STUDENT_ACCOUNT_REQUIRED');
  });

  it('students can leave a class', async () => {
    await request(http).delete(`/v1/me/classes/${classId}`).set(as.sara).expect(204);
    expect((await request(http).get('/v1/me/classes').set(as.sara).expect(200)).body).toEqual([]);
    expect((await request(http).get('/v1/me/assignments').set(as.sara).expect(200)).body).toEqual([]);
  });
});

describe('admin manages teachers', () => {
  it('lists teachers and admins with their numbers', async () => {
    const res = await request(http).get('/v1/admin/staff').set(as.admin).expect(200);
    const ana = res.body.find((s: { email: string }) => s.email === 'ana@school.test');
    expect(ana).toMatchObject({ role: 'teacher', class_count: 1, test_count: 2 });
    expect(res.body.map((s: { role: string }) => s.role)).toContain('admin');
  });

  it('adds a teacher directly', async () => {
    const res = await request(http)
      .post('/v1/admin/admins')
      .set(as.admin)
      .send({ display_name: 'Cara Teacher', email: 'cara@school.test', password: 'a-long-password', role: 'teacher' })
      .expect(201);
    const role = await pglite.query<{ role: string }>('select role from public.profiles where id = $1', [res.body.id]);
    expect(role.rows[0]!.role).toBe('teacher');
  });

  it('removes a teacher’s access, but not their own', async () => {
    await request(http).post(`/v1/admin/staff/${ids.ben}/role`).set(as.admin).send({ role: 'student' }).expect(204);
    // A new session sees the change straight away (roles are cached briefly per token).
    verifier.users.set('token-ben-new-000000000000000', { userId: ids.ben!, email: 'ben@school.test' });
    await request(http).get('/v1/tests').set('Authorization', 'Bearer token-ben-new-000000000000000').expect(403);

    const self = await request(http).post(`/v1/admin/staff/${ids.admin}/role`).set(as.admin).send({ role: 'teacher' }).expect(409);
    expect(self.body.error.code).toBe('CANNOT_REMOVE_SELF');
  });
});
