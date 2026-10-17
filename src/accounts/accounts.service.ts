import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/errors.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import type { CreateAdminRequest, SetupRequest } from '../contracts/account-schemas.js';
import type { AdminAccount, SetupStatus } from '../contracts/responses.js';
import { Database } from '../database/database.js';
import { AuthAdmin, notConfigured } from './auth-admin.js';

const digest = (s: string) => createHash('sha256').update(s).digest();

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly db: Database,
    private readonly authAdmin: AuthAdmin,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private adminExists(): Promise<boolean> {
    return this.db.rpc('admin_exists', {}) as Promise<boolean>;
  }

  async setupStatus(): Promise<SetupStatus> {
    return {
      needs_setup: !(await this.adminExists()),
      available: Boolean(this.config.setupCode) && this.authAdmin.configured,
    };
  }

  /** Creates the first administrator. Works only while no admin exists. */
  async setup(input: SetupRequest): Promise<{ email: string }> {
    if (!this.config.setupCode) {
      throw new AppError('SETUP_NOT_CONFIGURED', 503, 'Browser setup is not enabled. Add SETUP_CODE to the backend environment.');
    }
    if (!this.authAdmin.configured) throw notConfigured();
    if (!timingSafeEqual(digest(input.setup_code), digest(this.config.setupCode))) {
      throw new AppError('INVALID_SETUP_CODE', 403, 'The setup code is not correct.');
    }
    if (await this.adminExists()) {
      throw new AppError('SETUP_ALREADY_COMPLETE', 409, 'Setup is already complete. Please sign in.');
    }

    const userId = await this.authAdmin.createUser({ email: input.email, password: input.password, displayName: input.display_name });
    try {
      // Re-checked under a lock: if two setups race, only one becomes admin.
      await this.db.rpc('bootstrap_first_admin', { p_user_id: userId });
    } catch (error) {
      await this.discard(userId);
      throw error;
    }
    this.logger.log(`First administrator created (${userId})`);
    return { email: input.email };
  }

  async listAdmins(actorId: string): Promise<AdminAccount[]> {
    return ((await this.db.rpc('admin_list_admins', { p_actor: actorId })) as AdminAccount[] | null) ?? [];
  }

  async createAdmin(actorId: string, input: CreateAdminRequest): Promise<AdminAccount> {
    // Fail fast for non-admins before touching the auth provider.
    await this.db.rpc('assert_admin', { p_actor: actorId });
    const userId = await this.authAdmin.createUser({ email: input.email, password: input.password, displayName: input.display_name });
    try {
      await this.db.rpc('admin_grant_admin', { p_actor: actorId, p_user_id: userId });
    } catch (error) {
      await this.discard(userId);
      throw error;
    }
    this.logger.log(`Administrator ${userId} created by ${actorId}`);
    const created = (await this.listAdmins(actorId)).find((a) => a.id === userId);
    if (!created) throw new AppError('INTERNAL_ERROR', 500, 'Something went wrong. Please try again.');
    return created;
  }

  /** Removes admin rights, then deletes the sign-in account. */
  async removeAdmin(actorId: string, userId: string): Promise<void> {
    await this.db.rpc('admin_revoke_admin', { p_actor: actorId, p_user_id: userId });
    this.logger.log(`Administrator ${userId} removed by ${actorId}`);
    try {
      await this.authAdmin.deleteUser(userId);
    } catch (error) {
      // Access is already revoked; a leftover account without the admin role can do nothing.
      this.logger.warn(`Could not delete auth user ${userId}: ${(error as Error).message}`);
    }
  }

  private async discard(userId: string): Promise<void> {
    await this.authAdmin.deleteUser(userId).catch((e: unknown) => {
      this.logger.warn(`Could not delete auth user ${userId} after a failed role change: ${(e as Error).message}`);
    });
  }
}
