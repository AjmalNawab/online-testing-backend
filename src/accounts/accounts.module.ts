import { Module } from '@nestjs/common';
import { AccessRequestsController, AdminsController, SetupController, SignupController, StaffController } from './accounts.controller.js';
import { AccountsService } from './accounts.service.js';
import { AuthAdmin, SupabaseAuthAdmin } from './auth-admin.js';

@Module({
  controllers: [SetupController, SignupController, AdminsController, AccessRequestsController, StaffController],
  providers: [AccountsService, { provide: AuthAdmin, useClass: SupabaseAuthAdmin }],
})
export class AccountsModule {}
