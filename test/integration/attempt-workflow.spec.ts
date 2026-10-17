import type { PGlite } from '@electric-sql/pglite';
import { createAttemptStore, type AttemptStore } from '../../src/attempts/attempt-store.js';
import {
  finalizeExpiredAttempts,
  getStudentAttemptState,
  getStudentResult,
  saveStudentAnswers,
  startAttempt,
  submitStudentAttempt,
} from '../../src/attempts/attempt-workflow.js';
import { hashAttemptToken } from '../../src/attempts/token.js';
import { isErrorCode } from '../../src/common/errors.js';
import { createTestDb, expireAttempt, pgliteRpc, seedTest } from '../helpers/db.js';

let db: PGlite;
let store: AttemptStore;

beforeAll(async () => {
  db = await createTestDb();
  store = createAttemptStore(pgliteRpc(db));
});

const expectCode = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).not.toBeNull();
  expect(isErrorCode(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
};

describe('starting an attempt', () => {
  it('records a server start time and a deadline exactly duration minutes later', async () => {
    const { shareToken } = await seedTest(db, { duration_minutes: 20 });
    const { attempt, token } = await startAttempt(store, shareToken, '  Ayesha   Khan ', { roll: '7' });
    expect(attempt.student_name).toBe('Ayesha Khan');
    expect(attempt.student_info).toEqual({ roll: '7' });
    expect(Date.parse(attempt.deadline_at) - Date.parse(attempt.started_at)).toBe(20 * 60 * 1000);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempt).not.toHaveProperty('token_hash');
  });

  it('stores only the hash of the attempt secret', async () => {
    const { shareToken } = await seedTest(db);
    const { attempt, token } = await startAttempt(store, shareToken, 'Sara', {});
    const row = await db.query<{ token_hash: string }>('select token_hash from public.test_attempts where id = $1', [attempt.id]);
    expect(row.rows[0]!.token_hash).toBe(hashAttemptToken(token));
    expect(row.rows[0]!.token_hash).not.toContain(token);
  });

  it('refuses drafts, archived tests and unknown links', async () => {
    const draft = await seedTest(db, { status: 'draft' });
    const archived = await seedTest(db, { status: 'archived' });
    await expectCode(startAttempt(store, draft.shareToken, 'Sara', {}), 'TEST_NOT_AVAILABLE');
    await expectCode(startAttempt(store, archived.shareToken, 'Sara', {}), 'TEST_NOT_AVAILABLE');
    await expectCode(startAttempt(store, 'no_such_share_token_000', 'Sara', {}), 'TEST_NOT_AVAILABLE');
  });

  it('enforces the maximum number of attempts per student name (case-insensitive)', async () => {
    const { shareToken } = await seedTest(db, { max_attempts: 2 });
    await startAttempt(store, shareToken, 'Bilal', {});
    await startAttempt(store, shareToken, 'bilal', {});
    await expectCode(startAttempt(store, shareToken, 'BILAL ', {}), 'MAX_ATTEMPTS_REACHED');
    await expect(startAttempt(store, shareToken, 'Hina', {})).resolves.toBeTruthy();
  });
});

