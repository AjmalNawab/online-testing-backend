import type {
  AttemptGradingStatus,
  AttemptStatus,
  GradeOutcome,
  GradingMethod,
  QuestionType,
  ReleasePolicy,
  TestStatus,
} from './constants.js';
import type { AnswerValue } from './question-schemas.js';
import type { IdentityField, TestSettings } from './test-schemas.js';

/*
 * Response shapes. Student-facing shapes are built field-by-field on the
 * server so answer keys, rubrics and explanations cannot leak by accident.
 */

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

// ---------------------------------------------------------------- catalog ----

export interface Subject {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  archived: boolean;
  topic_count: number;
  test_count: number;
}

export interface Topic {
  id: string;
  subject_id: string;
  name: string;
  description: string | null;
  archived: boolean;
}

export interface Category {
  id: string;
  name: string;
  description: string | null;
}

export interface Tag {
  id: string;
  name: string;
}

// ------------------------------------------------------------------ tests ----

export interface TestSummary {
  id: string;
  title: string;
  status: TestStatus;
  subject: { id: string; name: string };
  topic: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
  tags: string[];
  difficulty: string;
  language: string;
  duration_minutes: number;
  question_count: number;
  total_marks: number;
  attempt_count: number;
  source: 'manual' | 'ai';
  share_token: string;
  /** Name of the teacher who created the test. */
  owner: string | null;
  created_at: string;
  updated_at: string;
}

/** Full admin view of a question, including its answer key. */
export interface AdminQuestion {
  id: string;
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
}

export interface MarksSummary {
  total_marks: number;
  auto_graded_marks: number;
  reviewed_marks: number;
  question_count: number;
}

export interface PublishCheck {
  errors: string[];
  warnings: string[];
  summary: MarksSummary;
}

