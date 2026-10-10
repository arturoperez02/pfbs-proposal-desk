-- =====================================================================
-- PFBS Proposal Desk — Supabase schema
-- Run once in Supabase: SQL Editor → New query → paste → Run.
-- Safe to re-run: it drops and recreates functions/policies/triggers,
-- and only creates tables that don't exist yet.
-- =====================================================================

-- ---------- Tables ----------------------------------------------------

create table if not exists public.team_members (
  email       text primary key,                -- Microsoft 365 work email, lowercase
  name        text not null unique,            -- name shown in "Sent by" / "BD rep"
  role        text not null check (role in ('Owner','Admin','Senior Estimator','Estimator','BD Rep')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.settings (
  id          int primary key default 1 check (id = 1),   -- single row
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

create sequence if not exists public.proposal_seq start 802;

create table if not exists public.proposals (
  num            text primary key,               -- PFBS-0802; assigned automatically when left blank
  date_sent      date,
  sent_by        text references public.team_members(name) on update cascade,
  client         text not null,
  property       text,
  service        text,
  frequency      text,
  amount         numeric(12,2),                  -- price per visit
  gp             numeric(12,2),                  -- estimated gross profit per visit
  pass_through   numeric(12,2),                  -- lifts, subcontractors
  status         text not null default 'Estimating' check (status in
                 ('Estimating','Needs Review','Sent','Follow-up','Approved','Scheduled','Invoiced','Paid','Declined','Expired','Withdrawn')),
  date_resolved  date,
  hcp_job        text,
  client_type    text,
  lead_source    text,
  bd_rep         text references public.team_members(name) on update cascade,
  lost_reason    text,
  date_paid      date,
  comm_paid_on   date,
  bid_link       text,
  folder_link    text,
  notes          text,
  reviewed_by    text,
  reviewed_at    timestamptz,
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_by     text,
  updated_at     timestamptz not null default now()
);

create table if not exists public.proposal_history (
  id          bigserial primary key,
  num         text not null references public.proposals(num) on delete cascade on update cascade,
  status      text not null,
  changed_at  timestamptz not null default now(),
  changed_by  text
);
create index if not exists proposal_history_num_idx on public.proposal_history(num);

-- ---------- Helper functions (who is signed in) -----------------------

create or replace function public.my_email() returns text
language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create or replace function public.my_member() returns public.team_members
language sql stable security definer set search_path = public as $$
  select * from public.team_members where email = public.my_email() and active
$$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.team_members where email = public.my_email() and active
$$;

create or replace function public.my_name() returns text
language sql stable security definer set search_path = public as $$
  select name from public.team_members where email = public.my_email() and active
$$;

-- Owner, Admin and Senior Estimator see and manage every proposal.
create or replace function public.is_manager() returns boolean
language sql stable as $$ select coalesce(public.my_role() in ('Owner','Admin','Senior Estimator'), false) $$;

-- ---------- Triggers --------------------------------------------------

-- Assign the next PFBS number, stamp who/when, and enforce the review + commission rules.
create or replace function public.proposals_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := public.my_role(); who text := coalesce(public.my_name(), nullif(public.my_email(), ''), 'Import');
begin
  if tg_op = 'INSERT' then
    if new.num is null or new.num = '' then
      new.num := 'PFBS-' || lpad(nextval('public.proposal_seq')::text, 4, '0');
    end if;
    new.created_by := coalesce(new.created_by, who);
    new.created_at := now();
  end if;

  -- Only the senior estimator (or owner) can send a proposal that hasn't been reviewed.
  if new.status not in ('Estimating','Needs Review')
     and (tg_op = 'INSERT' or old.status in ('Estimating','Needs Review'))
     and auth.uid() is not null
     and coalesce(r,'') not in ('Owner','Senior Estimator') then
    raise exception 'A senior estimator must review this proposal before it is sent.';
  end if;
  if tg_op = 'UPDATE' and old.status in ('Estimating','Needs Review') and new.status not in ('Estimating','Needs Review') then
    new.reviewed_by := who; new.reviewed_at := now();
  end if;

  -- Commission payment dates are owner/admin only.
  if auth.uid() is not null and coalesce(r,'') not in ('Owner','Admin')
     and (tg_op = 'INSERT' and new.comm_paid_on is not null
          or tg_op = 'UPDATE' and new.comm_paid_on is distinct from old.comm_paid_on) then
    raise exception 'Only the owner or admin can record commission payments.';
  end if;

  new.updated_by := who;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists proposals_guard on public.proposals;
create trigger proposals_guard before insert or update on public.proposals
for each row execute function public.proposals_guard();

-- Keep a status history automatically.
create or replace function public.proposals_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.proposal_history(num, status, changed_by)
    values (new.num, new.status, new.updated_by);
  end if;
  return new;
end $$;

drop trigger if exists proposals_history on public.proposals;
create trigger proposals_history after insert or update on public.proposals
for each row execute function public.proposals_history();

-- ---------- Row level security ----------------------------------------

alter table public.team_members     enable row level security;
alter table public.settings         enable row level security;
alter table public.proposals        enable row level security;
alter table public.proposal_history enable row level security;

-- team_members: every active member can see the roster; only the owner changes it.
drop policy if exists tm_read  on public.team_members;
drop policy if exists tm_write on public.team_members;
create policy tm_read  on public.team_members for select using (public.my_role() is not null);
create policy tm_write on public.team_members for all
  using (public.my_role() = 'Owner') with check (public.my_role() = 'Owner');

-- settings: members read; owner writes.
drop policy if exists st_read  on public.settings;
drop policy if exists st_write on public.settings;
create policy st_read  on public.settings for select using (public.my_role() is not null);
create policy st_write on public.settings for all
  using (public.my_role() = 'Owner') with check (public.my_role() = 'Owner');

-- proposals:
--   managers (Owner, Admin, Senior Estimator) see and edit everything;
--   an Estimator sees and edits only proposals they sent;
--   a BD Rep sees only proposals credited to them (read only).
drop policy if exists pr_read   on public.proposals;
drop policy if exists pr_insert on public.proposals;
drop policy if exists pr_update on public.proposals;
drop policy if exists pr_delete on public.proposals;
create policy pr_read on public.proposals for select using (
  public.is_manager()
  or (public.my_role() = 'Estimator' and sent_by = public.my_name())
  or (public.my_role() = 'BD Rep'    and bd_rep  = public.my_name())
);
create policy pr_insert on public.proposals for insert with check (
  public.is_manager()
  or (public.my_role() = 'Estimator' and sent_by = public.my_name())
);
create policy pr_update on public.proposals for update
  using      (public.is_manager() or (public.my_role() = 'Estimator' and sent_by = public.my_name()))
  with check (public.is_manager() or (public.my_role() = 'Estimator' and sent_by = public.my_name()));
create policy pr_delete on public.proposals for delete using (public.my_role() = 'Owner');

-- history: readable wherever the proposal is readable; written only by the trigger.
drop policy if exists ph_read on public.proposal_history;
create policy ph_read on public.proposal_history for select using (
  exists (select 1 from public.proposals p where p.num = proposal_history.num)
);

-- ---------- Live updates ----------------------------------------------
do $$ begin
  begin alter publication supabase_realtime add table public.proposals; exception when others then null; end;
  begin alter publication supabase_realtime add table public.settings;  exception when others then null; end;
end $$;

-- ---------- Starting data ---------------------------------------------
insert into public.settings(id, data) values (1, '{
  "services": ["Window Cleaning","Pressure Wash","Solar Panel Cleaning","Janitorial","Gutter Cleaning","Graffiti Removal","Gates & Doors","Lights - Decor","Multiple services","Other"],
  "frequencies": [["One-time",1],["Annual",1],["Semi-annual",2],["Quarterly",4],["Bi-monthly",6],["Monthly",12],["Weekly",52]],
  "leadSources": ["BD rep","Repeat client","Referral","BOMA / networking","Building Partners Network","Inbound (web / phone)","Bid invite / RFP","Cold outreach"],
  "lostReasons": ["Price too high","Went with incumbent","Timing / budget","No response","Scope changed","Other"],
  "clientTypes": [["New client",0.10],["Existing client - new property",0.05],["House account",0]],
  "marginFloor": 0.35,
  "belowFloorShare": 0.5,
  "estTiers": [[0,0.02],[0.35,0.035],[0.45,0.05]],
  "expiryDays": 90
}'::jsonb) on conflict (id) do nothing;
