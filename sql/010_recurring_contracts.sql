-- =====================================================================
-- PFBS Proposal Desk — update 010: recurring contracts
--   • proposals.term_months: contract length (blank = 12 months)
--   • proposals.year_value: value per year, saved by the app for recurring work
--   • proposals.cancelled_on / cancel_reason: a contract the client ended early
--   • commission on recurring contracts is earned month by month for the first
--     12 months, starting the month the first invoice is paid (date paid),
--     and stops when a contract is cancelled
--   • est_comm_paid_amt / comm_paid_amt: how much commission has been paid so far
--   • monthly report: contract values, recurring revenue per month, renewals due
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs updates 007 and 009 first.
-- =====================================================================

alter table public.proposals
  add column if not exists term_months int,
  add column if not exists year_value numeric,
  add column if not exists cancelled_on date,
  add column if not exists cancel_reason text,
  add column if not exists est_comm_paid_amt numeric,
  add column if not exists comm_paid_amt numeric;

-- only the owner and admin can record commission payments
create or replace function public.comm_paid_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and coalesce(public.my_role(),'') not in ('Owner','Admin')
     and ((tg_op = 'INSERT' and (new.est_comm_paid_amt is not null or new.comm_paid_amt is not null))
       or (tg_op = 'UPDATE' and (new.est_comm_paid_amt is distinct from old.est_comm_paid_amt
                                 or new.comm_paid_amt is distinct from old.comm_paid_amt))) then
    raise exception 'Only the owner or admin can record commission payments.';
  end if;
  return new;
end $$;
drop trigger if exists proposals_comm_paid_guard on public.proposals;
create trigger proposals_comm_paid_guard before insert or update on public.proposals
  for each row execute function public.comm_paid_guard();

-- visits per year for a frequency (Settings → Frequencies)
create or replace function public.freq_visits(f text) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select nullif(t->>1,'')::numeric from jsonb_array_elements(public.pfbs_setting('frequencies','[["One-time",1],["Annual",1]]')) t where t->>0 = f limit 1), 1)
$$;
create or replace function public.is_recurring(p public.proposals) returns boolean
language sql stable security definer set search_path = public as $$
  select case when p.year_value is not null then true else public.freq_visits(p.frequency) > 1 end
$$;
create or replace function public.year_val(p public.proposals) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(p.year_value, coalesce(p.amount,0) * public.freq_visits(p.frequency))
$$;
create or replace function public.contract_value(p public.proposals) returns numeric
language sql stable security definer set search_path = public as $$
  select case when public.is_recurring(p) then public.year_val(p) * coalesce(nullif(p.term_months,0),12) / 12.0 else coalesce(p.amount,0) end
$$;
create or replace function public.won_value(p public.proposals) returns numeric
language sql stable security definer set search_path = public as $$
  select public.contract_value(p) + public.co_rev(p.change_orders)
$$;
create or replace function public.value_factor(p public.proposals) returns numeric
language sql stable security definer set search_path = public as $$
  select case when coalesce(p.amount,0) = 0 then 1 else public.contract_value(p) / p.amount end
$$;
create or replace function public.monthly_value(p public.proposals) returns numeric
language sql stable security definer set search_path = public as $$
  select case when public.is_recurring(p) then public.year_val(p) / 12.0 else 0 end
$$;
create or replace function public.contract_end(p public.proposals) returns date
language sql stable security definer set search_path = public as $$
  select (coalesce(p.date_resolved, p.date_sent) + make_interval(months => coalesce(nullif(p.term_months,0),12)))::date
$$;
-- months of commission earned by date d (1 the month the first invoice is paid, up to 12)
create or replace function public.comm_months(p public.proposals, d date) returns int
language sql stable security definer set search_path = public as $$
  select case when p.date_paid is null or least(d, coalesce(p.cancelled_on, d)) < p.date_paid then 0
    else least(12, (extract(year from least(d, coalesce(p.cancelled_on, d)))::int - extract(year from p.date_paid)::int) * 12
                 + extract(month from least(d, coalesce(p.cancelled_on, d)))::int - extract(month from p.date_paid)::int + 1) end
$$;

