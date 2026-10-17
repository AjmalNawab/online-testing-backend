import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Auth, CurrentUser } from './auth.guard.js';
import type { AuthUser } from './auth.types.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  @Get('me')
  @Auth()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'The signed-in user and their role' })
  @ApiOkResponse({ description: '{ id, email, displayName, role }' })
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}
