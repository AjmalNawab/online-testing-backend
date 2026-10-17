import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { SupabaseTokenVerifier, TokenVerifier } from './token-verifier.js';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthGuard, { provide: TokenVerifier, useClass: SupabaseTokenVerifier }],
  exports: [AuthGuard, TokenVerifier],
})
export class AuthModule {}
