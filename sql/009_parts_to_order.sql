-- =====================================================================
-- PFBS Proposal Desk — update 009: parts to order
--   • proposals.parts: purchase checklist created when a job is approved
--       [{desc, qty, supplier, sku, link, status: To order|Ordered|Received,
--         orderedOn, orderedBy, orderNo, receivedOn}]
--   • proposals.buyer: who buys the parts (blank = the estimator on the job)
--   • monthly report: lists parts still waiting to be ordered
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 007 first.
-- =====================================================================

alter table public.proposals
  add column if not exists parts jsonb not null default '[]'::jsonb,
  add column if not exists buyer text;

-- parts still to order, as an HTML block for the monthly report
create or replace function public.parts_open_html() returns text
language sql stable security definer set search_path = public as $$
  select case when count(*) = 0 then '' else
    '<h3 style="color:#1F2A5C;margin:0">Parts still to order</h3><ul style="margin:6px 0 18px;padding-left:18px">'
    || string_agg('<li>' || public.h(p.num || ' · ' || p.client) || ' — ' || public.h(e->>'desc')
         || coalesce(' × ' || nullif(e->>'qty',''), '')
         || ' (buyer: ' || public.h(coalesce(nullif(p.buyer,''), p.sent_by, 'not set')) || ', approved '
         || coalesce(to_char(p.date_resolved, 'FMMM/FMDD'), '—') || ')</li>', '' order by p.date_resolved nulls last, p.num)
    || '</ul>' end
  from public.proposals p, jsonb_array_elements(coalesce(p.parts,'[]'::jsonb)) e
  where coalesce(e->>'status','To order') = 'To order'
    and p.status in ('Approved','Scheduled','Invoiced','Paid')
$$;

-- add that block to the report (app and Zapier)
create or replace function public.with_parts(r jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_set(r, '{html}', to_jsonb(regexp_replace(r->>'html', '</div>$', public.parts_open_html() || '</div>')))
$$;

create or replace function public.monthly_report(m date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_manager() then raise exception 'Only managers can see the monthly report.'; end if;
  return public.with_parts(public.monthly_report_html(m));
end $$;

create or replace function public.zap_monthly_report(token text, month date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.zap_check(token);
  return public.with_parts(public.monthly_report_html(coalesce(month, (date_trunc('month', current_date) - interval '1 month')::date)));
end $$;

revoke execute on function public.parts_open_html(), public.with_parts(jsonb) from public, anon, authenticated;
revoke execute on function public.monthly_report(date), public.zap_monthly_report(text, date) from public;
grant execute on function public.monthly_report(date) to authenticated;
grant execute on function public.zap_monthly_report(text, date) to anon, authenticated;
revoke execute on function public.monthly_report(date) from anon;

notify pgrst, 'reload schema';
