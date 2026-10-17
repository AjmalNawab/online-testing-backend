import { Injectable } from '@nestjs/common';
import { AppError, notFound } from '../common/errors.js';
import type {
  AdminQuestion,
  AdminTestDetail,
  Paginated,
  PublicTestInfo,
  StudentQuestion,
  TestSummary,
} from '../contracts/responses.js';
import type { ListTestsQuery, SaveTestRequest, TestSettings } from '../contracts/test-schemas.js';
import { Database } from '../database/database.js';
import type { QuestionRow, TestRow } from '../database/types.js';
import { generateShareToken } from '../attempts/token.js';
import { toPublicTestInfo, toStudentQuestion } from '../attempts/views.js';
import { round2 } from '../grading/grade.js';
import { publishCheck } from './publish-check.js';

type TestDetailRow = TestRow & {
  subject_name: string;
  topic_name: string | null;
  category_name: string | null;
  tags: string[];
  attempt_count: number;
};

const toAdminQuestion = (q: QuestionRow): AdminQuestion => ({
  id: q.id,
  position: q.position,
  question_type: q.question_type,
  prompt: q.prompt,
  content: q.content,
  answer_key: q.answer_key,
  grading_method: q.grading_method,
  rubric: q.rubric,
  explanation: q.explanation,
  marks: q.marks,
  negative_marks: q.negative_marks,
  partial_credit: q.partial_credit,
});

export function toSettings(t: TestRow, tags: string[]): TestSettings {
  return {
    title: t.title,
    description: t.description,
    subject_id: t.subject_id,
    topic_id: t.topic_id,
    category_id: t.category_id,
    tags,
    language: t.language,
    difficulty: t.difficulty,
    instructions: t.instructions,
    learning_objectives: t.learning_objectives,
    duration_minutes: t.duration_minutes,
    passing_percentage: t.passing_percentage,
    intended_total_marks: t.intended_total_marks,
    max_attempts: t.max_attempts,
    shuffle_questions: t.shuffle_questions,
    shuffle_options: t.shuffle_options,
    negative_marking: t.negative_marking,
    partial_credit: t.partial_credit,
    written_review_required: t.written_review_required,
    result_release_policy: t.result_release_policy,
    show_correct_answers: t.show_correct_answers,
    show_explanations: t.show_explanations,
    identity_fields: t.identity_fields,
  };
}

const DETAIL_SELECT = `
  select t.*, s.name as subject_name, tp.name as topic_name, c.name as category_name,
         coalesce((select array_agg(tg.name order by lower(tg.name)) from public.test_tags tt
                   join public.tags tg on tg.id = tt.tag_id where tt.test_id = t.id), '{}') as tags,
         (select count(*) from public.test_attempts a where a.test_id = t.id) as attempt_count
  from public.tests t
  join public.subjects s on s.id = t.subject_id
  left join public.topics tp on tp.id = t.topic_id
  left join public.categories c on c.id = t.category_id`;

@Injectable()
export class TestsService {
  constructor(private readonly db: Database) {}

  async list(q: ListTestsQuery): Promise<Paginated<TestSummary>> {
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      values.push(value);
      where.push(clause.replace('?', `$${values.length}`));
    };
    if (q.search) add(`(t.title ilike ? escape '\\')`, `%${q.search.replace(/[%_\\]/g, '\\$&')}%`);
    if (q.status) add('t.status = ?', q.status);
    else where.push(`t.status <> 'archived'`);
    if (q.subject_id) add('t.subject_id = ?', q.subject_id);
    if (q.topic_id) add('t.topic_id = ?', q.topic_id);
    if (q.category_id) add('t.category_id = ?', q.category_id);
    if (q.difficulty) add('lower(t.difficulty) = lower(?)', q.difficulty);
    if (q.tag)
      add(
        `exists (select 1 from public.test_tags tt join public.tags tg on tg.id = tt.tag_id
                 where tt.test_id = t.id and lower(tg.name) = lower(?))`,
        q.tag,
      );

    values.push(q.page_size, (q.page - 1) * q.page_size);
    const rows = await this.db.query<
      TestDetailRow & { question_count: number; total_marks: number; total_count: number }
    >(
      `with base as (${DETAIL_SELECT} ${where.length ? 'where ' + where.join(' and ') : ''})
         select b.*,
                (select count(*) from public.questions qq where qq.test_id = b.id) as question_count,
                (select coalesce(sum(qq.marks), 0) from public.questions qq where qq.test_id = b.id) as total_marks,
                count(*) over () as total_count
         from base b
         order by b.updated_at desc
         limit $${values.length - 1} offset $${values.length}`,
      values,
    );

