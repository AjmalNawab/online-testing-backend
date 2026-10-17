import { createHash } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiBearerAuth, ApiForbiddenResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { AppError } from '../common/errors.js';
import { Database } from '../database/database.js';
import type { AuthUser, AuthenticatedRequest, Role } from './auth.types.js';
import { TokenVerifier } from './token-verifier.js';

const ROLES_KEY = 'auth:roles';
const CACHE_TTL_MS = 15_000;
const CACHE_MAX = 500;

/**
 * Verifies the Supabase access token (Authorization: Bearer <jwt>) with the
 * Supabase Auth server, loads the caller's role from `profiles` and enforces
 * the roles declared with @Auth(). Results are cached briefly per token.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly cache = new Map<string, { user: AuthUser; expiresAt: number }>();

  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    const token = extractBearer(req.headers.authorization);
    if (!token) throw new AppError('UNAUTHORIZED', 401, 'Please sign in.');

    const user = await this.resolveUser(token);
    if (roles && roles.length > 0 && !roles.includes(user.role)) {
      throw new AppError('FORBIDDEN', 403, 'You do not have permission to do that.');
    }
    req.user = user;
    return true;
  }

  private async resolveUser(token: string): Promise<AuthUser> {
    const key = createHash('sha256').update(token).digest('hex');
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.user;

    const verified = await this.verifier.verify(token);
    if (!verified) throw new AppError('UNAUTHORIZED', 401, 'Your session has expired. Please sign in again.');

    const profile = await this.db.one<{ display_name: string; role: Role }>(
      'select display_name, role from public.profiles where id = $1',
      [verified.userId],
    );
    const user: AuthUser = {
      id: verified.userId,
      email: verified.email,
      displayName: profile?.display_name ?? '',
      role: profile?.role ?? 'student',
    };

    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { user, expiresAt: Date.now() + CACHE_TTL_MS });
    return user;
  }
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,4096})$/.exec(header.trim());
  return match ? match[1]! : null;
}

/** Requires a signed-in user; pass roles to restrict further. */
export function Auth(...roles: Role[]) {
  return applyDecorators(
    SetMetadata(ROLES_KEY, roles),
    UseGuards(AuthGuard),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ description: 'Missing or invalid access token' }),
    ApiForbiddenResponse({ description: 'Insufficient role' }),
  );
}

export const AdminOnly = () => Auth('admin');

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!req.user) throw new AppError('UNAUTHORIZED', 401, 'Please sign in.');
  return req.user;
});
