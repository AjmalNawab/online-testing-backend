import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminOnly, CurrentUser } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ApiZodBody, ApiZodQuery, ZodBody, ZodQuery } from '../common/zod.js';
import type { AdminTestDetail, Paginated, PublicTestInfo, StudentQuestion, TestSummary } from '../contracts/responses.js';
import { listTestsQuerySchema, saveTestSchema, type ListTestsQuery, type SaveTestRequest } from '../contracts/test-schemas.js';
import { TestsService } from './tests.service.js';

@ApiTags('tests (admin)')
@AdminOnly()
@Controller('tests')
export class TestsController {
  constructor(private readonly tests: TestsService) {}

  @Get()
  @ApiOperation({ summary: 'Search and filter tests' })
  @ApiZodQuery(listTestsQuerySchema)
  @ApiOkResponse({ description: 'Paginated<TestSummary>' })
  list(@ZodQuery(listTestsQuerySchema) query: ListTestsQuery): Promise<Paginated<TestSummary>> {
    return this.tests.list(query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a test (saved as a draft)' })
  @ApiZodBody(saveTestSchema)
  @ApiCreatedResponse({ description: 'AdminTestDetail' })
  create(@ZodBody(saveTestSchema) body: SaveTestRequest, @CurrentUser() user: AuthUser): Promise<AdminTestDetail> {
    return this.tests.create(body, user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Full test including answer keys and publish checks' })
  @ApiOkResponse({ description: 'AdminTestDetail' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminTestDetail> {
    return this.tests.get(id);
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Save test settings and (optionally) replace its questions',
    description: 'Send `questions: null` to keep existing questions. Questions are locked once a test has attempts.',
  })
  @ApiZodBody(saveTestSchema)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(saveTestSchema) body: SaveTestRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<AdminTestDetail> {
    return this.tests.update(id, body, user.id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a test that has no attempts (archive it otherwise)' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.tests.remove(id);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @ApiOperation({ summary: 'Publish (validates every question first)' })
  publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<AdminTestDetail> {
    return this.tests.setStatus(id, 'published', user.id);
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move back to draft (the share link stops working)' })
  unpublish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<AdminTestDetail> {
    return this.tests.setStatus(id, 'draft', user.id);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archive (hidden from lists, results kept)' })
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<AdminTestDetail> {
    return this.tests.setStatus(id, 'archived', user.id);
  }

  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Copy a test (new draft with a new share link)' })
  duplicate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<AdminTestDetail> {
    return this.tests.duplicate(id, user.id);
  }

  @Get(':id/preview')
  @ApiOperation({ summary: 'The test as a student sees it (no answer keys)' })
  preview(@Param('id', ParseUUIDPipe) id: string): Promise<{ info: PublicTestInfo; questions: StudentQuestion[] }> {
    return this.tests.preview(id);
  }
}
