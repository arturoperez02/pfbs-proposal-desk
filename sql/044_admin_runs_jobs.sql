-- =====================================================================
-- PFBS Proposal Desk — update 044: the Admin can run jobs like the Owner (Arturo 11/3)
--   "I want the Admin to have the ability to make job changes … I don't want the error message to come back again."
--   • the Admin no longer needs a senior estimator's review to move a proposal / job past Needs Review (New job, Make it a
--     job and Approve used to stop with "A senior estimator must review this proposal before it is sent")
--   • the Admin can change the price and scope of a job that was already sent / approved, like the Owner (no revision needed)
--   • the Admin can log review notes too
--   Estimators and BD reps keep the same rules. Everything is still recorded in the change history.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice. Needs update 043 first.
-- =====================================================================
do $$ begin
  if not exists (select 1 from pg_proc where proname = 'add_price_book') then
    raise exception 'Run updates 007 to 043 first, then run this one again.';
  end if;
end $$;

create or replace function public.proposals_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r   text := public.my_role();
  who text := coalesce(public.my_name(), nullif(public.my_email(), ''), nullif(current_setting('pfbs.actor', true), ''), 'Import');
  pre text[] := array['Lead','Estimating','Needs Review'];
  app boolean := auth.uid() is not null;     -- false from the SQL editor and from integrations
begin
  if tg_op = 'INSERT' then
    if new.num is null or new.num = '' then
      new.num := 'PFBS-' || lpad(nextval('public.proposal_seq')::text, 4, '0');
    end if;
    new.created_by := coalesce(new.created_by, who);
    new.created_at := now();
    if new.status = 'Lead' then new.lead_at := coalesce(new.lead_at, now()); end if;
  end if;

  if app and not (new.status = any(pre))
     and (tg_op = 'INSERT' or old.status = any(pre))
     and coalesce(r,'') not in ('Owner','Admin','Senior Estimator') then
    raise exception 'The owner, admin or a senior estimator must review this proposal before it is sent.';
  end if;
  if tg_op = 'UPDATE' and old.status = any(pre) and not (new.status = any(pre)) then
    new.reviewed_by := who; new.reviewed_at := now();
  end if;

  if app and tg_op = 'UPDATE' and not (old.status = any(pre)) and new.rev = old.rev
     and coalesce(r,'') not in ('Owner','Admin') then
    if public.items_scope(new.items) is distinct from public.items_scope(old.items) then
      raise exception 'This proposal was already sent, so its price and scope are locked. Create a revision to change them.';
    end if;
    if jsonb_array_length(coalesce(old.items,'[]'::jsonb)) = 0
       and (new.amount is distinct from old.amount or new.gp is distinct from old.gp or new.pass_through is distinct from old.pass_through) then
      raise exception 'This proposal was already sent, so its price is locked. Create a revision to change it.';
    end if;
  end if;

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

drop policy if exists pa_insert on public.proposal_activity;
create policy pa_insert on public.proposal_activity for insert with check (
  exists (select 1 from public.proposals p where p.num = proposal_activity.num)
  and (kind in ('note','follow_up') or (kind like 'review%' and public.my_role() in ('Owner','Admin','Senior Estimator')))
);
notify pgrst, 'reload schema';
