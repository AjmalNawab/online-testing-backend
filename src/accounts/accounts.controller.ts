import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminOnly, CurrentUser } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ApiZodBody, ZodBody } from '../common/zod.js';
import {
  createStaffSchema,
  setRoleSchema,
  setupSchema,
  signupSchema,
  type CreateStaffRequest,
  type SetupRequest,
  type SignupRequest,
} from '../contracts/account-schemas.js';
import type { AccessRequest, AdminAccount, SetupStatus, SignupResponse, StaffMember } from '../contracts/responses.js';
import { AccountsService } from './accounts.service.js';

@ApiTags('setup')
@Controller('setup')
export class SetupController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Whether the first administrator still needs to be created' })
  status(): Promise<SetupStatus> {
    return this.accounts.setupStatus();
  }

  @Post()
  @Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })
  @ApiOperation({ summary: 'Create the first administrator (requires SETUP_CODE; disabled once an admin exists)' })
  @ApiZodBody(setupSchema)
  setup(@ZodBody(setupSchema) body: SetupRequest): Promise<{ email: string }> {
    return this.accounts.setup(body);
  }
}

@ApiTags('auth')
@Controller('auth')
export class SignupController {
  constructor(private readonly accounts: AccountsService) {}

  @Post('signup')
  @Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })
  @ApiOperation({
    summary: 'Create a student account, or a teacher account that waits for administrator approval',
    description: 'Never grants administrator rights. Sign in with the email and password afterwards.',
  })
  @ApiZodBody(signupSchema)
  signup(@ZodBody(signupSchema) body: SignupRequest): Promise<SignupResponse> {
    return this.accounts.signup(body);
  }
}

@ApiTags('access requests (admin)')
@AdminOnly()
@Controller('admin/access-requests')
export class AccessRequestsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @ApiOperation({ summary: 'Pending requests for administrator access' })
  list(@CurrentUser() user: AuthUser): Promise<AccessRequest[]> {
    return this.accounts.listAccessRequests(user.id);
  }

  @Post(':id/approve')
  @HttpCode(204)
  @ApiOperation({ summary: 'Approve: the user becomes an administrator' })
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<void> {
    return this.accounts.decideAccessRequest(user.id, id, true);
  }

  @Post(':id/reject')
  @HttpCode(204)
  @ApiOperation({ summary: 'Reject: the user keeps a student account only' })
  reject(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<void> {
    return this.accounts.decideAccessRequest(user.id, id, false);
  }
}

@ApiTags('teachers & administrators (admin)')
@AdminOnly()
@Controller('admin/staff')
export class StaffController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @ApiOperation({ summary: 'All teachers and administrators with their classes, students and tests' })
  list(): Promise<StaffMember[]> {
    return this.accounts.listStaff();
  }

  @Post(':id/role')
  @HttpCode(204)
  @ApiOperation({ summary: 'Make someone an admin or teacher, or remove staff access (role "student")' })
  @ApiZodBody(setRoleSchema)
  setRole(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(setRoleSchema) body: { role: 'admin' | 'teacher' | 'student' },
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.accounts.setRole(user.id, id, body.role);
  }
}

@ApiTags('administrators (admin)')
@AdminOnly()
@Controller('admin/admins')
export class AdminsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @ApiOperation({ summary: 'List administrators' })
  list(@CurrentUser() user: AuthUser): Promise<AdminAccount[]> {
    return this.accounts.listAdmins(user.id);
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create a teacher or administrator account' })
  @ApiZodBody(createStaffSchema)
  create(@ZodBody(createStaffSchema) body: CreateStaffRequest, @CurrentUser() user: AuthUser): Promise<AdminAccount> {
    return this.accounts.createAdmin(user.id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove an administrator (not yourself, not the last one)' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<void> {
    return this.accounts.removeAdmin(user.id, id);
  }
}
