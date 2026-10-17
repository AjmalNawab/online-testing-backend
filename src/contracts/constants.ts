/*
 * Shared API contract. This folder is copied verbatim into the frontend
 * (`npm run sync:contracts` there); keep it free of backend-only imports.
 */

export const QUESTION_TYPES = [
  'mcq_single',
  'mcq_multiple',
  'true_false',
  'fill_blank',
  'matching',
  'ordering',
  'short_answer',
  'long_answer',
  'sentence_construction',
  'translation',
  'code',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** Types graded automatically from an answer key. */
export const AUTO_GRADED_TYPES = ['mcq_single', 'mcq_multiple', 'true_false', 'fill_blank', 'matching', 'ordering'] as const;
export type AutoGradedType = (typeof AUTO_GRADED_TYPES)[number];

export function isAutoGradedType(type: QuestionType): type is AutoGradedType {
  return (AUTO_GRADED_TYPES as readonly string[]).includes(type);
}

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  mcq_single: 'Multiple choice',
  mcq_multiple: 'Multiple select',
  true_false: 'True / False',
  fill_blank: 'Fill in the blanks',
  matching: 'Matching',
  ordering: 'Ordering / sequencing',
  short_answer: 'Short written answer',
  long_answer: 'Long answer / essay',
  sentence_construction: 'Sentence construction',
  translation: 'Translation',
  code: 'Code',
};

export const GRADING_METHODS = ['auto', 'manual', 'ai_assisted'] as const;
export type GradingMethod = (typeof GRADING_METHODS)[number];

export const DIFFICULTY_PRESETS = ['easy', 'medium', 'hard'] as const;

export const RELEASE_POLICIES = ['immediate', 'after_grading', 'manual'] as const;
export type ReleasePolicy = (typeof RELEASE_POLICIES)[number];

export const RELEASE_POLICY_LABELS: Record<ReleasePolicy, string> = {
  immediate: 'Immediately after submission (provisional while written answers are reviewed)',
  after_grading: 'After all grading is complete',
  manual: 'Only when an administrator releases them',
};

export const TEST_STATUSES = ['draft', 'published', 'archived'] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export const ATTEMPT_STATUSES = ['in_progress', 'submitted', 'expired'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const ATTEMPT_GRADING_STATUSES = ['not_submitted', 'grading', 'pending_review', 'complete'] as const;
export type AttemptGradingStatus = (typeof ATTEMPT_GRADING_STATUSES)[number];

export const ANSWER_GRADING_STATUSES = ['ungraded', 'auto_graded', 'pending_review', 'reviewed'] as const;
export type AnswerGradingStatus = (typeof ANSWER_GRADING_STATUSES)[number];

export const GRADE_OUTCOMES = ['correct', 'partial', 'incorrect', 'unanswered', 'pending_review'] as const;
export type GradeOutcome = (typeof GRADE_OUTCOMES)[number];

/** Must match public.attempt_grace() in the database. */
export const ATTEMPT_GRACE_MS = 5_000;

export const ATTEMPT_TOKEN_HEADER = 'x-attempt-token';

export const LIMITS = {
  questionsPerTest: 200,
  aiQuestionsPerRequest: 50,
  optionsPerQuestion: 10,
  itemsPerQuestion: 20,
  blanksPerQuestion: 20,
  writtenAnswerChars: 20_000,
} as const;

/** Languages written right-to-left (BCP-47 primary subtags). */
export const RTL_LANGUAGES = ['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ku'] as const;

export function isRtlLanguage(code: string | null | undefined): boolean {
  if (!code) return false;
  return (RTL_LANGUAGES as readonly string[]).includes(code.toLowerCase().split('-')[0]!);
}