describe('taking a test', () => {
  it('never exposes answer keys, rubrics or explanations to the student', async () => {
    const { shareToken } = await seedTest(db);
    const { attempt, token } = await startAttempt(store, shareToken, 'Sara', {});
    const state = await getStudentAttemptState(store, attempt.id, token);
    const json = JSON.stringify(state);
    expect(json).not.toContain('answer_key');
    expect(json).not.toContain('"correct"');
    expect(json).not.toContain('accepted');
    expect(json).not.toContain('model_answer');
    expect(json).not.toContain('Plants turn light');
    expect(json).not.toContain('rubric');
    expect(state.questions).toHaveLength(4);
    expect(state.questions[0]!.content).toEqual({
      options: [{ id: 'a', text: 'Berlin' }, { id: 'b', text: 'Paris' }, { id: 'c', text: 'Rome' }],
    });
  });

  it('a refresh restores the same deadline and the saved answers', async () => {
    const { shareToken, questionIds } = await seedTest(db);
    const { attempt, token } = await startAttempt(store, shareToken, 'Sara', {});
    await saveStudentAnswers(store, attempt.id, token, [
      { question_id: questionIds[0]!, answer: 'b', revision: 1 },
      { question_id: questionIds[2]!, answer: [' Four '], revision: 1 },
    ]);
    const first = await getStudentAttemptState(store, attempt.id, token);
    const second = await getStudentAttemptState(store, attempt.id, token);
    expect(second.attempt.deadline_at).toBe(attempt.deadline_at);
    expect(first.attempt.deadline_at).toBe(second.attempt.deadline_at);
    expect(second.answers[questionIds[0]!]).toEqual({ answer: 'b', revision: 1 });
    expect(second.answers[questionIds[2]!]!.answer).toEqual([' Four ']);
  });

  it('rejects a wrong or missing attempt secret (no IDOR)', async () => {
    const { shareToken, questionIds } = await seedTest(db);
    const { attempt } = await startAttempt(store, shareToken, 'Sara', {});
    const other = await startAttempt(store, shareToken, 'Hina', {});
    await expectCode(getStudentAttemptState(store, attempt.id, other.token), 'ATTEMPT_NOT_FOUND');
    await expectCode(
      saveStudentAnswers(store, attempt.id, other.token, [{ question_id: questionIds[0]!, answer: 'b', revision: 1 }]),
      'ATTEMPT_NOT_FOUND',
    );
    await expectCode(submitStudentAttempt(store, attempt.id, other.token, 'manual'), 'ATTEMPT_NOT_FOUND');
  });

  it('ignores answers for questions from another test', async () => {
    const a = await seedTest(db);
    const b = await seedTest(db);
    const { attempt, token } = await startAttempt(store, a.shareToken, 'Sara', {});
    const res = await saveStudentAnswers(store, attempt.id, token, [{ question_id: b.questionIds[0]!, answer: 'b', revision: 1 }]);
    expect(res.saved).toBe(0);
  });

  it('keeps the newest revision when saves arrive out of order', async () => {
    const { shareToken, questionIds } = await seedTest(db);
    const { attempt, token } = await startAttempt(store, shareToken, 'Sara', {});
    const q = questionIds[0]!;
    await saveStudentAnswers(store, attempt.id, token, [{ question_id: q, answer: 'c', revision: 5 }]);
    const stale = await saveStudentAnswers(store, attempt.id, token, [{ question_id: q, answer: 'a', revision: 3 }]);
    expect(stale.saved).toBe(0);
    await Promise.all([
      saveStudentAnswers(store, attempt.id, token, [{ question_id: q, answer: 'a', revision: 7 }]),
      saveStudentAnswers(store, attempt.id, token, [{ question_id: q, answer: 'b', revision: 9 }]),
      saveStudentAnswers(store, attempt.id, token, [{ question_id: q, answer: 'c', revision: 8 }]),
    ]);
    const state = await getStudentAttemptState(store, attempt.id, token);
    expect(state.answers[q]).toEqual({ answer: 'b', revision: 9 });
  });
});

describe('deadline enforcement', () => {
  it('rejects answers after the deadline and finalises with what was saved in time', async () => {
    const { shareToken, questionIds } = await seedTest(db);
    const { attempt, token } = await startAttempt(store, shareToken, 'Sara', {});
    await saveStudentAnswers(store, attempt.id, token, [{ question_id: questionIds[0]!, answer: 'b', revision: 1 }]);
    await expireAttempt(db, attempt.id, 30);

    await expectCode(
      saveStudentAnswers(store, attempt.id, token, [{ question_id: questionIds[1]!, answer: true, revision: 2 }]),
      'DEADLINE_PASSED',
    );
    const result = await getStudentResult(store, attempt.id, token);
    expect(result.attempt.status).toBe('expired');
    expect(result.attempt.submission_type).toBe('auto_server');
    expect(result.questions!.find((q) => q.prompt.includes('France'))!.outcome).toBe('correct');
    expect(result.questions!.find((q) => q.prompt.includes('boils'))!.outcome).toBe('unanswered');
  });

  it('accepts a save within the server grace window just after the deadline', async () => {
    const { shareToken, questionIds } = await seedTest(db);
    const { attempt, token } = await startAttempt(store, shareToken, 'Sara', {});
    await expireAttempt(db, attempt.id, 2); // 2s late, grace is 5s
    const res = await saveStudentAnswers(store, attempt.id, token, [{ question_id: questionIds[0]!, answer: 'b', revision: 1 }]);
    expect(res.saved).toBe(1);
  });

  it('finalises abandoned attempts in the background worker even if the browser never returns', async () => {
    const { shareToken, questionIds } = await seedTest(db);
    const { attempt, token } = await startAttempt(store, shareToken, 'Abandoned', {});
    await saveStudentAnswers(store, attempt.id, token, [{ question_id: questionIds[0]!, answer: 'b', revision: 1 }]);
    await expireAttempt(db, attempt.id, 120);

    const run = await finalizeExpiredAttempts(store);
    expect(run.finalized).toBeGreaterThanOrEqual(1);
    const row = await db.query<{ status: string; submitted_at: string; deadline_at: string; objective_score: string }>(
      'select status, submitted_at, deadline_at, objective_score from public.test_attempts where id = $1',
      [attempt.id],
    );
    expect(row.rows[0]!.status).toBe('expired');
    expect(new Date(row.rows[0]!.submitted_at).getTime()).toBe(new Date(row.rows[0]!.deadline_at).getTime());
    expect(Number(row.rows[0]!.objective_score)).toBe(2);

    const again = await finalizeExpiredAttempts(store);
    const ids = await store.listExpiredAttemptIds(500);
    expect(ids).not.toContain(attempt.id);
    expect(again.failed).toBe(0);
  });

  it('does not finalise attempts that are still running', async () => {
    const { shareToken } = await seedTest(db);
    const { attempt } = await startAttempt(store, shareToken, 'Active', {});
    await finalizeExpiredAttempts(store);
    const row = await db.query<{ status: string }>('select status from public.test_attempts where id = $1', [attempt.id]);
    expect(row.rows[0]!.status).toBe('in_progress');
  });
});

