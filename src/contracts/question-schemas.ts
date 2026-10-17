import { z } from 'zod';
import { GRADING_METHODS, LIMITS, QUESTION_TYPES, isAutoGradedType, type QuestionType } from './constants.js';

/*
 * Per-type question definitions.
 *   content    → public: shown to students
 *   answer_key → secret: used only for grading and (after release) feedback
 *   answer     → what a student submits
 */

const hasAtMostTwoDecimals = (n: number) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
export const marksSchema = z
  .number({ error: 'Enter a number' })
  .refine(Number.isFinite, 'Enter a number')
  .refine(hasAtMostTwoDecimals, 'Use at most two decimal places');

const itemId = z.string().regex(/^[a-z0-9]{1,12}$/, 'Ids use lowercase letters and digits');
const itemSchema = z.object({ id: itemId, text: z.string().trim().min(1, 'Text is required').max(1000) });
export type ChoiceItem = z.output<typeof itemSchema>;

const items = (min: number, max: number, label: string) =>
  z
    .array(itemSchema)
    .min(min, `Add at least ${min} ${label}`)
    .max(max, `At most ${max} ${label}`)
    .superRefine((list, ctx) => {
      const ids = list.map((i) => i.id);
      if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: `${label} ids must be unique` });
      const texts = list.map((i) => i.text.trim().toLowerCase());
      if (new Set(texts).size !== texts.length) ctx.addIssue({ code: 'custom', message: `${label} must not repeat` });
    });

const languageCode = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Use a language code such as en, ur or fr-CA');
const optionalString = (max: number) => z.string().trim().max(max).nullable().default(null);

const writtenKeySchema = z.object({
  model_answer: optionalString(LIMITS.writtenAnswerChars),
  key_points: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
});

export const questionTypeSchemas = {
  mcq_single: {
    content: z.object({ options: items(2, LIMITS.optionsPerQuestion, 'options') }),
    answerKey: z.object({ correct: itemId }),
    answer: itemId,
  },
  mcq_multiple: {
    content: z.object({ options: items(2, LIMITS.optionsPerQuestion, 'options') }),
    answerKey: z.object({ correct: z.array(itemId).min(1, 'Choose at least one correct option') }),
    answer: z.array(itemId).max(LIMITS.optionsPerQuestion),
  },
  true_false: {
    content: z.object({}),
    answerKey: z.object({ correct: z.boolean({ error: 'Choose True or False' }) }),
    answer: z.boolean(),
  },
  fill_blank: {
    // The prompt marks each blank with ___ (three or more underscores).
    content: z.object({ blanks: z.number().int().min(1).max(LIMITS.blanksPerQuestion) }),
    answerKey: z.object({
      blanks: z
        .array(z.object({ accepted: z.array(z.string().trim().min(1).max(300)).min(1, 'Add an accepted answer').max(20) }))
        .min(1)
        .max(LIMITS.blanksPerQuestion),
      case_sensitive: z.boolean().default(false),
    }),
    answer: z.array(z.string().max(500)).max(LIMITS.blanksPerQuestion),
  },
  matching: {
    content: z.object({
      left: items(2, LIMITS.itemsPerQuestion, 'left items'),
      right: items(2, LIMITS.itemsPerQuestion, 'right items'),
    }),
    // left id -> right id
    answerKey: z.object({ pairs: z.record(itemId, itemId) }),
    answer: z.record(itemId, itemId),
  },
  ordering: {
    content: z.object({ items: items(2, LIMITS.itemsPerQuestion, 'items') }),
    answerKey: z.object({ order: z.array(itemId).min(2) }),
    answer: z.array(itemId).max(LIMITS.itemsPerQuestion),
  },
  short_answer: {
    content: z.object({ max_words: z.number().int().min(1).max(5000).nullable().default(null) }),
    answerKey: writtenKeySchema,
    answer: z.string().max(LIMITS.writtenAnswerChars),
  },
  long_answer: {
    content: z.object({ max_words: z.number().int().min(1).max(10000).nullable().default(null) }),
    answerKey: writtenKeySchema,
    answer: z.string().max(LIMITS.writtenAnswerChars),
  },
  sentence_construction: {
    content: z.object({ required_words: z.array(z.string().trim().min(1).max(100)).max(20).default([]) }),
    answerKey: writtenKeySchema,
    answer: z.string().max(LIMITS.writtenAnswerChars),
  },
  translation: {
    content: z.object({
      source_language: languageCode,
      target_language: languageCode,
      source_text: optionalString(8000),
    }),
    answerKey: writtenKeySchema,
    answer: z.string().max(LIMITS.writtenAnswerChars),
  },
  code: {
    content: z.object({
      language: z.string().trim().min(1).max(40),
      starter_code: optionalString(LIMITS.writtenAnswerChars),
    }),
    answerKey: writtenKeySchema,
    answer: z.string().max(LIMITS.writtenAnswerChars),
  },
} satisfies Record<QuestionType, { content: z.ZodType; answerKey: z.ZodType; answer: z.ZodType }>;

