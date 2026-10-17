import { isAutoGradedType, isRtlLanguage, type GradeOutcome } from '../contracts/constants.js';
import type {
  PublicTestInfo,
  ResultVisibility,
  StudentAttemptState,
  StudentQuestion,
  StudentQuestionResult,
  StudentResultView,
} from '../contracts/responses.js';
import type { AnswerRow, AttemptBundle, AttemptRow, QuestionRow, TestRow } from '../database/types.js';
import { getEvaluator, isAnswered } from '../grading/evaluators.js';
import { gradeQuestion, percentageOf, round2 } from '../grading/grade.js';
import { seededShuffle } from '../grading/shuffle.js';

/*
 * Role-specific projections. Every field is copied explicitly from trusted
 * rows; answer keys, rubrics and explanations are only included where the
 * release policy allows.
 */

export const totalMarks = (questions: Pick<QuestionRow, 'marks'>[]) =>
  round2(questions.reduce((sum, q) => sum + q.marks, 0));

function answerDirection(q: QuestionRow, test: Pick<TestRow, 'language'>): 'rtl' | 'auto' {
  if (q.question_type === 'translation') {
    return isRtlLanguage((q.content as { target_language?: string }).target_language) ? 'rtl' : 'auto';
  }
  return !isAutoGradedType(q.question_type) && isRtlLanguage(test.language) ? 'rtl' : 'auto';
}

/** Question order for an attempt: stable per attempt when shuffling is enabled. */
export function orderedQuestions(bundle: Pick<AttemptBundle, 'attempt' | 'test' | 'questions'>): QuestionRow[] {
  const sorted = [...bundle.questions].sort((a, b) => a.position - b.position);
  return bundle.test.shuffle_questions ? seededShuffle(sorted, bundle.attempt.id) : sorted;
}

function studentContent(q: QuestionRow, attemptId: string, test: TestRow): Record<string, unknown> {
  return getEvaluator(q.question_type).toStudentContent(q.content as never, `${attemptId}:${q.id}`, test.shuffle_options);
}

export function toStudentQuestion(q: QuestionRow, index: number, attemptId: string, test: TestRow): StudentQuestion {
  return {
    id: q.id,
    number: index + 1,
    question_type: q.question_type,
    prompt: q.prompt,
    content: studentContent(q, attemptId, test),
    marks: q.marks,
    answer_dir: answerDirection(q, test),
  };
}

export function toStudentAttemptState(bundle: AttemptBundle): StudentAttemptState {
  const { attempt, test, answers } = bundle;
  const questions = orderedQuestions(bundle);
  return {
    attempt: {
      id: attempt.id,
      status: attempt.status,
      student_name: attempt.student_name,
      attempt_number: attempt.attempt_number,
      started_at: attempt.started_at,
      deadline_at: attempt.deadline_at,
      submitted_at: attempt.submitted_at,
    },
    server_time: bundle.server_time,
    test: {
      title: test.title,
      subject: test.subject_name ?? '',
      topic: test.topic_name ?? null,
      language: test.language,
      instructions: test.instructions,
      duration_minutes: test.duration_minutes,
      total_marks: totalMarks(questions),
      question_count: questions.length,
    },
    questions: questions.map((q, i) => toStudentQuestion(q, i, attempt.id, test)),
    answers: Object.fromEntries(
      answers.map((a) => [a.question_id, { answer: a.answer, revision: Number(a.client_revision) }]),
    ),
  };
}

export function toPublicTestInfo(
  test: TestRow,
  questions: Pick<QuestionRow, 'marks'>[],
  names: { subject: string; topic: string | null },
): PublicTestInfo {
  return {
    title: test.title,
    description: test.description,
    subject: names.subject,
    topic: names.topic,
    language: test.language,
    difficulty: test.difficulty,
    instructions: test.instructions,
    learning_objectives: test.learning_objectives,
    duration_minutes: test.duration_minutes,
    passing_percentage: test.passing_percentage,
    max_attempts: test.max_attempts,
    question_count: questions.length,
    total_marks: totalMarks(questions),
    identity_fields: test.identity_fields,
  };
}

// ----------------------------------------------------------------- release ---

