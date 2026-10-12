-- =====================================================================
-- PFBS Proposal Desk — update 015: who we lost to, and weekly backups
--   • proposals.lost_to / lost_price: the competitor and their price, when known
--   • zap_backup(token): everything in the Proposal Desk as one JSON file, for a
--     weekly Zapier backup to SharePoint/OneDrive (see SETUP_INTEGRATIONS.md, Zap 5).
--     Same integration key as the other Zaps; nobody else can call it.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 014 first.
-- =====================================================================
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='proposals' and column_name='budget_year') then
    raise exception 'Run update 014 (014_budget_estimates.sql) first, then run this one again.';
  end if;
end $$;

alter table public.proposals
  add column if not exists lost_to text,
  add column if not exists lost_price numeric;

create or replace function public.backup_json() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'app', 'PFBS Proposal Desk', 'exported_at', now(),
    'proposals',          coalesce((select jsonb_agg(to_jsonb(x) order by x.num) from public.proposals x), '[]'),
    'proposal_activity',  coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.proposal_activity x), '[]'),
    'prospects',          coalesce((select jsonb_agg(to_jsonb(x)) from public.prospects x), '[]'),
    'team_members',       coalesce((select jsonb_agg(to_jsonb(x)) from public.team_members x), '[]'),
    'settings',           coalesce((select jsonb_agg(to_jsonb(x)) from public.settings x), '[]'),
    'commission_payouts', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.commission_payouts x), '[]'),
    'admin_log',          coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.admin_log x), '[]'),
    'deleted_proposals',  coalesce((select jsonb_agg(to_jsonb(x)) from public.deleted_proposals x), '[]'))
$$;

-- Zapier: returns the file name and the file text, ready for "Create file" in OneDrive / SharePoint
create or replace function public.zap_backup(token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b jsonb;
begin
  perform public.zap_check(token);
  b := public.backup_json();
  return jsonb_build_object(
    'filename', 'PFBS Proposal Desk backup ' || to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD') || '.json',
    'proposals', jsonb_array_length(b->'proposals'),
    'content', b::text);
end $$;

-- the app's "Download backup" button (owner and admin only)
create or replace function public.download_backup() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(public.my_role(),'') not in ('Owner','Admin') then raise exception 'Only the owner or admin can download a backup.'; end if;
  return public.backup_json();
end $$;

revoke execute on function public.backup_json(), public.zap_backup(text), public.download_backup() from public, anon, authenticated;
grant execute on function public.zap_backup(text) to anon, authenticated;
grant execute on function public.download_backup() to authenticated;

notify pgrst, 'reload schema';
