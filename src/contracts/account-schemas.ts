import { z } from 'zod';

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Enter a valid email address' }).max(254));

/** Supabase Auth hashes with bcrypt, which reads at most 72 bytes. */
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(72, 'Use at most 72 characters');

const displayName = z.string().trim().min(1, 'Name is required').max(120);

/** Creates another administrator (by a signed-in admin). */
export const createAdminSchema = z.object({
  display_name: displayName,
  email,
  password: passwordSchema,
});
export type CreateAdminInput = z.input<typeof createAdminSchema>;
export type CreateAdminRequest = z.output<typeof createAdminSchema>;

/** Creates the first administrator on a fresh installation. */
export const setupSchema = createAdminSchema.extend({
  setup_code: z.string().trim().min(1, 'Enter the setup code').max(200),
});
export type SetupInput = z.input<typeof setupSchema>;
export type SetupRequest = z.output<typeof setupSchema>;

export const ACCOUNT_TYPES = ['student', 'teacher'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Self-service sign-up. Teachers get a pending administrator access request. */
export const signupSchema = createAdminSchema.extend({
  account_type: z.enum(ACCOUNT_TYPES),
});
export type SignupInput = z.input<typeof signupSchema>;
export type SignupRequest = z.output<typeof signupSchema>;

/** Guest attempts taken in this browser, proved by their attempt secrets. */
export const claimAttemptsSchema = z.object({
  attempts: z
    .array(z.object({ attempt_id: z.uuid(), attempt_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }))
    .min(1)
    .max(50),
});
export type ClaimAttemptsInput = z.input<typeof claimAttemptsSchema>;

export const STAFF_ROLES = ['admin', 'teacher'] as const;

/** An admin adds a teacher or another admin directly. */
export const createStaffSchema = createAdminSchema.extend({
  role: z.enum(STAFF_ROLES).default('admin'),
});
export type CreateStaffInput = z.input<typeof createStaffSchema>;
export type CreateStaffRequest = z.output<typeof createStaffSchema>;

/** Change a staff member's role; 'student' removes their staff access. */
export const setRoleSchema = z.object({ role: z.enum(['admin', 'teacher', 'student']) });
