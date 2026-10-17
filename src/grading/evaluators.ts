import type { GradeOutcome, QuestionType } from '../contracts/constants.js';
import {
  questionTypeSchemas,
  type AnswerValue,
  type ChoiceItem,
  type QuestionAnswerKey,
  type QuestionContent,
} from '../contracts/question-schemas.js';
import { textAnswerMatches } from './normalize.js';
import { seededDerange, seededShuffle } from './shuffle.js';

/**
 * Question evaluators. Each question type plugs in here:
 *   - score():            fraction correct in [0, 1] for auto-graded types
 *   - toStudentContent(): the public view (with per-attempt shuffling)
 *   - describeAnswer():   the correct answer in readable form (after release)
 *   - formatAnswer():     a student's answer in readable form
 *
 * To add a new type (e.g. code with a sandboxed test runner), add its schemas
 * to contracts/question-schemas.ts and an evaluator here. Student code is never
 * executed by this server.
 */

export interface Evaluator<T extends QuestionType = QuestionType> {
  autoGraded: boolean;
  score(content: QuestionContent<T>, key: QuestionAnswerKey<T>, answer: unknown): number;
  toStudentContent(content: QuestionContent<T>, seed: string, shuffleOptions: boolean): Record<string, unknown>;
  describeAnswer(content: QuestionContent<T>, key: QuestionAnswerKey<T>): string | null;
  formatAnswer(content: QuestionContent<T>, answer: AnswerValue): string;
}

const textOf = (list: ChoiceItem[], id: string) => list.find((i) => i.id === id)?.text ?? id;

/** Parses the answer against the type's schema; malformed answers score 0. */
function parseAnswer<T extends QuestionType>(type: T, answer: unknown) {
  const parsed = questionTypeSchemas[type].answer.safeParse(answer);
  return parsed.success ? (parsed.data as unknown) : undefined;
}

const writtenEvaluator = <T extends QuestionType>(): Evaluator<T> => ({
  autoGraded: false,
  score: () => 0,
  toStudentContent: (content) => ({ ...(content as Record<string, unknown>) }),
  describeAnswer: (_content, key) => (key as { model_answer: string | null }).model_answer,
  formatAnswer: (_content, answer) => (typeof answer === 'string' ? answer : ''),
});

