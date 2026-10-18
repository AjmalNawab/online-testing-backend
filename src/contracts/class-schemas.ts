import { z } from 'zod';

const optionalText = (max: number) => z.string().trim().max(max).nullable().default(null);

export const classInputSchema = z.object({
  name: z.string().trim().min(1, 'Class name is required').max(120),
  description: optionalText(2000),
});
export type ClassInput = z.input<typeof classInputSchema>;

export const classUpdateSchema = z
  .object({
    name: z.string().trim().min(1, 'Class name is required').max(120),
    description: optionalText(2000),
    archived: z.boolean(),
  })
  .partial();
export type ClassUpdate = z.input<typeof classUpdateSchema>;

/** Join codes are 8 letters/digits; dashes and spaces are ignored and case does not matter. */
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const normalizeJoinCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const formatJoinCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export const joinClassSchema = z.object({
  code: z
    .string()
    .transform(normalizeJoinCode)
    .pipe(z.string().regex(/^[A-Z0-9]{8}$/, 'Enter the 8-character class code')),
});
export type JoinClassInput = z.input<typeof joinClassSchema>;

export const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email({ error: 'Enter a valid email address' })),
});
export type AddMemberInput = z.input<typeof addMemberSchema>;

export const assignTestSchema = z.object({
  class_id: z.uuid('Choose a class'),
  due_at: z.iso.datetime({ offset: true, error: 'Enter a valid date and time' }).nullable().default(null),
});
export type AssignTestInput = z.input<typeof assignTestSchema>;
