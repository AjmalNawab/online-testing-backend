import type {
  AnswerGradingStatus,
  AttemptGradingStatus,
  AttemptStatus,
  GradingMethod,
  QuestionType,
  ReleasePolicy,
  TestStatus,
} from '../contracts/constants.js';
import type { AnswerValue } from '../contracts/question-schemas.js';
import type { IdentityField } from '../contracts/test-schemas.js';

/** Row shapes as returned by Postgres (numeric columns arrive as JSON numbers). */

export interface SubjectRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TopicRow {
  id: string;
  subject_id: string;
  name: string;
  description: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface TestRow {
  id: string;
  title: string;
  description: string | null;
  subject_id: string;
  topic_id: string | null;
  category_id: string | null;
  language: string;
  difficulty: string;
  instructions: string | null;
  learning_objectives: string[];
  duration_minutes: number;
  passing_percentage: number;
  intended_total_marks: number | null;
  max_attempts: number | null;
  shuffle_questions: boolean;
  shuffle_options: boolean;
  negative_marking: boolean;
  partial_credit: boolean;
  written_review_required: boolean;
  result_release_policy: ReleasePolicy;
  show_correct_answers: boolean;
  show_explanations: boolean;
  identity_fields: IdentityField[];
  require_student_account: boolean;
  class_only: boolean;
  status: TestStatus;
  share_token: string;
  source: 'manual' | 'ai';
  created_by: string | null;
  published_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  /** Present in attempt bundles. */
  subject_name?: string;
  topic_name?: string | null;
}

export interface QuestionRow {
  id: string;
  test_id: string;
  position: number;
  question_type: QuestionType;
  prompt: string;
  content: Record<string, unknown>;
  answer_key: Record<string, unknown>;
  grading_method: GradingMethod;
  rubric: string | null;
  explanation: string | null;
  marks: number;
  negative_marks: number;
  partial_credit: boolean | null;
  created_at: string;
  updated_at: string;
}

export interface AttemptRow {
  id: string;
  test_id: string;
  student_id: string | null;
  student_name: string;
  student_key: string;
  student_info: Record<string, string>;
  attempt_number: number;
  started_at: string;
  deadline_at: string;
  submitted_at: string | null;
  status: AttemptStatus;
  submission_type: 'manual' | 'auto_client' | 'auto_server' | null;
  grading_status: AttemptGradingStatus;
  objective_score: number | null;
  final_score: number | null;
  maximum_marks: number | null;
  percentage: number | null;
  passed: boolean | null;
  correct_count: number | null;
  incorrect_count: number | null;
  unanswered_count: number | null;
  pending_review_count: number | null;
  results_released_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AiGradingSuggestion {
  suggested_marks: number;
  max_marks: number;
  reasoning: string;
  feedback: string;
  corrections: string[];
  missing_points: string[];
  improved_answer: string;
  model: string;
}

export interface AnswerRow {
  id: string;
  attempt_id: string;
  question_id: string;
  answer: AnswerValue;
  client_revision: number;
  awarded_marks: number | null;
  is_correct: boolean | null;
  grading_status: AnswerGradingStatus;
  feedback: string | null;
  ai_suggestion: AiGradingSuggestion | null;
  ai_suggested_at: string | null;
  saved_at: string;
  graded_at: string | null;
  graded_by: string | null;
}

export interface AttemptBundle {
  server_time: string;
  attempt: AttemptRow;
  test: TestRow;
  questions: QuestionRow[];
  answers: AnswerRow[];
}
