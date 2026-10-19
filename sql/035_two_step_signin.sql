-- =====================================================================
-- PFBS Proposal Desk — update 035: password + 6-digit code (2-step sign-in)
--   • anyone who turned on the 6-digit code (authenticator app) must use it: without it the database treats them as signed out
--   • Settings → Security picks the roles that MUST use it (settings.data.mfaRoles, e.g. ["Owner","Admin","Accountant"]);
--     empty or missing = nobody is forced yet (so this update changes nothing until it's switched on)
--   • it works by tightening the three "who is signed in" helpers every rule already uses (my_member, my_role, my_name),
--     so every table and function is covered at once; the warehouse tablet logins are not team members and are not affected
--   • mfa_status(): what the sign-in screen needs to know (must use a code? has one set up? used it this time?)
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 034 first.
-- If you ever get locked out: run   update public.settings set data = data - 'mfaRoles' where id = 1;   in the SQL Editor.
-- =====================================================================
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'proposals' and column_name = 'contract_on') then
    raise exception 'Run updates 007 to 034 first, then run this one again.';
  end if;
end $$;

-- must this email use the code? (its role is in Settings → Security)
create or replace function public.mfa_required_for(e text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_members t, public.settings s
     where s.id = 1 and t.email = lower(e) and t.active
       and jsonb_typeof(s.data->'mfaRoles') = 'array' and (s.data->'mfaRoles') ? t.role)
$$;

-- has the signed-in person set up the 6-digit code?
create or replace function public.mfa_enrolled() returns boolean
language sql stable security definer set search_path = public, auth as $$
  select exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status::text = 'verified')
$$;

-- fine to let them in: used the code this time, or nobody asks them for one
create or replace function public.mfa_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt()->>'aal', '') = 'aal2'
      or not (public.mfa_enrolled() or public.mfa_required_for(public.my_email()))
$$;

create or replace function public.my_member() returns public.team_members
language sql stable security definer set search_path = public as $$
  select * from public.team_members where email = public.my_email() and active and public.mfa_ok()
$$;
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.team_members where email = public.my_email() and active and public.mfa_ok()
$$;
create or replace function public.my_name() returns text
language sql stable security definer set search_path = public as $$
  select name from public.team_members where email = public.my_email() and active and public.mfa_ok()
$$;

create or replace function public.mfa_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'member',   exists (select 1 from public.team_members where email = public.my_email() and active),
    'required', public.mfa_required_for(public.my_email()),
    'enrolled', public.mfa_enrolled(),
    'aal',      coalesce(auth.jwt()->>'aal', 'aal1'))
$$;

revoke execute on function public.mfa_required_for(text), public.mfa_enrolled(), public.mfa_ok() from public, anon;
grant execute on function public.mfa_ok() to authenticated;
revoke execute on function public.mfa_status() from public, anon;
grant execute on function public.mfa_status() to authenticated;

notify pgrst, 'reload schema';
