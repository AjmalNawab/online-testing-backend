import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminOnly, CurrentUser } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ApiZodBody, ZodBody } from '../common/zod.js';
import { createAdminSchema, setupSchema, type CreateAdminRequest, type SetupRequest } from '../contracts/account-schemas.js';
import type { AdminAccount, SetupStatus } from '../contracts/responses.js';
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
  @ApiOperation({ summary: 'Create another administrator account' })
  @ApiZodBody(createAdminSchema)
  create(@ZodBody(createAdminSchema) body: CreateAdminRequest, @CurrentUser() user: AuthUser): Promise<AdminAccount> {
    return this.accounts.createAdmin(user.id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove an administrator (not yourself, not the last one)' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<void> {
    return this.accounts.removeAdmin(user.id, id);
  }
}