create or replace function public.est_rate(p public.proposals) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare rate numeric; g numeric; t jsonb;
begin
  if not exists (select 1 from public.team_members m where m.name = p.sent_by and m.role in ('Estimator','Senior Estimator')) then return null; end if;
  if p.gp is null or coalesce(p.amount,0) = 0 then return null; end if;
  g := p.gp / p.amount;
  for t in select x from jsonb_array_elements(public.pfbs_setting('estTiers','[[0,0.02],[0.35,0.035],[0.45,0.05]]')) x order by (x->>0)::numeric loop
    if rate is null then rate := (t->>1)::numeric; end if;
    if g >= (t->>0)::numeric then rate := (t->>1)::numeric; end if;
  end loop;
  return rate;
end $$;
create or replace function public.bd_rate(p public.proposals) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare rate numeric; floor_ numeric := (public.pfbs_setting('marginFloor','0.35'))::text::numeric;
        share numeric := (public.pfbs_setting('belowFloorShare','0.5'))::text::numeric;
begin
  if p.bd_rep is null or p.client_type is null or p.gp is null then return null; end if;
  select (t->>1)::numeric into rate from jsonb_array_elements(public.pfbs_setting('clientTypes','[["New client",0.10],["Existing client - new property",0.05],["House account",0]]')) t where t->>0 = p.client_type limit 1;
  if rate is null then return null; end if;
  if coalesce(p.amount,0) <> 0 and p.gp / p.amount < floor_ then rate := rate * share; end if;
  return rate;
end $$;

-- commission earned through date d (null = none due on this proposal)
create or replace function public.est_comm_to(p public.proposals, d date) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare r numeric := public.est_rate(p);
begin
  if p.date_paid is null or p.amount is null or r is null then return null; end if;
  if p.date_paid > d then return 0; end if;
  if not public.is_recurring(p) then return (p.amount - coalesce(p.pass_through,0) + public.co_rev(p.change_orders)) * r; end if;
  return (public.year_val(p) * (1 - coalesce(p.pass_through,0) / p.amount) / 12.0 * public.comm_months(p, d) + public.co_rev(p.change_orders)) * r;
end $$;
create or replace function public.bd_comm_to(p public.proposals, d date) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare r numeric := public.bd_rate(p);
begin
  if p.date_paid is null or r is null then return null; end if;
  if p.date_paid > d then return 0; end if;
  if not public.is_recurring(p) then return (p.gp + public.co_gp(p.change_orders)) * r; end if;
  return ((case when coalesce(p.amount,0) = 0 then 0 else p.gp * public.year_val(p) / p.amount end) / 12.0 * public.comm_months(p, d) + public.co_gp(p.change_orders)) * r;
end $$;

-- earned to date (same names as before, so older callers keep working)
create or replace function public.est_comm(p public.proposals) returns numeric
language sql stable security definer set search_path = public as $$ select public.est_comm_to(p, current_date) $$;
create or replace function public.bd_comm(p public.proposals) returns numeric
language sql stable security definer set search_path = public as $$ select public.bd_comm_to(p, current_date) $$;

create or replace function public.est_comm_earned(p public.proposals, a date, b date) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(public.est_comm_to(p, b - 1),0) - coalesce(public.est_comm_to(p, a - 1),0) $$;
create or replace function public.bd_comm_earned(p public.proposals, a date, b date) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(public.bd_comm_to(p, b - 1),0) - coalesce(public.bd_comm_to(p, a - 1),0) $$;
create or replace function public.est_comm_owed(p public.proposals) returns numeric
language sql stable security definer set search_path = public as $$
  select greatest(0, coalesce(public.est_comm(p),0)
    - coalesce(p.est_comm_paid_amt, case when p.est_comm_paid_on is not null then coalesce(public.est_comm(p),0) else 0 end)) $$;
create or replace function public.bd_comm_owed(p public.proposals) returns numeric
language sql stable security definer set search_path = public as $$
  select greatest(0, coalesce(public.bd_comm(p),0)
    - coalesce(p.comm_paid_amt, case when p.comm_paid_on is not null then coalesce(public.bd_comm(p),0) else 0 end)) $$;

