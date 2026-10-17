import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiTooManyRequestsResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminOnly, CurrentUser } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ApiZodBody, ZodBody } from '../common/zod.js';
import {
  aiGenerateTestSchema,
  aiGradeSuggestionSchema,
  aiRegenerateQuestionSchema,
  type AiGenerateTestRequest,
  type AiRegenerateQuestionRequest,
} from '../contracts/ai-schemas.js';
import type { QuestionDefinition } from '../contracts/question-schemas.js';
import type { AdminAttemptDetail } from '../contracts/responses.js';
import { AiService, type GenerateTestResponse } from './ai.service.js';

@ApiTags('ai (admin)')
@AdminOnly()
@ApiTooManyRequestsResponse({ description: 'Rate limit or daily AI limit reached' })
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('status')
  @ApiOperation({ summary: 'Whether AI features are configured, and which model is used' })
  status() {
    return this.ai.status();
  }

  @Post('generate-test')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Generate a test with AI and save it as a draft',
    description:
      'Output is validated like a manually written test; invalid or duplicate questions are dropped and reported in `warnings`. ' +
      'Never publishes; review and edit the draft first.',
  })
  @ApiZodBody(aiGenerateTestSchema)
  generate(@ZodBody(aiGenerateTestSchema) body: AiGenerateTestRequest, @CurrentUser() user: AuthUser): Promise<GenerateTestResponse> {
    return this.ai.generateTest(body, user.id);
  }

  @Post('regenerate-question')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Generate one replacement question for the editor (not saved automatically)' })
  @ApiZodBody(aiRegenerateQuestionSchema)
  regenerate(
    @ZodBody(aiRegenerateQuestionSchema) body: AiRegenerateQuestionRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<{ question: QuestionDefinition }> {
    return this.ai.regenerateQuestion(body, user.id);
  }

  @Post('attempts/:id/grade-suggestion')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'AI-suggested marks and feedback for one written answer (requires approval)' })
  @ApiZodBody(aiGradeSuggestionSchema)
  suggest(
    @Param('id', ParseUUIDPipe) attemptId: string,
    @ZodBody(aiGradeSuggestionSchema) body: { question_id: string },
    @CurrentUser() user: AuthUser,
  ): Promise<AdminAttemptDetail> {
    return this.ai.suggestAndReturn(attemptId, body.question_id, user.id);
  }
}
