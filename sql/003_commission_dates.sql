-- PFBS Proposal Desk — update 003: separate payout dates for BD and estimator commission.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
alter table public.proposals add column if not exists est_comm_paid_on date;

-- Only the owner or admin can record either commission payout.
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
  if new.status not in ('Estimating','Needs Review')
     and (tg_op = 'INSERT' or old.status in ('Estimating','Needs Review'))
     and auth.uid() is not null
     and coalesce(r,'') not in ('Owner','Senior Estimator') then
    raise exception 'A senior estimator must review this proposal before it is sent.';
  end if;
  if tg_op = 'UPDATE' and old.status in ('Estimating','Needs Review') and new.status not in ('Estimating','Needs Review') then
    new.reviewed_by := who; new.reviewed_at := now();
  end if;
  if auth.uid() is not null and coalesce(r,'') not in ('Owner','Admin')
     and ((tg_op = 'INSERT' and (new.comm_paid_on is not null or new.est_comm_paid_on is not null))
          or (tg_op = 'UPDATE' and (new.comm_paid_on is distinct from old.comm_paid_on
                                    or new.est_comm_paid_on is distinct from old.est_comm_paid_on))) then
    raise exception 'Only the owner or admin can record commission payments.';
  end if;
  new.updated_by := who;
  new.updated_at := now();
  return new;
end $$;
notify pgrst, 'reload schema';
