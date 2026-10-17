import type { AnswerValue } from '../contracts/question-schemas.js';
import type { AnswerRow, AttemptBundle, AttemptRow } from '../database/types.js';
import type { AttemptSummary, QuestionGrade } from '../grading/grade.js';
import type { RpcCaller } from '../database/rpc.js';

export interface IncomingAnswer {
  question_id: string;
  answer: AnswerValue;
  revision: number;
}

export interface SaveAnswersResult {
  saved: number;
  received: number;
  server_time: string;
  deadline_at: string;
}

/** Typed wrapper over the SECURITY DEFINER functions in the migration. */
export function createAttemptStore(rpc: RpcCaller) {
  return {
    startAttempt: (shareToken: string, name: string, info: Record<string, string>, tokenHash: string) =>
      rpc('start_attempt', {
        p_share_token: shareToken,
        p_student_name: name,
        p_student_info: info,
        p_token_hash: tokenHash,
      }) as Promise<AttemptRow>,

    getBundle: (attemptId: string, tokenHash: string) =>
      rpc('get_attempt_bundle', { p_attempt_id: attemptId, p_token_hash: tokenHash }) as Promise<AttemptBundle | null>,

    getBundleInternal: (attemptId: string) =>
      rpc('get_attempt_bundle_internal', { p_attempt_id: attemptId }) as Promise<AttemptBundle | null>,

    saveAnswers: (attemptId: string, tokenHash: string, answers: IncomingAnswer[]) =>
      rpc('save_answers', { p_attempt_id: attemptId, p_token_hash: tokenHash, p_answers: answers }) as Promise<SaveAnswersResult>,

    claimSubmission: (attemptId: string, tokenHash: string | null, type: 'manual' | 'auto_client' | 'auto_server') =>
      rpc('claim_submission', {
        p_attempt_id: attemptId,
        p_token_hash: tokenHash,
        p_submission_type: type,
      }) as Promise<{ claimed: boolean; attempt: AttemptRow }>,

    applyGrading: (attemptId: string, grades: QuestionGrade[], summary: AttemptSummary) =>
      rpc('apply_grading', {
        p_attempt_id: attemptId,
        p_answers: grades.map((g) => ({
          question_id: g.question_id,
          awarded_marks: g.awarded_marks,
          is_correct: g.is_correct,
          grading_status: g.grading_status,
        })),
        p_summary: summary,
      }) as Promise<AttemptRow>,

    listExpiredAttemptIds: (limit: number) => rpc('list_expired_attempt_ids', { p_limit: limit }) as Promise<string[]>,

    reviewAnswer: (
      actorId: string,
      attemptId: string,
      questionId: string,
      marks: number,
      feedback: string | null,
      source: 'manual' | 'ai_approved',
    ) =>
      rpc('review_answer', {
        p_actor: actorId,
        p_attempt_id: attemptId,
        p_question_id: questionId,
        p_marks: marks,
        p_feedback: feedback,
        p_source: source,
      }) as Promise<AnswerRow>,

    saveAiSuggestion: (attemptId: string, questionId: string, suggestion: unknown) =>
      rpc('save_ai_suggestion', {
        p_attempt_id: attemptId,
        p_question_id: questionId,
        p_suggestion: suggestion,
      }) as Promise<void>,

    setResultsReleased: (actorId: string, attemptId: string, released: boolean) =>
      rpc('set_results_released', { p_actor: actorId, p_attempt_id: attemptId, p_released: released }) as Promise<void>,
  };
}

export type AttemptStore = ReturnType<typeof createAttemptStore>;
