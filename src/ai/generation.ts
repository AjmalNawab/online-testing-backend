import { QUESTION_TYPE_LABELS, isAutoGradedType, type QuestionType } from '../contracts/constants.js';
import type { AiGenerateTestRequest } from '../contracts/ai-schemas.js';
import { questionInputSchema, type QuestionDefinition, type QuestionInput } from '../contracts/question-schemas.js';

/*
 * AI test generation: prompt, response schema, and strict validation of the
 * model's output. Nothing generated is trusted: every question goes through
 * the same validation as a manually written one, duplicates are dropped and
 * marks are assigned by the server, not the model.
 */

const item = { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] };
const strings = { type: 'array', items: { type: 'string' } };

/** Flat question shape covering every type; unused fields are "" or []. */
function questionJsonSchema(types: readonly QuestionType[]) {
  const properties = {
    question_type: { type: 'string', enum: [...types] },
    prompt: { type: 'string' },
    options: { type: 'array', items: item },
    correct_option_ids: strings,
    true_false_answer: { type: 'boolean' },
    blanks: { type: 'array', items: { type: 'object', properties: { accepted: strings }, required: ['accepted'] } },
    left_items: { type: 'array', items: item },
    right_items: { type: 'array', items: item },
    pairs: {
      type: 'array',
      items: { type: 'object', properties: { left_id: { type: 'string' }, right_id: { type: 'string' } }, required: ['left_id', 'right_id'] },
    },
    order_items: { type: 'array', items: item },
    correct_order: strings,
    source_language: { type: 'string' },
    target_language: { type: 'string' },
    source_text: { type: 'string' },
    code_language: { type: 'string' },
    starter_code: { type: 'string' },
    required_words: strings,
    model_answer: { type: 'string' },
    key_points: strings,
    rubric: { type: 'string' },
    explanation: { type: 'string' },
  };
  return { type: 'object', properties, required: Object.keys(properties) };
}

export function generatedTestJsonSchema(types: readonly QuestionType[]) {
  return {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      instructions: { type: 'string' },
      questions: { type: 'array', items: questionJsonSchema(types) },
    },
    required: ['title', 'description', 'instructions', 'questions'],
  };
}

const TYPE_RULES: Record<QuestionType, string> = {
  mcq_single: 'mcq_single: 4 options with ids "a","b","c","d"; exactly one id in correct_option_ids; plausible distractors.',
  mcq_multiple: 'mcq_multiple: 4-6 options with ids "a".."f"; 2 or more ids in correct_option_ids; tell the student to select all that apply.',
  true_false: 'true_false: a clear statement that is unambiguously true or false; set true_false_answer.',
  fill_blank: 'fill_blank: mark each blank in the prompt with exactly "___"; provide one blanks entry per blank, in order, listing every acceptable answer (e.g. contractions, spelling variants, numerals and words).',
  matching: 'matching: 3-6 left_items (ids "l1".."l6") and right_items (ids "r1".."r7", optionally one extra distractor); pairs maps every left id to one right id.',
  ordering: 'ordering: 3-7 order_items (ids "i1".."i7"); correct_order lists every id once in the correct sequence.',
  short_answer: 'short_answer: an open question answerable in 1-3 sentences; give model_answer, 2-4 key_points and a marking rubric.',
  long_answer: 'long_answer: an essay/paragraph question; give model_answer, key_points and a rubric describing how marks are awarded.',
  sentence_construction: 'sentence_construction: ask the student to write a sentence; list required_words; give a model_answer and rubric.',
  translation: 'translation: set source_language and target_language as language codes (e.g. "ur", "en"), put the text to translate in source_text; give model_answer and rubric.',
  code: 'code: set code_language (e.g. "python"); optional starter_code; ask for a small, well-specified piece of code; give model_answer, key_points and rubric. Do not require running the code.',
};

