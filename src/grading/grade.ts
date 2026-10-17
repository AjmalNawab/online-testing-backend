import type { AnswerGradingStatus, AttemptGradingStatus, GradeOutcome } from '../contracts/constants.js';
import { isAutoGradedType } from '../contracts/constants.js';
import type { AnswerValue } from '../contracts/question-schemas.js';
import type { AnswerRow, QuestionRow } from '../database/types.js';
import { getEvaluator, isAnswered } from './evaluators.js';

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type GradableQuestion = Pick<
  QuestionRow,
  'id' | 'question_type' | 'content' | 'answer_key' | 'marks' | 'negative_marks' | 'partial_credit'
>;

export interface GradingPolicy {
  negativeMarking: boolean;
  /** Test-level default; a question's own partial_credit overrides it. */
  partialCredit: boolean;
}

export interface QuestionGrade {
  question_id: string;
  outcome: GradeOutcome;
  awarded_marks: number | null;
  is_correct: boolean | null;
  grading_status: Extract<AnswerGradingStatus, 'auto_graded' | 'pending_review'>;
}

/**
 * Grades one question from trusted question data. Malformed answers never
 * throw; they score 0.
 *   - fraction 1           → full marks
 *   - 0 < fraction < 1     → fraction × marks when partial credit applies, else wrong
 *   - wrong                → −negative_marks if negative marking is on, else 0
 *   - unanswered           → 0 (never negative)
 */
export function gradeQuestion(
  question: GradableQuestion,
  answer: AnswerValue | undefined,
  policy: GradingPolicy,
): QuestionGrade {
  const base = { question_id: question.id };

  if (!isAnswered(answer)) {
    return { ...base, outcome: 'unanswered', awarded_marks: 0, is_correct: false, grading_status: 'auto_graded' };
  }
  if (!isAutoGradedType(question.question_type)) {
    return { ...base, outcome: 'pending_review', awarded_marks: null, is_correct: null, grading_status: 'pending_review' };
  }

  const evaluator = getEvaluator(question.question_type);
  let fraction = 0;
  try {
    fraction = evaluator.score(question.content as never, question.answer_key as never, answer);
  } catch {
    fraction = 0;
  }
  fraction = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));

  if (fraction >= 1 - 1e-9) {
    return { ...base, outcome: 'correct', awarded_marks: round2(question.marks), is_correct: true, grading_status: 'auto_graded' };
  }
  const partialAllowed = question.partial_credit ?? policy.partialCredit;
  if (partialAllowed && fraction > 0) {
    return {
      ...base,
      outcome: 'partial',
      awarded_marks: round2(fraction * question.marks),
      is_correct: false,
      grading_status: 'auto_graded',
    };
  }
  return {
    ...base,
    outcome: 'incorrect',
    awarded_marks: policy.negativeMarking ? round2(-question.negative_marks) : 0,
    is_correct: false,
    grading_status: 'auto_graded',
  };
}

export function percentageOf(score: number, maximum: number): number {
  if (maximum <= 0) return 0;
  return round2(Math.min(100, Math.max(0, (score / maximum) * 100)));
}

export interface AttemptSummary {
  objective_score: number;
  /** All marks awarded so far (objective + reviewed written). */
  provisional_score: number;
  final_score: number | null;
  maximum_marks: number;
  percentage: number | null;
  passed: boolean | null;
  correct_count: number;
  incorrect_count: number;
  unanswered_count: number;
  pending_review_count: number;
  grading_status: Extract<AttemptGradingStatus, 'pending_review' | 'complete'>;
}

/**
 * Grades a whole attempt. Answers already reviewed by an administrator keep
 * their reviewed marks; everything else is recomputed — so this is idempotent
 * and is re-run after submission and after each review.
 */
export function gradeAttempt(
  questions: GradableQuestion[],
  answers: Pick<AnswerRow, 'question_id' | 'answer' | 'awarded_marks' | 'grading_status'>[],
  policy: GradingPolicy,
  passingPercentage: number,
): { grades: QuestionGrade[]; summary: AttemptSummary } {
  const byQuestion = new Map(answers.map((a) => [a.question_id, a]));
  const grades: QuestionGrade[] = [];
  let objective = 0;
  let awardedTotal = 0;
  let maximum = 0;
  let correct = 0;
  let incorrect = 0;
  let unanswered = 0;
  let pending = 0;

  for (const question of questions) {
    maximum += question.marks;
    const stored = byQuestion.get(question.id);
    const answered = isAnswered(stored?.answer);

    let awarded: number | null;
    if (stored?.grading_status === 'reviewed' && stored.awarded_marks !== null) {
      awarded = stored.awarded_marks;
    } else {
      const grade = gradeQuestion(question, stored?.answer, policy);
      grades.push(grade);
      awarded = grade.awarded_marks;
    }

    if (awarded === null) {
      pending += 1;
      continue;
    }
    awardedTotal += awarded;
    if (isAutoGradedType(question.question_type)) objective += awarded;

    if (!answered) unanswered += 1;
    else if (awarded >= question.marks) correct += 1;
    else incorrect += 1;
  }

  maximum = round2(maximum);
  const complete = pending === 0;
  const finalScore = complete ? round2(Math.max(0, awardedTotal)) : null;
  const percentage = finalScore === null ? null : percentageOf(finalScore, maximum);

  return {
    grades,
    summary: {
      objective_score: round2(objective),
      provisional_score: round2(Math.max(0, awardedTotal)),
      final_score: finalScore,
      maximum_marks: maximum,
      percentage,
      passed: percentage === null ? null : percentage >= passingPercentage,
      correct_count: correct,
      incorrect_count: incorrect,
      unanswered_count: unanswered,
      pending_review_count: pending,
      grading_status: complete ? 'complete' : 'pending_review',
    },
  };
}
