import { createTestDb } from '../helpers/db.js';

describe('migrations', () => {
  it('apply cleanly and enable RLS on every table', async () => {
    const db = await createTestDb();
    const res = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' order by 1`,
    );
    expect(res.rows.map((r) => r.relname)).toEqual([
      'ai_generations', 'answer_reviews', 'categories', 'class_members', 'classes', 'profiles', 'questions',
      'student_answers', 'subjects', 'tags', 'test_assignments', 'test_attempts', 'test_tags', 'tests', 'topics',
    ]);
    expect(res.rows.every((r) => r.relrowsecurity)).toBe(true);
  });
});
