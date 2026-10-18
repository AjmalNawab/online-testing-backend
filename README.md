# online-test-backend

The REST API for the Online Test & Assessment Platform. It is built with NestJS on Supabase (Postgres plus Auth) and uses Google Gemini for AI. The UI lives in the separate [`online-test-frontend`](../online-test-frontend) repository.

- Any subject, topic, language and difficulty. Admins create subjects, topics, categories and tags at runtime.
- 11 question types: single/multiple choice, true/false, fill in the blanks, short and long written answers, matching, ordering, sentence construction, translation, and code. Code is never executed.
- Server-enforced timer. The deadline is stored in Postgres, and submission and grading are idempotent. A background worker finalizes expired attempts.
- AI test generation and AI-assisted grading. AI output is always saved as a draft or a suggestion that an admin must approve.
- Swagger docs at `/docs` (OpenAPI JSON at `/docs/openapi.json`).

## Architecture

```
Browser ──► Next.js frontend (Vercel) ──► this API (Railway) ──► Supabase Postgres
                 │                              │                (RLS on every table)
                 └── Supabase Auth (admin login)└── Gemini API
```

- **Roles:**
  - **Admins** see and manage everything, approve teachers and manage staff.
  - **Teachers** see only the tests they created, those tests' attempts and their own classes. The subject/topic catalog is shared.
  - **Students** join classes with a code and take tests.
  - Everyone signs in with Supabase Auth. The API verifies the bearer token and reads the role from `profiles`.
- **Classes:** a teacher creates a class with an 8-character join code, students join it, and tests are assigned to classes with an optional due date. A test can be limited to members of its assigned classes (`class_only`).
- **Students** are guests. Starting an attempt returns a random 256-bit attempt token, which is sent back as `X-Attempt-Token`. Only its SHA-256 hash is stored.
- **Data access:** all business rules that need atomicity run in SQL functions, such as `start_attempt`, `save_answers`, `claim_submission`, `apply_grading` and `admin_save_test`. Only `service_role` can execute them. The `anon` and `authenticated` roles have no table access at all, so the public Supabase key cannot read data.
- **Contracts:** the shared contracts (zod schemas, constants and response types) live in `src/contracts/`. The frontend copies them with `npm run sync:contracts`.

| Folder | Purpose |
| --- | --- |
| `src/attempts` | public test info, start/resume, autosave, submit, results, expiry worker |
| `src/tests` | admin test CRUD, duplicate, preview, publish/unpublish/archive |
| `src/catalog` | subjects, topics, categories, tags |
| `src/reviews` | admin attempt review, manual marks, releasing results, regrading |
| `src/reports` | dashboard, CSV export, progress analytics |
| `src/ai` | Gemini provider, generation, grading suggestions, auto-grade worker |
| `src/grading` | pure evaluators for each question type |
| `supabase/migrations` | the database schema (single source of truth) |

## Local development

Requirements: Node 24+ and a Supabase project (free tier is fine).

```bash
npm install
cp .env.example .env    # fill in the values (see below)
npm run db:push         # apply migrations to your Supabase database
npm run start:dev       # http://localhost:4000, docs at http://localhost:4000/docs
```

### Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string from Supabase → **Connect**. URL-encode special characters in the password (`#` → `%23`, `*` → `%2A`, `@` → `%40`). |
| `SUPABASE_URL` | yes | `https://<ref>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | yes | The public key. It is used only to verify admin logins. |
| `SUPABASE_SECRET_KEY` | for accounts | The secret key (Settings → API Keys). It is needed for student and teacher sign-up and for creating or removing admin accounts. Server-side only. |
| `SETUP_CODE` | for first-run setup | A secret phrase you choose (12+ characters). The `/setup` page asks for it before creating the first admin. |
| `CORS_ORIGINS` | yes | Comma-separated frontend origins, e.g. `https://tests.example.com` |
| `GEMINI_API_KEY` | no | Leave empty to disable AI features. The rest of the app still works. |
| `GEMINI_MODEL` | no | Default `gemini-3.7-flash` |
| `GEMINI_FALLBACK_MODELS` | no | Models to switch to, in order, when `GEMINI_MODEL` is overloaded or out of quota. Default `gemini-3.6-flash,gemini-3.5-flash-lite`; `none` disables fallback. A busy model is skipped for 2 minutes, and one that hit its quota for 30 minutes. |
| `GEMINI_THINKING_LEVEL` | no | `low` (default), `medium` or `high`. Higher levels let the model reason longer but are far slower: 10 questions took ~185 s at the model default versus ~25 s at `low`. |
| `AI_DAILY_LIMIT` | no | Maximum AI calls per admin per 24 hours (cost guard). Default 100. |
| `EXPIRY_WORKER_ENABLED` | no | Default `true`. Keep exactly one always-on instance running it. |
| `TRUST_PROXY_HOPS` | no | `1` behind Railway or another single proxy. This value is used for per-IP rate limits. |
| `SWAGGER_ENABLED` | no | Set to `false` to hide `/docs` in production if you prefer. |

Data access never uses the secret key, because the API connects to Postgres directly. The secret key is used only for creating and deleting admin sign-in accounts.

## Supabase setup

