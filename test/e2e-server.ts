/**
 * Test-only API server for the frontend's Playwright suite: the real Nest app
 * on an in-memory Postgres (PGlite) with seeded data, a fake token verifier
 * and a fake AI provider. Never use in production.
 *
 *   npm run start:e2e      → http://localhost:4100
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AuthAdmin } from '../src/accounts/auth-admin.js';
import { AiProvider, type AiJsonRequest, type AiJsonResult } from '../src/ai/ai-provider.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { TokenVerifier } from '../src/auth/token-verifier.js';
import { Database } from '../src/database/database.js';
import { PgliteAuthAdmin, PgliteDatabase, createTestDb, createUser } from './helpers/db.js';

export const E2E_ADMIN_TOKEN = 'e2e-admin-token-0123456789abcdef';
export const E2E_STUDENT_TOKEN = 'e2e-student-token-0123456789abcd';
export const E2E_TEACHER_TOKEN = 'e2e-teacher-token-0123456789abcd';
export const E2E_CLASS_CODE = 'GRADE8SC';

async function main() {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: process.env.E2E_API_PORT ?? '4100',
    DATABASE_URL: 'postgresql://unused@localhost/unused',
    SUPABASE_URL: 'https://e2e.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_e2e_000000000000',
    CORS_ORIGINS: process.env.E2E_WEB_ORIGIN ?? 'http://localhost:3100',
    EXPIRY_WORKER_ENABLED: 'true',
    EXPIRY_WORKER_INTERVAL_SECONDS: '5',
    DISABLE_RATE_LIMIT: 'true',
    GEMINI_API_KEY: 'e2e-fake-key',
    SUPABASE_SECRET_KEY: 'sb_secret_e2e_0000000000000000',
    SETUP_CODE: 'e2e-setup-code-0000',
  });

  const pglite = await createTestDb();
  const adminId = await createUser(pglite, 'admin@e2e.test', true);
  const studentId = await createUser(pglite, 'student@e2e.test');
  await pglite.query(`update public.profiles set display_name = 'Sana Student' where id = $1`, [studentId]);
  const teacherId = await createUser(pglite, 'teacher@e2e.test');
  await pglite.query(`update public.profiles set display_name = 'Mr Rahim' where id = $1`, [teacherId]);
  await pglite.query(`select public.request_admin_access($1)`, [teacherId]);
  const tutorId = await createUser(pglite, 'tutor@e2e.test');
  await pglite.query(`update public.profiles set display_name = 'Tara Teacher', role = 'teacher' where id = $1`, [tutorId]);
  await seed(pglite, adminId);
  await seedClass(pglite, tutorId);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger: ['error', 'warn'] });
  // Replace infrastructure with test doubles.
  const db = new PgliteDatabase(pglite);
  Object.assign(app.get(Database), { query: db.query.bind(db), transaction: db.transaction.bind(db), rpc: db.rpc, one: db.one.bind(db) });
  Object.assign(app.get(TokenVerifier), {
    verify: async (token: string) =>
      token === E2E_ADMIN_TOKEN
        ? { userId: adminId, email: 'admin@e2e.test' }
        : token === E2E_STUDENT_TOKEN
          ? { userId: studentId, email: 'student@e2e.test' }
          : token === E2E_TEACHER_TOKEN
            ? { userId: tutorId, email: 'tutor@e2e.test' }
            : null,
  });
  const authAdmin = new PgliteAuthAdmin(pglite);
  Object.defineProperty(app.get(AuthAdmin), 'configured', { value: true });
  Object.assign(app.get(AuthAdmin), { createUser: authAdmin.createUser.bind(authAdmin), deleteUser: authAdmin.deleteUser.bind(authAdmin) });
  Object.assign(app.get(AiProvider), {
    configured: true,
    model: 'fake',
    generateJson: async (req: AiJsonRequest): Promise<AiJsonResult> => ({ json: fakeAi(req), model: 'fake', inputTokens: 1, outputTokens: 1 }),
  });

  configureApp(app);
  await app.listen(Number(process.env.PORT), '127.0.0.1');
  console.log(`E2E API ready on http://localhost:${process.env.PORT}`);
}

function fakeAi(req: AiJsonRequest): unknown {
  if (req.task === 'grade-answer') {
    return { suggested_marks: 2, reasoning: 'Mentions the key idea.', feedback: 'Good answer.', corrections: [], missing_points: [], improved_answer: 'A pronoun replaces a noun.' };
  }
  const blank = { options: [], correct_option_ids: [], true_false_answer: false, blanks: [], left_items: [], right_items: [], pairs: [], order_items: [], correct_order: [], source_language: '', target_language: '', source_text: '', code_language: '', starter_code: '', required_words: [], model_answer: '', key_points: [], rubric: '', explanation: '' };
  return {
    title: 'AI Pronouns test',
    description: 'Generated in E2E',
    instructions: 'Answer every question.',
    questions: [
      { ...blank, question_type: 'mcq_single', prompt: 'Which word is a pronoun?', options: [{ id: 'a', text: 'run' }, { id: 'b', text: 'she' }], correct_option_ids: ['b'] },
      { ...blank, question_type: 'true_false', prompt: '"They" is a pronoun.', true_false_answer: true },
    ],
  };
}

async function seed(db: Awaited<ReturnType<typeof createTestDb>>, adminId: string) {
  const subject = await db.query<{ id: string }>(`insert into public.subjects (name, slug, created_by) values ('English', 'english', $1) returning id`, [adminId]);
  const topic = await db.query<{ id: string }>(`insert into public.topics (subject_id, name) values ($1, 'Pronouns') returning id`, [subject.rows[0]!.id]);

  const general = [
    { t: 'mcq_single', p: 'What is a noun?', c: { options: [{ id: 'a', text: 'An action word' }, { id: 'b', text: 'The name of a person, place, animal or thing' }, { id: 'c', text: 'A describing word' }] }, k: { correct: 'b' }, m: 2 },
    { t: 'true_false', p: 'A pronoun can replace a noun.', c: {}, k: { correct: true }, m: 1 },
    { t: 'fill_blank', p: 'She ___ happy.', c: { blanks: 1 }, k: { blanks: [{ accepted: ['is'] }], case_sensitive: false }, m: 1 },
    { t: 'matching', p: 'Match each subject pronoun with its object pronoun.', c: { left: [{ id: 'l1', text: 'I' }, { id: 'l2', text: 'he' }], right: [{ id: 'r1', text: 'me' }, { id: 'r2', text: 'him' }] }, k: { pairs: { l1: 'r1', l2: 'r2' } }, m: 2 },
    { t: 'ordering', p: 'Put the words in order to make a sentence.', c: { items: [{ id: 'i1', text: 'I' }, { id: 'i2', text: 'am' }, { id: 'i3', text: 'learning' }] }, k: { order: ['i1', 'i2', 'i3'] }, m: 1 },
    { t: 'translation', p: 'Translate into English.', c: { source_language: 'ur', target_language: 'en', source_text: 'میں انگریزی سیکھ رہی ہوں۔' }, k: { model_answer: 'I am learning English.', key_points: [] }, m: 3, g: 'ai_assisted' },
  ];
  await insertTest(db, adminId, subject.rows[0]!.id, topic.rows[0]!.id, 'E2E General Test', 'e2e_general_test_token_01', 30, general);
  await insertTest(db, adminId, subject.rows[0]!.id, topic.rows[0]!.id, 'E2E Quick Test', 'e2e_quick_test_token_00001', 1, general.slice(0, 2));
  const members = await insertTest(db, adminId, subject.rows[0]!.id, topic.rows[0]!.id, 'E2E Members Test', 'e2e_account_test_token_01', 10, general.slice(0, 2));
  await db.query(`update public.tests set require_student_account = true where id = $1`, [members]);
}

/** A teacher with a class (join code GRADE8SC) and one test assigned to it. */
async function seedClass(db: Awaited<ReturnType<typeof createTestDb>>, tutorId: string) {
  const subject = await db.query<{ id: string }>(`insert into public.subjects (name, slug, created_by) values ('Science', 'science', $1) returning id`, [tutorId]);
  const testId = await insertTest(db, tutorId, subject.rows[0]!.id, null, 'E2E Class Test', 'e2e_class_test_token_0001', 15, [
    { t: 'true_false', p: 'Water boils at 100 °C at sea level.', c: {}, k: { correct: true }, m: 1 },
  ]);
  const cls = await db.query<{ id: string }>(
    `insert into public.classes (teacher_id, name, join_code) values ($1, 'Grade 8 Science', $2) returning id`,
    [tutorId, E2E_CLASS_CODE],
  );
  await db.query(`insert into public.test_assignments (test_id, class_id, due_at) values ($1, $2, now() + interval '7 days')`, [testId, cls.rows[0]!.id]);
}

async function insertTest(
  db: Awaited<ReturnType<typeof createTestDb>>,
  adminId: string,
  subjectId: string,
  topicId: string | null,
  title: string,
  shareToken: string,
  minutes: number,
  questions: { t: string; p: string; c: object; k: object; m: number; g?: string }[],
) {
  const t = await db.query<{ id: string }>(
    `insert into public.tests (title, subject_id, topic_id, duration_minutes, share_token, created_by, instructions, show_explanations)
     values ($1, $2, $3, $4, $5, $6, 'Read each question carefully.', true) returning id`,
    [title, subjectId, topicId, minutes, shareToken, adminId],
  );
  for (const [i, q] of questions.entries()) {
    await db.query(
      `insert into public.questions (test_id, position, question_type, prompt, content, answer_key, grading_method, marks, explanation)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, 'Explained.')`,
      [t.rows[0]!.id, i + 1, q.t, q.p, JSON.stringify(q.c), JSON.stringify(q.k), q.g ?? 'auto', q.m],
    );
  }
  await db.query(`update public.tests set status = 'published' where id = $1`, [t.rows[0]!.id]);
  return t.rows[0]!.id;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
