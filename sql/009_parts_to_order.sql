-- =====================================================================
-- PFBS Proposal Desk — update 009: parts to order
--   • proposals.parts: purchase checklist created when a job is approved
--       [{desc, qty, supplier, sku, link, status: To order|Ordered|Received,
--         orderedOn, orderedBy, orderNo, receivedOn}]
--   • proposals.buyer: who buys the parts (blank = the estimator on the job)
--   • lift / equipment rentals tracked in the same list (kind = rental)
--   • monthly report: parts still to order and rentals needing action
--   • follow-up emails: no price, no signature (your Outlook signature is added)
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 007 first.
-- =====================================================================

alter table public.proposals
  add column if not exists parts jsonb not null default '[]'::jsonb,
  add column if not exists buyer text;

-- parts still to order and rentals needing action, as an HTML block for the monthly report
create or replace function public.parts_open_html() returns text
language sql stable security definer set search_path = public as $$
  select case when count(*) = 0 then '' else
    '<h3 style="color:#1F2A5C;margin:0">Parts and rentals needing action</h3><ul style="margin:6px 0 18px;padding-left:18px">'
    || string_agg('<li>' || public.h(p.num || ' · ' || p.client) || ' — ' || public.h(e->>'desc')
         || case when e->>'kind' = 'rental'
                 then case when coalesce(e->>'status','To reserve') = 'To reserve' then ': rental not reserved yet'
                           else ': job is done, rental still on rent (call it off-rent)' end
                 else coalesce(' × ' || nullif(e->>'qty',''), '') || ': still to order' end
         || ' (' || public.h(coalesce(nullif(p.buyer,''), p.sent_by, 'no contact')) || ', approved '
         || coalesce(to_char(p.date_resolved, 'FMMM/FMDD'), '—') || ')</li>', '' order by p.date_resolved nulls last, p.num)
    || '</ul>' end
  from public.proposals p, jsonb_array_elements(coalesce(p.parts,'[]'::jsonb)) e
  where p.status in ('Approved','Scheduled','Invoiced','Paid')
    and ( (coalesce(e->>'kind','part') <> 'rental' and coalesce(e->>'status','To order') = 'To order')
       or (e->>'kind' = 'rental' and coalesce(e->>'status','To reserve') = 'To reserve')
       or (e->>'kind' = 'rental' and e->>'status' = 'Delivered' and p.status in ('Invoiced','Paid')) )
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

-- follow-up emails: no price and no signature (Outlook adds your signature)
create or replace function public.followup_email_for(p public.proposals) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  nxt date := public.fu_next(p.date_sent, p.last_follow_up);
  step int := public.fu_step(p.date_sent, nxt);
  first text := nullif(split_part(trim(coalesce(p.contact_name,'')),' ',1),'');
  scope text := coalesce(public.scope_text(p.items), p.service, 'the work');
  -- (all-caps descriptions read better in sentence case)
  place text := coalesce(nullif(p.property,''), p.client);
  est text := coalesce(p.sent_by, 'PF Building Services');
  est_email text := (select email from public.team_members where name = p.sent_by);
  expiry int := coalesce((public.pfbs_setting('expiryDays','90'))::text::int, 90);
  sent_txt text := to_char(p.date_sent, 'FMMonth FMDD');
  subj text; lines text[];
begin
  if scope = upper(scope) then scope := upper(left(lower(scope),1)) || substr(lower(scope),2); end if;
  subj := case step when 1 then '' when 2 then 'Following up: ' when 3 then 'Checking in: ' else 'Still interested? ' end
          || 'Proposal from PF Building Services – ' || p.num;
  lines := array['Hi ' || coalesce(first,'there') || ','];
  lines := lines || case step
    when 1 then 'I wanted to make sure you received our proposal (' || p.num || ') for ' || scope || ' at ' || place || ', sent on ' || sent_txt || '. Let me know if you have any questions or if anything should be adjusted.'
    when 2 then 'Following up on the proposal we sent on ' || sent_txt || ' for ' || scope || ' at ' || place || '. Do you have any questions, or would you like us to get it on the schedule?'
    when 3 then 'Checking in on our proposal for ' || scope || ' at ' || place || '. If timing or budget has changed, we are happy to walk the site again or adjust the scope.'
    else 'Our proposal for ' || scope || ' at ' || place || ' is still valid until ' || to_char(p.date_sent + expiry, 'FMMonth FMDD') || '. Is this still something you would like to move forward with? A quick yes or no helps us plan our schedule.' end;
  lines := lines || 'Thank you very much for the opportunity.'::text;
  return jsonb_build_object(
    'num', p.num, 'client', p.client, 'property', p.property, 'step', step, 'due', nxt,
    'to', coalesce(p.contact_email,''), 'contact', p.contact_name, 'estimator', est, 'estimator_email', coalesce(est_email,''),
    'subject', subj,
    'text', array_to_string(lines, E'\n\n'),
    'html', (select string_agg('<p>' || public.h(l) || '</p>', '') from unnest(lines) l));
end $$;

revoke execute on function public.parts_open_html(), public.with_parts(jsonb) from public, anon, authenticated;
revoke execute on function public.monthly_report(date), public.zap_monthly_report(text, date) from public;
grant execute on function public.monthly_report(date) to authenticated;
grant execute on function public.zap_monthly_report(text, date) to anon, authenticated;
revoke execute on function public.monthly_report(date) from anon;

notify pgrst, 'reload schema';
