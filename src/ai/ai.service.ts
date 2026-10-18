import type { Scope } from '../auth/scope.js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError, notFound } from '../common/errors.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { isAutoGradedType, type QuestionType } from '../contracts/constants.js';
import type { AiGenerateTestRequest, AiRegenerateQuestionRequest } from '../contracts/ai-schemas.js';
import type { QuestionDefinition } from '../contracts/question-schemas.js';
import type { AdminAttemptDetail, AdminTestDetail } from '../contracts/responses.js';
import { Database } from '../database/database.js';
import type { AiGradingSuggestion } from '../database/types.js';
import { AttemptsService } from '../attempts/attempts.service.js';
import { isAnswered } from '../grading/evaluators.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import { TestsService } from '../tests/tests.service.js';
import { AiProvider } from './ai-provider.js';
import { buildGenerationPrompts, generatedTestJsonSchema, outputBudget, validateGeneratedTest } from './generation.js';
import { GRADING_JSON_SCHEMA, buildGradingPrompts, parseGradingSuggestion } from './grading-assist.js';

/** Small batches run in parallel: ~10 s each with low thinking, instead of ~25 s for 10 questions in one call. */
const GENERATION_BATCH_SIZE = 5;
/** At most this many AI calls at once (stays inside per-minute quotas). */
const GENERATION_CONCURRENCY = 4;

/** 23 → [10, 10, 3] */
export function splitIntoBatches(total: number, size: number): number[] {
  const batches: number[] = [];
  for (let left = total; left > 0; left -= size) batches.push(Math.min(size, left));
  return batches;
}

