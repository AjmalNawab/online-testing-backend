import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { toAppError } from './errors.js';

const HTTP_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
};

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

/**
 * Every error leaves the API as `{ error: { code, message, details?, requestId } }`.
 * Internal details (stack traces, SQL messages, secrets) are logged, never returned.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? undefined;

    let status: number;
    let body: ErrorBody['error'];

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const message =
        status === 429 ? 'Too many requests. Please wait a moment and try again.' : exception.message;
      body = { code: HTTP_CODES[status] ?? 'HTTP_ERROR', message };
    } else if (isClientHttpError(exception)) {
      // e.g. malformed JSON or oversized bodies rejected by the body parser.
      status = exception.status;
      body = {
        code: HTTP_CODES[status] ?? 'BAD_REQUEST',
        message: status === 413 ? 'The request is too large.' : 'The request body is not valid JSON.',
      };
    } else {
      const appError = toAppError(exception);
      status = appError.status;
      body = { code: appError.code, message: appError.message, details: appError.details };
      if (status >= 500) {
        this.logger.error(
          `${req.method} ${req.path} failed [${requestId ?? '-'}]: ${exception instanceof Error ? exception.message : String(exception)}`,
          exception instanceof Error ? exception.stack : undefined,
        );
      }
    }

    res.status(status).json({ error: { ...body, requestId } } satisfies ErrorBody);
  }
}

function isClientHttpError(e: unknown): e is { status: number } {
  if (typeof e !== 'object' || e === null) return false;
  const status = (e as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500 && (e as { expose?: unknown }).expose === true;
}
