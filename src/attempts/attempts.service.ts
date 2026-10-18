import { Injectable } from '@nestjs/common';
import { AppError } from '../common/errors.js';
import type {
  PublicTestInfo,
  SaveAnswersResponse,
  StartAttemptResponse,
  StudentAttemptState,
  StudentResultView,
  SubmitResponse,
} from '../contracts/responses.js';
import type { IdentityField } from '../contracts/test-schemas.js';
import { Database } from '../database/database.js';
import type { TestRow } from '../database/types.js';
import { createAttemptStore, type AttemptStore, type IncomingAnswer } from './attempt-store.js';
import * as workflow from './attempt-workflow.js';
import { toPublicTestInfo } from './views.js';

@Injectable()
export class AttemptsService {
  readonly store: AttemptStore;

  constructor(private readonly db: Database) {
    this.store = createAttemptStore(db.rpc);
  }

  async getPublicTest(shareToken: string): Promise<PublicTestInfo> {
    const row = await this.db.one<TestRow & { subject_name: string; topic_name: string | null; marks: number[] }>(
      `select t.*, s.name as subject_name, tp.name as topic_name,
              coalesce((select array_agg(q.marks) from public.questions q where q.test_id = t.id), '{}') as marks
       from public.tests t
       join public.subjects s on s.id = t.subject_id
       left join public.topics tp on tp.id = t.topic_id
       where t.share_token = $1 and t.status = 'published'`,
      [shareToken],
    );
    if (!row) throw new AppError('TEST_NOT_AVAILABLE', 404, 'This test is not available. Please check the link.');
    return toPublicTestInfo(row, row.marks.map((m) => ({ marks: Number(m) })), {
      subject: row.subject_name,
      topic: row.topic_name,
    });
  }

  /** Starts an attempt as a guest, or linked to the signed-in student when `student` is given. */
  async start(
    shareToken: string,
    studentName: string,
    studentInfo: Record<string, string>,
    student: { id: string; displayName: string } | null = null,
  ): Promise<StartAttemptResponse> {
    const test = await this.db.one<{ identity_fields: IdentityField[] }>(
      `select identity_fields from public.tests where share_token = $1 and status = 'published'`,
      [shareToken],
    );
    if (!test) throw new AppError('TEST_NOT_AVAILABLE', 404, 'This test is not available. Please check the link.');
    const info = validateIdentity(test.identity_fields, studentInfo);
    // Signed-in students are recorded under their account name.
    const name = student?.displayName.trim() || studentName;
    const { attempt, token } = await workflow.startAttempt(this.store, shareToken, name, info, student?.id ?? null);
    return { attempt_id: attempt.id, attempt_token: token, deadline_at: attempt.deadline_at };
  }

  getState(attemptId: string, token: string): Promise<StudentAttemptState> {
    return workflow.getStudentAttemptState(this.store, attemptId, token);
  }

  saveAnswers(attemptId: string, token: string, answers: IncomingAnswer[]): Promise<SaveAnswersResponse> {
    return workflow.saveStudentAnswers(this.store, attemptId, token, answers);
  }

  async submit(attemptId: string, token: string, type: 'manual' | 'auto_client'): Promise<SubmitResponse> {
    const { attempt, alreadySubmitted } = await workflow.submitStudentAttempt(this.store, attemptId, token, type);
    return {
      attempt_id: attempt.id,
      status: attempt.status,
      grading_status: attempt.grading_status,
      submitted_at: attempt.submitted_at,
      already_submitted: alreadySubmitted,
    };
  }

  getResult(attemptId: string, token: string): Promise<StudentResultView> {
    return workflow.getStudentResult(this.store, attemptId, token);
  }

  finalizeExpired(limit?: number) {
    return workflow.finalizeExpiredAttempts(this.store, limit);
  }

  regrade(attemptId: string) {
    return workflow.gradeClosedAttempt(this.store, attemptId);
  }
}

/** Keeps only configured identification fields and checks required/format rules. */
export function validateIdentity(fields: IdentityField[], info: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  const problems: { path: string; message: string }[] = [];
  for (const field of fields) {
    const value = (info[field.key] ?? '').trim();
    if (!value) {
      if (field.required) problems.push({ path: field.key, message: `${field.label} is required` });
      continue;
    }
    if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      problems.push({ path: field.key, message: `${field.label} must be a valid email` });
    if (field.type === 'number' && !/^-?\d+(\.\d+)?$/.test(value))
      problems.push({ path: field.key, message: `${field.label} must be a number` });
    result[field.key] = value.slice(0, 200);
  }
  if (problems.length) throw new AppError('VALIDATION_FAILED', 400, 'Some fields are missing or invalid.', problems);
  return result;
}