export function computeVisibility(
  test: Pick<TestRow, 'result_release_policy' | 'show_correct_answers' | 'show_explanations'>,
  attempt: Pick<AttemptRow, 'status' | 'grading_status' | 'results_released_at'>,
): ResultVisibility {
  const hidden = (reason: string): ResultVisibility => ({
    released: false,
    reason,
    provisional: false,
    show_correct_answers: false,
    show_explanations: false,
  });

  if (attempt.status === 'in_progress') return hidden('The test has not been submitted yet.');
  if (attempt.grading_status === 'grading' || attempt.grading_status === 'not_submitted') {
    return hidden('Your answers are being marked. Please refresh in a moment.');
  }

  const complete = attempt.grading_status === 'complete';
  if (test.result_release_policy === 'after_grading' && !complete) {
    return hidden('Some answers are being reviewed. Your results will appear here afterwards.');
  }
  if (test.result_release_policy === 'manual' && attempt.results_released_at === null) {
    return hidden('Your results will be available once they are released.');
  }

  return {
    released: true,
    reason: null,
    provisional: !complete,
    show_correct_answers: test.show_correct_answers,
    show_explanations: test.show_explanations,
  };
}

// ----------------------------------------------------------------- results ---

export function timeTakenSeconds(attempt: Pick<AttemptRow, 'started_at' | 'submitted_at' | 'deadline_at'>): number | null {
  if (!attempt.submitted_at) return null;
  const end = Math.min(Date.parse(attempt.submitted_at), Date.parse(attempt.deadline_at));
  return Math.max(0, Math.round((end - Date.parse(attempt.started_at)) / 1000));
}

export function describeCorrectAnswer(q: QuestionRow): string | null {
  try {
    return getEvaluator(q.question_type).describeAnswer(q.content as never, q.answer_key as never);
  } catch {
    return null;
  }
}

export function formatAnswer(q: QuestionRow, answer: AnswerRow['answer'] | undefined): string {
  if (!isAnswered(answer)) return '';
  try {
    return getEvaluator(q.question_type).formatAnswer(q.content as never, answer ?? null);
  } catch {
    return '';
  }
}

export function outcomeFor(q: QuestionRow, a: AnswerRow | undefined, test: Pick<TestRow, 'negative_marking' | 'partial_credit'>): GradeOutcome {
  if (!isAnswered(a?.answer)) return 'unanswered';
  if (a?.awarded_marks === null || a?.awarded_marks === undefined) {
    if (!isAutoGradedType(q.question_type) || a?.grading_status === 'pending_review') return 'pending_review';
    return gradeQuestion(q, a?.answer, { negativeMarking: test.negative_marking, partialCredit: test.partial_credit }).outcome;
  }
  if (a.awarded_marks >= q.marks) return 'correct';
  if (a.awarded_marks > 0) return 'partial';
  return 'incorrect';
}

export function toStudentResultView(bundle: AttemptBundle): StudentResultView {
  const { attempt, test, answers } = bundle;
  const questions = orderedQuestions(bundle);
  const visibility = computeVisibility(test, attempt);
  const byQuestion = new Map(answers.map((a) => [a.question_id, a]));

  const view: StudentResultView = {
    attempt: {
      id: attempt.id,
      student_name: attempt.student_name,
      attempt_number: attempt.attempt_number,
      status: attempt.status,
      started_at: attempt.started_at,
      submitted_at: attempt.submitted_at,
      submission_type: attempt.submission_type,
      time_taken_seconds: timeTakenSeconds(attempt),
    },
    test: {
      title: test.title,
      subject: test.subject_name ?? '',
      topic: test.topic_name ?? null,
      passing_percentage: test.passing_percentage,
      language: test.language,
    },
    visibility,
    score: null,
    questions: null,
  };
  if (!visibility.released) return view;

  const maximum = attempt.maximum_marks ?? totalMarks(questions);
  const obtained = visibility.provisional
    ? round2(Math.max(0, answers.reduce((sum, a) => sum + (a.awarded_marks ?? 0), 0)))
    : (attempt.final_score ?? 0);

  view.score = {
    obtained,
    maximum,
    percentage: percentageOf(obtained, maximum),
    passed: visibility.provisional ? null : attempt.passed,
    correct: attempt.correct_count ?? 0,
    incorrect: attempt.incorrect_count ?? 0,
    unanswered: attempt.unanswered_count ?? 0,
    pending_review: attempt.pending_review_count ?? 0,
  };

  view.questions = questions.map((q, i): StudentQuestionResult => {
    const a = byQuestion.get(q.id);
    return {
      number: i + 1,
      question_type: q.question_type,
      prompt: q.prompt,
      content: studentContent(q, attempt.id, test),
      marks: q.marks,
      answer_dir: answerDirection(q, test),
      your_answer: a?.answer ?? null,
      your_answer_text: formatAnswer(q, a?.answer),
      awarded_marks: a?.awarded_marks ?? null,
      outcome: outcomeFor(q, a, test),
      correct_answer: visibility.show_correct_answers ? describeCorrectAnswer(q) : null,
      explanation: visibility.show_explanations ? q.explanation : null,
      feedback: a?.grading_status === 'reviewed' ? a.feedback : null,
    };
  });
  return view;
}
