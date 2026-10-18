-- =============================================================================
-- Student accounts and administrator access requests.
--  * Students may sign up; their attempts are linked to their account
--    (test_attempts.student_id) so they can see their history on any device.
--  * Tests can require a student account (require_student_account).
--  * Teachers may request administrator access; an admin approves or rejects.
-- Guest attempts via share link keep working unchanged.
-- =============================================================================

alter table public.profiles
  add column access_request text check (access_request in ('pending', 'rejected')),
  add column access_requested_at timestamptz;

alter table public.tests
  add column require_student_account boolean not null default false;

-- Attempt numbers were unique per (test, name). Signed-in students are counted
-- by account instead, and claimed guest attempts keep their numbers, so the
-- numbering is no longer unique. start_attempt still assigns numbers under a
-- row lock on the test.
alter table public.test_attempts drop constraint test_attempts_number_unique;
create index test_attempts_account_idx on public.test_attempts (student_id, created_at desc) where student_id is not null;

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
      result_release_policy, show_correct_answers, show_explanations, identity_fields, require_student_account,
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
      require_student_account = coalesce((p_test ->> 'require_student_account')::boolean, false)
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

drop function public.start_attempt(text, text, jsonb, text);

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

  if p_student_id is null and v_test.require_student_account then
    raise exception 'STUDENT_ACCOUNT_REQUIRED';
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

-- Bundle for the signed-in student who owns the attempt.
create or replace function public.get_student_attempt_bundle(p_student_id uuid, p_attempt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_student_id is null or not exists (
    select 1 from public.test_attempts where id = p_attempt_id and student_id = p_student_id
  ) then
    return null;
  end if;
  return public.get_attempt_bundle_internal(p_attempt_id);
end;
$$;

-- Issues a new attempt secret to the owner of an in-progress attempt, so they
-- can continue on another device. The previous secret stops working.
create or replace function public.rotate_attempt_token(p_student_id uuid, p_attempt_id uuid, p_token_hash text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_TOKEN';
  end if;
  update public.test_attempts set token_hash = p_token_hash, updated_at = now()
  where id = p_attempt_id and student_id = p_student_id and status = 'in_progress';
  if not found then
    if exists (select 1 from public.test_attempts where id = p_attempt_id and student_id = p_student_id) then
      raise exception 'ATTEMPT_CLOSED';
    end if;
    raise exception 'ATTEMPT_NOT_FOUND';
  end if;
end;
$$;

-- Links guest attempts (proved by their secrets) to a student account.
-- p_token_hashes: JSON array of SHA-256 hex strings.
create or replace function public.claim_attempts(p_student_id uuid, p_token_hashes jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not exists (select 1 from public.profiles where id = p_student_id) then
    raise exception 'USER_NOT_FOUND';
  end if;
  update public.test_attempts set student_id = p_student_id, updated_at = now()
  where student_id is null
    and token_hash in (select jsonb_array_elements_text(coalesce(p_token_hashes, '[]'::jsonb)));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- --------------------------------------------------------- access requests ---

create or replace function public.request_admin_access(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
  set access_request = 'pending', access_requested_at = now()
  where id = p_user_id and role <> 'admin';
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
    where p.access_request = 'pending' and p.role <> 'admin'
  ), '[]'::jsonb);
end;
$$;

create or replace function public.admin_decide_access_request(p_actor uuid, p_user_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin(p_actor);
  perform pg_advisory_xact_lock(hashtext('public.admin_roles'));
  if not exists (select 1 from public.profiles where id = p_user_id and access_request = 'pending' and role <> 'admin') then
    raise exception 'REQUEST_NOT_FOUND';
  end if;
  if p_approve then
    update public.profiles set role = 'admin', access_request = null where id = p_user_id;
  else
    update public.profiles set access_request = 'rejected' where id = p_user_id;
  end if;
end;
$$;

-- Approving through the admin list also clears any pending request.
create or replace function public.admin_grant_admin(p_actor uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin(p_actor);
  perform pg_advisory_xact_lock(hashtext('public.admin_roles'));
  update public.profiles set role = 'admin', access_request = null where id = p_user_id;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;
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
        'admin_save_test', 'start_attempt', 'get_student_attempt_bundle', 'rotate_attempt_token', 'claim_attempts',
        'request_admin_access', 'admin_list_access_requests', 'admin_decide_access_request', 'admin_grant_admin'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end;
$$;