-- monthly report with contract values, recurring revenue and monthly commission
create or replace function public.monthly_report_html(m date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  a date := date_trunc('month', m)::date; b date := (date_trunc('month', m) + interval '1 month')::date;
  won_ct int; won_amt numeric; lost_ct int; sent_ct int; sent_amt numeric; leads_ct int;
  open_ct int; open_amt numeric; due_ct int; stale_ct int; gp_won numeric; amt_gp numeric;
  bd_earned numeric; est_earned numeric; bd_owed numeric; est_owed numeric; mrr numeric; mrr_ct int;
  title text := 'PFBS proposals – ' || to_char(a, 'FMMonth YYYY');
  css_t text := 'border-collapse:collapse;width:100%;font:13px Arial,sans-serif;margin:6px 0 18px';
  th text := 'text-align:left;border-bottom:2px solid #1F2A5C;padding:6px 8px;color:#1F2A5C;font-size:11px;text-transform:uppercase';
  td text := 'border-bottom:1px solid #DFE2EA;padding:6px 8px';
  tdr text := 'border-bottom:1px solid #DFE2EA;padding:6px 8px;text-align:right';
  html text; rows text;
  won_s text[] := array['Approved','Scheduled','Invoiced','Paid']; open_s text[] := array['Sent','Follow-up'];
begin
  select count(*), coalesce(sum(public.won_value(p)),0),
         coalesce(sum(p.gp * public.value_factor(p)) filter (where p.gp is not null),0), coalesce(sum(public.contract_value(p)) filter (where p.gp is not null),0)
    into won_ct, won_amt, gp_won, amt_gp
    from proposals p where status = any(won_s) and coalesce(date_resolved, date_sent) >= a and coalesce(date_resolved, date_sent) < b;
  select count(*) into lost_ct from proposals where status in ('Declined','Expired') and coalesce(date_resolved, date_sent) >= a and coalesce(date_resolved, date_sent) < b;
  select count(*), coalesce(sum(public.contract_value(p)),0) into sent_ct, sent_amt from proposals p where coalesce(quoted_at::date, date_sent) >= a and coalesce(quoted_at::date, date_sent) < b and status not in ('Lead','Estimating','Needs Review');
  select count(*) into leads_ct from proposals where lead_at >= a and lead_at < b;
  select count(*), coalesce(sum(public.contract_value(p)),0) into open_ct, open_amt from proposals p where status = any(open_s);
  select count(*) into due_ct from proposals where status = any(open_s) and public.fu_next(date_sent, last_follow_up) <= current_date;
  select count(*) into stale_ct from proposals where status = any(open_s) and current_date - date_sent > coalesce((public.pfbs_setting('expiryDays','90'))::text::int, 90);
  select coalesce(sum(public.bd_comm_earned(p, a, b)),0), coalesce(sum(public.bd_comm_owed(p)),0),
         coalesce(sum(public.est_comm_earned(p, a, b)),0), coalesce(sum(public.est_comm_owed(p)),0)
    into bd_earned, bd_owed, est_earned, est_owed from proposals p;
  select count(*), coalesce(sum(public.monthly_value(p)),0) into mrr_ct, mrr from proposals p
   where p.status = any(won_s) and p.cancelled_on is null and public.is_recurring(p);

  html := '<div style="font:14px Arial,sans-serif;color:#1A1F33;max-width:760px">'
    || '<h2 style="color:#1F2A5C;margin:0 0 4px">' || public.h(title) || '</h2>'
    || '<div style="color:#5C6378;margin-bottom:14px">Monthly management report from the Proposal Desk · ' || to_char(a,'FMMM/FMDD') || '–' || to_char(b - 1,'FMMM/FMDD/YYYY') || '</div>'
    || '<table style="' || css_t || '"><tr>'
    || '<td style="' || td || '"><div style="font-size:11px;color:#5C6378">WON</div><b style="font-size:20px">' || public.usd(won_amt) || '</b><div>' || won_ct || ' job(s)</div></td>'
    || '<td style="' || td || '"><div style="font-size:11px;color:#5C6378">WIN RATE</div><b style="font-size:20px">' || public.pctx(case when won_ct + lost_ct > 0 then won_ct::numeric/(won_ct+lost_ct) end) || '</b><div>' || won_ct || ' won · ' || lost_ct || ' lost</div></td>'
    || '<td style="' || td || '"><div style="font-size:11px;color:#5C6378">PROPOSALS SENT</div><b style="font-size:20px">' || sent_ct || '</b><div>' || public.usd(sent_amt) || '</div></td>'
    || '<td style="' || td || '"><div style="font-size:11px;color:#5C6378">AVG GP ON WINS</div><b style="font-size:20px">' || public.pctx(case when amt_gp > 0 then gp_won/amt_gp end) || '</b><div>' || leads_ct || ' new lead(s)</div></td>'
    || '</tr><tr>'
    || '<td style="' || td || '"><div style="font-size:11px;color:#5C6378">OPEN NOW</div><b style="font-size:20px">' || public.usd(open_amt) || '</b><div>' || open_ct || ' proposal(s)</div></td>'
    || '<td style="' || td || '"><div style="font-size:11px;color:#5C6378">FOLLOW-UPS DUE</div><b style="font-size:20px;color:' || case when due_ct > 0 then '#8A6100' else '#1A1F33' end || '">' || due_ct || '</b></td>'
    || '<td style="' || td || '"><div style="font-size:11px;color:#5C6378">PAST EXPIRY</div><b style="font-size:20px;color:' || case when stale_ct > 0 then '#B3261E' else '#1A1F33' end || '">' || stale_ct || '</b></td>'
    || '<td style="' || td || '"><div style="font-size:11px;color:#5C6378">COMMISSION OWED</div><b style="font-size:20px">' || public.usd(bd_owed + est_owed) || '</b><div>earned this month ' || public.usd(bd_earned + est_earned) || '</div></td>'
    || '</tr></table>'
    || '<div style="margin:-8px 0 18px">Recurring revenue: <b>' || public.usd(mrr) || ' / month</b> from ' || mrr_ct || ' active contract(s).</div>';

  -- estimators
  select string_agg('<tr><td style="' || td || '">' || public.h(x.n) || '</td><td style="' || tdr || '">' || x.sent || '</td><td style="' || tdr || '">' || x.won || '</td><td style="' || tdr || '">' || public.usd(x.won_amt)
         || '</td><td style="' || tdr || '">' || public.pctx(case when x.won + x.lost > 0 then x.won::numeric/(x.won+x.lost) end) || '</td><td style="' || tdr || '">' || public.pctx(case when x.amt_gp > 0 then x.gp/x.amt_gp end)
         || '</td><td style="' || tdr || '">' || coalesce(round(x.dtq,1)::text,'—') || '</td><td style="' || tdr || '">' || x.sb || '</td><td style="' || tdr || '">' || public.usd(x.earned) || '</td><td style="' || tdr || '">' || public.usd(x.owed) || '</td></tr>', '' order by x.won_amt desc, x.n)
    into rows from (
      select m.name n,
        count(*) filter (where coalesce(p.quoted_at::date, p.date_sent) >= a and coalesce(p.quoted_at::date, p.date_sent) < b and p.status not in ('Lead','Estimating','Needs Review')) sent,
        count(*) filter (where p.status = any(won_s) and coalesce(p.date_resolved,p.date_sent) >= a and coalesce(p.date_resolved,p.date_sent) < b) won,
        count(*) filter (where p.status in ('Declined','Expired') and coalesce(p.date_resolved,p.date_sent) >= a and coalesce(p.date_resolved,p.date_sent) < b) lost,
        coalesce(sum(public.won_value(p)) filter (where p.status = any(won_s) and coalesce(p.date_resolved,p.date_sent) >= a and coalesce(p.date_resolved,p.date_sent) < b),0) won_amt,
        coalesce(sum(p.gp * public.value_factor(p)) filter (where p.gp is not null and p.status = any(won_s) and coalesce(p.date_resolved,p.date_sent) >= a and coalesce(p.date_resolved,p.date_sent) < b),0) gp,
        coalesce(sum(public.contract_value(p)) filter (where p.gp is not null and p.status = any(won_s) and coalesce(p.date_resolved,p.date_sent) >= a and coalesce(p.date_resolved,p.date_sent) < b),0) amt_gp,
        avg(extract(epoch from p.quoted_at - coalesce(p.lead_at, p.created_at))/86400) filter (where p.quoted_at >= a and p.quoted_at < b and p.quoted_at >= coalesce(p.lead_at, p.created_at)) dtq,
        (select count(*) from proposal_activity pa join proposals q on q.num = pa.num where q.sent_by = m.name and pa.kind = 'review_sent_back' and pa.at >= a and pa.at < b) sb,
        coalesce(sum(public.est_comm_earned(p, a, b)),0) earned,
        coalesce(sum(public.est_comm_owed(p)),0) owed
      from team_members m left join proposals p on p.sent_by = m.name
      where m.role <> 'BD Rep' and (m.active or p.num is not null)
      group by m.name) x
    where x.sent + x.won + x.lost > 0 or x.owed > 0;
  html := html || '<h3 style="color:#1F2A5C;margin:0">Estimators</h3><table style="' || css_t || '"><tr><th style="' || th || '">Estimator</th><th style="' || th || '">Sent</th><th style="' || th || '">Won</th><th style="' || th || '">Won $</th><th style="' || th || '">Win rate</th><th style="' || th || '">GP %</th><th style="' || th || '">Days to quote</th><th style="' || th || '">Sent back</th><th style="' || th || '">Comm. earned</th><th style="' || th || '">Comm. owed</th></tr>'
    || coalesce(rows, '<tr><td colspan="10" style="' || td || ';color:#5C6378">No estimator activity this month.</td></tr>') || '</table>';

  -- BD reps
  rows := null;
  select string_agg('<tr><td style="' || td || '">' || public.h(x.n) || '</td><td style="' || tdr || '">' || x.leads || '</td><td style="' || tdr || '">' || x.waiting || '</td><td style="' || tdr || '">' || x.won || '</td><td style="' || tdr || '">' || public.usd(x.won_amt) || '</td><td style="' || tdr || '">' || public.usd(x.earned) || '</td><td style="' || tdr || '">' || public.usd(x.owed) || '</td></tr>', '' order by x.won_amt desc)
    into rows from (
      select m.name n,
        count(*) filter (where p.lead_at >= a and p.lead_at < b) leads,
        count(*) filter (where p.status in ('Lead','Estimating','Needs Review')) waiting,
        count(*) filter (where p.status = any(won_s) and coalesce(p.date_resolved,p.date_sent) >= a and coalesce(p.date_resolved,p.date_sent) < b) won,
        coalesce(sum(public.won_value(p)) filter (where p.status = any(won_s) and coalesce(p.date_resolved,p.date_sent) >= a and coalesce(p.date_resolved,p.date_sent) < b),0) won_amt,
        coalesce(sum(public.bd_comm_earned(p, a, b)),0) earned,
        coalesce(sum(public.bd_comm_owed(p)),0) owed
      from team_members m left join proposals p on p.bd_rep = m.name
      where m.role = 'BD Rep' group by m.name) x;
  if rows is not null then
    html := html || '<h3 style="color:#1F2A5C;margin:0">Business development</h3><table style="' || css_t || '"><tr><th style="' || th || '">BD rep</th><th style="' || th || '">Leads</th><th style="' || th || '">Waiting</th><th style="' || th || '">Won</th><th style="' || th || '">Won $</th><th style="' || th || '">Comm. earned</th><th style="' || th || '">Comm. owed</th></tr>' || rows || '</table>';
  end if;

  -- estimated vs actual margin on jobs closed out this month
  rows := null;
  select string_agg('<tr><td style="' || td || '">' || public.h(p.num) || '</td><td style="' || td || '">' || public.h(p.client) || '</td><td style="' || tdr || '">'
         || public.pctx(case when (s->>'rev')::numeric > 0 and s->>'estGP' is not null then (s->>'estGP')::numeric/(s->>'rev')::numeric end) || '</td><td style="' || tdr || '">'
         || public.pctx(case when (s->>'rev')::numeric > 0 then (s->>'actGP')::numeric/(s->>'rev')::numeric end) || '</td><td style="' || tdr || '">'
         || coalesce(case when coalesce((s->>'estHrs')::numeric,0) > 0 then (case when (s->>'actHrs')::numeric >= (s->>'estHrs')::numeric then '+' else '−' end) || round(abs((s->>'actHrs')::numeric/(s->>'estHrs')::numeric - 1)*100)::text || '%' end, '—')
         || '</td><td style="' || td || '">' || public.h(p.sent_by) || '</td></tr>', '' order by p.num)
    into rows from proposals p, lateral (select p.actuals_summary s) z
    where p.actuals_summary is not null and (p.actuals_summary->>'lastDate')::date >= a and (p.actuals_summary->>'lastDate')::date < b;
  if rows is not null then
    html := html || '<h3 style="color:#1F2A5C;margin:0">Estimated vs actual (jobs closed out this month)</h3><table style="' || css_t || '"><tr><th style="' || th || '">PFBS #</th><th style="' || th || '">Client</th><th style="' || th || '">Est. margin</th><th style="' || th || '">Actual margin</th><th style="' || th || '">Hours vs est.</th><th style="' || th || '">Estimator</th></tr>' || rows || '</table>';
  end if;

  -- needs attention
  rows := null;
  select string_agg('<li>' || x, '</li>') || '</li>' into rows from (
    select public.h(num || ' · ' || client || coalesce(' · ' || property,'')) || ' — follow-up due (' || coalesce(sent_by,'no estimator') || ')' x from proposals where status = any(open_s) and public.fu_next(date_sent, last_follow_up) <= current_date
    union all
    select public.h(num || ' · ' || client) || ' — lead waiting ' || (current_date - coalesce(lead_at, created_at)::date) || ' days (' || coalesce(sent_by,'not assigned') || ')' from proposals where status = 'Lead' and current_date - coalesce(lead_at, created_at)::date > 3
    union all
    select public.h(num || ' · ' || client) || ' — open ' || (current_date - date_sent) || ' days, past expiry' from proposals where status = any(open_s) and current_date - date_sent > coalesce((public.pfbs_setting('expiryDays','90'))::text::int, 90)
    union all
    select public.h(num || ' · ' || client) || ' — contract ends ' || to_char(public.contract_end(p), 'FMMM/FMDD') || ', time to renew (' || coalesce(sent_by,'no estimator') || ')' from proposals p
     where status = any(won_s) and cancelled_on is null and public.is_recurring(p) and renewal_date is null and public.contract_end(p) - current_date between 0 and 60
    limit 25) t;
  if rows is not null then html := html || '<h3 style="color:#1F2A5C;margin:0">Needs attention</h3><ul style="margin:6px 0 18px;padding-left:18px">' || rows || '</ul>'; end if;

  html := html || '<div style="color:#5C6378;font-size:12px">Won uses the date a proposal was approved. Commission counts only jobs with a date paid; recurring contracts earn month by month for the first 12 months. Recurring contracts count at their full contract value. Amounts include approved change orders.</div></div>';
  return jsonb_build_object('subject', title, 'html', html, 'month', a);
end $$;

revoke execute on function public.comm_paid_guard(), public.freq_visits(text), public.is_recurring(public.proposals), public.year_val(public.proposals),
  public.contract_value(public.proposals), public.won_value(public.proposals), public.value_factor(public.proposals), public.monthly_value(public.proposals),
  public.contract_end(public.proposals), public.comm_months(public.proposals, date), public.est_rate(public.proposals), public.bd_rate(public.proposals),
  public.est_comm_to(public.proposals, date), public.bd_comm_to(public.proposals, date), public.est_comm_earned(public.proposals, date, date),
  public.bd_comm_earned(public.proposals, date, date), public.est_comm_owed(public.proposals), public.bd_comm_owed(public.proposals),
  public.est_comm(public.proposals), public.bd_comm(public.proposals), public.monthly_report_html(date) from public, anon, authenticated;
grant execute on function public.bd_comm(public.proposals), public.est_comm(public.proposals) to authenticated;

notify pgrst, 'reload schema';
