import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Auth, CurrentUser, StaffOnly } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { scopeOf } from '../auth/scope.js';
import { ApiZodBody, ZodBody } from '../common/zod.js';
import { addMemberSchema, assignTestSchema, classInputSchema, classUpdateSchema, joinClassSchema } from '../contracts/class-schemas.js';
import type { ClassDetail, ClassSummary, MyAssignment, MyClass, TestAssignment } from '../contracts/responses.js';
import { ClassesService } from './classes.service.js';

@ApiTags('classes (teachers & admins)')
@StaffOnly()
@Controller('classes')
export class ClassesController {
  constructor(private readonly classes: ClassesService) {}

  @Get()
  @ApiOperation({ summary: 'My classes (admins: all classes)' })
  @ApiQuery({ name: 'include_archived', required: false, type: Boolean })
  list(@CurrentUser() user: AuthUser, @Query('include_archived') includeArchived?: string): Promise<ClassSummary[]> {
    return this.classes.list(scopeOf(user), includeArchived === 'true');
  }

  @Post()
  @ApiOperation({ summary: 'Create a class (a join code is generated)' })
  @ApiZodBody(classInputSchema)
  create(@ZodBody(classInputSchema) body: { name: string; description: string | null }, @CurrentUser() user: AuthUser): Promise<ClassDetail> {
    return this.classes.create(scopeOf(user), body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'A class with its students and assigned tests' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<ClassDetail> {
    return this.classes.get(scopeOf(user), id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename, describe or archive a class' })
  @ApiZodBody(classUpdateSchema)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(classUpdateSchema) body: { name?: string; description?: string | null; archived?: boolean },
    @CurrentUser() user: AuthUser,
  ): Promise<ClassDetail> {
    return this.classes.update(scopeOf(user), id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a class (students and attempts are kept)' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<void> {
    return this.classes.remove(scopeOf(user), id);
  }

  @Post(':id/reset-code')
  @HttpCode(200)
  @ApiOperation({ summary: 'Replace the join code (the old one stops working)' })
  resetCode(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<ClassDetail> {
    return this.classes.resetCode(scopeOf(user), id);
  }

  @Post(':id/members')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add a student by the email of their student account' })
  @ApiZodBody(addMemberSchema)
  addMember(@Param('id', ParseUUIDPipe) id: string, @ZodBody(addMemberSchema) body: { email: string }, @CurrentUser() user: AuthUser): Promise<ClassDetail> {
    return this.classes.addMember(scopeOf(user), id, body.email);
  }

  @Delete(':id/members/:studentId')
  @ApiOperation({ summary: 'Remove a student from the class' })
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ClassDetail> {
    return this.classes.removeMember(scopeOf(user), id, studentId);
  }
}

@ApiTags('classes (teachers & admins)')
@StaffOnly()
@Controller('tests/:testId/assignments')
export class TestAssignmentsController {
  constructor(private readonly classes: ClassesService) {}

  @Get()
  @ApiOperation({ summary: 'Classes this test is assigned to' })
  list(@Param('testId', ParseUUIDPipe) testId: string, @CurrentUser() user: AuthUser): Promise<TestAssignment[]> {
    return this.classes.listForTest(scopeOf(user), testId);
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Assign the test to a class, or change its due date' })
  @ApiZodBody(assignTestSchema)
  assign(
    @Param('testId', ParseUUIDPipe) testId: string,
    @ZodBody(assignTestSchema) body: { class_id: string; due_at: string | null },
    @CurrentUser() user: AuthUser,
  ): Promise<TestAssignment[]> {
    return this.classes.assign(scopeOf(user), testId, body, user.id);
  }

  @Delete(':classId')
  @ApiOperation({ summary: 'Remove the test from a class' })
  unassign(
    @Param('testId', ParseUUIDPipe) testId: string,
    @Param('classId', ParseUUIDPipe) classId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<TestAssignment[]> {
    return this.classes.unassign(scopeOf(user), testId, classId);
  }
}

@ApiTags('my account (signed-in students)')
@Auth()
@Controller('me')
export class MyClassesController {
  constructor(private readonly classes: ClassesService) {}

  @Post('classes/join')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Join a class with its code' })
  @ApiZodBody(joinClassSchema)
  join(@ZodBody(joinClassSchema) body: { code: string }, @CurrentUser() user: AuthUser): Promise<MyClass> {
    return this.classes.join(user, body.code);
  }

  @Get('classes')
  @ApiOperation({ summary: 'Classes I belong to' })
  myClasses(@CurrentUser() user: AuthUser): Promise<MyClass[]> {
    return this.classes.myClasses(user.id);
  }

  @Delete('classes/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Leave a class' })
  leave(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<void> {
    return this.classes.leave(user.id, id);
  }

  @Get('assignments')
  @ApiOperation({ summary: 'Published tests assigned to my classes, to-do first' })
  assignments(@CurrentUser() user: AuthUser): Promise<MyAssignment[]> {
    return this.classes.myAssignments(user.id);
  }
}
