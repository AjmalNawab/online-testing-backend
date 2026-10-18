import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/errors.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import type { CreateStaffRequest, SetupRequest, SignupRequest } from '../contracts/account-schemas.js';
import type { AccessRequest, AdminAccount, SetupStatus, SignupResponse, StaffMember } from '../contracts/responses.js';
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

  /**
   * Self-service sign-up. Students can sign in immediately; teachers get a
   * pending request that an administrator must approve. Nobody becomes an
   * admin here.
   */
  async signup(input: SignupRequest): Promise<SignupResponse> {
    const userId = await this.authAdmin.createUser({ email: input.email, password: input.password, displayName: input.display_name });
    if (input.account_type === 'teacher') {
      try {
        await this.db.rpc('request_admin_access', { p_user_id: userId });
      } catch (error) {
        await this.discard(userId);
        throw error;
      }
      this.logger.log(`Administrator access requested (${userId})`);
    }
    return {
      email: input.email,
      account_type: input.account_type,
      status: input.account_type === 'teacher' ? 'pending_approval' : 'active',
    };
  }

  async listAccessRequests(actorId: string): Promise<AccessRequest[]> {
    return ((await this.db.rpc('admin_list_access_requests', { p_actor: actorId })) as AccessRequest[] | null) ?? [];
  }

  async decideAccessRequest(actorId: string, userId: string, approve: boolean): Promise<void> {
    await this.db.rpc('admin_decide_access_request', { p_actor: actorId, p_user_id: userId, p_approve: approve });
    this.logger.log(`Access request ${userId} ${approve ? 'approved' : 'rejected'} by ${actorId}`);
  }

  async listAdmins(actorId: string): Promise<AdminAccount[]> {
    return ((await this.db.rpc('admin_list_admins', { p_actor: actorId })) as AdminAccount[] | null) ?? [];
  }

  /** Admins and teachers with their classes, students and tests. */
  async listStaff(): Promise<StaffMember[]> {
    const rows = await this.db.query<StaffMember>(
      `select p.id, p.display_name, u.email, p.role, p.created_at,
              (select count(*) from public.classes c where c.teacher_id = p.id and c.archived_at is null) as class_count,
              (select count(distinct m.student_id) from public.class_members m
                 join public.classes c on c.id = m.class_id where c.teacher_id = p.id) as student_count,
              (select count(*) from public.tests t where t.created_by = p.id) as test_count
       from public.profiles p join auth.users u on u.id = p.id
       where p.role in ('admin', 'teacher')
       order by p.role, lower(p.display_name), u.email`,
    );
    return rows.map((r) => ({ ...r, class_count: Number(r.class_count), student_count: Number(r.student_count), test_count: Number(r.test_count) }));
  }

  async setRole(actorId: string, userId: string, role: 'admin' | 'teacher' | 'student'): Promise<void> {
    await this.db.rpc('admin_set_role', { p_actor: actorId, p_user_id: userId, p_role: role });
    this.logger.log(`Role of ${userId} set to ${role} by ${actorId}`);
  }

  async createAdmin(actorId: string, input: CreateStaffRequest): Promise<AdminAccount> {
    // Fail fast for non-admins before touching the auth provider.
    await this.db.rpc('assert_admin', { p_actor: actorId });
    const userId = await this.authAdmin.createUser({ email: input.email, password: input.password, displayName: input.display_name });
    try {
      if (input.role === 'teacher') await this.db.rpc('admin_set_role', { p_actor: actorId, p_user_id: userId, p_role: 'teacher' });
      else await this.db.rpc('admin_grant_admin', { p_actor: actorId, p_user_id: userId });
    } catch (error) {
      await this.discard(userId);
      throw error;
    }
    this.logger.log(`${input.role === 'teacher' ? 'Teacher' : 'Administrator'} ${userId} created by ${actorId}`);
    const created = await this.db.one<AdminAccount>(
      `select p.id, u.email, p.display_name, p.created_at, false as is_you
       from public.profiles p join auth.users u on u.id = p.id where p.id = $1`,
      [userId],
    );
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