export type QuestionContent<T extends QuestionType> = z.output<(typeof questionTypeSchemas)[T]['content']>;
export type QuestionAnswerKey<T extends QuestionType> = z.output<(typeof questionTypeSchemas)[T]['answerKey']>;
export type QuestionAnswer<T extends QuestionType> = z.output<(typeof questionTypeSchemas)[T]['answer']>;

/** Generic student answer shape accepted when saving (type-checked again at grading). */
export const answerValueSchema = z.union([
  z.string().max(LIMITS.writtenAnswerChars),
  z.boolean(),
  z.array(z.string().max(500)).max(50),
  z.record(z.string().max(12), z.string().max(12)),
  z.null(),
]);
export type AnswerValue = z.output<typeof answerValueSchema>;

interface LooseContent {
  options?: { id: string }[];
  blanks?: number;
  left?: { id: string }[];
  right?: { id: string }[];
  items?: { id: string }[];
}
interface LooseKey {
  correct?: string | string[] | boolean;
  blanks?: unknown[];
  pairs?: Record<string, string>;
  order?: string[];
}

/** Cross-field checks between a question's content and answer key (both already shape-validated). */
function crossValidate(type: QuestionType, content: LooseContent, key: LooseKey, prompt: string): string[] {
  const problems: string[] = [];
  const ids = (list: { id: string }[] | undefined) => (list ?? []).map((i) => i.id);
  switch (type) {
    case 'mcq_single':
      if (!ids(content.options).includes(key.correct as string)) problems.push('Choose which option is correct');
      break;
    case 'mcq_multiple': {
      const correct = (key.correct as string[]) ?? [];
      if (new Set(correct).size !== correct.length) problems.push('Correct options must not repeat');
      if (correct.some((c) => !ids(content.options).includes(c))) problems.push('A correct option does not exist');
      break;
    }
    case 'fill_blank': {
      if ((key.blanks ?? []).length !== content.blanks) problems.push('Provide accepted answers for every blank');
      const marked = (prompt.match(/_{3,}/g) ?? []).length;
      if (marked > 0 && marked !== content.blanks)
        problems.push(`The question text has ${marked} blank(s) (___) but ${content.blanks} are configured`);
      break;
    }
    case 'matching': {
      const left = ids(content.left);
      const right = new Set(ids(content.right));
      const pairs = key.pairs ?? {};
      if (left.some((id) => !pairs[id])) problems.push('Match every left item to a right item');
      if (Object.keys(pairs).some((id) => !left.includes(id))) problems.push('A matched left item does not exist');
      if (Object.values(pairs).some((id) => !right.has(id))) problems.push('A matched right item does not exist');
      break;
    }
    case 'ordering': {
      const all = ids(content.items).sort();
      const order = [...(key.order ?? [])].sort();
      if (all.length !== order.length || all.some((id, i) => id !== order[i]))
        problems.push('The correct order must contain every item exactly once');
      break;
    }
  }
  return problems;
}

export const questionInputSchema = z
  .object({
    id: z.uuid().optional(),
    question_type: z.enum(QUESTION_TYPES),
    prompt: z.string().trim().min(1, 'Question text is required').max(8000),
    content: z.record(z.string(), z.unknown()).default({}),
    answer_key: z.record(z.string(), z.unknown()).default({}),
    grading_method: z.enum(GRADING_METHODS),
    rubric: optionalString(8000),
    explanation: optionalString(8000),
    marks: marksSchema.refine((n) => n > 0, 'Marks must be greater than 0').refine((n) => n <= 1000, 'At most 1000'),
    negative_marks: marksSchema.refine((n) => n >= 0, 'Cannot be negative').default(0),
    partial_credit: z.boolean().nullable().default(null),
  })
  .transform((q, ctx) => {
    const issue = (message: string, path: string[]) => ctx.addIssue({ code: 'custom', message, path });
    const schemas = questionTypeSchemas[q.question_type];

    const content = schemas.content.safeParse(q.content);
    const key = schemas.answerKey.safeParse(q.answer_key);
    if (!content.success) content.error.issues.forEach((i) => issue(i.message, ['content', ...i.path.map(String)]));
    if (!key.success) key.error.issues.forEach((i) => issue(i.message, ['answer_key', ...i.path.map(String)]));

    if (q.negative_marks > q.marks) issue("Negative marks cannot exceed the question's marks", ['negative_marks']);
    const auto = isAutoGradedType(q.question_type);
    if (auto && q.grading_method !== 'auto') issue('This question type is graded automatically', ['grading_method']);
    if (!auto && q.grading_method === 'auto') issue('Choose manual or AI-assisted grading', ['grading_method']);

    if (!content.success || !key.success) return z.NEVER;
    for (const p of crossValidate(q.question_type, content.data as LooseContent, key.data as LooseKey, q.prompt)) issue(p, ['answer_key']);
    return { ...q, content: content.data as Record<string, unknown>, answer_key: key.data as Record<string, unknown> };
  });

export type QuestionInput = z.input<typeof questionInputSchema>;
export type QuestionDefinition = z.output<typeof questionInputSchema>;