    return {
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        subject: { id: r.subject_id, name: r.subject_name },
        topic: r.topic_id ? { id: r.topic_id, name: r.topic_name ?? '' } : null,
        category: r.category_id ? { id: r.category_id, name: r.category_name ?? '' } : null,
        tags: r.tags,
        difficulty: r.difficulty,
        language: r.language,
        duration_minutes: r.duration_minutes,
        question_count: Number(r.question_count),
        total_marks: round2(Number(r.total_marks)),
        attempt_count: Number(r.attempt_count),
        source: r.source,
        share_token: r.share_token,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
      total: rows.length ? Number(rows[0]!.total_count) : 0,
      page: q.page,
      page_size: q.page_size,
    };
  }

  private async loadRow(id: string): Promise<TestDetailRow> {
    const row = await this.db.one<TestDetailRow>(`${DETAIL_SELECT} where t.id = $1`, [id]);
    if (!row) throw notFound('Test');
    return row;
  }

  private loadQuestions(testId: string): Promise<QuestionRow[]> {
    return this.db.query<QuestionRow>('select * from public.questions where test_id = $1 order by position', [testId]);
  }

  async get(id: string): Promise<AdminTestDetail> {
    const row = await this.loadRow(id);
    const questions = await this.loadQuestions(id);
    const adminQuestions = questions.map(toAdminQuestion);
    return {
      id: row.id,
      status: row.status,
      share_token: row.share_token,
      source: row.source,
      settings: toSettings(row, row.tags),
      subject: { id: row.subject_id, name: row.subject_name },
      topic: row.topic_id ? { id: row.topic_id, name: row.topic_name ?? '' } : null,
      category: row.category_id ? { id: row.category_id, name: row.category_name ?? '' } : null,
      questions: adminQuestions,
      attempt_count: Number(row.attempt_count),
      locked: Number(row.attempt_count) > 0,
      check: publishCheck(row, adminQuestions),
      published_at: row.published_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private async save(
    actorId: string,
    id: string | null,
    input: SaveTestRequest,
    extra: { share_token?: string; source?: 'manual' | 'ai' } = {},
  ): Promise<string> {
    const { tags, ...settings } = input.settings;
    const testPayload = { ...settings, id, ...extra };
    const questions = input.questions?.map((q, i) => ({ ...q, position: i + 1 })) ?? null;
    // One call = one transaction: settings, tags and questions are saved together.
    const row = await this.db.one<{ id: string }>(
      'select public.admin_save_test($1, $2::jsonb, $3::jsonb, $4::text[]) as id',
      [actorId, JSON.stringify(testPayload), questions ? JSON.stringify(questions) : null, tags],
    );
    return row!.id;
  }

  async create(input: SaveTestRequest, actorId: string, source: 'manual' | 'ai' = 'manual'): Promise<AdminTestDetail> {
    const id = await this.save(actorId, null, input, { share_token: generateShareToken(), source });
    return this.get(id);
  }

  async update(id: string, input: SaveTestRequest, actorId: string): Promise<AdminTestDetail> {
    await this.loadRow(id);
    await this.save(actorId, id, input);
    const detail = await this.get(id);
    if (detail.status === 'published' && detail.check.errors.length > 0) {
      // Saved, but a published test must stay valid: move it back to draft.
      await this.db.rpc('admin_set_test_status', { p_actor: actorId, p_test_id: id, p_status: 'draft' });
      return this.get(id);
    }
    return detail;
  }

  async setStatus(id: string, status: 'draft' | 'published' | 'archived', actorId: string): Promise<AdminTestDetail> {
    if (status === 'published') {
      const detail = await this.get(id);
      if (detail.check.errors.length > 0) {
        throw new AppError('NOT_PUBLISHABLE', 422, 'Fix these problems before publishing.', detail.check.errors);
      }
    }
    await this.db.rpc('admin_set_test_status', { p_actor: actorId, p_test_id: id, p_status: status });
    return this.get(id);
  }

  async duplicate(id: string, actorId: string): Promise<AdminTestDetail> {
    const source = await this.get(id);
    const copy: SaveTestRequest = {
      settings: { ...source.settings, title: `${source.settings.title} (copy)`.slice(0, 200) },
      questions: source.questions.map(({ id: _id, position: _p, ...q }) => q),
    };
    return this.create(copy, actorId, source.source);
  }

  async remove(id: string): Promise<void> {
    const row = await this.loadRow(id);
    if (Number(row.attempt_count) > 0) {
      throw new AppError('IN_USE', 409, 'This test has attempts. Archive it instead so results are kept.');
    }
    await this.db.query('delete from public.tests where id = $1', [id]);
  }

  /** The test exactly as a student would see it (no answer keys). */
  async preview(id: string): Promise<{ info: PublicTestInfo; questions: StudentQuestion[] }> {
    const row = await this.loadRow(id);
    const questions = await this.loadQuestions(id);
    return {
      info: toPublicTestInfo(row, questions, { subject: row.subject_name, topic: row.topic_name }),
      questions: questions.map((q, i) => toStudentQuestion(q, i, 'preview', row)),
    };
  }
}