export function buildGenerationPrompts(req: AiGenerateTestRequest, count: number, avoidPrompts: string[] = []) {
  const types = req.question_types;
  const system = [
    'You are an expert assessment designer who writes accurate, fair, unambiguous test questions for any subject.',
    'Every answer key must be factually correct. If a question could have more than one valid answer, rewrite it or list all valid answers.',
    'Match the requested difficulty and audience. Never repeat or closely paraphrase a question.',
    'Return only data that follows the JSON schema. For fields that do not apply to a question type use "" or [].',
  ].join('\n');

  const lines = [
    `Create ${count} question(s) for an assessment.`,
    `Subject: ${req.subject}`,
    req.topic ? `Topic: ${req.topic}` : null,
    `Difficulty: ${req.difficulty}`,
    `Write questions, options and answers in language: ${req.language}.`,
    req.explanation_language
      ? `Write each explanation in ${req.language} followed by a short version in language ${req.explanation_language}.`
      : null,
    req.learning_objectives.length ? `Learning objectives:\n- ${req.learning_objectives.join('\n- ')}` : null,
    `Allowed question types: ${types.map((t) => `${t} (${QUESTION_TYPE_LABELS[t]})`).join(', ')}.`,
    types.length > 1 && count >= types.length
      ? 'Use every allowed type at least once and spread the questions sensibly across them.'
      : null,
    'Rules per type:',
    ...types.map((t) => `- ${TYPE_RULES[t]}`),
    req.include_explanations
      ? 'Give each question a brief explanation of the correct answer.'
      : 'Leave every explanation as "".',
    'Also propose a short title, a one-sentence description and student instructions for the test.',
    req.instructions ? `Additional instructions from the teacher:\n${req.instructions}` : null,
    avoidPrompts.length
      ? `Do not repeat or closely resemble these existing questions:\n${avoidPrompts.slice(0, 100).map((p) => `- ${p.slice(0, 200)}`).join('\n')}`
      : null,
  ];
  return { system, prompt: lines.filter(Boolean).join('\n') };
}

/** Output budget: generous enough for thinking models, bounded for cost. */
export const outputBudget = (count: number) => Math.min(65_536, 8_000 + count * 1_500);

// ---------------------------------------------------------------------------
// Conversion and validation
// ---------------------------------------------------------------------------

interface GeneratedItem {
  id: string;
  text: string;
}
interface GeneratedQuestion {
  question_type: QuestionType;
  prompt: string;
  options: GeneratedItem[];
  correct_option_ids: string[];
  true_false_answer: boolean;
  blanks: { accepted: string[] }[];
  left_items: GeneratedItem[];
  right_items: GeneratedItem[];
  pairs: { left_id: string; right_id: string }[];
  order_items: GeneratedItem[];
  correct_order: string[];
  source_language: string;
  target_language: string;
  source_text: string;
  code_language: string;
  starter_code: string;
  required_words: string[];
  model_answer: string;
  key_points: string[];
  rubric: string;
  explanation: string;
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const orNull = (v: unknown): string | null => str(v) || null;

/** Re-ids items as prefix1..n (or a..z) and returns the id mapping. */
function reId(items: GeneratedItem[], letters: boolean, prefix = ''): { list: GeneratedItem[]; map: Map<string, string> } {
  const map = new Map<string, string>();
  const list = items
    .filter((i) => i && str(i.text))
    .map((i, idx) => {
      const id = letters ? String.fromCharCode(97 + idx) : `${prefix}${idx + 1}`;
      map.set(str(i.id), id);
      return { id, text: str(i.text) };
    });
  return { list, map };
}

export function toQuestionInput(raw: unknown, marks: number): QuestionInput {
  const q = (raw ?? {}) as Partial<GeneratedQuestion>;
  const type = q.question_type as QuestionType;
  const base = {
    question_type: type,
    prompt: str(q.prompt).replace(/_{2,}/g, '___'),
    rubric: orNull(q.rubric),
    explanation: orNull(q.explanation),
    marks,
    negative_marks: 0,
    partial_credit: null,
    grading_method: isAutoGradedType(type) ? ('auto' as const) : ('ai_assisted' as const),
  };
  const written = { model_answer: orNull(q.model_answer), key_points: arr<string>(q.key_points).map(str).filter(Boolean).slice(0, 20) };

  switch (type) {
    case 'mcq_single':
    case 'mcq_multiple': {
      const { list, map } = reId(arr(q.options), true);
      const correct = arr<string>(q.correct_option_ids).map((id) => map.get(str(id)) ?? '__missing__');
      return {
        ...base,
        content: { options: list },
        answer_key: { correct: type === 'mcq_single' ? (correct.length === 1 ? correct[0] : '__ambiguous__') : correct },
      };
    }
    case 'true_false':
      return { ...base, content: {}, answer_key: { correct: q.true_false_answer } };
    case 'fill_blank': {
      const blanks = arr<{ accepted: string[] }>(q.blanks).map((b) => ({ accepted: arr<string>(b?.accepted).map(str).filter(Boolean) }));
      return { ...base, content: { blanks: blanks.length }, answer_key: { blanks, case_sensitive: false } };
    }
    case 'matching': {
      const left = reId(arr(q.left_items), false, 'l');
      const right = reId(arr(q.right_items), false, 'r');
      const pairs: Record<string, string> = {};
      for (const p of arr<{ left_id: string; right_id: string }>(q.pairs)) {
        const l = left.map.get(str(p?.left_id));
        const r = right.map.get(str(p?.right_id));
        if (l && r) pairs[l] = r;
      }
      return { ...base, content: { left: left.list, right: right.list }, answer_key: { pairs } };
    }
    case 'ordering': {
      const { list, map } = reId(arr(q.order_items), false, 'i');
      return {
        ...base,
        content: { items: list },
        answer_key: { order: arr<string>(q.correct_order).map((id) => map.get(str(id)) ?? '__missing__') },
      };
    }
    case 'short_answer':
    case 'long_answer':
      return { ...base, content: { max_words: null }, answer_key: written };
    case 'sentence_construction':
      return { ...base, content: { required_words: arr<string>(q.required_words).map(str).filter(Boolean).slice(0, 20) }, answer_key: written };
    case 'translation':
      return {
        ...base,
        content: {
          source_language: str(q.source_language).toLowerCase(),
          target_language: str(q.target_language).toLowerCase(),
          source_text: orNull(q.source_text),
        },
        answer_key: written,
      };
    case 'code':
      return { ...base, content: { language: str(q.code_language) || 'text', starter_code: orNull(q.starter_code) }, answer_key: written };
    default:
      return { ...base, content: {}, answer_key: {} };
  }
}

const words = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean));

