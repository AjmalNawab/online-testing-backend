# online-test-backend

NestJS 12 REST API for a general-purpose online test platform (any subject, language or question type). Supabase Postgres + Auth, Gemini for AI. The frontend is the sibling repo `../online-test-frontend`. See README.md for setup and deployment.

## Commands

- `npm run start:dev`: API on :4000, Swagger at /docs
- `npm run typecheck && npm run lint && npm run test:all`: run all three before calling work done
- `npm test`: unit + integration. `npm run test:e2e`: HTTP e2e. Single file: `npx vitest run path/to/spec.ts`
- `npm run db:push`: applies pending `supabase/migrations/*.sql` to `DATABASE_URL` (scripts/migrate.mjs)
- `npm run start:e2e`: seeded test API on :4100, used by the frontend's Playwright suite

## Conventions

- ESM with `nodenext`: relative imports need a `.js` extension.
- Validation uses zod via the custom `ZodBody`/`ApiZodBody` in `src/common/zod.ts`. nestjs-zod doesn't support Nest 12.
- Errors are always `{ error: { code, message, details?, requestId } }`. Throw `AppError(code, status, message)`. SQL functions `raise exception 'SOME_CODE'`, and the code is mapped in `KNOWN_DB_ERRORS` (`src/common/errors.ts`). Validation failures use code `VALIDATION_FAILED`.
- `src/contracts/` is shared with the frontend. After changing it, run `npm run sync:contracts` in the frontend repo.
- Each question type has a public `content` and a secret `answer_key`. Grading lives in the evaluator registry in `src/grading/evaluators.ts`. New question types go there and in `question-schemas.ts`, with no schema changes.

## Database rules

- Never edit an applied migration. Add a new timestamped file in `supabase/migrations/`.
- RLS is on for every table, and `anon`/`authenticated` get nothing. New SQL functions must be `security definer set search_path = ''` and granted to `service_role` only (copy the revoke/grant `do $$` block). Admin functions take `p_actor` and call `public.assert_admin`.
- The timer, saves and submission are enforced in SQL with the DB clock (`start_attempt`, `save_answers`, `claim_submission`). Never trust client time.
- Tests run the real migrations on PGlite with a Supabase stub (`test/helpers/db.ts`). The stub's `auth.users` has only `id`, `email` and `raw_user_meta_data`.

## Safety

- Never print `DATABASE_URL` or keys. Mask them, e.g. `sed -E 's#postgres(ql)?://[^ ]*#***#g'`.
- `.env` holds real secrets for the live Supabase project. Never commit it.
- Don't run destructive SQL against the live database without asking the user.
