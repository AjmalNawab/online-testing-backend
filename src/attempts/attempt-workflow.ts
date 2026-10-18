import { ATTEMPT_GRACE_MS } from '../contracts/constants.js';
import type { StudentAttemptState, StudentResultView } from '../contracts/responses.js';
import type { AttemptBundle, AttemptRow } from '../database/types.js';
import { AppError, isErrorCode } from '../common/errors.js';
import { gradeAttempt } from '../grading/grade.js';
import type { AttemptStore, IncomingAnswer, SaveAnswersResult } from './attempt-store.js';
import { generateAttemptToken, hashAttemptToken } from './token.js';
import { toStudentAttemptState, toStudentResultView } from './views.js';

/*
 * Framework-free attempt workflow, unit-testable against a real Postgres.
 * Timing decisions are made by the database clock inside the SQL functions.
 */

export async function startAttempt(
  store: AttemptStore,
  shareToken: string,
  studentName: string,
  studentInfo: Record<string, string>,
  studentId: string | null = null,
): Promise<{ attempt: AttemptRow; token: string }> {
  const token = generateAttemptToken();
  const attempt = await store.startAttempt(shareToken, studentName, studentInfo, hashAttemptToken(token), studentId);
  return { attempt, token };
}

const isPastGrace = (bundle: AttemptBundle) =>
  Date.parse(bundle.server_time) > Date.parse(bundle.attempt.deadline_at) + ATTEMPT_GRACE_MS;

/** Proves access to an attempt: its secret (guests) or its owner's account. */
export type AttemptAccess = { token: string } | { studentId: string };

async function loadBundle(store: AttemptStore, attemptId: string, access: AttemptAccess): Promise<AttemptBundle> {
  const bundle =
    'token' in access
      ? await store.getBundle(attemptId, hashAttemptToken(access.token))
      : await store.getStudentBundle(access.studentId, attemptId);
  if (!bundle) throw new AppError('ATTEMPT_NOT_FOUND', 404, 'This attempt was not found.');
  return bundle;
}

/** Loads an attempt, finalising it first if its deadline passed while nobody was watching. */
async function loadFreshBundle(store: AttemptStore, attemptId: string, access: AttemptAccess): Promise<AttemptBundle> {
  let bundle = await loadBundle(store, attemptId, access);
  const stale =
    (bundle.attempt.status === 'in_progress' && isPastGrace(bundle)) || bundle.attempt.grading_status === 'grading';
  if (stale) {
    await finalizeAttempt(store, attemptId);
    bundle = await loadBundle(store, attemptId, access);
  }
  return bundle;
}

export async function getStudentAttemptState(store: AttemptStore, attemptId: string, token: string): Promise<StudentAttemptState> {
  return toStudentAttemptState(await loadFreshBundle(store, attemptId, { token }));
}

export async function getStudentResult(store: AttemptStore, attemptId: string, access: string | AttemptAccess): Promise<StudentResultView> {
  return toStudentResultView(await loadFreshBundle(store, attemptId, typeof access === 'string' ? { token: access } : access));
}

/** Gives the owner of an in-progress attempt a new secret to continue on this device. */
export async function resumeOwnAttempt(store: AttemptStore, studentId: string, attemptId: string): Promise<string> {
  const bundle = await loadFreshBundle(store, attemptId, { studentId });
  if (bundle.attempt.status !== 'in_progress') {
    throw new AppError('ATTEMPT_CLOSED', 409, 'This attempt has already been submitted.');
  }
  const token = generateAttemptToken();
  await store.rotateToken(studentId, attemptId, hashAttemptToken(token));
  return token;
}

/** Links guest attempts to an account; each must be proved by its secret. */
export function claimGuestAttempts(store: AttemptStore, studentId: string, tokens: string[]): Promise<number> {
  return store.claimAttempts(studentId, tokens.map(hashAttemptToken));
}

export async function saveStudentAnswers(
  store: AttemptStore,
  attemptId: string,
  token: string,
  answers: IncomingAnswer[],
): Promise<SaveAnswersResult> {
  try {
    return await store.saveAnswers(attemptId, hashAttemptToken(token), answers);
  } catch (error) {
    if (isErrorCode(error, 'DEADLINE_PASSED')) {
      // Close the attempt with whatever was saved in time before reporting.
      await finalizeAttempt(store, attemptId).catch(() => undefined);
    }
    throw error;
  }
}

/** Grades a closed attempt from trusted question data. Idempotent. */
export async function gradeClosedAttempt(store: AttemptStore, attemptId: string): Promise<AttemptRow> {
  const bundle = await store.getBundleInternal(attemptId);
  if (!bundle) throw new AppError('ATTEMPT_NOT_FOUND', 404, 'Attempt not found.');
  if (bundle.attempt.status === 'in_progress') {
    throw new AppError('ATTEMPT_NOT_SUBMITTED', 409, 'This attempt has not been submitted yet.');
  }
  const { grades, summary } = gradeAttempt(
    bundle.questions,
    bundle.answers,
    { negativeMarking: bundle.test.negative_marking, partialCredit: bundle.test.partial_credit },
    bundle.test.passing_percentage,
  );
  return store.applyGrading(attemptId, grades, summary);
}

export async function submitStudentAttempt(
  store: AttemptStore,
  attemptId: string,
  token: string,
  type: 'manual' | 'auto_client',
): Promise<{ attempt: AttemptRow; alreadySubmitted: boolean }> {
  const claim = await store.claimSubmission(attemptId, hashAttemptToken(token), type);
  if (claim.claimed || claim.attempt.grading_status === 'grading') {
    return { attempt: await gradeClosedAttempt(store, attemptId), alreadySubmitted: !claim.claimed };
  }
  return { attempt: claim.attempt, alreadySubmitted: true };
}

/** Server-side finalisation of an expired or stuck attempt (no token needed). */
export async function finalizeAttempt(store: AttemptStore, attemptId: string): Promise<AttemptRow | null> {
  try {
    const claim = await store.claimSubmission(attemptId, null, 'auto_server');
    if (claim.claimed || claim.attempt.grading_status === 'grading') return await gradeClosedAttempt(store, attemptId);
    return null;
  } catch (error) {
    if (isErrorCode(error, 'ATTEMPT_STILL_ACTIVE')) return null;
    throw error;
  }
}

/** Finalises every attempt whose deadline has passed. Safe to run concurrently. */
export async function finalizeExpiredAttempts(store: AttemptStore, limit = 100): Promise<{ finalized: number; failed: number }> {
  const ids = await store.listExpiredAttemptIds(limit);
  let finalized = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      if (await finalizeAttempt(store, id)) finalized += 1;
    } catch {
      failed += 1;
    }
  }
  return { finalized, failed };
}
