import { Injectable } from '@nestjs/common';
import { assertAttemptInScope, type Scope } from '../auth/scope.js';
import { notFound } from '../common/errors.js';
import type { AdminAttemptDetail, AttemptSummaryRow, Paginated } from '../contracts/responses.js';
import type { ResultsQuery } from '../contracts/test-schemas.js';
import { Database } from '../database/database.js';
import type { ReleasePolicy } from '../contracts/constants.js';
import type { AttemptRow } from '../database/types.js';
import { AttemptsService } from '../attempts/attempts.service.js';
import { describeCorrectAnswer, formatAnswer, outcomeFor, timeTakenSeconds } from '../attempts/views.js';
import { round2 } from '../grading/grade.js';

export type AttemptListRow = AttemptRow & {
  test_title: string;
  subject_name: string;
  topic_name: string | null;
  awarded_sum: number | null;
  total_count?: number;
};

export function toSummaryRow(r: AttemptListRow): AttemptSummaryRow {
  return {
    id: r.id,
    test: { id: r.test_id, title: r.test_title, subject: r.subject_name, topic: r.topic_name },
    student_name: r.student_name,
    student_info: r.student_info,
    attempt_number: r.attempt_number,
    status: r.status,
    grading_status: r.grading_status,
    started_at: r.started_at,
    submitted_at: r.submitted_at,
    time_taken_seconds: timeTakenSeconds(r),
    score: r.final_score,
    provisional_score: r.status === 'in_progress' ? null : round2(Math.max(0, Number(r.awarded_sum ?? 0))),
    maximum_marks: r.maximum_marks,
    percentage: r.percentage,
    passed: r.passed,
    pending_review_count: r.pending_review_count ?? 0,
    results_released: r.results_released_at !== null,
  };
}

export const ATTEMPT_LIST_SELECT = `
  select a.*, t.title as test_title, s.name as subject_name, tp.name as topic_name,
         (select sum(sa.awarded_marks) from public.student_answers sa where sa.attempt_id = a.id) as awarded_sum
  from public.test_attempts a
  join public.tests t on t.id = a.test_id
  join public.subjects s on s.id = t.subject_id
  left join public.topics tp on tp.id = t.topic_id`;

@Injectable()
export class ReviewsService {
  constructor(
    private readonly db: Database,
    private readonly attempts: AttemptsService,
  ) {}

  assertAccess(attemptId: string, scope: Scope): Promise<void> {
    return assertAttemptInScope(this.db, scope, attemptId);
  }

  async list(q: ResultsQuery, scope: Scope): Promise<Paginated<AttemptSummaryRow>> {
    // Make sure abandoned attempts show up as finished.
    await this.attempts.finalizeExpired(50).catch(() => undefined);

    const where: string[] = [];
    const values: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      values.push(value);
      where.push(clause.replace('?', `$${values.length}`));
    };
    if (!scope.isAdmin) add('t.created_by = ?', scope.userId);
    if (q.test_id) add('a.test_id = ?', q.test_id);
    if (q.subject_id) add('t.subject_id = ?', q.subject_id);
    if (q.student) add('a.student_key = lower(regexp_replace(btrim(?), \'\\s+\', \' \', \'g\'))', q.student);
    if (q.grading_status) add('a.grading_status = ?', q.grading_status);
    values.push(q.page_size, (q.page - 1) * q.page_size);

    const rows = await this.db.query<AttemptListRow>(
      `select x.*, count(*) over () as total_count from (${ATTEMPT_LIST_SELECT}
         ${where.length ? 'where ' + where.join(' and ') : ''}) x
       order by coalesce(x.submitted_at, x.started_at) desc
       limit $${values.length - 1} offset $${values.length}`,
      values,
    );
    return {
      items: rows.map(toSummaryRow),
      total: rows.length ? Number(rows[0]!.total_count) : 0,
      page: q.page,
      page_size: q.page_size,
    };
  }

  async get(attemptId: string): Promise<AdminAttemptDetail> {
    const bundle = await this.attempts.store.getBundleInternal(attemptId);
    if (!bundle) throw notFound('Attempt');
    const listRow = await this.db.one<AttemptListRow>(`${ATTEMPT_LIST_SELECT} where a.id = $1`, [attemptId]);
    const reviews = await this.db.query<{
      question_id: string;
      awarded_marks: number;
      feedback: string | null;
      source: string;
      reviewer: string | null;
      created_at: string;
    }>(
      `select sa.question_id, r.awarded_marks, r.feedback, r.source, p.display_name as reviewer, r.created_at
       from public.answer_reviews r
       join public.student_answers sa on sa.id = r.answer_id
       left join public.profiles p on p.id = r.reviewer_id
       where sa.attempt_id = $1 order by r.created_at desc`,
      [attemptId],
    );

    const answers = new Map(bundle.answers.map((a) => [a.question_id, a]));
    return {
      attempt: {
        ...toSummaryRow(listRow!),
        deadline_at: bundle.attempt.deadline_at,
        submission_type: bundle.attempt.submission_type,
      },
      test: {
        id: bundle.test.id,
        title: bundle.test.title,
        result_release_policy: bundle.test.result_release_policy as ReleasePolicy,
        written_review_required: bundle.test.written_review_required,
      },
      answers: bundle.questions.map((q) => {
        const a = answers.get(q.id);
        return {
          question: {
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
          },
          answer: a?.answer ?? null,
          answer_text: formatAnswer(q, a?.answer),
          correct_answer: describeCorrectAnswer(q),
          awarded_marks: a?.awarded_marks ?? null,
          outcome: outcomeFor(q, a, bundle.test),
          grading_status: a?.grading_status ?? 'ungraded',
          feedback: a?.feedback ?? null,
          // Ignore failure markers left by the auto-grader.
          ai_suggestion: a?.ai_suggestion && typeof a.ai_suggestion.suggested_marks === 'number' ? a.ai_suggestion : null,
          reviews: reviews
            .filter((r) => r.question_id === q.id)
            .map(({ question_id: _q, ...r }) => r),
        };
      }),
    };
  }

  async review(
    attemptId: string,
    input: { question_id: string; marks: number; feedback: string | null; source: 'manual' | 'ai_approved' },
    actorId: string,
  ): Promise<AdminAttemptDetail> {
    await this.attempts.store.reviewAnswer(actorId, attemptId, input.question_id, input.marks, input.feedback, input.source);
    await this.attempts.regrade(attemptId);
    return this.get(attemptId);
  }

  async release(attemptId: string, released: boolean, actorId: string): Promise<AdminAttemptDetail> {
    await this.attempts.store.setResultsReleased(actorId, attemptId, released);
    return this.get(attemptId);
  }

  async regrade(attemptId: string): Promise<AdminAttemptDetail> {
    await this.attempts.regrade(attemptId);
    return this.get(attemptId);
  }

  async remove(attemptId: string): Promise<void> {
    const rows = await this.db.query('delete from public.test_attempts where id = $1 returning id', [attemptId]);
    if (rows.length === 0) throw notFound('Attempt');
  }
}
