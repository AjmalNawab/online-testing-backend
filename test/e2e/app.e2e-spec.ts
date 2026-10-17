import type { PGlite } from '@electric-sql/pglite';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AiProvider, type AiJsonRequest, type AiJsonResult } from '../../src/ai/ai-provider.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { TokenVerifier, type VerifiedToken } from '../../src/auth/token-verifier.js';
import { AppError } from '../../src/common/errors.js';
import { Database } from '../../src/database/database.js';
import { PgliteDatabase, createTestDb, createUser, expireAttempt } from '../helpers/db.js';

const ADMIN_TOKEN = 'admin-token-aaaaaaaaaaaaaaaaaaaa';
const STUDENT_TOKEN = 'student-token-bbbbbbbbbbbbbbbbbbbb';

class FakeVerifier extends TokenVerifier {
  users = new Map<string, VerifiedToken>();
  async verify(token: string) {
    return this.users.get(token) ?? null;
  }
}

class FakeAi extends AiProvider {
  configured = true;
  model = 'fake-model';
  next: ((req: AiJsonRequest) => unknown) | null = null;
  calls: AiJsonRequest[] = [];
  async generateJson(req: AiJsonRequest): Promise<AiJsonResult> {
    this.calls.push(req);
    const json = this.next ? this.next(req) : {};
    if (json instanceof Error) throw json;
    return { json, model: this.model, inputTokens: 10, outputTokens: 20 };
  }
}

let app: NestExpressApplication;
let http: Parameters<typeof request>[0];
let pglite: PGlite;
const verifier = new FakeVerifier();
const ai = new FakeAi();

const admin = () => ({ Authorization: `Bearer ${ADMIN_TOKEN}` });

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DISABLE_RATE_LIMIT = 'true';
  process.env.DATABASE_URL = 'postgresql://unused@localhost/unused';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test_key_000000';
  process.env.CORS_ORIGINS = 'http://localhost:3000,https://tests.example.com';
  process.env.EXPIRY_WORKER_ENABLED = 'false';
  process.env.GEMINI_API_KEY = 'fake-key-for-tests';

  pglite = await createTestDb();
  const adminId = await createUser(pglite, 'admin@example.com', true);
  const studentId = await createUser(pglite, 'student@example.com');
  verifier.users.set(ADMIN_TOKEN, { userId: adminId, email: 'admin@example.com' });
  verifier.users.set(STUDENT_TOKEN, { userId: studentId, email: 'student@example.com' });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Database)
    .useValue(new PgliteDatabase(pglite))
    .overrideProvider(TokenVerifier)
    .useValue(verifier)
    .overrideProvider(AiProvider)
    .useValue(ai)
    .compile();

  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app);
  await app.init();
  http = app.getHttpServer();
});

afterAll(async () => {
  await app?.close();
});

// ---------------------------------------------------------------- fixtures ---

const mcq = {
  question_type: 'mcq_single',
  prompt: 'What is the capital of France?',
  content: { options: [{ id: 'a', text: 'Berlin' }, { id: 'b', text: 'Paris' }] },
  answer_key: { correct: 'b' },
  grading_method: 'auto',
  marks: 2,
  explanation: 'Paris has been the capital since 987.',
};
const essay = {
  question_type: 'short_answer',
  prompt: 'Why do seasons change?',
  content: { max_words: 80 },
  answer_key: { model_answer: 'Because Earth is tilted on its axis.', key_points: ['axial tilt'] },
  grading_method: 'ai_assisted',
  rubric: 'Full marks for mentioning axial tilt.',
  marks: 3,
};

async function createSubject(name: string): Promise<string> {
  const res = await request(http).post('/v1/subjects').set(admin()).send({ name }).expect(201);
  return res.body.id as string;
}

async function createPublishedTest(overrides: Record<string, unknown> = {}, questions: unknown[] = [mcq, essay]) {
  const subjectId = await createSubject(`Subject ${Math.random().toString(36).slice(2, 8)}`);
  const created = await request(http)
    .post('/v1/tests')
    .set(admin())
    .send({ settings: { title: 'Geography quiz', subject_id: subjectId, duration_minutes: 10, ...overrides }, questions })
    .expect(201);
  await request(http).post(`/v1/tests/${created.body.id}/publish`).set(admin()).expect(200);
  return created.body as { id: string; share_token: string };
}

async function startAttempt(shareToken: string, name = 'Ayesha') {
  const res = await request(http).post(`/v1/public/tests/${shareToken}/attempts`).send({ student_name: name }).expect(201);
  return res.body as { attempt_id: string; attempt_token: string; deadline_at: string };
}

