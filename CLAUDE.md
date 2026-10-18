# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A NestJS 12 REST API for a general-purpose online test platform: any subject, language or question type. It uses Supabase Postgres + Auth, and Gemini for AI. The UI is the sibling repo `../online-test-frontend`, which copies this repo's `src/contracts/`. README.md covers setup, deployment, the API overview and costs.

## Commands

- `npm run start:dev`: API on :4000, Swagger at `/docs`. `main.ts` loads `.env` via `process.loadEnvFile`.
- `npm run typecheck && npm run lint && npm run test:all`: run all three before calling work done. Lint is oxlint.
- `npm test`: unit + integration (vitest, `vitest.config.ts`). `npm run test:e2e`: HTTP e2e (`vitest.config.e2e.ts`, files `test/e2e/*.e2e-spec.ts`).
- Single file: `npx vitest run test/unit/grading.spec.ts`. Single e2e file: `npx vitest run --config ./vitest.config.e2e.ts test/e2e/students.e2e-spec.ts`. Single test: add `-t "name"`.
- `npm run db:push`: applies pending `supabase/migrations/*.sql` to `DATABASE_URL`, each in a transaction, tracked in `supabase_migrations.schema_migrations` (`scripts/migrate.mjs`; no Supabase CLI needed).
- `npm run start:e2e`: seeded in-memory API on :4100 (`test/e2e-server.ts`) for the frontend's Playwright suite. Its seeded tokens and share tokens are hard-coded in the frontend's `e2e/helpers.ts`, so keep them in sync.

## Architecture

**Request path:** controller → service → `Database` (`src/database/`) → Postgres. The backend connects directly with `pg` as a privileged role. Anything that must be atomic or race-free lives in `security definer` SQL functions, called via `db.rpc('fn', { p_x })`. Examples: starting/saving/submitting attempts, saving a test with its questions, admin role changes. `buildRpcQuery` emits named args and casts arrays/objects to `jsonb`. Plain reads use `db.query` directly.

**Swappable classes:** `Database`, `TokenVerifier` (Supabase `auth.getUser`), `AuthAdmin` (Supabase admin API with the secret key, creates and deletes users) and `AiProvider` (Gemini) are abstract classes. Tests replace them with PGlite / fakes via `overrideProvider`, and `e2e-server.ts` replaces them via `Object.assign`. New external integrations should follow this pattern.

**Classes** (`src/classes/`): classes, members, join codes, test assignments, and students' "my classes / assigned tests". `tests.class_only` is enforced in `start_attempt` (`NOT_IN_CLASS`).

**Attempts** (`src/attempts/`):
- `attempt-workflow.ts` holds the framework-free flow (start, load-and-finalise-if-expired, save, submit, grade).
- `attempt-store.ts` is the typed wrapper over the SQL functions.
- `views.ts` builds the role-specific projections. Answer keys are copied out only when `computeVisibility` allows.
- Access is proved by an `AttemptAccess`: either the guest secret (`X-Attempt-Token`, only its SHA-256 is stored) or account ownership (`test_attempts.student_id`, used by `/v1/me/*` in `src/students/`).
- Expired attempts are finalised by `ExpiryWorker` (every 30 s) and also lazily on access. Submission and grading are idempotent.

**Grading** (`src/grading/`): pure functions over the evaluator registry. Each question type defines scoring, a student-safe `content` (seeded per-attempt shuffle) and answer formatting. A new question type goes in `evaluators.ts` + `contracts/question-schemas.ts`, with no DB change. Written types go to manual or AI-assisted review (`src/reviews/`). Reviewed marks are never overwritten by a regrade.

**Auth:**
- `AuthGuard` verifies the bearer token with Supabase, then reads `role` and `access_request` from `profiles`, cached for 15 s per token.
- Decorators: `@AdminOnly()`, `@Auth()`, and `@OptionalAuth()` + `@MaybeUser()` (used when starting an attempt as guest or student).
- Roles are `admin`, `teacher` and `student`. Teacher sign-ups stay `student` with `access_request = 'pending'` until an admin approves, which makes them `teacher` (`src/accounts/`). Nothing in sign-up may grant a staff role.
- **Teacher scoping:** staff routes use `@StaffOnly()` plus `src/auth/scope.ts`. `scopeOf(user)` drives the list filters (`t.created_by = …`), and `assert*InScope` returns 404 for other teachers' records. SQL functions repeat the check (`assert_test_access` / `assert_attempt_access`). Any new staff endpoint needs both. Admin-only areas (`/admin/staff`, access requests, admins) keep `@AdminOnly()`.
- First admin: the `/v1/setup` endpoint, which needs `SETUP_CODE` and works only while no admin exists.

**AI** (`src/ai/`): Gemini structured JSON output. Test generation runs in parallel batches and always saves a **draft**. Grading suggestions are stored for admin approval and clamped to the question's marks. Student text is fenced as data in prompts. There's a per-admin daily cap (`AI_DAILY_LIMIT`).

**Config:** `src/config/env.ts` validates env with zod at startup. Blank values count as unset. It's injected as `APP_CONFIG`.

## Conventions

- ESM `nodenext`: relative imports need a `.js` extension.
- Validation: the custom `ZodBody`/`ZodQuery` + `ApiZodBody` in `src/common/zod.ts`. nestjs-zod doesn't support Nest 12.
- Errors are always `{ error: { code, message, details?, requestId } }`. Throw `AppError(code, status, message)`. SQL raises `raise exception 'SOME_CODE'`, mapped in `KNOWN_DB_ERRORS` (`src/common/errors.ts`). Validation failures use `VALIDATION_FAILED`.
- After changing `src/contracts/`, run `npm run sync:contracts` in the frontend repo.

## Database rules

- Never edit an applied migration. Add a new timestamped file. To change an existing SQL function, `create or replace` it in the new migration; signature changes need a `drop function` first.
- RLS is on for every table, and `anon`/`authenticated` get nothing. New functions are `security definer set search_path = ''`, granted to `service_role` only (copy the revoke/grant `do $$` block at the end of each migration). Admin functions take `p_actor` and call `public.assert_admin`. Role changes take `pg_advisory_xact_lock(hashtext('public.admin_roles'))`.
- List parameters must be `jsonb`, not `text[]` (see rpc casting above).
- Timing uses the DB clock (`now()`, `attempt_grace()`), never client time.
- Tests run the real migrations on PGlite with a Supabase stub (`test/helpers/db.ts`: roles, `auth.users` with only `id`/`email`/`raw_user_meta_data`, `auth.uid()`). `PgliteAuthAdmin` fakes user creation there.

## Safety

- Never print `DATABASE_URL` or keys. Mask them, e.g. `sed -E 's#postgres(ql)?://[^ ]*#***#g'`.
- `.env` holds real secrets for the live Supabase project. Never commit it.
- Don't run destructive SQL against the live database without asking the user.
