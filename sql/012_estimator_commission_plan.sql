-- =====================================================================
-- PFBS Proposal Desk — update 012: estimator commission plan
--   • estimator rate by job margin: under 35% → 2%, 35–45% → 3%, 45% and up → 4%
--     (of the job amount less pass-through, plus approved change orders)
--   • when a BD rep is on the job, the estimator gets 75% of that rate
--   • jobs already paid keep the rate they were locked at (update 011), so past
--     commission does not change. Both numbers can be changed later in Settings.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 011 first.
-- =====================================================================
do $$ begin
  if to_regclass('public.commission_payouts') is null then
    raise exception 'Run update 011 (011_commission_ledger_audit.sql) first, then run this one again.';
  end if;
end $$;

update public.settings
   set data = coalesce(data,'{}'::jsonb) || jsonb_build_object('estTiers', '[[0,0.02],[0.35,0.03],[0.45,0.04]]'::jsonb, 'estBdShare', 0.75)
 where id = 1;

create or replace function public.est_rate(p public.proposals) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare rate numeric; g numeric; t jsonb; share numeric := coalesce((public.pfbs_setting('estBdShare','1'))::text::numeric, 1);
begin
  if not exists (select 1 from public.team_members m where m.name = p.sent_by and m.role in ('Estimator','Senior Estimator')) then return null; end if;
  if p.gp is null or coalesce(p.amount,0) = 0 then return null; end if;
  g := p.gp / p.amount;
  for t in select x from jsonb_array_elements(public.pfbs_setting('estTiers','[[0,0.02],[0.35,0.03],[0.45,0.04]]')) x order by (x->>0)::numeric loop
    if rate is null then rate := (t->>1)::numeric; end if;
    if g >= (t->>0)::numeric then rate := (t->>1)::numeric; end if;
  end loop;
  if p.bd_rep is not null then rate := rate * share; end if;
  return rate;
end $$;
revoke execute on function public.est_rate(public.proposals) from public, anon, authenticated;

notify pgrst, 'reload schema';
