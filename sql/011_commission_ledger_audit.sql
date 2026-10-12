-- =====================================================================
-- PFBS Proposal Desk — update 011: commission ledger and audit trail
--   • commission_payouts: every commission payment (who, how much, how, which jobs),
--     recorded by the owner or admin; never edited or deleted, only voided with a reason
--   • commission rates are locked on a job the day it is paid (est_comm_rate, bd_comm_rate),
--     so changing the rates in Settings later never changes past commission
--   • change logs for Settings and the team list, and an archive of deleted proposals
--   • the proposal change log now also records contract term, cancellation and commission paid
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 010 first.
-- =====================================================================

-- ---------- locked commission rates ------------------------------------
alter table public.proposals
  add column if not exists est_comm_rate numeric,
  add column if not exists bd_comm_rate numeric;

create or replace function public.lock_comm_rates() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.date_paid is null then
    new.est_comm_rate := null; new.bd_comm_rate := null;          -- un-paid: rates follow Settings again
  elsif tg_op = 'INSERT' or old.date_paid is null
        or new.gp is distinct from old.gp or new.amount is distinct from old.amount
        or new.sent_by is distinct from old.sent_by or new.bd_rep is distinct from old.bd_rep
        or new.client_type is distinct from old.client_type then
    new.est_comm_rate := public.est_rate(new);                     -- lock today's rate for this job
    new.bd_comm_rate  := public.bd_rate(new);
  end if;
  return new;
end $$;
drop trigger if exists proposals_lock_comm on public.proposals;
create trigger proposals_lock_comm before insert or update on public.proposals
  for each row execute function public.lock_comm_rates();

-- lock rates on jobs already paid
update public.proposals p set est_comm_rate = public.est_rate(p), bd_comm_rate = public.bd_rate(p)
 where p.date_paid is not null and p.est_comm_rate is null and p.bd_comm_rate is null;

-- commission uses the locked rate when there is one
create or replace function public.est_comm_to(p public.proposals, d date) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare r numeric := coalesce(p.est_comm_rate, public.est_rate(p));
begin
  if p.date_paid is null or p.amount is null or r is null then return null; end if;
  if p.date_paid > d then return 0; end if;
  if not public.is_recurring(p) then return (p.amount - coalesce(p.pass_through,0) + public.co_rev(p.change_orders)) * r; end if;
  return (public.year_val(p) * (1 - coalesce(p.pass_through,0) / p.amount) / 12.0 * public.comm_months(p, d) + public.co_rev(p.change_orders)) * r;
end $$;
create or replace function public.bd_comm_to(p public.proposals, d date) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare r numeric := coalesce(p.bd_comm_rate, public.bd_rate(p));
begin
  if p.date_paid is null or r is null or p.gp is null then return null; end if;
  if p.date_paid > d then return 0; end if;
  if not public.is_recurring(p) then return (p.gp + public.co_gp(p.change_orders)) * r; end if;
  return ((case when coalesce(p.amount,0) = 0 then 0 else p.gp * public.year_val(p) / p.amount end) / 12.0 * public.comm_months(p, d) + public.co_gp(p.change_orders)) * r;
end $$;

-- earned in a period never counts months that haven't happened yet
create or replace function public.est_comm_earned(p public.proposals, a date, b date) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(public.est_comm_to(p, least(b - 1, current_date)),0) - coalesce(public.est_comm_to(p, a - 1),0) $$;
create or replace function public.bd_comm_earned(p public.proposals, a date, b date) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(public.bd_comm_to(p, least(b - 1, current_date)),0) - coalesce(public.bd_comm_to(p, a - 1),0) $$;

-- ---------- commission payout ledger -----------------------------------
create table if not exists public.commission_payouts (
  id           bigserial primary key,
  person       text not null,
  amount       numeric not null check (amount > 0),
  paid_on      date not null default current_date,
  method       text,                 -- Payroll, Check, Direct deposit, Other
  reference    text,                 -- check # or payroll period
  notes        text,
  lines        jsonb not null default '[]'::jsonb,   -- [{num, kind: est|bd, amount}]
  voided       boolean not null default false,
  void_reason  text,
  voided_by    text,
  voided_at    timestamptz,
  recorded_by  text,
  created_at   timestamptz not null default now()
);
create index if not exists commission_payouts_person_idx on public.commission_payouts(person, paid_on desc);