/** Near-duplicate check: identical text or ≥ 90% word overlap. */
export function isNearDuplicate(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.max(x.size, y.size) >= 0.9;
}

export interface GenerationResult {
  title: string | null;
  description: string | null;
  instructions: string | null;
  questions: QuestionDefinition[];
  issues: string[];
}

/** Validates raw model output against the request. Invalid questions are dropped with a reason. */
export function validateGeneratedTest(
  raw: unknown,
  allowedTypes: readonly QuestionType[],
  marks: number,
  existingPrompts: string[] = [],
): GenerationResult {
  const data = (raw ?? {}) as Record<string, unknown>;
  const issues: string[] = [];
  const questions: QuestionDefinition[] = [];
  const seen = [...existingPrompts];

  if (!Array.isArray(data.questions)) {
    return { title: null, description: null, instructions: null, questions: [], issues: ['The response contained no questions.'] };
  }

  data.questions.forEach((rawQuestion, index) => {
    const label = `Generated question ${index + 1}`;
    const type = (rawQuestion as { question_type?: string })?.question_type as QuestionType;
    if (!allowedTypes.includes(type)) {
      issues.push(`${label}: type "${String(type)}" was not requested.`);
      return;
    }
    const parsed = questionInputSchema.safeParse(toQuestionInput(rawQuestion, marks));
    if (!parsed.success) {
      issues.push(`${label}: ${[...new Set(parsed.error.issues.map((i) => i.message))].join('; ')}`);
      return;
    }
    if (seen.some((p) => isNearDuplicate(p, parsed.data.prompt))) {
      issues.push(`${label}: duplicate of another question.`);
      return;
    }
    seen.push(parsed.data.prompt);
    questions.push(parsed.data);
  });

  return {
    title: orNull(data.title)?.slice(0, 200) ?? null,
    description: orNull(data.description)?.slice(0, 4000) ?? null,
    instructions: orNull(data.instructions)?.slice(0, 8000) ?? null,
    questions,
    issues,
  };
}