1. Create a project at [supabase.com](https://supabase.com). Note the project ref and the database password.
2. Put the connection string in `.env` as `DATABASE_URL` and run `npm run db:push`. This applies every file in `supabase/migrations`. To verify, the tables `tests`, `questions`, `test_attempts` and the others should appear in the Table Editor.
3. **Create the first admin in the browser.** Set `SUPABASE_SECRET_KEY` and `SETUP_CODE` in `.env` and restart the API. Then open the frontend's `/setup` page (the login page links to it while no admin exists) and enter your name, email, password and the setup code. The page switches itself off for good once an admin exists. You can add or remove more admins under **Settings → Administrators**. An admin cannot remove themselves, so at least one admin always remains.

   Without the secret key, you can still do it by hand. Go to **Authentication → Users → Add user** (tick "auto confirm"), then run `select public.promote_to_admin('you@example.com');` in the SQL editor.
4. **Disable public sign-ups** under **Authentication → Sign In / Providers → "Allow new users to sign up" (off)**. Admins are created by hand, and students never need accounts.
5. Under **Authentication → URL Configuration**, set the Site URL to your frontend URL.
6. Once everything works, disable the legacy JWT API keys (Settings → API Keys) and use only the publishable key.

New schema changes go in a new timestamped file in `supabase/migrations/`, followed by `npm run db:push`. That command applies pending files in order, each in its own transaction, and records them in `supabase_migrations.schema_migrations`, the same table the Supabase CLI uses. Never edit an applied migration.

## Tests

```bash
npm run typecheck
npm run lint
npm test              # unit + integration (real Postgres via PGlite, includes RLS and security tests)
npm run test:e2e      # HTTP end-to-end through the full Nest app
npm run test:all
```

The tests need no network and no Supabase project. The migrations run against an in-process Postgres (PGlite) with a small stub of the Supabase `auth` schema and roles. `npm run start:e2e` starts a seeded API on port 4100, which the frontend Playwright suite uses.

## Deployment (Railway)

The repo includes a `Dockerfile` and a `railway.json` (health check: `/health/ready`).

1. Push this repository to GitHub.
2. In Railway, go to **New Project → Deploy from GitHub repo** and select it. Railway builds the Dockerfile.
3. Under **Variables**, set everything from `.env.example`, with these production values:
   - `NODE_ENV=production`
   - `DATABASE_URL` = the Supabase **Session pooler** URL (port 5432, host `aws-0-<region>.pooler.supabase.com`, user `postgres.<ref>`). Railway has no IPv6, so the direct `db.<ref>.supabase.co` host won't connect.
   - `CORS_ORIGINS` = your Vercel URL(s), e.g. `https://online-test.vercel.app`
   - `APP_URL` = the Railway public URL
   - `TRUST_PROXY_HOPS=1`
4. Go to **Settings → Networking → Generate Domain**. Then check `https://<domain>/health/ready` and `/docs`.
5. Keep **one replica**, or set `EXPIRY_WORKER_ENABLED=false` on all but one. The SQL is safe with several workers, but one is enough.

Any Docker host works the same way, for example Render, Fly.io or a VPS: `docker build -t online-test-backend . && docker run -p 4000:4000 --env-file .env online-test-backend`.

## API overview

All routes are under `/v1` except `/health`. Full schemas are in Swagger at `/docs`.

| Area | Routes |
| --- | --- |
| Public | `GET /v1/public/tests/:shareToken`, `POST /v1/public/tests/:shareToken/attempts` |
| Attempt (needs `X-Attempt-Token`) | `GET /v1/attempts/:id`, `PUT /v1/attempts/:id/answers`, `POST /v1/attempts/:id/submit`, `GET /v1/attempts/:id/result` |
| Setup | `GET /v1/setup`, `POST /v1/setup` (needs `SETUP_CODE`; works only while no admin exists) |
| Administrators (admin) | `GET /v1/admin/admins`, `POST /v1/admin/admins`, `DELETE /v1/admin/admins/:id` |
| Sign-up | `POST /v1/auth/signup` (`account_type`: `student`, active at once; or `teacher`, a pending request that an admin approves) |
| Access requests (admin) | `GET /v1/admin/access-requests`, `POST /v1/admin/access-requests/:id/approve` (the user becomes a teacher) and `…/reject` |
| Staff (admin) | `GET /v1/admin/staff`, `POST /v1/admin/staff/:id/role` (`admin`, `teacher`, or `student` to remove access) |
| Classes (teachers & admins) | `GET/POST /v1/classes`, `GET/PATCH/DELETE /v1/classes/:id`, `POST /v1/classes/:id/reset-code`, `POST /v1/classes/:id/members`, `DELETE /v1/classes/:id/members/:studentId`, `GET/POST /v1/tests/:id/assignments`, `DELETE /v1/tests/:id/assignments/:classId` |
| My classes (students) | `POST /v1/me/classes/join`, `GET /v1/me/classes`, `DELETE /v1/me/classes/:id`, `GET /v1/me/assignments` |
| My account (signed in) | `GET /v1/me/attempts`, `GET /v1/me/attempts/:id/result`, `POST /v1/me/attempts/:id/resume`, `POST /v1/me/attempts/claim`, `GET /v1/me/progress` |
| Admin (needs a Bearer token) | `/v1/admin/tests…`, `/v1/admin/catalog…`, `/v1/admin/attempts…`, `/v1/admin/reports…` |
| AI (admin) | `GET /v1/ai/status`, `POST /v1/ai/generate-test`, `POST /v1/ai/regenerate-question`, `POST /v1/ai/attempts/:id/grade-suggestion` |
| Health | `GET /health`, `GET /health/ready` (checks the DB) |

Errors always have this shape: `{ "error": { "code": "ATTEMPT_EXPIRED", "message": "…", "details": …, "requestId": "…" } }`.

Rate limits: 300 requests/min per IP overall, 5 setup attempts per 15 min, 10 attempt starts/min, and 5 AI generations/min, plus the daily AI limit per admin.

## Security notes

- RLS is enabled on every table, and `anon`/`authenticated` have no grants. Admin SQL functions re-check the admin role (`assert_admin`).
- Request bodies are validated with strict zod schemas, so unknown fields are rejected (mass-assignment protection). Every attempt or test ID is checked against the attempt token or admin role (IDOR protection).
- Answer keys never reach students before results are released. Option order is shuffled per attempt with a seeded shuffle.
- Student answers sent to AI are fenced and treated as data, not instructions. AI marks are clamped to the question maximum.
- Helmet headers, a CORS allow-list, a 1 MB body limit, and request IDs on every response.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `ENOTFOUND`/`ENETUNREACH` connecting to `db.<ref>.supabase.co` | Your network or host has no IPv6. Use the Session pooler URL. |
| `password authentication failed` | URL-encode the password in `DATABASE_URL`. |
| `/health/ready` fails after a week idle | Free Supabase projects pause after 7 days of inactivity. Restore the project in the dashboard. |
| Browser shows a CORS error | Add the exact frontend origin (scheme + host, no trailing slash) to `CORS_ORIGINS`. |
| Admin gets 403 | The user isn't an admin yet. Add them under Settings → Administrators, or run `promote_to_admin`. |
| `/setup` says "not enabled" | Set `SUPABASE_SECRET_KEY` and `SETUP_CODE` in the API environment and restart it. |
| AI generation is slow or ends with `AI_TIMEOUT` | Keep `GEMINI_THINKING_LEVEL=low`. Tests are generated in parallel batches of 5 (4 at a time), so a 10-question test takes about 15 s. Very large tests take longer. |
| `AI_BUSY` / `AI_QUOTA_EXCEEDED` | `AI_BUSY` means Google reports high demand on every configured model, so try again in a few minutes. `AI_QUOTA_EXCEEDED` means the key's limit is used up: the free tier allows about 20 requests per model per day, and a 10-question test uses 2. Enable billing in Google AI Studio for real use. |
| AI returns `AI_NOT_CONFIGURED` / `AI_RATE_LIMITED` | Set `GEMINI_API_KEY`, or wait. The free Gemini tier has low per-minute limits. |
| Attempts never auto-submit | The expiry worker isn't running. Make sure one always-on instance has `EXPIRY_WORKER_ENABLED=true`. Attempts are also finalized when opened. |

## Expected costs

Prices checked in October 2026. Verify them before committing.

| Service | Free tier | Paid | Notes |
| --- | --- | --- | --- |
| **Supabase** (DB + Auth) | 500 MB database, 5 GB egress, 50k monthly active users; **pauses after 1 week idle**; no backups | Pro **$25/mo** (8 GB DB, daily backups, no pausing) | [Supabase pricing](https://supabase.com/pricing), [free-tier limits](https://mykavo.app/blog/supabase-free-tier-limits) |
| **Railway** (API) | Trial credit only | Hobby **$5/mo** including $5 of usage. A small always-on Nest app usually fits. | [Railway calculator](https://makerkit.dev/pricing-calculator/railway), [overview](https://costbench.com/software/developer-tools/railway/) |
| **Vercel** (frontend) | Hobby: free, **non-commercial only**, ~100 GB transfer | Pro **$20/user/mo** | [Vercel limits](https://deploywise.dev/blog/vercel-free-tier-limits-2026), [pricing](https://livemy.app/blog/vercel-pricing) |
| **Gemini** (AI) | Free tier with low rate limits; **free-tier prompts may be used to improve Google products** | Flash ≈ $0.75 / 1M input tokens, $3.75 / 1M output tokens | [Gemini pricing](https://morphllm.com/gemini-api-pricing), [overview](https://developer.puter.com/tutorials/gemini-api-pricing/) |

Rough AI cost per action: about **2–3¢ to generate a 10-question test** and **under 1¢ per grading suggestion**.

- **Small school or teacher (hobby):** about $5/mo (Railway) plus a few dollars of Gemini. Supabase and Vercel stay on free tiers.
- **Production or commercial:** about $50/mo plus AI usage (Supabase Pro $25, Railway $5–10, Vercel Pro $20).

Use a paid Gemini tier for real student data, because free-tier data may be used by Google.

## Known limitations

- For guest attempts (taken without signing in), "Max attempts" counts by student name, and results open only in the browser that took the test. For exact limits and results on any device, turn on **Require students to sign in** for the test. Signed-in attempts are counted per account.
- Sign-up creates accounts through the server with the secret key and does not verify email addresses. Teacher requests are checked by an admin before they get any access. Connect an email provider in Supabase if you need verified emails.
- The Postgres TLS connection uses `rejectUnauthorized: false`. Traffic is still encrypted, but the certificate is not pinned.
- AI-generated questions and grading suggestions can be wrong. They are always reviewed by an admin before publishing or release.
- Code answers are graded by humans or AI review only. Code is never executed.
