-- =====================================================================
-- PFBS Proposal Desk — update 016: "paid" from HousecallPro
--   When an invoice is marked paid in HousecallPro, a Zap can tell the Proposal Desk:
--   the job moves to Paid and Date paid is filled in (which starts commission).
--   Needs the HousecallPro MAX plan (webhooks) and a paid Zapier plan
--   (see SETUP_INTEGRATIONS.md, "HousecallPro: paid invoices").
--   Matches by the PFBS number in the job description, or the HCP job #.
--   A recurring contract that is already Paid stays Paid, and its first date paid is kept.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 014 first.
-- =====================================================================
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='proposals' and column_name='budget_year') then
    raise exception 'Run update 014 (014_budget_estimates.sql) first, then run this one again.';
  end if;
end $$;

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
    when lower(event) like '%paid%' and p.status in ('Sent','Follow-up','Budget','Approved','Scheduled','Invoiced') then 'Paid'
    when lower(event) like '%sched%' and p.status in ('Sent','Follow-up','Budget','Approved') then 'Scheduled'
    when lower(event) like '%complet%' and p.status in ('Sent','Follow-up','Budget','Approved','Scheduled') then 'Invoiced'
    else p.status end;

  update public.proposals set
    hcp_job = coalesce(nullif(public.proposals.hcp_job,''), nullif(zap_hcp.hcp_job,'')),
    status = new_status,
    date_paid = case when lower(event) like '%paid%' then coalesce(public.proposals.date_paid, current_date) else public.proposals.date_paid end,
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
