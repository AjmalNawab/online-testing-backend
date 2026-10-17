import { Module } from '@nestjs/common';
import { AdminsController, SetupController } from './accounts.controller.js';
import { AccountsService } from './accounts.service.js';
import { AuthAdmin, SupabaseAuthAdmin } from './auth-admin.js';

@Module({
  controllers: [SetupController, AdminsController],
  providers: [AccountsService, { provide: AuthAdmin, useClass: SupabaseAuthAdmin }],
})
export class AccountsModule {}
