import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Auth, CurrentUser } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { AppError } from '../common/errors.js';
import { ApiZodBody, ZodBody } from '../common/zod.js';
import { claimAttemptsSchema } from '../contracts/account-schemas.js';
import type { MyAttempt, ProgressReport, StudentResultView } from '../contracts/responses.js';
import { StudentsService } from './students.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@ApiTags('my account (signed-in students)')
@Auth()
@Controller('me')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get('attempts')
  @ApiOperation({ summary: 'My attempts, newest first; scores only where results are released' })
  attempts(@CurrentUser() user: AuthUser): Promise<MyAttempt[]> {
    return this.students.listAttempts(user);
  }

  @Get('attempts/:id/result')
  @ApiOperation({ summary: 'Result of one of my attempts, filtered by the test’s release policy' })
  result(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<StudentResultView> {
    return this.students.result(user, id);
  }

  @Post('attempts/:id/resume')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Continue one of my in-progress attempts on this device',
    description: 'Issues a new attempt secret; the previous device can no longer save answers. The deadline does not change.',
  })
  resume(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<{ attempt_id: string; attempt_token: string }> {
    return this.students.resume(user, id);
  }

  @Post('attempts/claim')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Add guest attempts taken in this browser to my account (each proved by its attempt secret)' })
  @ApiZodBody(claimAttemptsSchema)
  claim(
    @ZodBody(claimAttemptsSchema) body: { attempts: { attempt_id: string; attempt_token: string }[] },
    @CurrentUser() user: AuthUser,
  ): Promise<{ claimed: number }> {
    return this.students.claim(user, body.attempts.map((a) => a.attempt_token));
  }

  @Get('progress')
  @ApiOperation({ summary: 'My progress across completed attempts' })
  @ApiQuery({ name: 'subject_id', required: false })
  progress(@CurrentUser() user: AuthUser, @Query('subject_id') subjectId?: string): Promise<ProgressReport> {
    if (subjectId !== undefined && !UUID.test(subjectId)) throw new AppError('VALIDATION_FAILED', 400, 'Invalid subject.');
    return this.students.progress(user, subjectId);
  }
}
