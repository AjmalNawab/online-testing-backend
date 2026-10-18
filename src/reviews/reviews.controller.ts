import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, StaffOnly } from '../auth/auth.guard.js';
import { scopeOf } from '../auth/scope.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ApiZodBody, ApiZodQuery, ZodBody, ZodQuery } from '../common/zod.js';
import type { AdminAttemptDetail, AttemptSummaryRow, Paginated } from '../contracts/responses.js';
import { releaseResultsSchema, resultsQuerySchema, reviewAnswerSchema, type ResultsQuery } from '../contracts/test-schemas.js';
import { ReviewsService } from './reviews.service.js';

@ApiTags('attempts & reviews (teachers & admins)')
@StaffOnly()
@Controller('admin/attempts')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @ApiOperation({ summary: 'Attempts with scores and grading status (filter by test, subject, student, status)' })
  @ApiZodQuery(resultsQuerySchema)
  list(@ZodQuery(resultsQuerySchema) query: ResultsQuery, @CurrentUser() user: AuthUser): Promise<Paginated<AttemptSummaryRow>> {
    return this.reviews.list(query, scopeOf(user));
  }

  @Get(':id')
  @ApiOperation({ summary: 'One attempt with every answer, answer keys, AI suggestions and review history' })
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<AdminAttemptDetail> {
    await this.reviews.assertAccess(id, scopeOf(user));
    return this.reviews.get(id);
  }

  @Post(':id/reviews')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set marks and feedback for one answer',
    description: 'Marks must be between 0 and the question maximum. Recalculates the attempt; the result becomes final when nothing is pending.',
  })
  @ApiZodBody(reviewAnswerSchema)
  async review(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(reviewAnswerSchema) body: { question_id: string; marks: number; feedback: string | null; source: 'manual' | 'ai_approved' },
    @CurrentUser() user: AuthUser,
  ): Promise<AdminAttemptDetail> {
    await this.reviews.assertAccess(id, scopeOf(user));
    return this.reviews.review(id, body, user.id);
  }

  @Post(':id/release')
  @HttpCode(200)
  @ApiOperation({ summary: 'Release or withdraw results (for the "manual" release policy)' })
  @ApiZodBody(releaseResultsSchema)
  async release(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(releaseResultsSchema) body: { released: boolean },
    @CurrentUser() user: AuthUser,
  ): Promise<AdminAttemptDetail> {
    await this.reviews.assertAccess(id, scopeOf(user));
    return this.reviews.release(id, body.released, user.id);
  }

  @Post(':id/regrade')
  @HttpCode(200)
  @ApiOperation({ summary: 'Recalculate automatic grades (reviewed answers are kept)' })
  async regrade(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<AdminAttemptDetail> {
    await this.reviews.assertAccess(id, scopeOf(user));
    return this.reviews.regrade(id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an attempt and its answers' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<void> {
    await this.reviews.assertAccess(id, scopeOf(user));
    return this.reviews.remove(id);
  }
}
