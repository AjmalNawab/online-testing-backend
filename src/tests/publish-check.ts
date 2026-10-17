import { isAutoGradedType, type QuestionType } from '../contracts/constants.js';
import { questionInputSchema } from '../contracts/question-schemas.js';
import type { MarksSummary, PublishCheck } from '../contracts/responses.js';
import { round2 } from '../grading/grade.js';

export function summarizeMarks(questions: { question_type: QuestionType; marks: number }[]): MarksSummary {
  let auto = 0;
  let reviewed = 0;
  for (const q of questions) {
    if (isAutoGradedType(q.question_type)) auto += q.marks;
    else reviewed += q.marks;
  }
  return {
    total_marks: round2(auto + reviewed),
    auto_graded_marks: round2(auto),
    reviewed_marks: round2(reviewed),
    question_count: questions.length,
  };
}

const normalizePrompt = (p: string) => p.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Checks run before publication. Errors block publishing; warnings (such as
 * a marks mismatch or repeated questions) are shown to the administrator.
 */
export function publishCheck<Q extends { question_type: QuestionType; prompt: string; marks: number }>(
  settings: { intended_total_marks: number | null },
  questions: Q[],
): PublishCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (questions.length === 0) errors.push('Add at least one question before publishing.');

  questions.forEach((q, i) => {
    const parsed = questionInputSchema.safeParse(q);
    if (!parsed.success) {
      const unique = [...new Set(parsed.error.issues.map((issue) => issue.message))];
      errors.push(`Question ${i + 1}: ${unique.join('; ')}`);
    }
  });

  const seen = new Map<string, number>();
  questions.forEach((q, i) => {
    const key = normalizePrompt(q.prompt);
    const first = seen.get(key);
    if (first !== undefined && !['fill_blank'].includes(q.question_type)) {
      warnings.push(`Question ${i + 1} repeats question ${first + 1}.`);
    } else if (first === undefined) seen.set(key, i);
  });

  const summary = summarizeMarks(questions);
  if (questions.length > 0 && summary.total_marks <= 0) errors.push('The test must be worth more than 0 marks.');
  if (settings.intended_total_marks !== null && round2(settings.intended_total_marks) !== summary.total_marks) {
    warnings.push(
      `Questions add up to ${summary.total_marks} marks, but the intended total is ${settings.intended_total_marks}.`,
    );
  }
  return { errors, warnings, summary };
}