export const evaluators: { [T in QuestionType]: Evaluator<T> } = {
  mcq_single: {
    autoGraded: true,
    score: (_content, key, answer) => (parseAnswer('mcq_single', answer) === key.correct ? 1 : 0),
    toStudentContent: (content, seed, shuffle) => ({
      options: shuffle ? seededShuffle(content.options, seed) : content.options,
    }),
    describeAnswer: (content, key) => textOf(content.options, key.correct),
    formatAnswer: (content, answer) => (typeof answer === 'string' ? textOf(content.options, answer) : ''),
  },

  mcq_multiple: {
    autoGraded: true,
    // Each correct choice earns 1/n; each wrong choice removes 1/n; floor 0.
    score: (content, key, answer) => {
      const selected = parseAnswer('mcq_multiple', answer) as string[] | undefined;
      if (!selected) return 0;
      const valid = new Set(content.options.map((o) => o.id));
      const correct = new Set(key.correct);
      let right = 0;
      let wrong = 0;
      for (const id of new Set(selected)) {
        if (!valid.has(id)) continue;
        if (correct.has(id)) right += 1;
        else wrong += 1;
      }
      return Math.max(0, (right - wrong) / correct.size);
    },
    toStudentContent: (content, seed, shuffle) => ({
      options: shuffle ? seededShuffle(content.options, seed) : content.options,
    }),
    describeAnswer: (content, key) => key.correct.map((id) => textOf(content.options, id)).join(', '),
    formatAnswer: (content, answer) =>
      Array.isArray(answer) ? answer.map((id) => textOf(content.options, id)).join(', ') : '',
  },

  true_false: {
    autoGraded: true,
    score: (_content, key, answer) => (parseAnswer('true_false', answer) === key.correct ? 1 : 0),
    toStudentContent: () => ({}),
    describeAnswer: (_content, key) => (key.correct ? 'True' : 'False'),
    formatAnswer: (_content, answer) => (typeof answer === 'boolean' ? (answer ? 'True' : 'False') : ''),
  },

  fill_blank: {
    autoGraded: true,
    score: (content, key, answer) => {
      const given = parseAnswer('fill_blank', answer) as string[] | undefined;
      if (!given) return 0;
      let right = 0;
      key.blanks.forEach((blank, i) => {
        if (typeof given[i] === 'string' && textAnswerMatches(given[i]!, blank.accepted, key.case_sensitive)) right += 1;
      });
      return right / content.blanks;
    },
    toStudentContent: (content) => ({ blanks: content.blanks }),
    describeAnswer: (_content, key) =>
      key.blanks.length === 1
        ? key.blanks[0]!.accepted.join(' / ')
        : key.blanks.map((b, i) => `${i + 1}) ${b.accepted.join(' / ')}`).join('; '),
    formatAnswer: (_content, answer) =>
      Array.isArray(answer) ? (answer.length === 1 ? answer[0]! : answer.map((a, i) => `${i + 1}) ${a}`).join('; ')) : '',
  },

  matching: {
    autoGraded: true,
    score: (content, key, answer) => {
      const given = parseAnswer('matching', answer) as Record<string, string> | undefined;
      if (!given) return 0;
      const right = content.left.filter((l) => given[l.id] !== undefined && given[l.id] === key.pairs[l.id]).length;
      return right / content.left.length;
    },
    toStudentContent: (content, seed, shuffle) => ({
      left: shuffle ? seededShuffle(content.left, `${seed}:left`) : content.left,
      // The right column is always shuffled; its order would otherwise reveal the answer.
      right: seededShuffle(content.right, `${seed}:right`),
    }),
    describeAnswer: (content, key) =>
      content.left.map((l) => `${l.text} → ${textOf(content.right, key.pairs[l.id] ?? '')}`).join('; '),
    formatAnswer: (content, answer) => {
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return '';
      const map = answer as Record<string, string>;
      return content.left
        .filter((l) => map[l.id])
        .map((l) => `${l.text} → ${textOf(content.right, map[l.id]!)}`)
        .join('; ');
    },
  },

  ordering: {
    autoGraded: true,
    score: (_content, key, answer) => {
      const given = parseAnswer('ordering', answer) as string[] | undefined;
      if (!given) return 0;
      const right = key.order.filter((id, i) => given[i] === id).length;
      return right / key.order.length;
    },
    // Always shuffled, never shown in the correct order.
    toStudentContent: (content, seed) => ({ items: seededDerange(content.items, `${seed}:order`) }),
    describeAnswer: (content, key) => key.order.map((id) => textOf(content.items, id)).join(' → '),
    formatAnswer: (content, answer) =>
      Array.isArray(answer) ? answer.map((id) => textOf(content.items, id)).join(' → ') : '',
  },

  short_answer: writtenEvaluator(),
  long_answer: writtenEvaluator(),
  sentence_construction: writtenEvaluator(),
  translation: writtenEvaluator(),
  code: writtenEvaluator(),
};

export function getEvaluator(type: QuestionType): Evaluator {
  return evaluators[type] as unknown as Evaluator;
}

export function isAnswered(answer: AnswerValue | undefined): boolean {
  if (answer === null || answer === undefined) return false;
  if (typeof answer === 'string') return answer.trim().length > 0;
  if (typeof answer === 'boolean') return true;
  if (Array.isArray(answer)) return answer.some((a) => typeof a === 'string' && a.trim().length > 0);
  return Object.values(answer).some((v) => typeof v === 'string' && v.length > 0);
}

export type { GradeOutcome };
