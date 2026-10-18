import { notFound } from '../common/errors.js';
import type { Queryable } from '../database/database.js';
import type { AuthUser } from './auth.types.js';

/**
 * Whose data a staff member may see: admins see everything, teachers only the
 * tests they created (and those tests' attempts) and their own classes.
 * Records outside the scope are reported as "not found".
 */
export interface Scope {
  userId: string;
  isAdmin: boolean;
}

export const scopeOf = (user: AuthUser): Scope => ({ userId: user.id, isAdmin: user.role === 'admin' });

export async function assertTestInScope(db: Queryable, scope: Scope, testId: string): Promise<void> {
  if (scope.isAdmin) return;
  const rows = await db.query('select 1 from public.tests where id = $1 and created_by = $2', [testId, scope.userId]);
  if (!rows.length) throw notFound('Test');
}

export async function assertAttemptInScope(db: Queryable, scope: Scope, attemptId: string): Promise<void> {
  if (scope.isAdmin) return;
  const rows = await db.query(
    `select 1 from public.test_attempts a join public.tests t on t.id = a.test_id where a.id = $1 and t.created_by = $2`,
    [attemptId, scope.userId],
  );
  if (!rows.length) throw notFound('Attempt');
}

export async function assertClassInScope(db: Queryable, scope: Scope, classId: string): Promise<void> {
  const rows = await db.query(
    `select 1 from public.classes where id = $1 and ($2::boolean or teacher_id = $3)`,
    [classId, scope.isAdmin, scope.userId],
  );
  if (!rows.length) throw notFound('Class');
}
