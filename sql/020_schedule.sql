-- =====================================================================
-- PFBS Proposal Desk — update 020: schedule (replaces HousecallPro's schedule and TechSched data entry)
--   • visits: each day(s) a job is worked: dates, times, techs, work, equipment, vehicle, notes, status
--     (also "events" that are not jobs, like a site walk or a lift delivery)
--   • visit_series: the repeat rule of a recurring job (every N weeks/months, on a day # or "first Tuesday",
--     ends never / after N / on a date); the app creates the visits about 12 months ahead and keeps topping up
--   • the crew list (names, emails, English/Spanish) lives in Settings
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 019 first.
-- =====================================================================
do $$ begin
  if to_regclass('public.clients') is null then
    raise exception 'Run updates 007 to 019 first, then run this one again.';
  end if;
end $$;

create table if not exists public.visit_series (
  id          uuid primary key default gen_random_uuid(),
  num         text references public.proposals(num) on update cascade on delete cascade,
  rule        jsonb not null,                       -- {every, unit:'week'|'month', mode:'day'|'nth', day, nth, weekday}
  starts      date not null,
  ends        jsonb not null default '{"type":"never"}'::jsonb,   -- {type:'never'|'after'|'on', count, date}
  template    jsonb not null default '{}'::jsonb,   -- {days, start_time, end_time, techs[], work[], equipment[], vehicle, notes, office_notes}
  exceptions  date[] not null default '{}',         -- occurrences removed on purpose (not re-created)
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  text,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
create index if not exists visit_series_num_idx on public.visit_series(num);

create table if not exists public.visits (
  id            uuid primary key default gen_random_uuid(),
  num           text references public.proposals(num) on update cascade on delete cascade,
  series_id     uuid references public.visit_series(id) on delete set null,
  occ_date      date,                               -- the series date this visit came from (stays if it is moved)
  kind          text not null default 'job' check (kind in ('job','event')),
  title         text,
  visit_date    date not null,
  end_date      date,
  start_time    text,
  end_time      text,
  techs         text[] not null default '{}',
  work          text[] not null default '{}',
  equipment     text[] not null default '{}',
  vehicle       text,
  notes         text,                               -- goes in the crew email
  office_notes  text,                               -- office only
  status        text not null default 'Scheduled' check (status in ('Scheduled','Done','Skipped','Cancelled')),
  address       text,
  client        text,
  detached      boolean not null default false,     -- changed on its own; "this and future" changes leave it alone
  invoice_id    uuid references public.invoices(id) on delete set null,
  created_at    timestamptz not null default now(),
  created_by    text,
  updated_at    timestamptz not null default now(),
  updated_by    text,
  check (end_date is null or end_date >= visit_date)
);
create index if not exists visits_date_idx on public.visits(visit_date);
create index if not exists visits_num_idx on public.visits(num);
create index if not exists visits_series_idx on public.visits(series_id, occ_date);

create or replace function public.schedule_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := coalesce(nullif(public.my_name(),''), 'Office');
begin
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, who); new.created_at := now(); end if;
  new.updated_by := who; new.updated_at := now();
  return new;
end $$;
drop trigger if exists visits_stamp on public.visits;
create trigger visits_stamp before insert or update on public.visits for each row execute function public.schedule_stamp();
drop trigger if exists visit_series_stamp on public.visit_series;
create trigger visit_series_stamp before insert or update on public.visit_series for each row execute function public.schedule_stamp();

-- first visit on an approved job → the job is Scheduled
create or replace function public.visits_after() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.num is not null and new.kind = 'job' and new.status = 'Scheduled' then
    update public.proposals set status = 'Scheduled' where num = new.num and status = 'Approved';
  end if;
  return new;
end $$;
drop trigger if exists visits_after on public.visits;
create trigger visits_after after insert on public.visits for each row execute function public.visits_after();

-- everyone on the team can see the schedule; the office (owner, admin, senior estimator) changes it
alter table public.visits enable row level security;
alter table public.visit_series enable row level security;
do $$ declare t text; begin
  foreach t in array array['visits','visit_series'] loop
    execute format('drop policy if exists %I on public.%I', t||'_read', t);
    execute format('drop policy if exists %I on public.%I', t||'_write', t);
    execute format('create policy %I on public.%I for select using (public.my_role() is not null)', t||'_read', t);
    execute format('create policy %I on public.%I for all using (public.is_manager()) with check (public.is_manager())', t||'_write', t);
  end loop;
end $$;
grant select, insert, update, delete on public.visits, public.visit_series to authenticated;
revoke all on public.visits, public.visit_series from anon;

-- backups include the schedule
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
    'deleted_proposals',  coalesce((select jsonb_agg(to_jsonb(x)) from public.deleted_proposals x), '[]'),
    'invoices',           coalesce((select jsonb_agg(to_jsonb(x) order by x.inv_no) from public.invoices x), '[]'),
    'invoice_payments',   coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.invoice_payments x), '[]'),
    'service_reports',    coalesce((select jsonb_agg(to_jsonb(x) - 'doc' || jsonb_build_object('doc', x.doc - '_raw')) from public.service_reports x), '[]'),
    'clients',            coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from public.clients x), '[]'),
    'client_contacts',    coalesce((select jsonb_agg(to_jsonb(x)) from public.client_contacts x), '[]'),
    'properties',         coalesce((select jsonb_agg(to_jsonb(x)) from public.properties x), '[]'),
    'visit_series',       coalesce((select jsonb_agg(to_jsonb(x)) from public.visit_series x), '[]'),
    'visits',             coalesce((select jsonb_agg(to_jsonb(x) order by x.visit_date) from public.visits x), '[]'))
$$;

revoke execute on function public.schedule_stamp(), public.visits_after(), public.backup_json() from public, anon, authenticated;

notify pgrst, 'reload schema';