create or replace function public.payout_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.recorded_by := coalesce(public.my_name(), public.my_email(), new.recorded_by, 'Import');
    new.created_at := now(); new.voided := false; new.void_reason := null; new.voided_by := null; new.voided_at := null;
    return new;
  end if;
  -- updates: only voiding, once, with a reason
  if old.voided then raise exception 'This payout is already voided.'; end if;
  if not new.voided or coalesce(trim(new.void_reason),'') = '' then raise exception 'Payouts cannot be edited. Void it with a reason and record a new one.'; end if;
  if (new.person, new.amount, new.paid_on, new.method, new.reference, new.notes, new.lines, new.recorded_by, new.created_at)
     is distinct from (old.person, old.amount, old.paid_on, old.method, old.reference, old.notes, old.lines, old.recorded_by, old.created_at) then
    raise exception 'Payouts cannot be edited. Void it with a reason and record a new one.';
  end if;
  new.voided_by := coalesce(public.my_name(), public.my_email()); new.voided_at := now();
  return new;
end $$;
drop trigger if exists commission_payouts_guard on public.commission_payouts;
create trigger commission_payouts_guard before insert or update on public.commission_payouts
  for each row execute function public.payout_guard();

alter table public.commission_payouts enable row level security;
drop policy if exists cp_read   on public.commission_payouts;
drop policy if exists cp_insert on public.commission_payouts;
drop policy if exists cp_update on public.commission_payouts;
create policy cp_read   on public.commission_payouts for select using (public.my_role() in ('Owner','Admin') or person = public.my_name());
create policy cp_insert on public.commission_payouts for insert with check (public.my_role() in ('Owner','Admin'));
create policy cp_update on public.commission_payouts for update using (public.my_role() in ('Owner','Admin')) with check (public.my_role() in ('Owner','Admin'));
-- no delete policy: payouts are never deleted
grant select, insert, update on public.commission_payouts to authenticated;
grant usage, select on sequence public.commission_payouts_id_seq to authenticated;

-- ---------- settings and team change log -------------------------------
create table if not exists public.admin_log (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  by_name   text,
  area      text not null,           -- Settings, Team, Deleted proposal
  item      text,
  old_value text,
  new_value text
);
alter table public.admin_log enable row level security;
drop policy if exists al_read on public.admin_log;
create policy al_read on public.admin_log for select using (public.my_role() in ('Owner','Admin'));
grant select on public.admin_log to authenticated;

create or replace function public.settings_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; who text := coalesce(public.my_name(), public.my_email(), 'Import');
begin
  for k in select key from jsonb_each(coalesce(new.data,'{}'::jsonb)) union select key from jsonb_each(coalesce(old.data,'{}'::jsonb)) loop
    if (old.data->k) is distinct from (new.data->k) then
      insert into public.admin_log(by_name, area, item, old_value, new_value)
      values (who, 'Settings', k, left((old.data->k)::text, 2000), left((new.data->k)::text, 2000));
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists settings_log on public.settings;
create trigger settings_log after update on public.settings for each row execute function public.settings_log();

create or replace function public.team_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := coalesce(public.my_name(), public.my_email(), 'Import');
begin
  if tg_op = 'INSERT' then
    insert into public.admin_log(by_name, area, item, new_value) values (who, 'Team', new.name, 'added as ' || new.role || ' (' || new.email || ')');
  elsif tg_op = 'DELETE' then
    insert into public.admin_log(by_name, area, item, old_value) values (who, 'Team', old.name, 'removed (' || old.role || ', ' || old.email || ')');
  else
    if new.role is distinct from old.role then insert into public.admin_log(by_name, area, item, old_value, new_value) values (who, 'Team', new.name, 'role ' || old.role, 'role ' || new.role); end if;
    if new.active is distinct from old.active then insert into public.admin_log(by_name, area, item, old_value, new_value) values (who, 'Team', new.name, case when old.active then 'active' else 'inactive' end, case when new.active then 'active' else 'inactive' end); end if;
    if new.name is distinct from old.name or new.email is distinct from old.email then insert into public.admin_log(by_name, area, item, old_value, new_value) values (who, 'Team', new.name, old.name || ' ' || old.email, new.name || ' ' || new.email); end if;
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists team_log on public.team_members;
create trigger team_log after insert or update or delete on public.team_members for each row execute function public.team_log();