// ------------------------------------------------------------------- tests ---

describe('platform', () => {
  it('serves health checks and OpenAPI docs', async () => {
    await request(http).get('/health').expect(200);
    await request(http).get('/health/ready').expect(200);
    const docs = await request(http).get('/docs/openapi.json').expect(200);
    expect(docs.body.paths['/v1/public/tests/{shareToken}/attempts']).toBeDefined();
    expect(docs.body.paths['/v1/tests']).toBeDefined();
  });

  it('returns consistent error bodies with a request id', async () => {
    const res = await request(http).get('/v1/nope').expect(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.body.error.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(res.body.error.requestId);
  });

  it('rejects malformed JSON', async () => {
    const res = await request(http).post('/v1/subjects').set(admin()).set('Content-Type', 'application/json').send('{bad').expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rate-limits starting attempts', async () => {
    const test = await createPublishedTest();
    process.env.DISABLE_RATE_LIMIT = 'false';
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push((await request(http).post(`/v1/public/tests/${test.share_token}/attempts`).send({ student_name: `S${i}` })).status);
      }
      expect(statuses.filter((s) => s === 201)).toHaveLength(10);
      expect(statuses.at(-1)).toBe(429);
    } finally {
      process.env.DISABLE_RATE_LIMIT = 'true';
    }
  });

  it('allows only configured CORS origins', async () => {
    const ok = await request(http).options('/v1/tests').set('Origin', 'https://tests.example.com').set('Access-Control-Request-Method', 'GET');
    expect(ok.headers['access-control-allow-origin']).toBe('https://tests.example.com');
    const bad = await request(http).options('/v1/tests').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('authentication and authorization', () => {
  it('requires a valid token for admin routes', async () => {
    expect((await request(http).get('/v1/tests').expect(401)).body.error.code).toBe('UNAUTHORIZED');
    await request(http).get('/v1/tests').set('Authorization', 'Bearer not-a-real-token-xxxxxxxxxxxx').expect(401);
  });

  it('forbids non-admin users', async () => {
    await request(http).get('/v1/tests').set('Authorization', `Bearer ${STUDENT_TOKEN}`).expect(403);
    const me = await request(http).get('/v1/auth/me').set('Authorization', `Bearer ${STUDENT_TOKEN}`).expect(200);
    expect(me.body.role).toBe('student');
  });

  it('identifies admins', async () => {
    const me = await request(http).get('/v1/auth/me').set(admin()).expect(200);
    expect(me.body).toMatchObject({ role: 'admin', email: 'admin@example.com' });
  });
});

describe('catalog', () => {
  it('creates subjects and topics without code changes, rejecting duplicates', async () => {
    const subjectId = await createSubject('Mathematics');
    const dup = await request(http).post('/v1/subjects').set(admin()).send({ name: '  mathematics ' }).expect(409);
    expect(dup.body.error.code).toBe('CONFLICT');
    const topic = await request(http).post(`/v1/subjects/${subjectId}/topics`).set(admin()).send({ name: 'Algebra' }).expect(201);
    const topics = await request(http).get(`/v1/subjects/${subjectId}/topics`).set(admin()).expect(200);
    expect(topics.body.map((t: { id: string }) => t.id)).toContain(topic.body.id);
    await request(http).post('/v1/categories').set(admin()).send({ name: 'Interview prep' }).expect(201);
  });

  it('validates input and strips unknown fields', async () => {
    const res = await request(http).post('/v1/subjects').set(admin()).send({ name: '' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details[0].path).toBe('name');
  });
});

describe('test management', () => {
  it('creates, validates and publishes a test with tags', async () => {
    const subjectId = await createSubject('Science');
    const created = await request(http)
      .post('/v1/tests')
      .set(admin())
      .send({
        settings: { title: 'Seasons', subject_id: subjectId, duration_minutes: 15, tags: ['earth', 'Year 7'], intended_total_marks: 10 },
        questions: [mcq, essay],
      })
      .expect(201);
    expect(created.body.status).toBe('draft');
    expect(created.body.questions).toHaveLength(2);
    expect(created.body.settings.tags).toEqual(['earth', 'Year 7']);
    expect(created.body.check.summary).toMatchObject({ total_marks: 5, auto_graded_marks: 2, reviewed_marks: 3 });
    expect(created.body.check.warnings.join(' ')).toMatch(/intended total is 10/);

    const list = await request(http).get('/v1/tests').query({ tag: 'year 7' }).set(admin()).expect(200);
    expect(list.body.items.map((t: { id: string }) => t.id)).toContain(created.body.id);

    await request(http).post(`/v1/tests/${created.body.id}/publish`).set(admin()).expect(200);
  });

  it('rejects invalid questions with useful messages', async () => {
    const subjectId = await createSubject('Physics');
    const res = await request(http)
      .post('/v1/tests')
      .set(admin())
      .send({ settings: { title: 'Bad', subject_id: subjectId, duration_minutes: 5 }, questions: [{ ...mcq, answer_key: { correct: 'z' } }] })
      .expect(400);
    expect(JSON.stringify(res.body.error.details)).toMatch(/Choose which option is correct/);
  });

  it('refuses to publish an empty test', async () => {
    const subjectId = await createSubject('History');
    const created = await request(http)
      .post('/v1/tests')
      .set(admin())
      .send({ settings: { title: 'Empty', subject_id: subjectId, duration_minutes: 5 } })
      .expect(201);
    const res = await request(http).post(`/v1/tests/${created.body.id}/publish`).set(admin()).expect(422);
    expect(res.body.error.code).toBe('NOT_PUBLISHABLE');
  });

  it('duplicates, previews without answer keys, archives and locks questions after attempts', async () => {
    const test = await createPublishedTest();
    const preview = await request(http).get(`/v1/tests/${test.id}/preview`).set(admin()).expect(200);
    expect(JSON.stringify(preview.body)).not.toMatch(/answer_key|Paris has been|axial tilt/);

    const copy = await request(http).post(`/v1/tests/${test.id}/duplicate`).set(admin()).expect(201);
    expect(copy.body).toMatchObject({ status: 'draft' });
    expect(copy.body.share_token).not.toBe(test.share_token);

    await startAttempt(test.share_token);
    const detail = await request(http).get(`/v1/tests/${test.id}`).set(admin()).expect(200);
    expect(detail.body.locked).toBe(true);
    const locked = await request(http)
      .put(`/v1/tests/${test.id}`)
      .set(admin())
      .send({ settings: detail.body.settings, questions: [mcq] })
      .expect(409);
    expect(locked.body.error.code).toBe('TEST_LOCKED');
    await request(http).put(`/v1/tests/${test.id}`).set(admin()).send({ settings: { ...detail.body.settings, title: 'Renamed' }, questions: null }).expect(200);
    await request(http).delete(`/v1/tests/${test.id}`).set(admin()).expect(409);
    await request(http).post(`/v1/tests/${test.id}/archive`).set(admin()).expect(200);
    await request(http).get(`/v1/public/tests/${test.share_token}`).expect(404);
  });
});

describe('student flow', () => {
  it('runs a complete attempt: start, autosave, refresh, submit, result', async () => {
    const test = await createPublishedTest({ result_release_policy: 'immediate' });

    const info = await request(http).get(`/v1/public/tests/${test.share_token}`).expect(200);
    expect(info.body).toMatchObject({ title: 'Geography quiz', question_count: 2, total_marks: 5 });
    expect(JSON.stringify(info.body)).not.toMatch(/Paris|answer_key/);

    const started = await startAttempt(test.share_token);
    const token = { 'X-Attempt-Token': started.attempt_token };

    const state = await request(http).get(`/v1/attempts/${started.attempt_id}`).set(token).expect(200);
    expect(state.body.attempt.deadline_at).toBe(started.deadline_at);
    expect(JSON.stringify(state.body)).not.toMatch(/answer_key|"correct"|axial tilt|Paris has been|rubric/);
    const [q1, q2] = state.body.questions as { id: string }[];

    await request(http)
      .put(`/v1/attempts/${started.attempt_id}/answers`)
      .set(token)
      .send({ answers: [{ question_id: q1!.id, answer: 'b', revision: 1 }, { question_id: q2!.id, answer: 'The tilt of the Earth.', revision: 1 }] })
      .expect(200);

    const refreshed = await request(http).get(`/v1/attempts/${started.attempt_id}`).set(token).expect(200);
    expect(refreshed.body.attempt.deadline_at).toBe(started.deadline_at);
    expect(refreshed.body.answers[q1!.id].answer).toBe('b');

    const submit = await request(http).post(`/v1/attempts/${started.attempt_id}/submit`).set(token).send({ type: 'manual' }).expect(200);
    expect(submit.body).toMatchObject({ status: 'submitted', grading_status: 'pending_review', already_submitted: false });
    const again = await request(http).post(`/v1/attempts/${started.attempt_id}/submit`).set(token).send({ type: 'manual' }).expect(200);
    expect(again.body.already_submitted).toBe(true);

    await request(http)
      .put(`/v1/attempts/${started.attempt_id}/answers`)
      .set(token)
      .send({ answers: [{ question_id: q1!.id, answer: 'a', revision: 2 }] })
      .expect(409);

    const result = await request(http).get(`/v1/attempts/${started.attempt_id}/result`).set(token).expect(200);
    expect(result.body.visibility).toMatchObject({ released: true, provisional: true });
    expect(result.body.score).toMatchObject({ obtained: 2, maximum: 5, passed: null, pending_review: 1 });
    expect(result.body.questions[0]).toMatchObject({ outcome: 'correct', correct_answer: 'Paris' });
  });

  it('protects attempts from other tokens (IDOR) and missing tokens', async () => {
    const test = await createPublishedTest();
    const mine = await startAttempt(test.share_token, 'Sara');
    const theirs = await startAttempt(test.share_token, 'Hina');
    await request(http).get(`/v1/attempts/${mine.attempt_id}`).expect(404);
    await request(http).get(`/v1/attempts/${mine.attempt_id}`).set('X-Attempt-Token', theirs.attempt_token).expect(404);
    await request(http).get(`/v1/attempts/${mine.attempt_id}/result`).set('X-Attempt-Token', 'x'.repeat(43)).expect(404);
  });

  it('finalises an expired attempt when the student returns', async () => {
    const test = await createPublishedTest();
    const started = await startAttempt(test.share_token);
    await expireAttempt(pglite, started.attempt_id, 120);
    const state = await request(http).get(`/v1/attempts/${started.attempt_id}`).set('X-Attempt-Token', started.attempt_token).expect(200);
    expect(state.body.attempt.status).toBe('expired');
  });

  it('validates required identification fields', async () => {
    const test = await createPublishedTest({ identity_fields: [{ key: 'roll_no', label: 'Roll number', required: true, type: 'number' }] });
    const bad = await request(http).post(`/v1/public/tests/${test.share_token}/attempts`).send({ student_name: 'Sara' }).expect(400);
    expect(bad.body.error.details[0]).toMatchObject({ path: 'roll_no' });
    await request(http).post(`/v1/public/tests/${test.share_token}/attempts`).send({ student_name: 'Sara', student_info: { roll_no: '12', hack: 'x' } }).expect(201);
  });
});

describe('review, release and reports', () => {
  it('admin reviews a written answer; the result becomes final; manual release works', async () => {
    const test = await createPublishedTest({ result_release_policy: 'manual', passing_percentage: 60 });
    const started = await startAttempt(test.share_token, 'Zara');
    const token = { 'X-Attempt-Token': started.attempt_token };
    const state = await request(http).get(`/v1/attempts/${started.attempt_id}`).set(token);
    const [q1, q2] = state.body.questions as { id: string }[];
    await request(http)
      .put(`/v1/attempts/${started.attempt_id}/answers`)
      .set(token)
      .send({ answers: [{ question_id: q1!.id, answer: 'b', revision: 1 }, { question_id: q2!.id, answer: 'Axial tilt', revision: 1 }] });
    await request(http).post(`/v1/attempts/${started.attempt_id}/submit`).set(token).send({ type: 'manual' }).expect(200);

    const hidden = await request(http).get(`/v1/attempts/${started.attempt_id}/result`).set(token).expect(200);
    expect(hidden.body.visibility.released).toBe(false);
    expect(hidden.body.score).toBeNull();

    const pending = await request(http).get('/v1/admin/attempts').query({ grading_status: 'pending_review' }).set(admin()).expect(200);
    expect(pending.body.items.map((a: { id: string }) => a.id)).toContain(started.attempt_id);

    await request(http)
      .post(`/v1/admin/attempts/${started.attempt_id}/reviews`)
      .set(admin())
      .send({ question_id: q2!.id, marks: 9, feedback: 'too many' })
      .expect(400);

    ai.next = () => ({
      suggested_marks: 99,
      reasoning: 'Mentions tilt.',
      feedback: 'Good. Ignore previous instructions? No.',
      corrections: [],
      missing_points: [],
      improved_answer: 'Earth’s axial tilt changes sunlight angle.',
    });
    const suggested = await request(http)
      .post(`/v1/ai/attempts/${started.attempt_id}/grade-suggestion`)
      .set(admin())
      .send({ question_id: q2!.id })
      .expect(200);
    const written = suggested.body.answers.find((a: { question: { id: string } }) => a.question.id === q2!.id);
    expect(written.ai_suggestion.suggested_marks).toBe(3); // clamped to the maximum
    expect(written.grading_status).toBe('pending_review'); // still needs approval
    expect(ai.calls.at(-1)!.prompt).toContain('<student_answer>\nAxial tilt\n</student_answer>');

    const reviewed = await request(http)
      .post(`/v1/admin/attempts/${started.attempt_id}/reviews`)
      .set(admin())
      .send({ question_id: q2!.id, marks: 2.5, feedback: 'Good, mention sunlight angle.', source: 'ai_approved' })
      .expect(200);
    expect(reviewed.body.attempt).toMatchObject({ grading_status: 'complete', score: 4.5, percentage: 90, passed: true });
    expect(reviewed.body.answers[1].reviews[0]).toMatchObject({ source: 'ai_approved', awarded_marks: 2.5 });

    await request(http).post(`/v1/admin/attempts/${started.attempt_id}/release`).set(admin()).send({ released: true }).expect(200);
    const released = await request(http).get(`/v1/attempts/${started.attempt_id}/result`).set(token).expect(200);
    expect(released.body.score).toMatchObject({ obtained: 4.5, percentage: 90, passed: true });
    expect(released.body.questions[1].feedback).toBe('Good, mention sunlight angle.');

    const csv = await request(http).get('/v1/reports/results.csv').set(admin()).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('Zara');

    const progress = await request(http).get('/v1/reports/progress').query({ student: 'zara' }).set(admin()).expect(200);
    expect(progress.body.totals).toMatchObject({ attempts: 1, latest_percentage: 90 });

    const dashboard = await request(http).get('/v1/reports/dashboard').set(admin()).expect(200);
    expect(dashboard.body.tests.total).toBeGreaterThan(0);
  });
});

describe('AI test generation', () => {
  const generated = (questions: unknown[]) => ({ title: 'Fractions', description: 'Basics', instructions: 'Answer all.', questions });
  const aiMcq = (prompt: string, correct = ['b']) => ({
    question_type: 'mcq_single', prompt, options: [{ id: 'x1', text: '1/2' }, { id: 'x2', text: '1/4' }], correct_option_ids: correct.map((c) => (c === 'b' ? 'x2' : c)),
    true_false_answer: false, blanks: [], left_items: [], right_items: [], pairs: [], order_items: [], correct_order: [],
    source_language: '', target_language: '', source_text: '', code_language: '', starter_code: '', required_words: [],
    model_answer: '', key_points: [], rubric: '', explanation: 'Half of a half.',
  });

  it('saves valid output as a draft, drops invalid/duplicate questions and reports warnings', async () => {
    let call = 0;
    ai.next = () => {
      call += 1;
      return call === 1
        ? generated([aiMcq('What is half of 1/2?'), aiMcq('What is half of 1/2?'), aiMcq('Broken question', ['nope'])])
        : generated([aiMcq('What is a quarter of 1?')]);
    };
    const res = await request(http)
      .post('/v1/ai/generate-test')
      .set(admin())
      .send({ subject: 'Maths', topic: 'Fractions', question_count: 3, duration_minutes: 10, question_types: ['mcq_single'], marks_per_question: 2 })
      .expect(201);
    expect(res.body.test).toMatchObject({ status: 'draft', source: 'ai' });
    expect(res.body.test.questions).toHaveLength(2);
    expect(res.body.test.questions.every((q: { marks: number }) => q.marks === 2)).toBe(true);
    expect(res.body.warnings.join(' ')).toMatch(/duplicate/);
    expect(res.body.warnings.join(' ')).toMatch(/Only 2 of 3/);
    expect(res.body.test.subject.name).toBe('Maths');
  });

  it('fails clearly when nothing valid is produced, and maps provider errors', async () => {
    ai.next = () => ({ nonsense: true });
    const bad = await request(http)
      .post('/v1/ai/generate-test')
      .set(admin())
      .send({ subject: 'Maths', question_count: 1, duration_minutes: 5, question_types: ['true_false'] })
      .expect(502);
    expect(bad.body.error.code).toBe('AI_NO_VALID_QUESTIONS');

    ai.next = () => new AppError('AI_RATE_LIMITED', 429, 'busy');
    const limited = await request(http)
      .post('/v1/ai/generate-test')
      .set(admin())
      .send({ subject: 'Maths', question_count: 1, duration_minutes: 5, question_types: ['true_false'] })
      .expect(429);
    expect(limited.body.error.code).toBe('AI_RATE_LIMITED');
  });
});