describe('submission and grading', () => {
  it('grades on the server and keeps written answers pending', async () => {
    const { shareToken, questionIds } = await seedTest(db);
    const { attempt, token } = await startAttempt(store, shareToken, 'Sara', {});
    await saveStudentAnswers(store, attempt.id, token, [
      { question_id: questionIds[0]!, answer: 'b', revision: 1 },
      { question_id: questionIds[1]!, answer: false, revision: 1 },
      { question_id: questionIds[2]!, answer: ['FOUR.'], revision: 1 },
      { question_id: questionIds[3]!, answer: 'Plants make food from sunlight.', revision: 1 },
    ]);
    const { attempt: graded } = await submitStudentAttempt(store, attempt.id, token, 'manual');
    expect(graded).toMatchObject({
      status: 'submitted',
      submission_type: 'manual',
      grading_status: 'pending_review',
      objective_score: 4,
      final_score: null,
      maximum_marks: 10,
      correct_count: 2,
      incorrect_count: 1,
      pending_review_count: 1,
    });

    const result = await getStudentResult(store, attempt.id, token);
    expect(result.visibility).toMatchObject({ released: true, provisional: true });
    expect(result.score).toMatchObject({ obtained: 4, maximum: 10, passed: null, pending_review: 1 });
  });

  it('duplicate and concurrent submissions grade exactly once', async () => {
    const { shareToken, questionIds } = await seedTest(db);
    const { attempt, token } = await startAttempt(store, shareToken, 'Sara', {});
    await saveStudentAnswers(store, attempt.id, token, [{ question_id: questionIds[0]!, answer: 'b', revision: 1 }]);
    const results = await Promise.all([
      submitStudentAttempt(store, attempt.id, token, 'manual'),
      submitStudentAttempt(store, attempt.id, token, 'auto_client'),
      submitStudentAttempt(store, attempt.id, token, 'manual'),
    ]);
    expect(results.filter((r) => !r.alreadySubmitted)).toHaveLength(1);
    const first = await db.query<{ submitted_at: string; submission_type: string }>(
      'select submitted_at, submission_type from public.test_attempts where id = $1',
      [attempt.id],
    );
    const again = await submitStudentAttempt(store, attempt.id, token, 'auto_client');
    expect(again.alreadySubmitted).toBe(true);
    const after = await db.query<{ submitted_at: string; submission_type: string }>(
      'select submitted_at, submission_type from public.test_attempts where id = $1',
      [attempt.id],
    );
    expect(after.rows[0]).toEqual(first.rows[0]);
  });

  it('rejects edits after submission', async () => {
    const { shareToken, questionIds } = await seedTest(db);
    const { attempt, token } = await startAttempt(store, shareToken, 'Sara', {});
    await submitStudentAttempt(store, attempt.id, token, 'manual');
    await expectCode(
      saveStudentAnswers(store, attempt.id, token, [{ question_id: questionIds[0]!, answer: 'b', revision: 99 }]),
      'ATTEMPT_CLOSED',
    );
  });

  it('respects result release policies and answer-key visibility', async () => {
    const auto = [SAMPLE_AUTO];
    const afterGrading = await seedTest(db, { result_release_policy: 'manual' }, auto);
    const a = await startAttempt(store, afterGrading.shareToken, 'Sara', {});
    await submitStudentAttempt(store, a.attempt.id, a.token, 'manual');
    const hidden = await getStudentResult(store, a.attempt.id, a.token);
    expect(hidden.visibility.released).toBe(false);
    expect(hidden.score).toBeNull();
    expect(hidden.questions).toBeNull();

    const noKey = await seedTest(db, { show_correct_answers: false }, auto);
    const b = await startAttempt(store, noKey.shareToken, 'Sara', {});
    await submitStudentAttempt(store, b.attempt.id, b.token, 'manual');
    const shown = await getStudentResult(store, b.attempt.id, b.token);
    expect(shown.visibility.released).toBe(true);
    expect(shown.questions![0]!.correct_answer).toBeNull();
  });

  it('shuffles questions per attempt but keeps the order stable across refreshes', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...SAMPLE_AUTO, prompt: `Question ${i + 1}?` }));
    const { shareToken } = await seedTest(db, { shuffle_questions: true }, many);
    const { attempt, token } = await startAttempt(store, shareToken, 'Sara', {});
    const one = (await getStudentAttemptState(store, attempt.id, token)).questions.map((q) => q.id);
    const two = (await getStudentAttemptState(store, attempt.id, token)).questions.map((q) => q.id);
    expect(two).toEqual(one);
    expect((await getStudentAttemptState(store, attempt.id, token)).questions.map((q) => q.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

const SAMPLE_AUTO = {
  question_type: 'true_false',
  prompt: 'The Earth orbits the Sun.',
  answer_key: { correct: true },
  marks: 1,
};
