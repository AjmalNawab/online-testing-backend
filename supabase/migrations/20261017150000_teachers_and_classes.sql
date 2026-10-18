-- =============================================================================
-- Teachers and classes.
--  * New role 'teacher': manages only their own tests, classes and results.
--    'admin' sees everything and approves teachers.
--  * Classes with join codes; students join one or more classes.
--  * Tests are assigned to classes (optional due date); a test can be limited
--    to members of its assigned classes (class_only).
-- =============================================================================

alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'teacher', 'student'));

-- Admins who came in through a teacher request become teachers.
update public.profiles set role = 'teacher' where role = 'admin' and access_requested_at is not null;

alter table public.tests add column class_only boolean not null default false;
create index tests_created_by_idx on public.tests (created_by);

-- ------------------------------------------------------------------ access ---

create or replace function public.assert_staff(p_actor uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_actor is null or not exists (
    select 1 from public.profiles where id = p_actor and role in ('admin', 'teacher')
  ) then
    raise exception 'FORBIDDEN';
  end if;
end;
$$;

-- Admins may manage any test; teachers only the tests they created.
create or replace function public.assert_test_access(p_actor uuid, p_test_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.profiles where id = p_actor and role = 'admin') then
    return;
  end if;
  if exists (
    select 1 from public.profiles p join public.tests t on t.created_by = p.id
    where p.id = p_actor and p.role = 'teacher' and t.id = p_test_id
  ) then
    return;
  end if;
  raise exception 'FORBIDDEN';
end;
$$;

create or replace function public.assert_attempt_access(p_actor uuid, p_attempt_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_test_id uuid;
begin
  select test_id into v_test_id from public.test_attempts where id = p_attempt_id;
  if v_test_id is null then
    if exists (select 1 from public.profiles where id = p_actor and role = 'admin') then
      return; -- the caller reports ATTEMPT_NOT_FOUND
    end if;
    raise exception 'FORBIDDEN';
  end if;
  perform public.assert_test_access(p_actor, v_test_id);
end;
$$;

-- ----------------------------------------------------------------- classes ---

create table public.classes (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (char_length(description) <= 2000),
  join_code text not null unique check (join_code ~ '^[A-Z0-9]{8}$'),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index classes_teacher_idx on public.classes (teacher_id, created_at desc);
create trigger classes_set_updated_at before update on public.classes
  for each row execute function public.set_updated_at();

create table public.class_members (
  class_id uuid not null references public.classes (id) on delete cascade,
  student_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (class_id, student_id)
);
create index class_members_student_idx on public.class_members (student_id);

create table public.test_assignments (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests (id) on delete cascade,
  class_id uuid not null references public.classes (id) on delete cascade,
  due_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (test_id, class_id)
);
create index test_assignments_class_idx on public.test_assignments (class_id);

alter table public.classes enable row level security;
alter table public.class_members enable row level security;
alter table public.test_assignments enable row level security;
-- All access goes through the backend; the public and signed-in keys get nothing.
revoke all on table public.classes, public.class_members, public.test_assignments from anon, authenticated;

-- ------------------------------------------------ teacher access requests ---

create or replace function public.request_admin_access(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
  set access_request = 'pending', access_requested_at = now()
  where id = p_user_id and role = 'student';
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;
end;
$$;

create or replace function public.admin_list_access_requests(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin(p_actor);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id,
      'email', u.email,
      'display_name', p.display_name,
      'requested_at', p.access_requested_at
    ) order by p.access_requested_at)
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.access_request = 'pending' and p.role = 'student'
  ), '[]'::jsonb);
end;
$$;

-- Approving makes the user a teacher (not an admin).
create or replace function public.admin_decide_access_request(p_actor uuid, p_user_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin(p_actor);
  perform pg_advisory_xact_lock(hashtext('public.admin_roles'));
  if not exists (select 1 from public.profiles where id = p_user_id and access_request = 'pending' and role = 'student') then
    raise exception 'REQUEST_NOT_FOUND';
  end if;
  if p_approve then
    update public.profiles set role = 'teacher', access_request = null where id = p_user_id;
  else
    update public.profiles set access_request = 'rejected' where id = p_user_id;
  end if;
end;
$$;

-- Admins set a staff member's role: 'admin', 'teacher' or 'student' (removes staff access).
create or replace function public.admin_set_role(p_actor uuid, p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin(p_actor);
  perform pg_advisory_xact_lock(hashtext('public.admin_roles'));
  if p_role not in ('admin', 'teacher', 'student') then
    raise exception 'INVALID_PAYLOAD';
  end if;
  if p_user_id = p_actor then
    raise exception 'CANNOT_REMOVE_SELF';
  end if;
  update public.profiles set role = p_role, access_request = null where id = p_user_id;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;
end;
$$;

-- ---------------------------------------------- functions now open to teachers ---

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
  if v_id is null then
    perform public.assert_staff(p_actor);
  else
    perform public.assert_test_access(p_actor, v_id);
  end if;

  if v_id is null then
    insert into public.tests (
      title, description, subject_id, topic_id, category_id, language, difficulty, instructions,
      learning_objectives, duration_minutes, passing_percentage, intended_total_marks, max_attempts,
      shuffle_questions, shuffle_options, negative_marking, partial_credit, written_review_required,
      result_release_policy, show_correct_answers, show_explanations, identity_fields, require_student_account, class_only,
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
      coalesce((p_test ->> 'require_student_account')::boolean, false),
      coalesce((p_test ->> 'class_only')::boolean, false),
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
      identity_fields = coalesce(p_test -> 'identity_fields', '[]'::jsonb),
      require_student_account = coalesce((p_test ->> 'require_student_account')::boolean, false),
      class_only = coalesce((p_test ->> 'class_only')::boolean, false)
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
  perform public.assert_test_access(p_actor, p_test_id);
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
  perform public.assert_attempt_access(p_actor, p_attempt_id);
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

create or replace function public.set_results_released(p_actor uuid, p_attempt_id uuid, p_released boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_attempt_access(p_actor, p_attempt_id);
  update public.test_attempts
  set results_released_at = case when p_released then coalesce(results_released_at, now()) else null end
  where id = p_attempt_id and status <> 'in_progress';
  if not found then
    raise exception 'ATTEMPT_NOT_SUBMITTED';
  end if;
end;
$$;

create or replace function public.start_attempt(
  p_share_token text, p_student_name text, p_student_info jsonb, p_token_hash text, p_student_id uuid default null
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
  if p_student_id is not null and not exists (select 1 from public.profiles where id = p_student_id) then
    raise exception 'USER_NOT_FOUND';
  end if;

  -- Lock the test row so attempt numbers are assigned without races.
  select * into v_test from public.tests
  where share_token = p_share_token and status = 'published'
  for update;
  if not found then
    raise exception 'TEST_NOT_AVAILABLE';
  end if;

  if p_student_id is null and (v_test.require_student_account or v_test.class_only) then
    raise exception 'STUDENT_ACCOUNT_REQUIRED';
  end if;
  if v_test.class_only and not exists (
    select 1 from public.test_assignments ta
    join public.class_members cm on cm.class_id = ta.class_id
    join public.classes c on c.id = ta.class_id and c.archived_at is null
    where ta.test_id = v_test.id and cm.student_id = p_student_id
  ) then
    raise exception 'NOT_IN_CLASS';
  end if;

  if p_student_id is not null then
    select count(*) into v_count from public.test_attempts
    where test_id = v_test.id and student_id = p_student_id;
  else
    select count(*) into v_count from public.test_attempts
    where test_id = v_test.id and student_key = lower(v_name);
  end if;

  if v_test.max_attempts is not null and v_count >= v_test.max_attempts then
    raise exception 'MAX_ATTEMPTS_REACHED';
  end if;

  insert into public.test_attempts (
    test_id, student_id, student_name, student_info, attempt_number, token_hash, started_at, deadline_at
  ) values (
    v_test.id, p_student_id, v_name, coalesce(p_student_info, '{}'::jsonb), v_count + 1, p_token_hash,
    now(), now() + make_interval(mins => v_test.duration_minutes)
  )
  returning * into v_attempt;

  return to_jsonb(v_attempt) - 'token_hash';
end;
$$;

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'assert_staff', 'assert_test_access', 'assert_attempt_access', 'request_admin_access',
        'admin_list_access_requests', 'admin_decide_access_request', 'admin_set_role', 'admin_save_test',
        'admin_set_test_status', 'review_answer', 'set_results_released', 'start_attempt'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end;
$$;
