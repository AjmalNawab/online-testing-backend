import { ApiError, GoogleGenAI, ThinkingLevel } from '@google/genai';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/errors.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { AiProvider, type AiJsonRequest, type AiJsonResult } from './ai-provider.js';

const BLOCKED_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const THINKING_LEVELS = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH } as const;
/** 429 quota/busy and 503 "high demand": switch to another model if one is configured. */
const OVERLOADED = new Set([429, 503]);
/** 500 server trouble and 504 Gemini's own deadline: worth one more try. */
const TRANSIENT = new Set([500, 504]);
/** How long an overloaded model is tried last. */
const BUSY_COOLDOWN_MS = 2 * 60_000;
/** A used-up quota (e.g. the free tier's daily request limit) lasts much longer. */
const QUOTA_COOLDOWN_MS = 30 * 60_000;
const isQuotaError = (error: unknown) => error instanceof ApiError && error.status === 429 && /quota/i.test(error.message);

/** Google Gemini via the official @google/genai SDK, using JSON-schema structured output. */
@Injectable()
export class GeminiProvider extends AiProvider {
  private readonly logger = new Logger('Gemini');
  private readonly client: GoogleGenAI | null;
  readonly configured: boolean;
  readonly model: string;
  private readonly timeoutMs: number;
  private readonly thinkingLevel: ThinkingLevel;
  private readonly fallbackModels: string[];
  /** Models that rejected thinking settings; later calls to them skip it. */
  private readonly noThinking = new Set<string>();
  /** Models that recently reported overload, and until when to try them last. */
  private readonly busyUntil = new Map<string, number>();

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    this.configured = Boolean(config.ai.apiKey);
    this.model = config.ai.model;
    this.fallbackModels = config.ai.fallbackModels;
    this.timeoutMs = config.ai.timeoutMs;
    // Without this the model's default (deep) thinking applies: measured ~185 s vs ~25 s for 10 questions.
    this.thinkingLevel = THINKING_LEVELS[config.ai.thinkingLevel];
    this.client = config.ai.apiKey ? new GoogleGenAI({ apiKey: config.ai.apiKey }) : null;
  }

  async generateJson(request: AiJsonRequest): Promise<AiJsonResult> {
    if (!this.client) {
      throw new AppError('AI_NOT_CONFIGURED', 503, 'AI features are not configured. Set GEMINI_API_KEY on the backend.');
    }

    const models = this.modelOrder();
    let lastError: unknown;
    let overloadError: unknown;
    for (const [index, model] of models.entries()) {
      const hasNext = index < models.length - 1;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          return await this.call(model, request);
        } catch (error) {
          lastError = error;
          const status = error instanceof ApiError ? error.status : undefined;
          if (status === 400 && !this.noThinking.has(model) && /thinking/i.test((error as Error).message)) {
            this.logger.warn(`Model ${model} does not accept thinking level ${this.thinkingLevel}; continuing without it.`);
            this.noThinking.add(model);
            attempt -= 1; // does not count as a retry
            continue;
          }
          if (status !== undefined && OVERLOADED.has(status)) {
            overloadError = error;
            const quota = isQuotaError(error);
            this.busyUntil.set(model, Date.now() + (quota ? QUOTA_COOLDOWN_MS : BUSY_COOLDOWN_MS));
            if (hasNext) {
              this.logger.warn(`${request.task}: ${model} ${quota ? 'has used its quota' : 'is overloaded'} (${status}); trying ${models[index + 1]}`);
              break;
            }
            if (quota) throw this.mapError(error, request.task, model); // retrying now cannot help
          }
          if (status === 404 && hasNext && model !== this.model) {
            this.logger.warn(`Fallback model ${model} is not available; skipping it.`);
            break;
          }
          const retryable = status !== undefined && (OVERLOADED.has(status) || TRANSIENT.has(status));
          if (retryable && attempt < 2) {
            await sleep(2_000);
            continue;
          }
          if (retryable && hasNext) break;
          // A missing fallback should not hide the real problem: the main model was busy.
          if (status === 404 && overloadError) throw this.mapError(overloadError, request.task, model);
          throw this.mapError(error, request.task, model);
        }
      }
    }
    throw this.mapError(lastError, request.task, this.model);
  }

  /** The main model first, then fallbacks; models that were overloaded recently go last. */
  private modelOrder(): string[] {
    const now = Date.now();
    const all = [this.model, ...this.fallbackModels];
    const busy = (m: string) => (this.busyUntil.get(m) ?? 0) > now;
    return [...all.filter((m) => !busy(m)), ...all.filter(busy)];
  }

  private async call(model: string, request: AiJsonRequest): Promise<AiJsonResult> {
    const response = await this.client!.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
      config: {
        systemInstruction: request.system,
        responseMimeType: 'application/json',
        responseJsonSchema: request.schema,
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        ...(this.noThinking.has(model) ? {} : { thinkingConfig: { thinkingLevel: this.thinkingLevel } }),
        abortSignal: AbortSignal.timeout(this.timeoutMs),
        httpOptions: { timeout: this.timeoutMs },
      },
    });

    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) throw new AppError('AI_BLOCKED', 422, 'The AI service declined this request. Try rephrasing the topic or instructions.');

    const finish = response.candidates?.[0]?.finishReason;
    if (finish === 'MAX_TOKENS') {
      throw new AppError('AI_OUTPUT_TRUNCATED', 502, 'The AI response was too long and got cut off. Try fewer questions.');
    }
    if (finish && BLOCKED_REASONS.has(finish)) {
      throw new AppError('AI_BLOCKED', 422, 'The AI service declined to answer this request. Try rephrasing it.');
    }

    const text = response.text;
    if (!text) throw new AppError('AI_MALFORMED', 502, 'The AI service returned an empty response. Please try again.');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AppError('AI_MALFORMED', 502, 'The AI service returned invalid data. Please try again.');
    }

    return {
      json,
      model: response.modelVersion ?? model,
      inputTokens: response.usageMetadata?.promptTokenCount ?? null,
      outputTokens:
        (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0) || null,
    };
  }

  private mapError(error: unknown, task: string, model: string): AppError {
    if (error instanceof AppError) return error;
    if (error instanceof ApiError) {
      this.logger.warn(`${task}: Gemini API error ${error.status}`);
      switch (error.status) {
        case 400:
          return new AppError('AI_BAD_REQUEST', 502, 'The AI service rejected the request. Try fewer questions or simpler instructions.');
        case 401:
        case 403:
          return new AppError('AI_AUTH_FAILED', 503, 'The Gemini API key is invalid or does not have access.');
        case 404:
          return new AppError('AI_MODEL_UNAVAILABLE', 503, `The AI model "${model}" is not available. Check GEMINI_MODEL.`);
        case 429:
          if (/quota/i.test(error.message)) {
            return new AppError(
              'AI_QUOTA_EXCEEDED',
              429,
              'The AI usage limit for this Gemini key has been reached (the free tier allows about 20 requests per model per day). Try again later, or enable billing in Google AI Studio.',
            );
          }
          return new AppError('AI_RATE_LIMITED', 429, 'The AI service is busy. Please try again in a minute.');
        case 503:
          return new AppError('AI_BUSY', 503, 'Google’s AI service is very busy right now. Please try again in a few minutes.');
        case 504:
          return new AppError('AI_TIMEOUT', 504, 'The AI service took too long to respond. Please try again, or ask for fewer questions.');
        default:
          return new AppError('AI_UNAVAILABLE', 503, 'The AI service is temporarily unavailable. Please try again.');
      }
    }
    const name = (error as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new AppError('AI_TIMEOUT', 504, 'The AI service took too long to respond. Try fewer questions.');
    }
    this.logger.error(`${task}: unexpected AI error: ${error instanceof Error ? error.message : String(error)}`);
    return new AppError('AI_UNAVAILABLE', 503, 'The AI service could not be reached. Please try again.');
  }
}
