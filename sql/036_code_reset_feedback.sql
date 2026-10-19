-- =====================================================================
-- PFBS Proposal Desk — update 036: reset someone's 6-digit code + the Feedback list
--   • reset_mfa(email): the owner removes a team member's authenticator (lost / new phone); they set it up again at their
--     next sign-in. Owner only, never their own (that's under My sign-in), and it goes in the admin log.
--   • feedback: anyone on the team sends "this is confusing / I wish it did X" from the page they're on (who, which screen,
--     which job); the Owner and Admin read it and mark it done. Nothing is deleted.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 035 first.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.mfa_status()') is null then
    raise exception 'Run updates 007 to 035 first, then run this one again.';
  end if;
end $$;

create or replace function public.reset_mfa(p_email text) returns integer
language plpgsql security definer set search_path = public, auth as $$
declare e text := lower(trim(coalesce(p_email, ''))); n integer;
begin
  if public.my_role() is distinct from 'Owner' then raise exception 'Only the owner can reset a 6-digit code.'; end if;
  if e = public.my_email() then raise exception 'To change your own, use My sign-in.'; end if;
  if not exists (select 1 from public.team_members where email = e) then raise exception '% is not on the team list.', e; end if;
  delete from auth.mfa_factors f using auth.users u where f.user_id = u.id and lower(u.email) = e;
  get diagnostics n = row_count;
  insert into public.admin_log(by_name, area, item, new_value) values (public.my_name(), 'Team', e, '6-digit code reset (' || n || ' removed): sets it up again at next sign-in');
  return n;
end $$;
revoke execute on function public.reset_mfa(text) from public, anon;
grant execute on function public.reset_mfa(text) to authenticated;

create table if not exists public.feedback (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  by_email  text not null default public.my_email(),
  by_name   text default public.my_name(),
  page      text,
  num       text,
  message   text not null check (length(trim(message)) > 0),
  done_at   timestamptz,
  done_by   text,
  reply     text
);
alter table public.feedback enable row level security;
drop policy if exists fb_insert on public.feedback;
drop policy if exists fb_read on public.feedback;
drop policy if exists fb_update on public.feedback;
create policy fb_insert on public.feedback for insert with check (public.my_role() is not null and by_email = public.my_email());
create policy fb_read   on public.feedback for select using (public.my_role() in ('Owner','Admin') or by_email = public.my_email());
create policy fb_update on public.feedback for update using (public.my_role() in ('Owner','Admin')) with check (public.my_role() in ('Owner','Admin'));
grant select, insert, update on public.feedback to authenticated;
grant usage, select on sequence public.feedback_id_seq to authenticated;

notify pgrst, 'reload schema';
