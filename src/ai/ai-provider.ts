export interface AiJsonRequest {
  /** Short label for logs, e.g. "generate-test". */
  task: string;
  system: string;
  prompt: string;
  /** JSON Schema the response must follow. */
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  temperature?: number;
}

export interface AiJsonResult {
  json: unknown;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Provider-neutral structured-output call. The backend validates every
 * response itself; providers only promise "JSON matching the schema, or an
 * AppError explaining why not".
 */
export abstract class AiProvider {
  abstract readonly configured: boolean;
  abstract readonly model: string;
  abstract generateJson(request: AiJsonRequest): Promise<AiJsonResult>;
}
