-- =====================================================================
-- PFBS Proposal Desk — update 006: clear audit trail
--   • "Lead" status: BD reps log leads and assign an estimator
--   • Price lock: after a proposal is sent, scope and price can only change
--     through a revision (the owner can override; every change is logged)
--   • proposal_activity: automatic change log + review notes + follow-ups
--   • lead_at / quoted_at: time-to-quote per estimator
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- =====================================================================

-- ---------- new columns ----------------------------------------------
alter table public.proposals
  add column if not exists lead_at   timestamptz,   -- when the lead was logged
  add column if not exists quoted_at timestamptz;   -- first time it was sent

-- ---------- allow the "Lead" status -----------------------------------
alter table public.proposals drop constraint if exists proposals_status_check;
alter table public.proposals add constraint proposals_status_check check (status in
  ('Lead','Estimating','Needs Review','Sent','Follow-up','Approved','Scheduled','Invoiced','Paid','Declined','Expired','Withdrawn'));

-- ---------- activity log ----------------------------------------------
create table if not exists public.proposal_activity (
  id          bigserial primary key,
  num         text not null references public.proposals(num) on delete cascade on update cascade,
  at          timestamptz not null default now(),
  by_name     text,
  kind        text not null check (kind in ('change','review_approved','review_sent_back','note','follow_up')),
  field       text,
  old_value   text,
  new_value   text,
  note        text
);
create index if not exists proposal_activity_num_idx on public.proposal_activity(num, at desc);

-- line items without the "client accepted" ticks (accepting an add-on is not a price change)
create or replace function public.items_scope(items jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(e - 'accepted'), '[]'::jsonb) from jsonb_array_elements(coalesce(items,'[]'::jsonb)) e
$$;

-- ---------- guard: numbering, review, price lock, commission ------------
create or replace function public.proposals_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r   text := public.my_role();
  who text := coalesce(public.my_name(), nullif(public.my_email(), ''), 'Import');
  pre text[] := array['Lead','Estimating','Needs Review'];
  app boolean := auth.uid() is not null;     -- false when run from the SQL editor
begin
  if tg_op = 'INSERT' then
    if new.num is null or new.num = '' then
      new.num := 'PFBS-' || lpad(nextval('public.proposal_seq')::text, 4, '0');
    end if;
    new.created_by := coalesce(new.created_by, who);
    new.created_at := now();
    if new.status = 'Lead' then new.lead_at := coalesce(new.lead_at, now()); end if;
  end if;

  -- Only the owner or senior estimator can send something that hasn't been reviewed.
  if app and not (new.status = any(pre))
     and (tg_op = 'INSERT' or old.status = any(pre))
     and coalesce(r,'') not in ('Owner','Senior Estimator') then
    raise exception 'A senior estimator must review this proposal before it is sent.';
  end if;
  if tg_op = 'UPDATE' and old.status = any(pre) and not (new.status = any(pre)) then
    new.reviewed_by := who; new.reviewed_at := now();
  end if;

  -- Price lock: once sent, scope/price change only through a revision (owner may override; it is logged).
  if app and tg_op = 'UPDATE' and not (old.status = any(pre)) and new.rev = old.rev
     and coalesce(r,'') <> 'Owner' then
    if public.items_scope(new.items) is distinct from public.items_scope(old.items) then
      raise exception 'This proposal was already sent, so its price and scope are locked. Create a revision to change them.';
    end if;
    if jsonb_array_length(coalesce(old.items,'[]'::jsonb)) = 0
       and (new.amount is distinct from old.amount or new.gp is distinct from old.gp or new.pass_through is distinct from old.pass_through) then
      raise exception 'This proposal was already sent, so its price is locked. Create a revision to change it.';
    end if;
  end if;

  -- Commission payouts: owner or admin only.
  if app and coalesce(r,'') not in ('Owner','Admin')
     and ((tg_op = 'INSERT' and (new.comm_paid_on is not null or new.est_comm_paid_on is not null))
          or (tg_op = 'UPDATE' and (new.comm_paid_on is distinct from old.comm_paid_on
                                    or new.est_comm_paid_on is distinct from old.est_comm_paid_on))) then
    raise exception 'Only the owner or admin can record commission payments.';
  end if;

  if new.status = 'Sent' and (tg_op = 'INSERT' or old.status <> 'Sent') and new.quoted_at is null then
    new.quoted_at := now();
  end if;

  new.updated_by := who;
  new.updated_at := now();
  return new;
end $$;

-- ---------- automatic change log ----------------------------------------
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

drop trigger if exists proposals_log on public.proposals;
create trigger proposals_log after insert or update on public.proposals
for each row execute function public.proposals_log();

-- stamp who wrote a note / review / follow-up
create or replace function public.activity_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Rows written by the proposals trigger (nested) are trusted; direct inserts from the app are stamped.
  if auth.uid() is not null and pg_trigger_depth() = 1 then
    if new.kind = 'change' then raise exception 'Change entries are written automatically.'; end if;
    new.by_name := coalesce(public.my_name(), public.my_email());
    new.at := now();
  end if;
  return new;
end $$;
drop trigger if exists activity_stamp on public.proposal_activity;
create trigger activity_stamp before insert on public.proposal_activity
for each row execute function public.activity_stamp();

-- ---------- security for the activity log ------------------------------
alter table public.proposal_activity enable row level security;
drop policy if exists pa_read   on public.proposal_activity;
drop policy if exists pa_insert on public.proposal_activity;
create policy pa_read on public.proposal_activity for select using (
  exists (select 1 from public.proposals p where p.num = proposal_activity.num)
);
create policy pa_insert on public.proposal_activity for insert with check (
  exists (select 1 from public.proposals p where p.num = proposal_activity.num)
  and (kind in ('note','follow_up') or (kind like 'review%' and public.my_role() in ('Owner','Senior Estimator')))
);
-- no update/delete policies: the log cannot be edited or erased from the app

-- ---------- BD reps can log leads and edit them until estimating starts ---
drop policy if exists pr_insert on public.proposals;
drop policy if exists pr_update on public.proposals;
create policy pr_insert on public.proposals for insert with check (
  public.is_manager()
  or (public.my_role() = 'Estimator' and sent_by = public.my_name())
  or (public.my_role() = 'BD Rep' and bd_rep = public.my_name() and status = 'Lead')
);
create policy pr_update on public.proposals for update
  using (
    public.is_manager()
    or (public.my_role() = 'Estimator' and sent_by = public.my_name())
    or (public.my_role() = 'BD Rep' and bd_rep = public.my_name() and status = 'Lead'))
  with check (
    public.is_manager()
    or (public.my_role() = 'Estimator' and sent_by = public.my_name())
    or (public.my_role() = 'BD Rep' and bd_rep = public.my_name() and status = 'Lead'));

grant select, insert on public.proposal_activity to authenticated;
grant usage, select on sequence public.proposal_activity_id_seq to authenticated;
notify pgrst, 'reload schema';
