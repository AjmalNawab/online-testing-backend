import type { PGlite } from '@electric-sql/pglite';
import { asRole, createTestDb, createUser } from '../helpers/db.js';

const fails = async (fn: () => Promise<unknown>) =>
  fn().then(
    () => null,
    (e: { message: string }) => e.message,
  );

const isAdmin = async (db: PGlite, id: string) =>
  (await db.query<{ role: string }>('select role from public.profiles where id = $1', [id])).rows[0]?.role === 'admin';

describe('first-run setup', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('makes the first user an admin, then refuses any further setup', async () => {
    const first = await createUser(db, 'first@example.com');
    const second = await createUser(db, 'second@example.com');
    expect((await db.query<{ r: boolean }>('select public.admin_exists() as r')).rows[0]!.r).toBe(false);

    await db.query('select public.bootstrap_first_admin($1)', [first]);
    expect(await isAdmin(db, first)).toBe(true);
    expect((await db.query<{ r: boolean }>('select public.admin_exists() as r')).rows[0]!.r).toBe(true);

    expect(await fails(() => db.query('select public.bootstrap_first_admin($1)', [second]))).toBe('SETUP_ALREADY_COMPLETE');
    expect(await isAdmin(db, second)).toBe(false);
  });

  it('rejects unknown users', async () => {
    expect(await fails(() => db.query('select public.bootstrap_first_admin(gen_random_uuid())'))).toBe('USER_NOT_FOUND');
  });

  it('cannot be called with the public or signed-in keys', async () => {
    const user = await createUser(db, 'sneaky@example.com');
    for (const role of ['anon', 'authenticated'] as const) {
      const msg = await asRole(db, role, user, () => fails(() => db.query('select public.bootstrap_first_admin($1)', [user])));
      expect(msg, role).toMatch(/permission denied/);
    }
    expect(await isAdmin(db, user)).toBe(false);
  });
});

describe('managing administrators', () => {
  let db: PGlite;
  let admin: string;
  let student: string;
  beforeEach(async () => {
    db = await createTestDb();
    admin = await createUser(db, 'admin@example.com', true);
    student = await createUser(db, 'student@example.com');
  });

  it('lists admins with their email and marks the caller', async () => {
    const list = (await db.query<{ r: { email: string; is_you: boolean }[] }>('select public.admin_list_admins($1) as r', [admin])).rows[0]!.r;
    expect(list).toEqual([expect.objectContaining({ email: 'admin@example.com', is_you: true })]);
  });

  it('only admins can list, grant or revoke', async () => {
    expect(await fails(() => db.query('select public.admin_list_admins($1)', [student]))).toBe('FORBIDDEN');
    expect(await fails(() => db.query('select public.admin_grant_admin($1, $1)', [student]))).toBe('FORBIDDEN');
    expect(await fails(() => db.query('select public.admin_revoke_admin($1, $2)', [student, admin]))).toBe('FORBIDDEN');
    expect(await isAdmin(db, student)).toBe(false);
  });

  it('grants and revokes admin rights', async () => {
    await db.query('select public.admin_grant_admin($1, $2)', [admin, student]);
    expect(await isAdmin(db, student)).toBe(true);
    await db.query('select public.admin_revoke_admin($1, $2)', [admin, student]);
    expect(await isAdmin(db, student)).toBe(false);
  });

  it('an admin cannot remove themselves, so one admin always remains', async () => {
    expect(await fails(() => db.query('select public.admin_revoke_admin($1, $1)', [admin]))).toBe('CANNOT_REMOVE_SELF');
    expect(await isAdmin(db, admin)).toBe(true);
  });

  it('revoking someone who is not an admin is reported', async () => {
    expect(await fails(() => db.query('select public.admin_revoke_admin($1, $2)', [admin, student]))).toBe('USER_NOT_FOUND');
  });
});
