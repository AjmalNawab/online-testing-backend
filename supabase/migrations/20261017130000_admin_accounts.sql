-- =============================================================================
-- Administrator accounts: first-run setup and managing admins from the app.
-- Auth users themselves are created by the backend through the Supabase Auth
-- admin API; these functions only decide who holds the admin role.
-- Every role change takes the same advisory lock, so concurrent requests
-- cannot create two "first" admins or remove the last one.
-- =============================================================================

create or replace function public.admin_exists()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where role = 'admin');
$$;

-- Makes the given user the first administrator. Fails once any admin exists.
create or replace function public.bootstrap_first_admin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('public.admin_roles'));
  if exists (select 1 from public.profiles where role = 'admin') then
    raise exception 'SETUP_ALREADY_COMPLETE';
  end if;
  update public.profiles set role = 'admin' where id = p_user_id;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;
end;
$$;

create or replace function public.admin_list_admins(p_actor uuid)
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
      'created_at', p.created_at,
      'is_you', p.id = p_actor
    ) order by p.created_at, u.email)
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.role = 'admin'
  ), '[]'::jsonb);
end;
$$;

create or replace function public.admin_grant_admin(p_actor uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin(p_actor);
  perform pg_advisory_xact_lock(hashtext('public.admin_roles'));
  update public.profiles set role = 'admin' where id = p_user_id;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;
end;
$$;

-- Removes admin rights. An admin cannot remove themselves, and the last admin stays.
create or replace function public.admin_revoke_admin(p_actor uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin(p_actor);
  perform pg_advisory_xact_lock(hashtext('public.admin_roles'));
  if p_user_id = p_actor then
    raise exception 'CANNOT_REMOVE_SELF';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id and role = 'admin') then
    raise exception 'USER_NOT_FOUND';
  end if;
  if (select count(*) from public.profiles where role = 'admin') <= 1 then
    raise exception 'LAST_ADMIN';
  end if;
  update public.profiles set role = 'student' where id = p_user_id;
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
      and p.proname in ('admin_exists', 'bootstrap_first_admin', 'admin_list_admins', 'admin_grant_admin', 'admin_revoke_admin')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end;
$$;
