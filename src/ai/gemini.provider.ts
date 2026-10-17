import { ApiError, GoogleGenAI } from '@google/genai';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/errors.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { AiProvider, type AiJsonRequest, type AiJsonResult } from './ai-provider.js';

const BLOCKED_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Google Gemini via the official @google/genai SDK, using JSON-schema structured output. */
@Injectable()
export class GeminiProvider extends AiProvider {
  private readonly logger = new Logger('Gemini');
  private readonly client: GoogleGenAI | null;
  readonly configured: boolean;
  readonly model: string;
  private readonly timeoutMs: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    this.configured = Boolean(config.ai.apiKey);
    this.model = config.ai.model;
    this.timeoutMs = config.ai.timeoutMs;
    this.client = config.ai.apiKey ? new GoogleGenAI({ apiKey: config.ai.apiKey }) : null;
  }

  async generateJson(request: AiJsonRequest): Promise<AiJsonResult> {
    if (!this.client) {
      throw new AppError('AI_NOT_CONFIGURED', 503, 'AI features are not configured. Set GEMINI_API_KEY on the backend.');
    }

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.call(request);
      } catch (error) {
        const status = error instanceof ApiError ? error.status : undefined;
        const retryable = status === 429 || status === 500 || status === 503;
        if (retryable && attempt < 2) {
          await sleep(2_000);
          continue;
        }
        throw this.mapError(error, request.task);
      }
    }
  }

  private async call(request: AiJsonRequest): Promise<AiJsonResult> {
    const response = await this.client!.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
      config: {
        systemInstruction: request.system,
        responseMimeType: 'application/json',
        responseJsonSchema: request.schema,
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
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
      model: response.modelVersion ?? this.model,
      inputTokens: response.usageMetadata?.promptTokenCount ?? null,
      outputTokens:
        (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0) || null,
    };
  }

  private mapError(error: unknown, task: string): AppError {
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
          return new AppError('AI_MODEL_UNAVAILABLE', 503, `The AI model "${this.model}" is not available. Check GEMINI_MODEL.`);
        case 429:
          return new AppError('AI_RATE_LIMITED', 429, 'The AI service is busy or its quota is used up. Please try again in a minute.');
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
