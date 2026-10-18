import { Injectable } from '@nestjs/common';
import type { Scope } from '../auth/scope.js';
import type { DashboardStats, ProgressReport } from '../contracts/responses.js';
import type { ResultsQuery } from '../contracts/test-schemas.js';
import { Database } from '../database/database.js';
import { AttemptsService } from '../attempts/attempts.service.js';
import { ATTEMPT_LIST_SELECT, ReviewsService, toSummaryRow, type AttemptListRow } from '../reviews/reviews.service.js';
import { round2 } from '../grading/grade.js';
import { toCsv } from './csv.js';
import { buildProgress, type ProgressAnswer, type ProgressAttempt } from './progress.js';

@Injectable()
export class ReportsService {
  constructor(
    private readonly db: Database,
    private readonly attempts: AttemptsService,
    private readonly reviews: ReviewsService,
  ) {}

  async dashboard(scope: Scope): Promise<DashboardStats> {
    await this.attempts.finalizeExpired(50).catch(() => undefined);
    // Teachers see figures for their own tests only.
    const own = scope.isAdmin ? 'true' : 't.created_by = $1';
    const args = scope.isAdmin ? [] : [scope.userId];
    const [tests, attempts, recent, bySubject] = await Promise.all([
      this.db.one<{ total: number; draft: number; published: number; archived: number }>(
        `select count(*) as total,
                count(*) filter (where status = 'draft') as draft,
                count(*) filter (where status = 'published') as published,
                count(*) filter (where status = 'archived') as archived
         from public.tests t where ${own}`,
        args,
      ),
      this.db.one<{ total: number; in_progress: number; completed: number; pending_review: number; avg: number | null }>(
        `select count(*) as total,
                count(*) filter (where a.status = 'in_progress') as in_progress,
                count(*) filter (where a.status <> 'in_progress') as completed,
                count(*) filter (where a.grading_status = 'pending_review') as pending_review,
                avg(a.percentage) filter (where a.grading_status = 'complete') as avg
         from public.test_attempts a join public.tests t on t.id = a.test_id where ${own}`,
        args,
      ),
      this.db.query<AttemptListRow>(`${ATTEMPT_LIST_SELECT} where ${own} order by coalesce(a.submitted_at, a.started_at) desc limit 8`, args),
      this.db.query<{ subject: string; attempts: number; avg: number | null }>(
        `select s.name as subject, count(a.id) as attempts,
                avg(a.percentage) filter (where a.grading_status = 'complete') as avg
         from public.subjects s
         join public.tests t on t.subject_id = s.id
         join public.test_attempts a on a.test_id = t.id
         where ${own}
         group by s.name order by count(a.id) desc limit 10`,
        args,
      ),
    ]);
    return {
      tests: {
        total: Number(tests!.total),
        draft: Number(tests!.draft),
        published: Number(tests!.published),
        archived: Number(tests!.archived),
      },
      attempts: {
        total: Number(attempts!.total),
        in_progress: Number(attempts!.in_progress),
        completed: Number(attempts!.completed),
        pending_review: Number(attempts!.pending_review),
      },
      average_percentage: attempts!.avg === null ? null : round2(Number(attempts!.avg)),
      recent_attempts: recent.map(toSummaryRow),
      by_subject: bySubject.map((s) => ({
        subject: s.subject,
        attempts: Number(s.attempts),
        average_percentage: s.avg === null ? null : round2(Number(s.avg)),
      })),
    };
  }

  async resultsCsv(q: ResultsQuery, scope: Scope): Promise<string> {
    const page = await this.reviews.list({ ...q, page: 1, page_size: 200 }, scope);
    const all = [...page.items];
    for (let p = 2; all.length < page.total && p <= 50; p++) {
      all.push(...(await this.reviews.list({ ...q, page: p, page_size: 200 }, scope)).items);
    }
    return toCsv(
      ['Student', 'Test', 'Subject', 'Topic', 'Attempt', 'Status', 'Grading', 'Submitted at', 'Time taken (min)',
        'Score', 'Provisional score', 'Max marks', 'Percentage', 'Passed'],
      all.map((r) => [
        r.student_name,
        r.test.title,
        r.test.subject,
        r.test.topic,
        r.attempt_number,
        r.status,
        r.grading_status,
        r.submitted_at,
        r.time_taken_seconds === null ? null : round2(r.time_taken_seconds / 60),
        r.score,
        r.provisional_score,
        r.maximum_marks,
        r.percentage,
        r.passed === null ? '' : r.passed ? 'yes' : 'no',
      ]),
    );
  }

  /**
   * Progress across completed attempts. Admins filter by student name; `account`
   * restricts the report to one signed-in student's own attempts.
   */
  async progress(
    student: string | undefined,
    subjectId: string | undefined,
    account?: { id: string; displayName: string },
    scope?: Scope,
  ): Promise<ProgressReport> {
    const teacherId = scope && !scope.isAdmin ? scope.userId : null;
    const students = account
      ? []
      : (
          await this.db.query<{ name: string }>(
            `select distinct on (a.student_key) a.student_name as name from public.test_attempts a
             join public.tests t on t.id = a.test_id
             where ($1::uuid is null or t.created_by = $1)
             order by a.student_key, a.created_at desc`,
            [teacherId],
          )
        )
          .map((r) => r.name)
          .sort((a, b) => a.localeCompare(b));
    const selected = account ? account.displayName : (student ?? (students.length === 1 ? students[0]! : null));

    const values: unknown[] = [];
    const filters: string[] = [`a.grading_status = 'complete'`];
    if (account) {
      values.push(account.id);
      filters.push(`a.student_id = $${values.length}`);
    } else if (selected) {
      values.push(selected);
      filters.push(`a.student_key = lower(regexp_replace(btrim($${values.length}), '\\s+', ' ', 'g'))`);
    }
    if (subjectId) {
      values.push(subjectId);
      filters.push(`t.subject_id = $${values.length}`);
    }
    if (teacherId) {
      values.push(teacherId);
      filters.push(`t.created_by = $${values.length}`);
    }
    const where = filters.join(' and ');

    const [attempts, answers] = await Promise.all([
      this.db.query<ProgressAttempt>(
        `select a.id, a.submitted_at, t.title as test_title, s.name as subject, tp.name as topic, a.percentage
         from public.test_attempts a
         join public.tests t on t.id = a.test_id
         join public.subjects s on s.id = t.subject_id
         left join public.topics tp on tp.id = t.topic_id
         where ${where} order by a.submitted_at`,
        values,
      ),
      this.db.query<ProgressAnswer>(
        `select q.question_type, coalesce(sa.awarded_marks, 0) as awarded, q.marks
         from public.student_answers sa
         join public.questions q on q.id = sa.question_id
         join public.test_attempts a on a.id = sa.attempt_id
         join public.tests t on t.id = a.test_id
         where ${where}`,
        values,
      ),
    ]);
    return buildProgress(students, selected, attempts, answers.map((a) => ({ ...a, awarded: Number(a.awarded), marks: Number(a.marks) })));
  }
}
