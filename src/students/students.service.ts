import { Injectable } from '@nestjs/common';
import * as workflow from '../attempts/attempt-workflow.js';
import { AttemptsService } from '../attempts/attempts.service.js';
import { computeVisibility } from '../attempts/views.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { MyAttempt, ProgressReport, StudentResultView } from '../contracts/responses.js';
import { Database } from '../database/database.js';
import type { AttemptRow, TestRow } from '../database/types.js';
import { ReportsService } from '../reports/reports.service.js';

type MyAttemptRow = Pick<
  AttemptRow,
  | 'id' | 'attempt_number' | 'status' | 'grading_status' | 'started_at' | 'deadline_at' | 'submitted_at'
  | 'results_released_at' | 'final_score' | 'objective_score' | 'maximum_marks' | 'percentage' | 'passed'
> &
  Pick<TestRow, 'title' | 'result_release_policy' | 'show_correct_answers' | 'show_explanations'> & {
    subject: string;
    topic: string | null;
  };

/** A signed-in student's own attempts. Every query is scoped to their account. */
@Injectable()
export class StudentsService {
  constructor(
    private readonly db: Database,
    private readonly attempts: AttemptsService,
    private readonly reports: ReportsService,
  ) {}

  async listAttempts(user: AuthUser): Promise<MyAttempt[]> {
    // Close attempts whose time ran out, so the list shows their real status.
    await this.attempts.finalizeExpired(20).catch(() => undefined);
    const rows = await this.db.query<MyAttemptRow>(
      `select a.id, a.attempt_number, a.status, a.grading_status, a.started_at, a.deadline_at, a.submitted_at,
              a.results_released_at, a.final_score, a.objective_score, a.maximum_marks, a.percentage, a.passed,
              t.title, t.result_release_policy, t.show_correct_answers, t.show_explanations,
              s.name as subject, tp.name as topic
       from public.test_attempts a
       join public.tests t on t.id = a.test_id
       join public.subjects s on s.id = t.subject_id
       left join public.topics tp on tp.id = t.topic_id
       where a.student_id = $1
       order by a.started_at desc
       limit 200`,
      [user.id],
    );
    return rows.map((r) => {
      const visibility = computeVisibility(r, r);
      const obtained = r.final_score ?? r.objective_score;
      return {
        id: r.id,
        test: { title: r.title, subject: r.subject, topic: r.topic },
        attempt_number: r.attempt_number,
        status: r.status,
        started_at: r.started_at,
        deadline_at: r.deadline_at,
        submitted_at: r.submitted_at,
        visibility,
        score:
          visibility.released && obtained !== null && r.maximum_marks !== null && r.percentage !== null
            ? { obtained, maximum: r.maximum_marks, percentage: r.percentage, passed: r.passed }
            : null,
      };
    });
  }

  result(user: AuthUser, attemptId: string): Promise<StudentResultView> {
    return workflow.getStudentResult(this.attempts.store, attemptId, { studentId: user.id });
  }

  async resume(user: AuthUser, attemptId: string): Promise<{ attempt_id: string; attempt_token: string }> {
    const token = await workflow.resumeOwnAttempt(this.attempts.store, user.id, attemptId);
    return { attempt_id: attemptId, attempt_token: token };
  }

  async claim(user: AuthUser, tokens: string[]): Promise<{ claimed: number }> {
    return { claimed: await workflow.claimGuestAttempts(this.attempts.store, user.id, tokens) };
  }

  progress(user: AuthUser, subjectId: string | undefined): Promise<ProgressReport> {
    return this.reports.progress(undefined, subjectId, { id: user.id, displayName: user.displayName || user.email || 'You' });
  }
}