export interface AdminTestDetail {
  id: string;
  status: TestStatus;
  share_token: string;
  source: 'manual' | 'ai';
  settings: TestSettings;
  subject: { id: string; name: string };
  topic: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
  questions: AdminQuestion[];
  attempt_count: number;
  /** Questions are locked once attempts exist. */
  locked: boolean;
  check: PublishCheck;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------- student ----

export interface PublicTestInfo {
  title: string;
  description: string | null;
  subject: string;
  topic: string | null;
  language: string;
  difficulty: string;
  instructions: string | null;
  learning_objectives: string[];
  duration_minutes: number;
  passing_percentage: number;
  max_attempts: number | null;
  question_count: number;
  total_marks: number;
  identity_fields: IdentityField[];
  /** Guests cannot start this test; students must sign in. */
  requires_account: boolean;
}

export interface StudentQuestion {
  id: string;
  number: number;
  question_type: QuestionType;
  prompt: string;
  /** Public content only (options, items, languages...), possibly shuffled. */
  content: Record<string, unknown>;
  marks: number;
  answer_dir: 'rtl' | 'auto';
}

export interface StartAttemptResponse {
  attempt_id: string;
  /** Secret for this attempt; send as the X-Attempt-Token header. Shown once. */
  attempt_token: string;
  deadline_at: string;
}

export interface StudentAttemptState {
  attempt: {
    id: string;
    status: AttemptStatus;
    student_name: string;
    attempt_number: number;
    started_at: string;
    deadline_at: string;
    submitted_at: string | null;
  };
  server_time: string;
  test: {
    title: string;
    subject: string;
    topic: string | null;
    language: string;
    instructions: string | null;
    duration_minutes: number;
    total_marks: number;
    question_count: number;
  };
  questions: StudentQuestion[];
  answers: Record<string, { answer: AnswerValue; revision: number }>;
}

export interface SaveAnswersResponse {
  saved: number;
  received: number;
  server_time: string;
  deadline_at: string;
}

export interface SubmitResponse {
  attempt_id: string;
  status: AttemptStatus;
  grading_status: AttemptGradingStatus;
  submitted_at: string | null;
  already_submitted: boolean;
}

export interface ResultVisibility {
  released: boolean;
  /** Why results are hidden, when they are. */
  reason: string | null;
  /** Written answers still await review: the score is partial. */
  provisional: boolean;
  show_correct_answers: boolean;
  show_explanations: boolean;
}

export interface StudentQuestionResult {
  number: number;
  question_type: QuestionType;
  prompt: string;
  content: Record<string, unknown>;
  marks: number;
  answer_dir: 'rtl' | 'auto';
  your_answer: AnswerValue;
  your_answer_text: string;
  awarded_marks: number | null;
  outcome: GradeOutcome;
  correct_answer: string | null;
  explanation: string | null;
  feedback: string | null;
}

export interface StudentResultView {
  attempt: {
    id: string;
    student_name: string;
    attempt_number: number;
    status: AttemptStatus;
    started_at: string;
    submitted_at: string | null;
    submission_type: 'manual' | 'auto_client' | 'auto_server' | null;
    time_taken_seconds: number | null;
  };
  test: { title: string; subject: string; topic: string | null; passing_percentage: number; language: string };
  visibility: ResultVisibility;
  score: {
    obtained: number;
    maximum: number;
    percentage: number;
    passed: boolean | null;
    correct: number;
    incorrect: number;
    unanswered: number;
    pending_review: number;
  } | null;
  questions: StudentQuestionResult[] | null;
}

// ---------------------------------------------------------- admin attempts ----

export interface AttemptSummaryRow {
  id: string;
  test: { id: string; title: string; subject: string; topic: string | null };
  student_name: string;
  student_info: Record<string, string>;
  attempt_number: number;
  status: AttemptStatus;
  grading_status: AttemptGradingStatus;
  started_at: string;
  submitted_at: string | null;
  time_taken_seconds: number | null;
  score: number | null;
  provisional_score: number | null;
  maximum_marks: number | null;
  percentage: number | null;
  passed: boolean | null;
  pending_review_count: number;
  results_released: boolean;
}

export interface AdminAnswerReview {
  question: AdminQuestion;
  answer: AnswerValue;
  answer_text: string;
  correct_answer: string | null;
  awarded_marks: number | null;
  outcome: GradeOutcome;
  grading_status: string;
  feedback: string | null;
  ai_suggestion: {
    suggested_marks: number;
    max_marks: number;
    reasoning: string;
    feedback: string;
    corrections: string[];
    missing_points: string[];
    improved_answer: string;
    model: string;
  } | null;
  reviews: { awarded_marks: number; feedback: string | null; source: string; reviewer: string | null; created_at: string }[];
}

export interface AdminAttemptDetail {
  attempt: AttemptSummaryRow & { deadline_at: string; submission_type: string | null };
  test: { id: string; title: string; result_release_policy: ReleasePolicy; written_review_required: boolean };
  answers: AdminAnswerReview[];
}

// ---------------------------------------------------------------- reports ----

export interface DashboardStats {
  tests: { total: number; draft: number; published: number; archived: number };
  attempts: { total: number; in_progress: number; completed: number; pending_review: number };
  average_percentage: number | null;
  recent_attempts: AttemptSummaryRow[];
  by_subject: { subject: string; attempts: number; average_percentage: number | null }[];
}

export interface ProgressReport {
  students: string[];
  student: string | null;
  totals: {
    attempts: number;
    average_percentage: number | null;
    best_percentage: number | null;
    latest_percentage: number | null;
  };
  timeline: { date: string; test: string; subject: string; percentage: number }[];
  by_subject: { subject: string; attempts: number; average_percentage: number }[];
  by_topic: { subject: string; topic: string; attempts: number; average_percentage: number }[];
  by_question_type: { question_type: QuestionType; earned: number; possible: number; percentage: number }[];
  recommendations: string[];
}

// --------------------------------------------------------------- accounts ----

export interface SetupStatus {
  /** True while no administrator exists yet. */
  needs_setup: boolean;
  /** Whether the server is configured for browser setup (setup code and secret key set). */
  available: boolean;
}

export interface AdminAccount {
  id: string;
  email: string | null;
  display_name: string;
  created_at: string;
  is_you: boolean;
}

export interface AccessRequest {
  id: string;
  email: string | null;
  display_name: string;
  requested_at: string;
}

export interface SignupResponse {
  email: string;
  account_type: 'student' | 'teacher';
  /** Students can sign in straight away; teachers wait for an administrator. */
  status: 'active' | 'pending_approval';
}

/** One attempt in a signed-in student's history. */
export interface MyAttempt {
  id: string;
  test: { title: string; subject: string; topic: string | null };
  attempt_number: number;
  status: AttemptStatus;
  started_at: string;
  deadline_at: string;
  submitted_at: string | null;
  visibility: ResultVisibility;
  /** Present only when results are released. */
  score: { obtained: number; maximum: number; percentage: number; passed: boolean | null } | null;
}

// ---------------------------------------------------------------- classes ----

export interface ClassSummary {
  id: string;
  name: string;
  description: string | null;
  /** 8 characters; shown to users as XXXX-XXXX. */
  join_code: string;
  archived: boolean;
  teacher: { id: string; name: string };
  member_count: number;
  test_count: number;
  created_at: string;
}

export interface ClassMember {
  id: string;
  display_name: string;
  email: string | null;
  joined_at: string;
}

export interface ClassAssignment {
  test_id: string;
  title: string;
  status: TestStatus;
  due_at: string | null;
  /** Class members with at least one submitted attempt. */
  submitted_count: number;
}

export interface ClassDetail extends ClassSummary {
  members: ClassMember[];
  assignments: ClassAssignment[];
}

/** One class a test is assigned to (test editor view). */
export interface TestAssignment {
  class_id: string;
  class_name: string;
  due_at: string | null;
  member_count: number;
  submitted_count: number;
}

export interface MyClass {
  id: string;
  name: string;
  teacher_name: string;
  joined_at: string;
}

/** A test assigned to one of the signed-in student's classes. */
export interface MyAssignment {
  test_id: string;
  title: string;
  subject: string;
  duration_minutes: number;
  share_token: string;
  class_name: string;
  due_at: string | null;
  state: 'not_started' | 'in_progress' | 'submitted';
  latest_attempt_id: string | null;
}

export interface StaffMember {
  id: string;
  display_name: string;
  email: string | null;
  role: 'admin' | 'teacher';
  class_count: number;
  student_count: number;
  test_count: number;
  created_at: string;
}