-- ---------- archive a proposal before it is deleted (with its history) ----
create table if not exists public.deleted_proposals (
  num         text not null,
  deleted_at  timestamptz not null default now(),
  deleted_by  text,
  row_data    jsonb not null,
  activity    jsonb
);
alter table public.deleted_proposals enable row level security;
drop policy if exists dp_read on public.deleted_proposals;
create policy dp_read on public.deleted_proposals for select using (public.my_role() = 'Owner');
grant select on public.deleted_proposals to authenticated;

create or replace function public.proposals_archive() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := coalesce(public.my_name(), public.my_email(), 'Import');
begin
  insert into public.deleted_proposals(num, deleted_by, row_data, activity)
  values (old.num, who, to_jsonb(old), (select jsonb_agg(to_jsonb(a) order by a.at) from public.proposal_activity a where a.num = old.num));
  insert into public.admin_log(by_name, area, item, old_value) values (who, 'Deleted proposal', old.num, coalesce(old.client,'') || coalesce(' · ' || old.property,'') || ' · ' || old.status);
  return old;
end $$;
drop trigger if exists proposals_archive on public.proposals;
create trigger proposals_archive before delete on public.proposals for each row execute function public.proposals_archive();

-- ---------- proposal change log: also contract and commission fields ----
create or replace function public.proposals_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := coalesce(new.updated_by, 'Import');
begin
  if tg_op = 'INSERT' then
    insert into public.proposal_activity(num, by_name, kind, field, new_value)
    values (new.num, who, 'change', 'created', new.status);
    return new;
  end if;
  if new.num <> old.num then return new; end if;
  insert into public.proposal_activity(num, by_name, kind, field, old_value, new_value)
  select new.num, who, 'change', f, o, n from (values
    ('status',            old.status,                 new.status),
    ('price',             old.amount::text,           new.amount::text),
    ('gross profit',      old.gp::text,               new.gp::text),
    ('pass-through',      old.pass_through::text,     new.pass_through::text),
    ('revision',          old.rev::text,              new.rev::text),
    ('estimator',         old.sent_by,                new.sent_by),
    ('BD rep',            old.bd_rep,                 new.bd_rep),
    ('client type',       old.client_type,            new.client_type),
    ('lead source',       old.lead_source,            new.lead_source),
    ('client',            old.client,                 new.client),
    ('property',          old.property,               new.property),
    ('date paid',         old.date_paid::text,        new.date_paid::text),
    ('BD commission paid',old.comm_paid_on::text,     new.comm_paid_on::text),
    ('estimator commission paid', old.est_comm_paid_on::text, new.est_comm_paid_on::text),
    ('HCP job #',         old.hcp_job,                new.hcp_job),
    ('contract term (months)', old.term_months::text, new.term_months::text),
    ('contract cancelled on',  old.cancelled_on::text, new.cancelled_on::text),
    ('BD commission paid $',   old.comm_paid_amt::text, new.comm_paid_amt::text),
    ('estimator commission paid $', old.est_comm_paid_amt::text, new.est_comm_paid_amt::text),
    ('estimator commission rate', old.est_comm_rate::text, new.est_comm_rate::text),
    ('BD commission rate',     old.bd_comm_rate::text, new.bd_comm_rate::text),
    ('line items / estimate',
       case when public.items_scope(new.items) is distinct from public.items_scope(old.items) then jsonb_array_length(coalesce(old.items,'[]'::jsonb))||' lines' end,
       case when public.items_scope(new.items) is distinct from public.items_scope(old.items) then jsonb_array_length(coalesce(new.items,'[]'::jsonb))||' lines' end),
    ('change orders',
       case when new.change_orders is distinct from old.change_orders then jsonb_array_length(coalesce(old.change_orders,'[]'::jsonb))||' change orders' end,
       case when new.change_orders is distinct from old.change_orders then jsonb_array_length(coalesce(new.change_orders,'[]'::jsonb))||' change orders' end)
  ) as t(f, o, n)
  where o is distinct from n;
  return new;
end $$;

revoke execute on function public.lock_comm_rates(), public.payout_guard(), public.settings_log(), public.team_log(), public.proposals_archive(),
  public.est_comm_to(public.proposals, date), public.bd_comm_to(public.proposals, date),
  public.est_comm_earned(public.proposals, date, date), public.bd_comm_earned(public.proposals, date, date) from public, anon, authenticated;
revoke all on public.commission_payouts, public.admin_log, public.deleted_proposals from anon;

notify pgrst, 'reload schema';
