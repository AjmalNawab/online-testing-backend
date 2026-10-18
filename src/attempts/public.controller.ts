import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MaybeUser, OptionalAuth } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { AppError } from '../common/errors.js';
import { ApiZodBody, ZodBody } from '../common/zod.js';
import type { PublicTestInfo, StartAttemptResponse } from '../contracts/responses.js';
import { startAttemptSchema } from '../contracts/test-schemas.js';
import { AttemptsService } from './attempts.service.js';

const SHARE_TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

@ApiTags('public')
@Controller('public/tests')
export class PublicController {
  constructor(private readonly attempts: AttemptsService) {}

  @Get(':shareToken')
  @ApiOperation({ summary: 'Public information about a published test (no questions or answers)' })
  @ApiOkResponse({ description: 'PublicTestInfo' })
  @ApiNotFoundResponse({ description: 'Unknown, unpublished or archived test' })
  getTest(@Param('shareToken') shareToken: string): Promise<PublicTestInfo> {
    assertShareToken(shareToken);
    return this.attempts.getPublicTest(shareToken);
  }

  @Post(':shareToken/attempts')
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @OptionalAuth()
  @ApiOperation({
    summary: 'Start an attempt (as a guest, or as the signed-in student)',
    description:
      'Creates an attempt with a server-recorded start time and deadline. Returns a one-time attempt secret ' +
      'that must be sent as the X-Attempt-Token header on every attempt request. With a bearer token the ' +
      'attempt is linked to that account; tests that require an account reject guests (401 STUDENT_ACCOUNT_REQUIRED).',
  })
  @ApiZodBody(startAttemptSchema)
  @ApiCreatedResponse({ description: 'StartAttemptResponse' })
  start(
    @Param('shareToken') shareToken: string,
    @ZodBody(startAttemptSchema) body: { student_name: string; student_info: Record<string, string> },
    @MaybeUser() user: AuthUser | null,
  ): Promise<StartAttemptResponse> {
    assertShareToken(shareToken);
    return this.attempts.start(shareToken, body.student_name, body.student_info, user);
  }
}

function assertShareToken(token: string) {
  if (!SHARE_TOKEN.test(token)) {
    throw new AppError('TEST_NOT_AVAILABLE', 404, 'This test is not available. Please check the link.');
  }
}
