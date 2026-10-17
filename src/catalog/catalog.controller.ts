import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AdminOnly, CurrentUser } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ApiZodBody, ZodBody } from '../common/zod.js';
import type { Category, Subject, Tag, Topic } from '../contracts/responses.js';
import {
  categoryInputSchema,
  categoryUpdateSchema,
  subjectInputSchema,
  subjectUpdateSchema,
  topicInputSchema,
  topicUpdateSchema,
} from '../contracts/test-schemas.js';
import { CatalogService } from './catalog.service.js';

type NamedInput = { name: string; description: string | null };
type NamedPatch = { name?: string; description?: string | null; archived?: boolean };

@ApiTags('catalog (admin)')
@AdminOnly()
@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('subjects')
  @ApiOperation({ summary: 'List subjects' })
  @ApiQuery({ name: 'include_archived', required: false, type: Boolean })
  listSubjects(@Query('include_archived') includeArchived?: string): Promise<Subject[]> {
    return this.catalog.listSubjects(includeArchived === 'true');
  }

  @Post('subjects')
  @ApiOperation({ summary: 'Create a subject' })
  @ApiZodBody(subjectInputSchema)
  createSubject(@ZodBody(subjectInputSchema) body: NamedInput, @CurrentUser() user: AuthUser): Promise<Subject> {
    return this.catalog.createSubject(body, user.id);
  }

  @Patch('subjects/:id')
  @ApiOperation({ summary: 'Rename, describe or archive a subject' })
  @ApiZodBody(subjectUpdateSchema)
  updateSubject(@Param('id', ParseUUIDPipe) id: string, @ZodBody(subjectUpdateSchema) body: NamedPatch): Promise<Subject> {
    return this.catalog.updateSubject(id, body);
  }

  @Delete('subjects/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a subject that has no tests' })
  deleteSubject(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.catalog.deleteSubject(id);
  }

  @Get('subjects/:id/topics')
  @ApiOperation({ summary: 'List topics of a subject' })
  @ApiQuery({ name: 'include_archived', required: false, type: Boolean })
  listTopics(@Param('id', ParseUUIDPipe) id: string, @Query('include_archived') includeArchived?: string): Promise<Topic[]> {
    return this.catalog.listTopics(id, includeArchived === 'true');
  }

  @Post('subjects/:id/topics')
  @ApiOperation({ summary: 'Create a topic' })
  @ApiZodBody(topicInputSchema)
  createTopic(@Param('id', ParseUUIDPipe) id: string, @ZodBody(topicInputSchema) body: NamedInput): Promise<Topic> {
    return this.catalog.createTopic(id, body);
  }

  @Patch('topics/:id')
  @ApiOperation({ summary: 'Update or archive a topic' })
  @ApiZodBody(topicUpdateSchema)
  updateTopic(@Param('id', ParseUUIDPipe) id: string, @ZodBody(topicUpdateSchema) body: NamedPatch): Promise<Topic> {
    return this.catalog.updateTopic(id, body);
  }

  @Delete('topics/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a topic (tests keep their subject)' })
  deleteTopic(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.catalog.deleteTopic(id);
  }

  @Get('categories')
  @ApiOperation({ summary: 'List categories' })
  listCategories(): Promise<Category[]> {
    return this.catalog.listCategories();
  }

  @Post('categories')
  @ApiOperation({ summary: 'Create a category' })
  @ApiZodBody(categoryInputSchema)
  createCategory(@ZodBody(categoryInputSchema) body: NamedInput): Promise<Category> {
    return this.catalog.createCategory(body);
  }

  @Patch('categories/:id')
  @ApiOperation({ summary: 'Update a category' })
  @ApiZodBody(categoryUpdateSchema)
  updateCategory(@Param('id', ParseUUIDPipe) id: string, @ZodBody(categoryUpdateSchema) body: NamedPatch): Promise<Category> {
    return this.catalog.updateCategory(id, body);
  }

  @Delete('categories/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a category (tests are uncategorised)' })
  deleteCategory(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.catalog.deleteCategory(id);
  }

  @Get('tags')
  @ApiOperation({ summary: 'Tags currently used by tests' })
  listTags(): Promise<Tag[]> {
    return this.catalog.listTags();
  }
}
