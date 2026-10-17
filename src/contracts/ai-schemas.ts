import { z } from 'zod';
import { LIMITS, QUESTION_TYPES } from './constants.js';
import { marksSchema } from './question-schemas.js';

const languageCode = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Use a language code such as en, ur or fr-CA');

export const aiGenerateTestSchema = z.object({
  /** Subject name; created if it does not exist yet. */
  subject: z.string().trim().min(1, 'Subject is required').max(100),
  topic: z.string().trim().max(150).nullable().default(null),
  title: z.string().trim().max(200).nullable().default(null),
  difficulty: z.string().trim().min(1).max(40).default('medium'),
  question_count: z.number().int().min(1).max(LIMITS.aiQuestionsPerRequest),
  duration_minutes: z.number().int().min(1).max(1440),
  question_types: z.array(z.enum(QUESTION_TYPES)).min(1, 'Choose at least one question type'),
  marks_per_question: marksSchema.refine((n) => n > 0 && n <= 1000, 'Between 0 and 1000').default(1),
  /** Language the questions are written in. */
  language: languageCode.default('en'),
  /** Optional second language for explanations/translations, e.g. "ur". */
  explanation_language: languageCode.nullable().default(null),
  learning_objectives: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  instructions: z.string().trim().max(2000).nullable().default(null),
  include_explanations: z.boolean().default(true),
});
export type AiGenerateTestInput = z.input<typeof aiGenerateTestSchema>;
export type AiGenerateTestRequest = z.output<typeof aiGenerateTestSchema>;

export const aiRegenerateQuestionSchema = z.object({
  test_id: z.uuid(),
  question_type: z.enum(QUESTION_TYPES),
  marks: marksSchema.refine((n) => n > 0, 'Must be greater than 0'),
  /** Prompts already in the editor, so the new question is different. */
  existing_prompts: z.array(z.string().max(8000)).max(LIMITS.questionsPerTest).default([]),
  instructions: z.string().trim().max(1000).nullable().default(null),
});
export type AiRegenerateQuestionRequest = z.output<typeof aiRegenerateQuestionSchema>;

export const aiGradeSuggestionSchema = z.object({
  question_id: z.uuid(),
});
