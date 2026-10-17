-- =============================================================================
-- Online Test & Assessment Platform — baseline schema
--
-- Security model
--   * RLS is enabled on every table. The browser's publishable/anon key has no
--     table or function access at all.
--   * The NestJS backend uses the service-role key. It verifies the caller
--     (admin JWT or guest attempt secret) before calling the functions below.
--   * Timing-critical operations (start, save, submit) run inside SECURITY
--     DEFINER functions that use the database clock and row locks, so
--     deadlines survive restarts and submissions are idempotent.
--   * Each question stores its public `content` separately from its secret
--     `answer_key`; student-facing responses are built from `content` only.
--   * All timestamps are timestamptz (UTC).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Server-defined grace window for requests sent just before the deadline.
-- Must match ATTEMPT_GRACE_MS in the backend.
create or replace function public.attempt_grace()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '5 seconds' $$;

create or replace function public.slugify(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim(both '-' from regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g'))
$$;

-- -----------------------------------------------------------------------------
-- Profiles
-- -----------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 120),
  role text not null default 'student' check (role in ('admin', 'student')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'display_name', split_part(coalesce(new.email, ''), '@', 1)), 120)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin'
  );
$$;

-- Run once from the SQL editor (or `npm run db:promote`) to grant admin rights.
create or replace function public.promote_to_admin(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  select id into v_user_id from auth.users where lower(email) = lower(p_email);
  if v_user_id is null then
    raise exception 'USER_NOT_FOUND';
  end if;
  insert into public.profiles (id, role) values (v_user_id, 'admin')
  on conflict (id) do update set role = 'admin';
end;
$$;

create or replace function public.assert_admin(p_actor uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_actor is null or not exists (
    select 1 from public.profiles where id = p_actor and role = 'admin'
  ) then
    raise exception 'FORBIDDEN';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Catalog: subjects, topics, categories, tags
-- -----------------------------------------------------------------------------

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text check (char_length(description) <= 2000),
  archived_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index subjects_name_unique on public.subjects (lower(btrim(name)));
create trigger subjects_set_updated_at before update on public.subjects
  for each row execute function public.set_updated_at();

create table public.topics (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.subjects (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 150),
  description text check (char_length(description) <= 2000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index topics_name_unique on public.topics (subject_id, lower(btrim(name)));
create trigger topics_set_updated_at before update on public.topics
  for each row execute function public.set_updated_at();

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  description text check (char_length(description) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index categories_name_unique on public.categories (lower(btrim(name)));
create trigger categories_set_updated_at before update on public.categories
  for each row execute function public.set_updated_at();

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 50),
  created_at timestamptz not null default now()
);
create unique index tags_name_unique on public.tags (lower(btrim(name)));

-- -----------------------------------------------------------------------------
-- Tests
-- -----------------------------------------------------------------------------

create table public.tests (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  description text check (char_length(description) <= 4000),
  subject_id uuid not null references public.subjects (id) on delete restrict,
  topic_id uuid references public.topics (id) on delete set null,
  category_id uuid references public.categories (id) on delete set null,
  language text not null default 'en' check (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  -- 'easy' | 'medium' | 'hard' or any custom label
  difficulty text not null default 'medium' check (char_length(btrim(difficulty)) between 1 and 40),
  instructions text check (char_length(instructions) <= 8000),
  learning_objectives text[] not null default '{}' check (cardinality(learning_objectives) <= 30),
  duration_minutes integer not null check (duration_minutes between 1 and 1440),
  passing_percentage numeric(5, 2) not null default 50 check (passing_percentage between 0 and 100),
  intended_total_marks numeric(8, 2) check (intended_total_marks is null or intended_total_marks > 0),
  max_attempts integer check (max_attempts is null or max_attempts between 1 and 100),
  shuffle_questions boolean not null default false,
  shuffle_options boolean not null default false,
  negative_marking boolean not null default false,
  partial_credit boolean not null default true,
  written_review_required boolean not null default true,
  result_release_policy text not null default 'immediate'
    check (result_release_policy in ('immediate', 'after_grading', 'manual')),
  show_correct_answers boolean not null default true,
  show_explanations boolean not null default true,
  -- Extra identification fields collected from guests, e.g.
  -- [{"key":"roll_number","label":"Roll number","required":true,"type":"text"}]
  identity_fields jsonb not null default '[]'::jsonb check (jsonb_typeof(identity_fields) = 'array'),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  share_token text not null unique check (share_token ~ '^[A-Za-z0-9_-]{20,64}$'),
  source text not null default 'manual' check (source in ('manual', 'ai')),
  created_by uuid references public.profiles (id) on delete set null,
  published_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tests_topic_requires_subject check (topic_id is null or subject_id is not null)
);

create index tests_status_created_idx on public.tests (status, created_at desc);
create index tests_subject_idx on public.tests (subject_id);
create index tests_topic_idx on public.tests (topic_id);
create index tests_category_idx on public.tests (category_id);

create trigger tests_set_updated_at before update on public.tests
  for each row execute function public.set_updated_at();

-- The topic must belong to the test's subject.
create or replace function public.check_test_topic()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.topic_id is not null and not exists (
    select 1 from public.topics t where t.id = new.topic_id and t.subject_id = new.subject_id
  ) then
    raise exception 'TOPIC_SUBJECT_MISMATCH';
  end if;
  return new;
end;
$$;

create trigger tests_check_topic before insert or update of topic_id, subject_id on public.tests
  for each row execute function public.check_test_topic();

create table public.test_tags (
  test_id uuid not null references public.tests (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  primary key (test_id, tag_id)
);
create index test_tags_tag_idx on public.test_tags (tag_id);

-- -----------------------------------------------------------------------------
-- Questions
--
-- content    : everything a student may see (options, items, languages, ...)
-- answer_key : secret grading data (correct options, accepted answers, ...)
-- The backend validates both per question type (see src/grading/evaluators).
-- -----------------------------------------------------------------------------

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests (id) on delete cascade,
  position integer not null check (position >= 1),
  question_type text not null check (question_type in (
    'mcq_single', 'mcq_multiple', 'true_false', 'fill_blank', 'matching', 'ordering',
    'short_answer', 'long_answer', 'sentence_construction', 'translation', 'code'
  )),
  prompt text not null check (char_length(btrim(prompt)) between 1 and 8000),
  content jsonb not null default '{}'::jsonb
    check (jsonb_typeof(content) = 'object' and octet_length(content::text) <= 50000),
  answer_key jsonb not null default '{}'::jsonb
    check (jsonb_typeof(answer_key) = 'object' and octet_length(answer_key::text) <= 50000),
  grading_method text not null check (grading_method in ('auto', 'manual', 'ai_assisted')),
  rubric text check (char_length(rubric) <= 8000),
  explanation text check (char_length(explanation) <= 8000),
  marks numeric(6, 2) not null check (marks > 0 and marks <= 1000),
  negative_marks numeric(6, 2) not null default 0 check (negative_marks >= 0 and negative_marks <= marks),
  -- null = inherit the test's partial_credit setting
  partial_credit boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint questions_position_unique unique (test_id, position) deferrable initially deferred,
  constraint questions_grading_method_matches_type check (
    (question_type in ('mcq_single', 'mcq_multiple', 'true_false', 'fill_blank', 'matching', 'ordering')
      and grading_method = 'auto')
    or
    (question_type not in ('mcq_single', 'mcq_multiple', 'true_false', 'fill_blank', 'matching', 'ordering')
      and grading_method in ('manual', 'ai_assisted'))
  )
);

create index questions_test_idx on public.questions (test_id, position);

create trigger questions_set_updated_at before update on public.questions
  for each row execute function public.set_updated_at();

-- A test cannot be published without questions.
create or replace function public.ensure_publishable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status is distinct from 'published') then
    if not exists (select 1 from public.questions q where q.test_id = new.id) then
      raise exception 'TEST_HAS_NO_QUESTIONS';
    end if;
    new.published_at = coalesce(new.published_at, now());
  end if;
  if new.status = 'archived' and (tg_op = 'INSERT' or old.status is distinct from 'archived') then
    new.archived_at = now();
  elsif new.status <> 'archived' then
    new.archived_at = null;
  end if;
  return new;
end;
$$;

create trigger tests_ensure_publishable before insert or update of status on public.tests
  for each row execute function public.ensure_publishable();

-- -----------------------------------------------------------------------------
-- Attempts
-- -----------------------------------------------------------------------------

create table public.test_attempts (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests (id) on delete cascade,
  -- Set when registered student accounts are introduced; guests leave it null.
  student_id uuid references public.profiles (id) on delete set null,
  student_name text not null check (char_length(btrim(student_name)) between 1 and 80),
  student_key text generated always as (lower(regexp_replace(btrim(student_name), '\s+', ' ', 'g'))) stored,
  student_info jsonb not null default '{}'::jsonb
    check (jsonb_typeof(student_info) = 'object' and octet_length(student_info::text) <= 4000),
  attempt_number integer not null check (attempt_number >= 1),
  -- SHA-256 (hex) of the random attempt secret held by the student's browser.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  submitted_at timestamptz,
  status text not null default 'in_progress' check (status in ('in_progress', 'submitted', 'expired')),
  submission_type text check (submission_type in ('manual', 'auto_client', 'auto_server')),
  grading_status text not null default 'not_submitted'
    check (grading_status in ('not_submitted', 'grading', 'pending_review', 'complete')),
  objective_score numeric(8, 2),
  final_score numeric(8, 2),
  maximum_marks numeric(8, 2),
  percentage numeric(5, 2),
  passed boolean,
  correct_count integer,
  incorrect_count integer,
  unanswered_count integer,
  pending_review_count integer,
  results_released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint test_attempts_number_unique unique (test_id, student_key, attempt_number),
  constraint test_attempts_deadline_after_start check (deadline_at > started_at),
  constraint test_attempts_submitted_matches_status check ((status = 'in_progress') = (submitted_at is null))
);

create index test_attempts_test_idx on public.test_attempts (test_id, created_at desc);
create index test_attempts_active_deadline_idx on public.test_attempts (deadline_at) where status = 'in_progress';
create index test_attempts_student_idx on public.test_attempts (student_key, created_at desc);
create index test_attempts_grading_idx on public.test_attempts (grading_status);

create trigger test_attempts_set_updated_at before update on public.test_attempts
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Answers and reviews
-- -----------------------------------------------------------------------------

create table public.student_answers (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.test_attempts (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete cascade,
  answer jsonb not null default 'null'::jsonb check (octet_length(answer::text) <= 50000),
  -- Monotonic client revision; a save only wins if it is newer than what is stored.
  client_revision bigint not null default 0,
  awarded_marks numeric(8, 2),
  is_correct boolean,
  grading_status text not null default 'ungraded'
    check (grading_status in ('ungraded', 'auto_graded', 'pending_review', 'reviewed')),
  feedback text check (char_length(feedback) <= 8000),
  ai_suggestion jsonb,
  ai_suggested_at timestamptz,
  saved_at timestamptz not null default now(),
  graded_at timestamptz,
  graded_by uuid references public.profiles (id) on delete set null,
  constraint student_answers_unique unique (attempt_id, question_id)
);

create index student_answers_question_idx on public.student_answers (question_id);
create index student_answers_pending_idx on public.student_answers (attempt_id)
  where grading_status = 'pending_review';

-- Audit trail of every review decision (manual or approved AI suggestion).
create table public.answer_reviews (
  id uuid primary key default gen_random_uuid(),
  answer_id uuid not null references public.student_answers (id) on delete cascade,
  reviewer_id uuid references public.profiles (id) on delete set null,
  awarded_marks numeric(8, 2) not null check (awarded_marks >= 0),
  feedback text check (char_length(feedback) <= 8000),
  source text not null check (source in ('manual', 'ai_approved')),
  ai_suggestion jsonb,
  created_at timestamptz not null default now()
);
create index answer_reviews_answer_idx on public.answer_reviews (answer_id, created_at desc);

-- -----------------------------------------------------------------------------
-- AI usage log (cost tracking and per-admin limits)
-- -----------------------------------------------------------------------------

create table public.ai_generations (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references public.profiles (id) on delete set null,
  kind text not null check (kind in ('test', 'question', 'grading')),
  status text not null check (status in ('succeeded', 'failed')),
  model text not null,
  request jsonb not null default '{}'::jsonb,
  input_tokens integer,
  output_tokens integer,
  error_code text,
  test_id uuid references public.tests (id) on delete set null,
  created_at timestamptz not null default now()
);
create index ai_generations_created_idx on public.ai_generations (created_by, created_at desc);

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.subjects enable row level security;
alter table public.topics enable row level security;
alter table public.categories enable row level security;
alter table public.tags enable row level security;
alter table public.tests enable row level security;
alter table public.test_tags enable row level security;
alter table public.questions enable row level security;
alter table public.test_attempts enable row level security;
alter table public.student_answers enable row level security;
alter table public.answer_reviews enable row level security;
alter table public.ai_generations enable row level security;

-- No direct access for the anonymous/publishable key.
revoke all on table
  public.profiles, public.subjects, public.topics, public.categories, public.tags, public.tests,
  public.test_tags, public.questions, public.test_attempts, public.student_answers,
  public.answer_reviews, public.ai_generations
from anon;

-- Signed-in users: read-only access, own profile or admin. All writes go
-- through the backend (service role), which enforces authorization.
revoke insert, update, delete on table
  public.profiles, public.subjects, public.topics, public.categories, public.tags, public.tests,
  public.test_tags, public.questions, public.test_attempts, public.student_answers,
  public.answer_reviews, public.ai_generations
from authenticated;

create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
create policy subjects_admin_select on public.subjects for select to authenticated using ((select public.is_admin()));
create policy topics_admin_select on public.topics for select to authenticated using ((select public.is_admin()));
create policy categories_admin_select on public.categories for select to authenticated using ((select public.is_admin()));
create policy tags_admin_select on public.tags for select to authenticated using ((select public.is_admin()));
create policy tests_admin_select on public.tests for select to authenticated using ((select public.is_admin()));
create policy test_tags_admin_select on public.test_tags for select to authenticated using ((select public.is_admin()));
create policy questions_admin_select on public.questions for select to authenticated using ((select public.is_admin()));
create policy test_attempts_admin_select on public.test_attempts for select to authenticated using ((select public.is_admin()));
create policy student_answers_admin_select on public.student_answers for select to authenticated using ((select public.is_admin()));
create policy answer_reviews_admin_select on public.answer_reviews for select to authenticated using ((select public.is_admin()));
create policy ai_generations_admin_select on public.ai_generations for select to authenticated using ((select public.is_admin()));

-- -----------------------------------------------------------------------------
-- Admin: save a test, its tags and (optionally) its questions atomically.
-- Questions cannot change once a test has attempts (duplicate it instead).
-- -----------------------------------------------------------------------------

create or replace function public.admin_save_test(
  p_actor uuid, p_test jsonb, p_questions jsonb default null, p_tags text[] default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(p_test ->> 'id', '')::uuid;
  v_objectives text[] := coalesce(
    (select array_agg(value) from jsonb_array_elements_text(coalesce(p_test -> 'learning_objectives', '[]'::jsonb))),
    '{}'
  );
begin
  perform public.assert_admin(p_actor);

  if v_id is null then
    insert into public.tests (
      title, description, subject_id, topic_id, category_id, language, difficulty, instructions,
      learning_objectives, duration_minutes, passing_percentage, intended_total_marks, max_attempts,
      shuffle_questions, shuffle_options, negative_marking, partial_credit, written_review_required,
      result_release_policy, show_correct_answers, show_explanations, identity_fields,
      share_token, source, created_by
    ) values (
      p_test ->> 'title',
      p_test ->> 'description',
      (p_test ->> 'subject_id')::uuid,
      nullif(p_test ->> 'topic_id', '')::uuid,
      nullif(p_test ->> 'category_id', '')::uuid,
      coalesce(p_test ->> 'language', 'en'),
      coalesce(p_test ->> 'difficulty', 'medium'),
      p_test ->> 'instructions',
      v_objectives,
      (p_test ->> 'duration_minutes')::integer,
      (p_test ->> 'passing_percentage')::numeric,
      (p_test ->> 'intended_total_marks')::numeric,
      (p_test ->> 'max_attempts')::integer,
      coalesce((p_test ->> 'shuffle_questions')::boolean, false),
      coalesce((p_test ->> 'shuffle_options')::boolean, false),
      coalesce((p_test ->> 'negative_marking')::boolean, false),
      coalesce((p_test ->> 'partial_credit')::boolean, true),
      coalesce((p_test ->> 'written_review_required')::boolean, true),
      coalesce(p_test ->> 'result_release_policy', 'immediate'),
      coalesce((p_test ->> 'show_correct_answers')::boolean, true),
      coalesce((p_test ->> 'show_explanations')::boolean, true),
      coalesce(p_test -> 'identity_fields', '[]'::jsonb),
      p_test ->> 'share_token',
      coalesce(p_test ->> 'source', 'manual'),
      p_actor
    )
    returning id into v_id;
  else
    update public.tests set
      title = p_test ->> 'title',
      description = p_test ->> 'description',
      subject_id = (p_test ->> 'subject_id')::uuid,
      topic_id = nullif(p_test ->> 'topic_id', '')::uuid,
      category_id = nullif(p_test ->> 'category_id', '')::uuid,
      language = coalesce(p_test ->> 'language', 'en'),
      difficulty = coalesce(p_test ->> 'difficulty', 'medium'),
      instructions = p_test ->> 'instructions',
      learning_objectives = v_objectives,
      duration_minutes = (p_test ->> 'duration_minutes')::integer,
      passing_percentage = (p_test ->> 'passing_percentage')::numeric,
      intended_total_marks = (p_test ->> 'intended_total_marks')::numeric,
      max_attempts = (p_test ->> 'max_attempts')::integer,
      shuffle_questions = coalesce((p_test ->> 'shuffle_questions')::boolean, false),
      shuffle_options = coalesce((p_test ->> 'shuffle_options')::boolean, false),
      negative_marking = coalesce((p_test ->> 'negative_marking')::boolean, false),
      partial_credit = coalesce((p_test ->> 'partial_credit')::boolean, true),
      written_review_required = coalesce((p_test ->> 'written_review_required')::boolean, true),
      result_release_policy = coalesce(p_test ->> 'result_release_policy', 'immediate'),
      show_correct_answers = coalesce((p_test ->> 'show_correct_answers')::boolean, true),
      show_explanations = coalesce((p_test ->> 'show_explanations')::boolean, true),
      identity_fields = coalesce(p_test -> 'identity_fields', '[]'::jsonb)
    where id = v_id;
    if not found then
      raise exception 'TEST_NOT_FOUND';
    end if;
  end if;

  if p_tags is not null then
    insert into public.tags (name)
    select distinct on (lower(btrim(t))) btrim(t) from unnest(p_tags) as t where btrim(t) <> ''
    on conflict (lower(btrim(name))) do nothing;

    delete from public.test_tags where test_id = v_id;
    insert into public.test_tags (test_id, tag_id)
    select distinct v_id, tg.id from public.tags tg
    where lower(btrim(tg.name)) in (select lower(btrim(t)) from unnest(p_tags) as t);
  end if;

  if p_questions is not null then
    if jsonb_typeof(p_questions) <> 'array' then
      raise exception 'INVALID_PAYLOAD';
    end if;
    if exists (select 1 from public.test_attempts a where a.test_id = v_id) then
      raise exception 'TEST_LOCKED';
    end if;

    delete from public.questions where test_id = v_id;

    insert into public.questions (
      id, test_id, position, question_type, prompt, content, answer_key, grading_method,
      rubric, explanation, marks, negative_marks, partial_credit
    )
    select
      coalesce(x.id, gen_random_uuid()), v_id, x.position, x.question_type, x.prompt,
      coalesce(x.content, '{}'::jsonb), coalesce(x.answer_key, '{}'::jsonb), x.grading_method,
      x.rubric, x.explanation, x.marks, coalesce(x.negative_marks, 0), x.partial_credit
    from jsonb_to_recordset(p_questions) as x(
      id uuid, position integer, question_type text, prompt text, content jsonb, answer_key jsonb,
      grading_method text, rubric text, explanation text, marks numeric, negative_marks numeric,
      partial_credit boolean
    );

    if not exists (select 1 from public.questions q where q.test_id = v_id)
       and exists (select 1 from public.tests t where t.id = v_id and t.status = 'published') then
      raise exception 'TEST_HAS_NO_QUESTIONS';
    end if;
  end if;

  return v_id;
end;
$$;

create or replace function public.admin_set_test_status(p_actor uuid, p_test_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_test public.tests%rowtype;
begin
  perform public.assert_admin(p_actor);
  if p_status not in ('draft', 'published', 'archived') then
    raise exception 'INVALID_PAYLOAD';
  end if;
  update public.tests set status = p_status where id = p_test_id returning * into v_test;
  if not found then
    raise exception 'TEST_NOT_FOUND';
  end if;
  return to_jsonb(v_test);
end;
$$;

-- -----------------------------------------------------------------------------
-- Student attempt workflow
-- -----------------------------------------------------------------------------

create or replace function public.start_attempt(
  p_share_token text, p_student_name text, p_student_info jsonb, p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_test public.tests%rowtype;
  v_name text := btrim(regexp_replace(coalesce(p_student_name, ''), '\s+', ' ', 'g'));
  v_count integer;
  v_attempt public.test_attempts%rowtype;
begin
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'INVALID_NAME';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_TOKEN';
  end if;

  -- Lock the test row so attempt numbers are assigned without races.
  select * into v_test from public.tests
  where share_token = p_share_token and status = 'published'
  for update;
  if not found then
    raise exception 'TEST_NOT_AVAILABLE';
  end if;

  select count(*) into v_count from public.test_attempts
  where test_id = v_test.id and student_key = lower(v_name);

  if v_test.max_attempts is not null and v_count >= v_test.max_attempts then
    raise exception 'MAX_ATTEMPTS_REACHED';
  end if;

  insert into public.test_attempts (
    test_id, student_name, student_info, attempt_number, token_hash, started_at, deadline_at
  ) values (
    v_test.id, v_name, coalesce(p_student_info, '{}'::jsonb), v_count + 1, p_token_hash,
    now(), now() + make_interval(mins => v_test.duration_minutes)
  )
  returning * into v_attempt;

  return to_jsonb(v_attempt) - 'token_hash';
end;
$$;

-- Full bundle including answer keys. The backend projects it into
-- role-specific response shapes; it is never returned to a browser as-is.
create or replace function public.get_attempt_bundle_internal(p_attempt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_attempt public.test_attempts%rowtype;
begin
  select * into v_attempt from public.test_attempts where id = p_attempt_id;
  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'server_time', now(),
    'attempt', to_jsonb(v_attempt) - 'token_hash',
    'test', (
      select to_jsonb(t) || jsonb_build_object('subject_name', s.name, 'topic_name', tp.name)
      from public.tests t
      join public.subjects s on s.id = t.subject_id
      left join public.topics tp on tp.id = t.topic_id
      where t.id = v_attempt.test_id
    ),
    'questions', coalesce((
      select jsonb_agg(to_jsonb(q) order by q.position)
      from public.questions q where q.test_id = v_attempt.test_id
    ), '[]'::jsonb),
    'answers', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.saved_at)
      from public.student_answers a where a.attempt_id = p_attempt_id
    ), '[]'::jsonb)
  );
end;
$$;

-- Same bundle, only for a caller holding the attempt secret.
create or replace function public.get_attempt_bundle(p_attempt_id uuid, p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_token_hash is null or not exists (
    select 1 from public.test_attempts where id = p_attempt_id and token_hash = p_token_hash
  ) then
    return null;
  end if;
  return public.get_attempt_bundle_internal(p_attempt_id);
end;
$$;

create or replace function public.save_answers(p_attempt_id uuid, p_token_hash text, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.test_attempts%rowtype;
  v_saved integer;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  select * into v_attempt from public.test_attempts where id = p_attempt_id for update;
  if not found or p_token_hash is null or v_attempt.token_hash <> p_token_hash then
    raise exception 'ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status <> 'in_progress' then
    raise exception 'ATTEMPT_CLOSED';
  end if;
  if now() > v_attempt.deadline_at + public.attempt_grace() then
    raise exception 'DEADLINE_PASSED';
  end if;

  with incoming as (
    select distinct on (x.question_id)
      x.question_id, coalesce(x.answer, 'null'::jsonb) as answer, coalesce(x.revision, 0) as revision
    from jsonb_to_recordset(p_answers) as x(question_id uuid, answer jsonb, revision bigint)
    where x.question_id is not null
    order by x.question_id, x.revision desc nulls last
  ),
  valid as (
    select i.* from incoming i
    join public.questions q on q.id = i.question_id and q.test_id = v_attempt.test_id
  ),
  upserted as (
    insert into public.student_answers (attempt_id, question_id, answer, client_revision, saved_at)
    select p_attempt_id, v.question_id, v.answer, v.revision, now() from valid v
    on conflict (attempt_id, question_id) do update
      set answer = excluded.answer,
          client_revision = excluded.client_revision,
          saved_at = excluded.saved_at
      where public.student_answers.client_revision < excluded.client_revision
    returning question_id
  )
  select count(*) into v_saved from upserted;

  return jsonb_build_object(
    'saved', v_saved,
    'received', jsonb_array_length(p_answers),
    'server_time', now(),
    'deadline_at', v_attempt.deadline_at
  );
end;
$$;

-- Idempotent: the first call closes the attempt; later calls only report state.
create or replace function public.claim_submission(p_attempt_id uuid, p_token_hash text, p_submission_type text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.test_attempts%rowtype;
  v_now timestamptz := now();
  v_expired boolean;
begin
  if p_submission_type is null or p_submission_type not in ('manual', 'auto_client', 'auto_server') then
    raise exception 'INVALID_SUBMISSION_TYPE';
  end if;

  select * into v_attempt from public.test_attempts where id = p_attempt_id for update;
  if not found then
    raise exception 'ATTEMPT_NOT_FOUND';
  end if;
  if p_submission_type <> 'auto_server'
     and (p_token_hash is null or v_attempt.token_hash <> p_token_hash) then
    raise exception 'ATTEMPT_NOT_FOUND';
  end if;

  if v_attempt.status <> 'in_progress' then
    return jsonb_build_object('claimed', false, 'attempt', to_jsonb(v_attempt) - 'token_hash');
  end if;

  v_expired := v_now > v_attempt.deadline_at + public.attempt_grace();

  if p_submission_type = 'auto_server' and not v_expired then
    raise exception 'ATTEMPT_STILL_ACTIVE';
  end if;

  update public.test_attempts set
    status = case when v_expired then 'expired' else 'submitted' end,
    submitted_at = least(v_now, v_attempt.deadline_at),
    submission_type = case when v_expired then 'auto_server' else p_submission_type end,
    grading_status = 'grading'
  where id = p_attempt_id
  returning * into v_attempt;

  return jsonb_build_object('claimed', true, 'attempt', to_jsonb(v_attempt) - 'token_hash');
end;
$$;

-- Stores grades computed by the backend from trusted question data.
-- Answers already reviewed by an administrator are never overwritten.
create or replace function public.apply_grading(p_attempt_id uuid, p_answers jsonb, p_summary jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.test_attempts%rowtype;
begin
  select * into v_attempt from public.test_attempts where id = p_attempt_id for update;
  if not found then
    raise exception 'ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status = 'in_progress' then
    raise exception 'ATTEMPT_NOT_SUBMITTED';
  end if;

  -- Every question gets an answer row, so unanswered questions are graded too.
  insert into public.student_answers (attempt_id, question_id, answer, saved_at)
  select p_attempt_id, x.question_id, 'null'::jsonb, v_attempt.submitted_at
  from jsonb_to_recordset(coalesce(p_answers, '[]'::jsonb)) as x(question_id uuid)
  join public.questions q on q.id = x.question_id and q.test_id = v_attempt.test_id
  on conflict (attempt_id, question_id) do nothing;

  update public.student_answers sa set
    awarded_marks = x.awarded_marks,
    is_correct = x.is_correct,
    grading_status = x.grading_status,
    graded_at = case when x.grading_status = 'auto_graded' then now() else sa.graded_at end
  from jsonb_to_recordset(coalesce(p_answers, '[]'::jsonb)) as x(
    question_id uuid, awarded_marks numeric, is_correct boolean, grading_status text
  )
  where sa.attempt_id = p_attempt_id
    and sa.question_id = x.question_id
    and sa.grading_status <> 'reviewed';

  update public.test_attempts set
    objective_score = (p_summary ->> 'objective_score')::numeric,
    final_score = (p_summary ->> 'final_score')::numeric,
    maximum_marks = (p_summary ->> 'maximum_marks')::numeric,
    percentage = (p_summary ->> 'percentage')::numeric,
    passed = (p_summary ->> 'passed')::boolean,
    correct_count = (p_summary ->> 'correct_count')::integer,
    incorrect_count = (p_summary ->> 'incorrect_count')::integer,
    unanswered_count = (p_summary ->> 'unanswered_count')::integer,
    pending_review_count = (p_summary ->> 'pending_review_count')::integer,
    grading_status = p_summary ->> 'grading_status'
  where id = p_attempt_id
  returning * into v_attempt;

  return to_jsonb(v_attempt) - 'token_hash';
end;
$$;

create or replace function public.list_expired_attempt_ids(p_limit integer default 50)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(id), '[]'::jsonb) from (
    select a.id from public.test_attempts a
    where (a.status = 'in_progress' and a.deadline_at + public.attempt_grace() < now())
       or (a.status <> 'in_progress' and a.grading_status = 'grading' and a.updated_at < now() - interval '1 minute')
    order by a.deadline_at
    limit greatest(1, least(coalesce(p_limit, 50), 500))
  ) s;
$$;

-- -----------------------------------------------------------------------------
-- Admin review
-- -----------------------------------------------------------------------------

create or replace function public.review_answer(
  p_actor uuid, p_attempt_id uuid, p_question_id uuid, p_marks numeric, p_feedback text, p_source text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.test_attempts%rowtype;
  v_question public.questions%rowtype;
  v_row public.student_answers%rowtype;
  v_feedback text := nullif(btrim(coalesce(p_feedback, '')), '');
begin
  perform public.assert_admin(p_actor);
  if p_source not in ('manual', 'ai_approved') then
    raise exception 'INVALID_PAYLOAD';
  end if;

  select * into v_attempt from public.test_attempts where id = p_attempt_id for update;
  if not found then
    raise exception 'ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status = 'in_progress' then
    raise exception 'ATTEMPT_NOT_SUBMITTED';
  end if;

  select * into v_question from public.questions where id = p_question_id and test_id = v_attempt.test_id;
  if not found then
    raise exception 'QUESTION_NOT_FOUND';
  end if;
  if p_marks is null or p_marks < 0 or p_marks > v_question.marks then
    raise exception 'INVALID_MARKS';
  end if;

  insert into public.student_answers (
    attempt_id, question_id, answer, awarded_marks, is_correct, grading_status,
    feedback, graded_at, graded_by, saved_at
  ) values (
    p_attempt_id, p_question_id, 'null'::jsonb, p_marks, p_marks = v_question.marks, 'reviewed',
    v_feedback, now(), p_actor, coalesce(v_attempt.submitted_at, now())
  )
  on conflict (attempt_id, question_id) do update set
    awarded_marks = excluded.awarded_marks,
    is_correct = excluded.is_correct,
    grading_status = 'reviewed',
    feedback = excluded.feedback,
    graded_at = excluded.graded_at,
    graded_by = excluded.graded_by
  returning * into v_row;

  insert into public.answer_reviews (answer_id, reviewer_id, awarded_marks, feedback, source, ai_suggestion)
  values (v_row.id, p_actor, p_marks, v_feedback, p_source,
          case when p_source = 'ai_approved' then v_row.ai_suggestion end);

  return to_jsonb(v_row);
end;
$$;

create or replace function public.save_ai_suggestion(p_attempt_id uuid, p_question_id uuid, p_suggestion jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.test_attempts%rowtype;
begin
  select * into v_attempt from public.test_attempts where id = p_attempt_id;
  if not found or v_attempt.status = 'in_progress' then
    raise exception 'ATTEMPT_NOT_SUBMITTED';
  end if;
  if not exists (select 1 from public.questions where id = p_question_id and test_id = v_attempt.test_id) then
    raise exception 'QUESTION_NOT_FOUND';
  end if;

  insert into public.student_answers (attempt_id, question_id, answer, ai_suggestion, ai_suggested_at, saved_at)
  values (p_attempt_id, p_question_id, 'null'::jsonb, p_suggestion, now(), coalesce(v_attempt.submitted_at, now()))
  on conflict (attempt_id, question_id) do update
    set ai_suggestion = excluded.ai_suggestion, ai_suggested_at = excluded.ai_suggested_at;
end;
$$;

create or replace function public.set_results_released(p_actor uuid, p_attempt_id uuid, p_released boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin(p_actor);
  update public.test_attempts
  set results_released_at = case when p_released then coalesce(results_released_at, now()) else null end
  where id = p_attempt_id and status <> 'in_progress';
  if not found then
    raise exception 'ATTEMPT_NOT_SUBMITTED';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Function privileges: everything except is_admin() is service-role only.
-- -----------------------------------------------------------------------------

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'promote_to_admin', 'handle_new_user', 'assert_admin', 'admin_save_test', 'admin_set_test_status',
        'start_attempt', 'get_attempt_bundle_internal', 'get_attempt_bundle', 'save_answers',
        'claim_submission', 'apply_grading', 'list_expired_attempt_ids', 'review_answer',
        'save_ai_suggestion', 'set_results_released'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end;
$$;
