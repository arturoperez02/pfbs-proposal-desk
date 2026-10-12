-- =====================================================================
-- PFBS Proposal Desk — update 014: budget proposals
--   • new status "Budget": pricing a client asked for next year's budget.
--     It stays out of the open pipeline, win rate, follow-up emails and the
--     monthly report's open/follow-up counts (those only look at "Sent").
--   • budget_year and budget_check (the day to check back, e.g. January 15)
--   • HousecallPro: a budget that gets scheduled or completed moves on like a proposal
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 007 first.
-- =====================================================================
alter table public.proposals
  add column if not exists budget_year int,
  add column if not exists budget_check date;

alter table public.proposals drop constraint if exists proposals_status_check;
alter table public.proposals add constraint proposals_status_check check (status in
  ('Lead','Estimating','Needs Review','Sent','Follow-up','Budget','Approved','Scheduled','Invoiced','Paid','Declined','Expired','Withdrawn'));

create or replace function public.zap_hcp(token text, event text, ref text default null, hcp_job text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n text; mt text[]; p public.proposals; new_status text;
begin
  perform public.zap_check(token);
  perform set_config('pfbs.actor', 'HousecallPro', true);
  mt := regexp_match(coalesce(ref,''), 'PFBS[\s#:-]*0*([0-9]{1,6})', 'i');
  if mt is not null then n := 'PFBS-' || lpad(mt[1], 4, '0'); end if;
  if n is not null then select * into p from public.proposals where num = n;
  elsif coalesce(hcp_job,'') <> '' then select * into p from public.proposals pr where pr.hcp_job = zap_hcp.hcp_job order by pr.num desc limit 1;
  end if;
  if p.num is null then
    return jsonb_build_object('ok', false, 'reason', 'No proposal found. Put the PFBS number (e.g. PFBS-0801) in the HousecallPro job description.');
  end if;

  new_status := case
    when lower(event) like '%sched%' and p.status in ('Sent','Follow-up','Budget','Approved') then 'Scheduled'
    when lower(event) like '%complet%' and p.status in ('Sent','Follow-up','Budget','Approved','Scheduled') then 'Invoiced'
    else p.status end;

  update public.proposals set
    hcp_job = coalesce(nullif(public.proposals.hcp_job,''), nullif(zap_hcp.hcp_job,'')),
    status = new_status,
    date_resolved = case when p.status in ('Sent','Follow-up','Budget') and new_status <> p.status then coalesce(date_resolved, current_date) else date_resolved end
  where num = p.num;

  insert into public.proposal_activity(num, by_name, kind, note)
  values (p.num, 'HousecallPro', 'note', 'HousecallPro: ' || coalesce(event,'update') || coalesce(' (job ' || nullif(hcp_job,'') || ')','')
          || case when new_status <> p.status then ' → status ' || new_status else '' end);
  return jsonb_build_object('ok', true, 'num', p.num, 'status', new_status);
end $$;
revoke execute on function public.zap_hcp(text, text, text, text) from public;
grant execute on function public.zap_hcp(text, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
