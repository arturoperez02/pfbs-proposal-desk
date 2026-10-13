-- =====================================================================
-- PFBS Proposal Desk — update 025: KitTracker reads the CRM schedule
--   • warehouse_logins: the KitTracker device login(s) allowed to read upcoming jobs (Settings → Warehouse)
--   • warehouse_jobs(days): upcoming scheduled visits with job #, site, techs, work, equipment, vehicle,
--     notes and scope, so the warehouse packs from the schedule instead of retyping it.
--     A warehouse login is NOT a team member: it can call this one function and nothing else.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 024 first.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.assign_job_no(text)') is null then
    raise exception 'Run updates 007 to 024 first, then run this one again.';
  end if;
end $$;

create table if not exists public.warehouse_logins (
  email     text primary key check (email = lower(email)),
  added_by  text,
  added_at  timestamptz not null default now()
);
alter table public.warehouse_logins enable row level security;
drop policy if exists wl_owner on public.warehouse_logins;
create policy wl_owner on public.warehouse_logins for all
  using (public.my_role() in ('Owner','Admin')) with check (public.my_role() in ('Owner','Admin'));
grant select, insert, delete on public.warehouse_logins to authenticated;
create or replace function public.warehouse_logins_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.added_by := coalesce(nullif(public.my_name(),''), new.added_by);
    insert into public.admin_log(by_name, area, item, new_value) values (public.my_name(), 'Settings', 'Warehouse login added', new.email);
    return new;
  end if;
  insert into public.admin_log(by_name, area, item, old_value) values (public.my_name(), 'Settings', 'Warehouse login removed', old.email);
  return old;
end $$;
revoke execute on function public.warehouse_logins_log() from public, anon, authenticated;
drop trigger if exists warehouse_logins_log on public.warehouse_logins;
create trigger warehouse_logins_log before insert or delete on public.warehouse_logins for each row execute function public.warehouse_logins_log();

-- the job's scope lines, like the page's countedItems(): accepted add-ons + the chosen pricing option (or the first)
create or replace function public.pfbs_scope(items jsonb, pick text) returns jsonb
language sql immutable set search_path = public as $$
  with it as (select i, n from jsonb_array_elements(case when jsonb_typeof(items) = 'array' then items else '[]'::jsonb end) with ordinality t(i, n)),
  grp as (select i->>'group' g, min(n) n from it where coalesce(i->>'type','') <> 'Add-on' and coalesce(i->>'group','') <> '' group by 1),
  chosen as (select g from grp where g = any (string_to_array(coalesce(pick,''), '||'))),
  picked as (select g from chosen union all select g from (select g from grp order by n limit 1) f where not exists (select 1 from chosen))
  select coalesce(jsonb_agg(split_part(coalesce(nullif(i->>'description',''), i->>'service'), E'\n', 1) order by n), '[]'::jsonb)
    from it
   where coalesce(nullif(i->>'description',''), i->>'service', '') <> ''
     and case when i->>'type' = 'Add-on' then coalesce((i->>'accepted')::boolean, false)
              else coalesce(i->>'group','') = '' or i->>'group' in (select g from picked) end
$$;

create or replace function public.warehouse_jobs(p_days int default 14) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_manager() or exists (select 1 from public.warehouse_logins where email = lower(public.my_email()))) then
    raise exception 'This login is not set up for the warehouse. Add it in the CRM: Settings → Warehouse.';
  end if;
  return coalesce((
    select jsonb_agg(x order by x->>'visit_date', x->>'start_time') from (
      select jsonb_build_object(
        'id', v.id, 'job_no', coalesce(v.job_no, p.hcp_job), 'num', v.num,
        'visit_date', v.visit_date, 'end_date', v.end_date, 'start_time', v.start_time, 'skip_weekends', v.skip_weekends,
        'client', coalesce(p.client, v.client), 'property', p.property,
        'address', coalesce(nullif(v.address,''), nullif(p.site_address,''), p.property),
        'techs', v.techs, 'work', v.work, 'equipment', v.equipment, 'vehicle', v.vehicle, 'notes', v.notes,
        'scope', public.pfbs_scope(p.items, p.pricing_option)
      ) x
      from public.visits v left join public.proposals p on p.num = v.num
      where v.kind = 'job' and v.status = 'Scheduled'
        and coalesce(v.end_date, v.visit_date) >= current_date - 1
        and v.visit_date <= current_date + greatest(1, least(coalesce(p_days, 14), 60))
    ) q), '[]'::jsonb);
end $$;
revoke execute on function public.warehouse_jobs(int) from public, anon, authenticated;
grant execute on function public.warehouse_jobs(int) to authenticated;

notify pgrst, 'reload schema';
