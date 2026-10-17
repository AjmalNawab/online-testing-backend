import { createParamDecorator, type ExecutionContext, applyDecorators } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { Request } from 'express';
import { AppError } from '../common/errors.js';
import { ATTEMPT_TOKEN_HEADER } from '../contracts/constants.js';
import { ATTEMPT_TOKEN_PATTERN } from './token.js';

/** Reads and shape-checks the guest attempt secret from the X-Attempt-Token header. */
export const AttemptToken = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<Request>();
  const token = req.headers[ATTEMPT_TOKEN_HEADER];
  if (typeof token !== 'string' || !ATTEMPT_TOKEN_PATTERN.test(token)) {
    throw new AppError('ATTEMPT_NOT_FOUND', 404, 'This attempt was not found.');
  }
  return token;
});

export const ApiAttemptToken = () =>
  applyDecorators(
    ApiHeader({
      name: 'X-Attempt-Token',
      required: true,
      description: 'Attempt secret returned when the attempt was started',
    }),
  );
