import { z } from 'zod';
import { LIMITS, RELEASE_POLICIES, TEST_STATUSES } from './constants.js';
import { answerValueSchema, marksSchema, questionInputSchema } from './question-schemas.js';

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .default(null)
    .transform((v) => (v && v.trim() ? v.trim() : null));

// -----------------------------------------------------------------------------
// Catalog
// -----------------------------------------------------------------------------

export const subjectInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  description: optionalText(2000),
});
export const subjectUpdateSchema = subjectInputSchema.partial().extend({ archived: z.boolean().optional() });

export const topicInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(150),
  description: optionalText(2000),
});
export const topicUpdateSchema = topicInputSchema.partial().extend({ archived: z.boolean().optional() });

export const categoryInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  description: optionalText(2000),
});
export const categoryUpdateSchema = categoryInputSchema.partial();

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

export const identityFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lowercase letters, digits and underscores'),
  label: z.string().trim().min(1).max(80),
  required: z.boolean().default(false),
  type: z.enum(['text', 'email', 'number']).default('text'),
});
export type IdentityField = z.output<typeof identityFieldSchema>;

export const testSettingsSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  description: optionalText(4000),
  subject_id: z.uuid('Choose a subject'),
  topic_id: z.uuid().nullable().default(null),
  category_id: z.uuid().nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  language: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Use a language code such as en, ur or fr-CA')
    .default('en'),
  difficulty: z.string().trim().min(1).max(40).default('medium'),
  instructions: optionalText(8000),
  learning_objectives: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
  duration_minutes: z.number().int('Whole minutes only').min(1).max(1440),
  passing_percentage: z.number().min(0).max(100).default(50),
  intended_total_marks: marksSchema.refine((n) => n > 0, 'Must be greater than 0').nullable().default(null),
  max_attempts: z.number().int().min(1).max(100).nullable().default(null),
  shuffle_questions: z.boolean().default(false),
  shuffle_options: z.boolean().default(false),
  negative_marking: z.boolean().default(false),
  partial_credit: z.boolean().default(true),
  written_review_required: z.boolean().default(true),
  result_release_policy: z.enum(RELEASE_POLICIES).default('immediate'),
  show_correct_answers: z.boolean().default(true),
  show_explanations: z.boolean().default(true),
  identity_fields: z
    .array(identityFieldSchema)
    .max(5)
    .default([])
    .refine((f) => new Set(f.map((x) => x.key)).size === f.length, 'Field keys must be unique')
    .refine((f) => !f.some((x) => x.key === 'name'), 'The name field is always collected'),
});
export type TestSettings = z.output<typeof testSettingsSchema>;
export type TestSettingsInput = z.input<typeof testSettingsSchema>;

export const saveTestSchema = z.object({
  settings: testSettingsSchema,
  /** Omit or send null to keep the existing questions (required once a test has attempts). */
  questions: z.array(questionInputSchema).max(LIMITS.questionsPerTest).nullable().default(null),
});
export type SaveTestInput = z.input<typeof saveTestSchema>;
export type SaveTestRequest = z.output<typeof saveTestSchema>;

export const listTestsQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(TEST_STATUSES).optional(),
  subject_id: z.uuid().optional(),
  topic_id: z.uuid().optional(),
  category_id: z.uuid().optional(),
  tag: z.string().trim().max(50).optional(),
  difficulty: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListTestsQuery = z.output<typeof listTestsQuerySchema>;

// -----------------------------------------------------------------------------
// Student attempts
// -----------------------------------------------------------------------------

export const startAttemptSchema = z.object({
  student_name: z.string().trim().min(1, 'Please enter your name').max(80, 'Name is too long'),
  student_info: z.record(z.string().max(40), z.string().trim().max(200)).default({}),
});
export type StartAttemptInput = z.input<typeof startAttemptSchema>;

export const saveAnswersSchema = z.object({
  answers: z
    .array(
      z.object({
        question_id: z.uuid(),
        answer: answerValueSchema,
        revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .min(1)
    .max(LIMITS.questionsPerTest),
});
export type SaveAnswersInput = z.input<typeof saveAnswersSchema>;

export const submitAttemptSchema = z.object({ type: z.enum(['manual', 'auto_client']).default('manual') });

// -----------------------------------------------------------------------------
// Reviews and reports
// -----------------------------------------------------------------------------

export const reviewAnswerSchema = z.object({
  question_id: z.uuid(),
  marks: marksSchema.refine((n) => n >= 0, 'Cannot be negative'),
  feedback: optionalText(8000),
  source: z.enum(['manual', 'ai_approved']).default('manual'),
});
export type ReviewAnswerInput = z.input<typeof reviewAnswerSchema>;

export const releaseResultsSchema = z.object({ released: z.boolean() });

export const resultsQuerySchema = z.object({
  test_id: z.uuid().optional(),
  subject_id: z.uuid().optional(),
  student: z.string().trim().max(80).optional(),
  grading_status: z.enum(['pending_review', 'complete', 'grading']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});
export type ResultsQuery = z.output<typeof resultsQuerySchema>;

export const progressQuerySchema = z.object({
  student: z.string().trim().min(1).max(80).optional(),
  subject_id: z.uuid().optional(),
});
