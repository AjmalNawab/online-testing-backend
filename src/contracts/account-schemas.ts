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
