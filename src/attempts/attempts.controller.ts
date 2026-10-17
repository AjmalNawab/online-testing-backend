import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiConflictResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiZodBody, ZodBody } from '../common/zod.js';
import type {
  SaveAnswersResponse,
  StudentAttemptState,
  StudentResultView,
  SubmitResponse,
} from '../contracts/responses.js';
import { saveAnswersSchema, submitAttemptSchema } from '../contracts/test-schemas.js';
import type { IncomingAnswer } from './attempt-store.js';
import { ApiAttemptToken, AttemptToken } from './attempt-token.decorator.js';
import { AttemptsService } from './attempts.service.js';

@ApiTags('attempts (guest)')
@ApiAttemptToken()
@ApiNotFoundResponse({ description: 'Unknown attempt or wrong attempt secret' })
@Controller('attempts')
export class AttemptsController {
  constructor(private readonly attempts: AttemptsService) {}

  @Get(':id')
  @ApiOperation({
    summary: 'Current attempt state',
    description:
      'Questions (without answer keys), saved answers, the authoritative deadline and the server time. ' +
      'If the deadline has passed, the attempt is finalised before responding.',
  })
  @ApiOkResponse({ description: 'StudentAttemptState' })
  get(@Param('id', ParseUUIDPipe) id: string, @AttemptToken() token: string): Promise<StudentAttemptState> {
    return this.attempts.getState(id, token);
  }

  @Put(':id/answers')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Save answers (autosave)',
    description:
      'Upserts answers. Each answer carries a client revision; older revisions never overwrite newer ones. ' +
      'Rejected with 409 DEADLINE_PASSED after the deadline (plus a small server grace period).',
  })
  @ApiZodBody(saveAnswersSchema)
  @ApiOkResponse({ description: 'SaveAnswersResponse' })
  @ApiConflictResponse({ description: 'ATTEMPT_CLOSED or DEADLINE_PASSED' })
  save(
    @Param('id', ParseUUIDPipe) id: string,
    @AttemptToken() token: string,
    @ZodBody(saveAnswersSchema) body: { answers: IncomingAnswer[] },
  ): Promise<SaveAnswersResponse> {
    return this.attempts.saveAnswers(id, token, body.answers);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Submit the attempt',
    description: 'Idempotent: repeated or concurrent submissions return the original result and never re-grade.',
  })
  @ApiZodBody(submitAttemptSchema)
  @ApiOkResponse({ description: 'SubmitResponse' })
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @AttemptToken() token: string,
    @ZodBody(submitAttemptSchema) body: { type: 'manual' | 'auto_client' },
  ): Promise<SubmitResponse> {
    return this.attempts.submit(id, token, body.type);
  }

  @Get(':id/result')
  @ApiOperation({ summary: 'Result, filtered by the test’s release and answer-key policies' })
  @ApiOkResponse({ description: 'StudentResultView' })
  result(@Param('id', ParseUUIDPipe) id: string, @AttemptToken() token: string): Promise<StudentResultView> {
    return this.attempts.getResult(id, token);
  }
}