/** Like Promise.allSettled, but runs at most `limit` tasks at a time. Results keep input order. */
export async function settleWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]!) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface GenerateTestResponse {
  test: AdminTestDetail;
  warnings: string[];
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly ai: AiProvider,
    private readonly db: Database,
    private readonly tests: TestsService,
    private readonly catalog: CatalogService,
    private readonly attempts: AttemptsService,
    private readonly reviews: ReviewsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  assertTestAccess(testId: string, scope: Scope): Promise<void> {
    return this.tests.assertAccess(testId, scope);
  }

  assertAttemptAccess(attemptId: string, scope: Scope): Promise<void> {
    return this.reviews.assertAccess(attemptId, scope);
  }

  status() {
    return { configured: this.ai.configured, provider: this.config.ai.provider, model: this.ai.model };
  }

  /** Generates a test with AI and saves it as a draft. Never publishes. */
  async generateTest(req: AiGenerateTestRequest, actorId: string): Promise<GenerateTestResponse> {
    await this.enforceDailyLimit(actorId);
    const types = [...new Set(req.question_types)];

    // Large requests are split into parallel batches to stay fast and within output limits.
    const batches = splitIntoBatches(req.question_count, GENERATION_BATCH_SIZE);
    const settled = await settleWithLimit(batches, GENERATION_CONCURRENCY, (n) => this.callGeneration(req, n, [], actorId, 'test'));
    const failures = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length === settled.length) throw failures[0]!.reason;

    const warnings: string[] = failures.map(
      (f) => `One batch failed: ${f.reason instanceof AppError ? f.reason.message : 'unknown error'}`,
    );
    let result: ReturnType<typeof validateGeneratedTest> = { title: null, description: null, instructions: null, questions: [], issues: [] };
    for (const r of settled) {
      if (r.status !== 'fulfilled') continue;
      const v = validateGeneratedTest(r.value, types, req.marks_per_question, result.questions.map((q) => q.prompt));
      warnings.push(...v.issues);
      result = {
        title: result.title ?? v.title,
        description: result.description ?? v.description,
        instructions: result.instructions ?? v.instructions,
        questions: [...result.questions, ...v.questions],
        issues: [],
      };
    }

    // One focused retry for the shortfall (invalid or duplicate questions were dropped).
    const missing = req.question_count - result.questions.length;
    if (missing > 0) {
      const retry = await this.callGeneration(req, missing, result.questions.map((q) => q.prompt), actorId, 'test').catch(
        (e: unknown) => {
          warnings.push(`Retry failed: ${e instanceof AppError ? e.message : 'unknown error'}`);
          return null;
        },
      );
      if (retry) {
        const extra = validateGeneratedTest(retry, types, req.marks_per_question, result.questions.map((q) => q.prompt));
        warnings.push(...extra.issues);
        result = { ...result, questions: [...result.questions, ...extra.questions.slice(0, missing)] };
      }
    }
    result.questions = result.questions.slice(0, req.question_count);

    if (result.questions.length === 0) {
      throw new AppError('AI_NO_VALID_QUESTIONS', 502, 'The AI did not produce any valid questions. Please try again or adjust the request.', warnings);
    }
    if (result.questions.length < req.question_count) {
      warnings.push(`Only ${result.questions.length} of ${req.question_count} questions passed validation.`);
    }

    const subjectId = await this.catalog.findOrCreateSubject(req.subject, actorId);
    const topicId = req.topic ? await this.catalog.findOrCreateTopic(subjectId, req.topic) : null;

    const test = await this.tests.create(
      {
        settings: {
          title: req.title || result.title || `${req.topic ?? req.subject} test`,
          description: result.description,
          subject_id: subjectId,
          topic_id: topicId,
          category_id: null,
          tags: ['ai-generated'],
          language: req.language,
          difficulty: req.difficulty,
          instructions: result.instructions,
          learning_objectives: req.learning_objectives,
          duration_minutes: req.duration_minutes,
          passing_percentage: 50,
          intended_total_marks: req.question_count * req.marks_per_question,
          max_attempts: null,
          shuffle_questions: false,
          shuffle_options: false,
          negative_marking: false,
          partial_credit: true,
          written_review_required: true,
          result_release_policy: 'immediate',
          show_correct_answers: true,
          show_explanations: req.include_explanations,
          identity_fields: [],
          require_student_account: false,
          class_only: false,
        },
        questions: result.questions,
      },
      actorId,
      'ai',
    );
    return { test, warnings };
  }

  /** Returns one new candidate question for the editor (not saved until the admin saves the test). */
  async regenerateQuestion(req: AiRegenerateQuestionRequest, actorId: string): Promise<{ question: QuestionDefinition }> {
    await this.enforceDailyLimit(actorId);
    const test = await this.tests.get(req.test_id);
    const genReq: AiGenerateTestRequest = {
      subject: test.subject.name,
      topic: test.topic?.name ?? null,
      title: test.settings.title,
      difficulty: test.settings.difficulty,
      question_count: 1,
      duration_minutes: test.settings.duration_minutes,
      question_types: [req.question_type],
      marks_per_question: req.marks,
      language: test.settings.language,
      explanation_language: null,
      learning_objectives: test.settings.learning_objectives,
      instructions: req.instructions,
      include_explanations: test.settings.show_explanations,
    };
    const avoid = [...req.existing_prompts, ...test.questions.map((q) => q.prompt)];
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.callGeneration(genReq, 1, avoid, actorId, 'question');
      const result = validateGeneratedTest(raw, [req.question_type], req.marks, avoid);
      if (result.questions[0]) return { question: result.questions[0] };
    }
    throw new AppError('AI_NO_VALID_QUESTIONS', 502, 'The AI could not produce a valid replacement question. Please try again.');
  }

  /** Asks the AI to suggest marks for one written answer and stores the suggestion. */
  async suggestGrade(attemptId: string, questionId: string, actorId: string | null): Promise<AiGradingSuggestion> {
    if (actorId) await this.enforceDailyLimit(actorId);
    const bundle = await this.attempts.store.getBundleInternal(attemptId);
    if (!bundle) throw notFound('Attempt');
    if (bundle.attempt.status === 'in_progress') {
      throw new AppError('ATTEMPT_NOT_SUBMITTED', 409, 'This attempt has not been submitted yet.');
    }
    const question = bundle.questions.find((q) => q.id === questionId);
    if (!question) throw notFound('Question');
    if (isAutoGradedType(question.question_type)) {
      throw new AppError('NOT_WRITTEN', 400, 'AI suggestions are only available for written answers.');
    }
    const answer = bundle.answers.find((a) => a.question_id === questionId)?.answer;
    if (!isAnswered(answer) || typeof answer !== 'string') {
      throw new AppError('NO_ANSWER', 400, 'There is no written answer to evaluate.');
    }

    const { system, prompt } = buildGradingPrompts(question, answer, {
      subject: bundle.test.subject_name ?? '',
      language: bundle.test.language,
    });
    const result = await this.logged(actorId, 'grading', { attempt_id: attemptId, question_id: questionId }, () =>
      this.ai.generateJson({ task: 'grade-answer', system, prompt, schema: GRADING_JSON_SCHEMA, maxOutputTokens: 8_000, temperature: 0.2 }),
    );
    const suggestion = parseGradingSuggestion(result.json, question.marks, result.model);
    await this.attempts.store.saveAiSuggestion(attemptId, questionId, suggestion);
    return suggestion;
  }

  async suggestAndReturn(attemptId: string, questionId: string, actorId: string): Promise<AdminAttemptDetail> {
    await this.suggestGrade(attemptId, questionId, actorId);
    return this.reviews.get(attemptId);
  }

  /**
   * For tests that do not require manual review: AI-grade pending answers of
   * AI-assisted questions and apply the suggestion automatically.
   */
  async autoGradePending(limit = 5): Promise<number> {
    if (!this.ai.configured) return 0;
    const pending = await this.db.query<{ attempt_id: string; question_id: string }>(
      `select sa.attempt_id, sa.question_id
       from public.student_answers sa
       join public.questions q on q.id = sa.question_id
       join public.tests t on t.id = q.test_id
       where sa.grading_status = 'pending_review' and sa.ai_suggestion is null
         and q.grading_method = 'ai_assisted' and t.written_review_required = false
       order by sa.saved_at limit $1`,
      [limit],
    );
    let done = 0;
    for (const p of pending) {
      try {
        const s = await this.suggestGrade(p.attempt_id, p.question_id, null);
        const systemActor = await this.db.one<{ id: string }>(
          `select created_by as id from public.tests t join public.questions q on q.test_id = t.id where q.id = $1`,
          [p.question_id],
        );
        if (!systemActor?.id) continue;
        await this.attempts.store.reviewAnswer(systemActor.id, p.attempt_id, p.question_id, s.suggested_marks, s.feedback || null, 'ai_approved');
        await this.attempts.regrade(p.attempt_id);
        done += 1;
      } catch (error) {
        this.logger.warn(`Auto-grading failed for attempt ${p.attempt_id}: ${error instanceof Error ? error.message : String(error)}`);
        // Mark as attempted so a persistent failure does not loop; an admin can still review manually.
        await this.attempts.store.saveAiSuggestion(p.attempt_id, p.question_id, { error: 'auto-grading failed' }).catch(() => undefined);
      }
    }
    return done;
  }

  // ---------------------------------------------------------------------------

  private async callGeneration(
    req: AiGenerateTestRequest,
    count: number,
    avoid: string[],
    actorId: string,
    kind: 'test' | 'question',
  ): Promise<unknown> {
    const types = [...new Set(req.question_types)] as QuestionType[];
    const { system, prompt } = buildGenerationPrompts(req, count, avoid);
    const result = await this.logged(actorId, kind, { ...req, count }, () =>
      this.ai.generateJson({
        task: kind === 'test' ? 'generate-test' : 'regenerate-question',
        system,
        prompt,
        schema: generatedTestJsonSchema(types),
        maxOutputTokens: outputBudget(count),
        temperature: 0.7,
      }),
    );
    return result.json;
  }

  private async logged<T extends { model: string; inputTokens: number | null; outputTokens: number | null }>(
    actorId: string | null,
    kind: 'test' | 'question' | 'grading',
    request: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await fn();
      await this.log(actorId, kind, 'succeeded', result.model, request, result.inputTokens, result.outputTokens, null);
      return result;
    } catch (error) {
      await this.log(actorId, kind, 'failed', this.ai.model, request, null, null, error instanceof AppError ? error.code : 'UNKNOWN');
      throw error;
    }
  }

  private async log(
    actorId: string | null,
    kind: string,
    status: string,
    model: string,
    request: unknown,
    inputTokens: number | null,
    outputTokens: number | null,
    errorCode: string | null,
  ): Promise<void> {
    await this.db
      .query(
        `insert into public.ai_generations (created_by, kind, status, model, request, input_tokens, output_tokens, error_code)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [actorId, kind, status, model, JSON.stringify(request ?? {}), inputTokens, outputTokens, errorCode],
      )
      .catch(() => undefined);
  }

  private async enforceDailyLimit(actorId: string): Promise<void> {
    if (!this.ai.configured) {
      throw new AppError('AI_NOT_CONFIGURED', 503, 'AI features are not configured. Set GEMINI_API_KEY on the backend.');
    }
    const row = await this.db.one<{ n: number }>(
      `select count(*) as n from public.ai_generations where created_by = $1 and created_at > now() - interval '24 hours'`,
      [actorId],
    );
    if (Number(row?.n ?? 0) >= this.config.ai.dailyLimit) {
      throw new AppError('AI_DAILY_LIMIT', 429, `Daily AI limit reached (${this.config.ai.dailyLimit} requests per 24 hours).`);
    }
  }
}

