-- =====================================================================
-- PFBS Proposal Desk — update 007
--   • Leads: what the client asked for (lead_info) + a Prospects list for BD
--   • Follow-ups: cadence tracking (last_follow_up) and ready-to-send emails
--   • Monthly management report (in the app, and emailed through Zapier)
--   • HousecallPro → Proposal Desk (through Zapier): Scheduled / Invoiced
--   • actuals_summary: job margin snapshot saved by the app for the report
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- =====================================================================

-- ---------- new columns ------------------------------------------------
alter table public.proposals
  add column if not exists lead_info       jsonb not null default '{}'::jsonb, -- services asked for, walkthrough date, timing
  add column if not exists last_follow_up  date,                               -- last logged follow-up (drives the cadence)
  add column if not exists actuals_summary jsonb;                              -- {rev, estGP, actGP, estHrs, actHrs, lastDate}

-- ---------- prospects (BD's list before something becomes a lead) -------
create table if not exists public.prospects (
  id             bigserial primary key,
  company        text not null,
  property       text,
  contact_name   text,
  contact_title  text,
  phone          text,
  email          text,
  address        text,
  stage          text not null default 'New' check (stage in ('New','Contacted','Meeting set','Walkthrough','Converted','Not now')),
  next_touch     date,
  last_touch     date,
  touches        jsonb not null default '[]'::jsonb,   -- [{date, kind, note, by}]
  bd_rep         text references public.team_members(name) on update cascade,
  notes          text,
  converted_num  text references public.proposals(num) on update cascade on delete set null,
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists prospects_rep_idx on public.prospects(bd_rep, next_touch);

create or replace function public.prospects_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then new.created_by := coalesce(public.my_name(), new.created_by); new.created_at := now(); end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists prospects_stamp on public.prospects;
create trigger prospects_stamp before insert or update on public.prospects
for each row execute function public.prospects_stamp();

alter table public.prospects enable row level security;
drop policy if exists pp_read   on public.prospects;
drop policy if exists pp_insert on public.prospects;
drop policy if exists pp_update on public.prospects;
drop policy if exists pp_delete on public.prospects;
create policy pp_read   on public.prospects for select using (public.is_manager() or bd_rep = public.my_name());
create policy pp_insert on public.prospects for insert with check (public.is_manager() or (public.my_role() = 'BD Rep' and bd_rep = public.my_name()));
create policy pp_update on public.prospects for update
  using (public.is_manager() or (public.my_role() = 'BD Rep' and bd_rep = public.my_name()))
  with check (public.is_manager() or (public.my_role() = 'BD Rep' and bd_rep = public.my_name()));
create policy pp_delete on public.prospects for delete using (public.is_manager());
grant select, insert, update, delete on public.prospects to authenticated;
grant usage, select on sequence public.prospects_id_seq to authenticated;

-- ---------- guard: same rules as 006, plus a named actor for integrations ---
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
     and coalesce(r,'') not in ('Owner','Senior Estimator') then
    raise exception 'A senior estimator must review this proposal before it is sent.';
  end if;
  if tg_op = 'UPDATE' and old.status = any(pre) and not (new.status = any(pre)) then
    new.reviewed_by := who; new.reviewed_at := now();
  end if;

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

-- ---------- follow-up cadence ---------------------------------------------
-- Day 3, 10 and 21 after sending, then every 14 days until the proposal expires.
-- A logged follow-up (note type "Follow-up") moves the proposal to its next step.
create or replace function public.pfbs_setting(k text, dflt jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select data -> k from public.settings where id = 1), dflt)
$$;

create or replace function public.fu_next(sent date, last_fu date) returns date
language plpgsql stable as $$
declare
  expiry int := coalesce((public.pfbs_setting('expiryDays','90'))::text::int, 90);
  s int; steps int[] := array[3,10,21];
begin
  if sent is null then return null; end if;
  s := 35; while s < expiry loop steps := steps || s; s := s + 14; end loop;
  foreach s in array steps loop
    if sent + s > coalesce(last_fu, sent) and s < expiry then return sent + s; end if;
  end loop;
  return null;
end $$;

create or replace function public.fu_step(sent date, nxt date) returns int
language sql immutable as $$
  select case when nxt is null then null when nxt - sent <= 3 then 1 when nxt - sent <= 10 then 2 when nxt - sent <= 21 then 3 else 4 end
$$;

-- logging a follow-up stamps the proposal
create or replace function public.activity_followup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'follow_up' then
    update public.proposals set last_follow_up = greatest(coalesce(last_follow_up, new.at::date), new.at::date)
     where num = new.num and (last_follow_up is null or last_follow_up < new.at::date);
  end if;
  return new;
end $$;
drop trigger if exists activity_followup on public.proposal_activity;
create trigger activity_followup after insert on public.proposal_activity
for each row execute function public.activity_followup();

-- Fresh start: proposals already out when this update runs begin their cadence today,
-- so the first Monday doesn't produce a follow-up for every old proposal at once.
update public.proposals set last_follow_up = current_date
 where status in ('Sent','Follow-up') and last_follow_up is null and date_sent < current_date - 2;

-- ---------- small helpers ---------------------------------------------------
create or replace function public.h(t text) returns text
language sql immutable as $$ select replace(replace(replace(coalesce(t,''),'&','&amp;'),'<','&lt;'),'>','&gt;') $$;

create or replace function public.usd(v numeric) returns text
language sql immutable as $$ select case when v is null then '—' when v < 0 then '−$' || to_char(round(-v), 'FM999,999,990') else '$' || to_char(round(v), 'FM999,999,990') end $$;

create or replace function public.pctx(v numeric) returns text
language sql immutable as $$ select case when v is null then '—' else round(v*100)::text || '%' end $$;

-- line descriptions (no add-ons) for emails
create or replace function public.scope_text(items jsonb) returns text
language sql immutable as $$
  select nullif(string_agg(e->>'description', ', '), '')
  from (select e from jsonb_array_elements(coalesce(items,'[]'::jsonb)) e
        where coalesce(e->>'type','Service') <> 'Add-on' and coalesce(e->>'description','') <> '' limit 3) x
$$;

-- ---------- commission (same rules as the app) --------------------------
create or replace function public.co_rev(co jsonb) returns numeric language sql immutable as $$
  select coalesce(sum(coalesce(nullif(e->>'amount','')::numeric,0)),0) from jsonb_array_elements(coalesce(co,'[]'::jsonb)) e where e->>'status' = 'Approved' $$;
create or replace function public.co_gp(co jsonb) returns numeric language sql immutable as $$
  select coalesce(sum(coalesce(nullif(e->>'amount','')::numeric,0) - coalesce(nullif(e->>'cost','')::numeric,0)),0) from jsonb_array_elements(coalesce(co,'[]'::jsonb)) e where e->>'status' = 'Approved' $$;

create or replace function public.bd_comm(p public.proposals) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare rate numeric; g numeric; floor_ numeric := (public.pfbs_setting('marginFloor','0.35'))::text::numeric;
        share numeric := (public.pfbs_setting('belowFloorShare','0.5'))::text::numeric;
begin
  if p.date_paid is null or p.bd_rep is null or p.client_type is null or p.gp is null then return null; end if;
  select (t->>1)::numeric into rate from jsonb_array_elements(public.pfbs_setting('clientTypes','[["New client",0.10],["Existing client - new property",0.05],["House account",0]]')) t where t->>0 = p.client_type limit 1;
  if rate is null then return null; end if;
  g := case when coalesce(p.amount,0) <> 0 then p.gp / p.amount end;
  if g is not null and g < floor_ then rate := rate * share; end if;
  return (p.gp + public.co_gp(p.change_orders)) * rate;
end $$;

create or replace function public.est_comm(p public.proposals) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare rate numeric; g numeric; t jsonb;
begin
  if p.date_paid is null or p.amount is null then return null; end if;
  if not exists (select 1 from public.team_members m where m.name = p.sent_by and m.role in ('Estimator','Senior Estimator')) then return null; end if;
  if p.gp is null or p.amount = 0 then return null; end if;
  g := p.gp / p.amount;
  for t in select x from jsonb_array_elements(public.pfbs_setting('estTiers','[[0,0.02],[0.35,0.035],[0.45,0.05]]')) x order by (x->>0)::numeric loop
    if rate is null then rate := (t->>1)::numeric; end if;
    if g >= (t->>0)::numeric then rate := (t->>1)::numeric; end if;
  end loop;
  return (p.amount - coalesce(p.pass_through,0) + public.co_rev(p.change_orders)) * rate;
end $$;

-- ---------- follow-up email (one template for the app and for Zapier) ----
create or replace function public.followup_email_for(p public.proposals) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  nxt date := public.fu_next(p.date_sent, p.last_follow_up);
  step int := public.fu_step(p.date_sent, nxt);
  first text := nullif(split_part(trim(coalesce(p.contact_name,'')),' ',1),'');
  scope text := coalesce(public.scope_text(p.items), p.service, 'the work');
  place text := coalesce(nullif(p.property,''), p.client);
  est text := coalesce(p.sent_by, 'PF Building Services');
  est_email text := (select email from public.team_members where name = p.sent_by);
  expiry int := coalesce((public.pfbs_setting('expiryDays','90'))::text::int, 90);
  sent_txt text := to_char(p.date_sent, 'FMMonth FMDD');
  subj text; lines text[];
begin
  subj := case step when 1 then 'Proposal ' || p.num || ' – ' || place
                    when 2 then 'Following up: ' || place || ' proposal'
                    when 3 then 'Checking in on your ' || place || ' proposal'
                    else 'Still interested? ' || place || ' proposal' end;
  lines := array['Hi ' || coalesce(first,'there') || ','];
  lines := lines || case step
    when 1 then 'I wanted to make sure you received our proposal (' || p.num || ') for ' || scope || ' at ' || place || ', sent on ' || sent_txt || '. Let me know if you have any questions or if anything should be adjusted.'
    when 2 then 'Following up on the proposal we sent on ' || sent_txt || ' for ' || scope || ' at ' || place || ' (' || public.usd(p.amount) || '). Do you have any questions, or would you like us to get it on the schedule?'
    when 3 then 'Checking in on our proposal for ' || scope || ' at ' || place || '. If timing or budget has changed, we are happy to walk the site again or adjust the scope.'
    else 'Our proposal for ' || scope || ' at ' || place || ' is still valid until ' || to_char(p.date_sent + expiry, 'FMMonth FMDD') || '. Is this still something you would like to move forward with? A quick yes or no helps us plan our schedule.' end;
  lines := lines || 'Thank you very much for the opportunity.'::text;
  return jsonb_build_object(
    'num', p.num, 'client', p.client, 'property', p.property, 'step', step, 'due', nxt,
    'to', coalesce(p.contact_email,''), 'contact', p.contact_name, 'estimator', est, 'estimator_email', coalesce(est_email,''),
    'subject', subj,
    'text', array_to_string(lines, E'\n\n') || E'\n\n' || est || E'\nPF Building Services\n(510) 359-5181',
    'html', (select string_agg('<p>' || public.h(l) || '</p>', '') from unnest(lines) l)
            || '<p>' || public.h(est) || '<br>PF Building Services<br>(510) 359-5181</p>');
end $$;

-- the app: email for one proposal the signed-in user can see (RLS applies)
create or replace function public.followup_email(p_num text) returns jsonb
language sql stable security invoker set search_path = public as $$
  select public.followup_email_for(p) from public.proposals p where p.num = p_num
$$;

-- ---------- monthly management report ------------------------------------
create or replace function public.monthly_report_html(m date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  a date := date_trunc('month', m)::date; b date := (date_trunc('month', m) + interval '1 month')::date;
  won_ct int; won_amt numeric; lost_ct int; sent_ct int; sent_amt numeric; leads_ct int;
  open_ct int; open_amt numeric; due_ct int; stale_ct int; gp_won numeric; amt_gp numeric;
  bd_earned numeric; est_earned numeric; bd_owed numeric; est_owed numeric;
  title text := 'PFBS proposals – ' || to_char(a, 'FMMonth YYYY');
  css_t text := 'border-collapse:collapse;width:100%;font:13px Arial,sans-serif;margin:6px 0 18px';
  th text := 'text-align:left;border-bottom:2px solid #1F2A5C;padding:6px 8px;color:#1F2A5C;font-size:11px;text-transform:uppercase';
  td text := 'border-bottom:1px solid #DFE2EA;padding:6px 8px';
  tdr text := 'border-bottom:1px solid #DFE2EA;padding:6px 8px;text-align:right';
  html text; rows text;
  won_s text[] := array['Approved','Scheduled','Invoiced','Paid']; open_s text[] := array['Sent','Follow-up'];
begin
  select count(*), coalesce(sum(coalesce(amount,0) + public.co_rev(change_orders)),0),
         coalesce(sum(gp) filter (where gp is not null),0), coalesce(sum(amount) filter (where gp is not null),0)
    into won_ct, won_amt, gp_won, amt_gp
    from proposals where status = any(won_s) and coalesce(date_resolved, date_sent) >= a and coalesce(date_resolved, date_sent) < b;
  select count(*) into lost_ct from proposals where status in ('Declined','Expired') and coalesce(date_resolved, date_sent) >= a and coalesce(date_resolved, date_sent) < b;
  select count(*), coalesce(sum(amount),0) into sent_ct, sent_amt from proposals where coalesce(quoted_at::date, date_sent) >= a and coalesce(quoted_at::date, date_sent) < b and status not in ('Lead','Estimating','Needs Review');
  select count(*) into leads_ct from proposals where lead_at >= a and lead_at < b;
  select count(*), coalesce(sum(amount),0) into open_ct, open_amt from proposals where status = any(open_s);
  select count(*) into due_ct from proposals where status = any(open_s) and public.fu_next(date_sent, last_follow_up) <= current_date;
  select count(*) into stale_ct from proposals where status = any(open_s) and current_date - date_sent > coalesce((public.pfbs_setting('expiryDays','90'))::text::int, 90);
  select coalesce(sum(public.bd_comm(p)) filter (where p.date_paid >= a and p.date_paid < b),0), coalesce(sum(public.bd_comm(p)) filter (where p.comm_paid_on is null),0),
         coalesce(sum(public.est_comm(p)) filter (where p.date_paid >= a and p.date_paid < b),0), coalesce(sum(public.est_comm(p)) filter (where p.est_comm_paid_on is null),0)
    into bd_earned, bd_owed, est_earned, est_owed from proposals p;

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
    || '</tr></table>';

  -- estimators
  select string_agg('<tr><td style="' || td || '">' || public.h(x.n) || '</td><td style="' || tdr || '">' || x.sent || '</td><td style="' || tdr || '">' || x.won || '</td><td style="' || tdr || '">' || public.usd(x.won_amt)
         || '</td><td style="' || tdr || '">' || public.pctx(case when x.won + x.lost > 0 then x.won::numeric/(x.won+x.lost) end) || '</td><td style="' || tdr || '">' || public.pctx(case when x.amt_gp > 0 then x.gp/x.amt_gp end)
         || '</td><td style="' || tdr || '">' || coalesce(round(x.dtq,1)::text,'—') || '</td><td style="' || tdr || '">' || x.sb || '</td><td style="' || tdr || '">' || public.usd(x.earned) || '</td><td style="' || tdr || '">' || public.usd(x.owed) || '</td></tr>', '' order by x.won_amt desc, x.n)
    into rows from (
      select m.name n,
        count(*) filter (where coalesce(p.quoted_at::date, p.date_sent) >= a and coalesce(p.quoted_at::date, p.date_sent) < b and p.status not in ('Lead','Estimating','Needs Review')) sent,
        count(*) filter (where p.status = any(won_s) and coalesce(p.date_resolved,p.date_sent) >= a and coalesce(p.date_resolved,p.date_sent) < b) won,
        count(*) filter (where p.status in ('Declined','Expired') and coalesce(p.date_resolved,p.date_sent) >= a and coalesce(p.date_resolved,p.date_sent) < b) lost,
        coalesce(sum(coalesce(p.amount,0) + public.co_rev(p.change_orders)) filter (where p.status = any(won_s) and coalesce(p.date_resolved,p.date_sent) >= a and coalesce(p.date_resolved,p.date_sent) < b),0) won_amt,
        coalesce(sum(p.gp) filter (where p.gp is not null and p.status = any(won_s) and coalesce(p.date_resolved,p.date_sent) >= a and coalesce(p.date_resolved,p.date_sent) < b),0) gp,
        coalesce(sum(p.amount) filter (where p.gp is not null and p.status = any(won_s) and coalesce(p.date_resolved,p.date_sent) >= a and coalesce(p.date_resolved,p.date_sent) < b),0) amt_gp,
        avg(extract(epoch from p.quoted_at - coalesce(p.lead_at, p.created_at))/86400) filter (where p.quoted_at >= a and p.quoted_at < b and p.quoted_at >= coalesce(p.lead_at, p.created_at)) dtq,
        (select count(*) from proposal_activity pa join proposals q on q.num = pa.num where q.sent_by = m.name and pa.kind = 'review_sent_back' and pa.at >= a and pa.at < b) sb,
        coalesce(sum(public.est_comm(p)) filter (where p.date_paid >= a and p.date_paid < b),0) earned,
        coalesce(sum(public.est_comm(p)) filter (where p.est_comm_paid_on is null),0) owed
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
        coalesce(sum(coalesce(p.amount,0) + public.co_rev(p.change_orders)) filter (where p.status = any(won_s) and coalesce(p.date_resolved,p.date_sent) >= a and coalesce(p.date_resolved,p.date_sent) < b),0) won_amt,
        coalesce(sum(public.bd_comm(p)) filter (where p.date_paid >= a and p.date_paid < b),0) earned,
        coalesce(sum(public.bd_comm(p)) filter (where p.comm_paid_on is null),0) owed
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
    limit 25) t;
  if rows is not null then html := html || '<h3 style="color:#1F2A5C;margin:0">Needs attention</h3><ul style="margin:6px 0 18px;padding-left:18px">' || rows || '</ul>'; end if;

  html := html || '<div style="color:#5C6378;font-size:12px">Won uses the date a proposal was approved. Commission counts only jobs with a date paid. Amounts are per visit and include approved change orders.</div></div>';
  return jsonb_build_object('subject', title, 'html', html, 'month', a);
end $$;

-- the app (managers only)
create or replace function public.monthly_report(m date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_manager() then raise exception 'Only managers can see the monthly report.'; end if;
  return public.monthly_report_html(m);
end $$;

-- ---------- integrations (Zapier) ------------------------------------------
-- One secret key. Read it once in the SQL editor:  select token from public.integration_keys;
-- Replace it any time:  update public.integration_keys set token = replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
create table if not exists public.integration_keys (
  name   text primary key,
  token  text not null default replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')
);
insert into public.integration_keys(name) values ('zapier') on conflict do nothing;
alter table public.integration_keys enable row level security;   -- no policies: unreadable from the app
revoke all on public.integration_keys from anon, authenticated;

create or replace function public.zap_check(p_token text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if p_token is null or not exists (select 1 from public.integration_keys where name = 'zapier' and token = p_token) then
    raise exception 'Invalid integration key';
  end if;
end $$;

-- Monday follow-up drafts: returns the emails and logs the follow-up on each proposal
create or replace function public.zap_followups(token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare out jsonb := '[]'::jsonb; p public.proposals; e jsonb;
begin
  perform public.zap_check(token);
  perform set_config('pfbs.actor', 'Zapier', true);
  for p in select * from public.proposals
            where status in ('Sent','Follow-up') and coalesce(contact_email,'') <> ''
              and public.fu_next(date_sent, last_follow_up) <= current_date
            order by date_sent
            limit 25 loop
    e := public.followup_email_for(p);
    out := out || e;
    insert into public.proposal_activity(num, by_name, kind, note)
    values (p.num, 'Zapier', 'follow_up', 'Follow-up email #' || (e->>'step') || ' drafted in Outlook: ' || (e->>'subject'));
  end loop;
  return jsonb_build_object('count', jsonb_array_length(out), 'emails', out);
end $$;

-- Monthly report email (defaults to last month)
create or replace function public.zap_monthly_report(token text, month date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.zap_check(token);
  return public.monthly_report_html(coalesce(month, (date_trunc('month', current_date) - interval '1 month')::date));
end $$;

-- HousecallPro: "New Scheduled Job" → Scheduled, "New Completed Job" → Invoiced
-- ref: any text from the HCP job that contains the PFBS number (description, tags, notes)
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
    when lower(event) like '%sched%' and p.status in ('Sent','Follow-up','Approved') then 'Scheduled'
    when lower(event) like '%complet%' and p.status in ('Sent','Follow-up','Approved','Scheduled') then 'Invoiced'
    else p.status end;

  update public.proposals set
    hcp_job = coalesce(nullif(public.proposals.hcp_job,''), nullif(zap_hcp.hcp_job,'')),
    status = new_status,
    date_resolved = case when p.status in ('Sent','Follow-up') and new_status <> p.status then coalesce(date_resolved, current_date) else date_resolved end
  where num = p.num;

  insert into public.proposal_activity(num, by_name, kind, note)
  values (p.num, 'HousecallPro', 'note', 'HousecallPro: ' || coalesce(event,'update') || coalesce(' (job ' || nullif(hcp_job,'') || ')','')
          || case when new_status <> p.status then ' → status ' || new_status else '' end);
  return jsonb_build_object('ok', true, 'num', p.num, 'status', new_status);
end $$;

-- who may call what (Supabase grants new functions to anon and authenticated by default, so revoke explicitly)
revoke execute on function public.zap_followups(text), public.zap_monthly_report(text, date), public.zap_hcp(text, text, text, text),
                 public.monthly_report_html(date), public.followup_email_for(public.proposals), public.zap_check(text),
                 public.monthly_report(date), public.followup_email(text), public.pfbs_setting(text, jsonb),
                 public.bd_comm(public.proposals), public.est_comm(public.proposals) from public, anon, authenticated;
grant execute on function public.zap_followups(text), public.zap_monthly_report(text, date), public.zap_hcp(text, text, text, text) to anon, authenticated;
grant execute on function public.monthly_report(date), public.followup_email(text), public.followup_email_for(public.proposals),
                 public.pfbs_setting(text, jsonb), public.bd_comm(public.proposals), public.est_comm(public.proposals) to authenticated;

notify pgrst, 'reload schema';
