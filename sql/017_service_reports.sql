-- =====================================================================
-- PFBS Proposal Desk — update 017: service reports move into the CRM
--   • service_reports: one report per visit, linked to its PFBS job when there is one
--   • private storage "job-reports" for report photos and the approved PDFs
--   • zap_report_job: HousecallPro "Job finished" → a new report waiting for review
--     (same Zap as today, pointed here instead of the old Cloudflare app)
--   • report_hook / set_report_hook: the "report approved → Outlook draft" Zap URL,
--     kept out of the page; only the office can read it
--   • save_crew_leads: the crew lead list, editable by the office
--   • report_approved: marks the report sent and shows it on the job
-- The old service report app keeps working until you switch the Zap over.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 016 first.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.zap_check(text)') is null
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='proposals' and column_name='report_url') then
    raise exception 'Run updates 007 to 016 first, then run this one again.';
  end if;
end $$;

-- ---------- reports ----------------------------------------------------
create table if not exists public.service_reports (
  id             uuid primary key default gen_random_uuid(),
  num            text references public.proposals(num) on update cascade on delete set null,
  hcp_job        text,
  status         text not null default 'pending' check (status in ('pending','approved')),
  client         text,
  address        text,
  addr_key       text,
  service_dates  text,
  photo_count    int not null default 0,
  doc            jsonb not null default '{}'::jsonb,   -- the full report (same shape as the old app)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  approved_at    timestamptz,
  created_by     text,
  updated_by     text
);
create index if not exists service_reports_status_idx on public.service_reports(status, created_at desc);
create index if not exists service_reports_num_idx on public.service_reports(num);
create index if not exists service_reports_addr_idx on public.service_reports(addr_key);
create index if not exists service_reports_hcp_idx on public.service_reports(hcp_job);

create or replace function public.service_reports_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := coalesce(nullif(public.my_name(),''), nullif(public.my_email(),''), nullif(current_setting('pfbs.actor', true), ''), 'HousecallPro');
begin
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, who); new.created_at := now(); end if;
  new.updated_by := who; new.updated_at := now();
  return new;
end $$;
drop trigger if exists service_reports_stamp on public.service_reports;
create trigger service_reports_stamp before insert or update on public.service_reports
  for each row execute function public.service_reports_stamp();

alter table public.service_reports enable row level security;
drop policy if exists sr_read   on public.service_reports;
drop policy if exists sr_write  on public.service_reports;
drop policy if exists sr_update on public.service_reports;
drop policy if exists sr_delete on public.service_reports;
create policy sr_read   on public.service_reports for select using (public.is_manager());
create policy sr_write  on public.service_reports for insert with check (public.is_manager());
create policy sr_update on public.service_reports for update using (public.is_manager()) with check (public.is_manager());
create policy sr_delete on public.service_reports for delete using (public.my_role() in ('Owner','Admin'));
grant select, insert, update, delete on public.service_reports to authenticated;
revoke all on public.service_reports from anon;

-- ---------- private storage for photos and PDFs -------------------------
insert into storage.buckets (id, name, public) values ('job-reports', 'job-reports', false)
on conflict (id) do nothing;
drop policy if exists "pfbs reports read"   on storage.objects;
drop policy if exists "pfbs reports add"    on storage.objects;
drop policy if exists "pfbs reports change" on storage.objects;
drop policy if exists "pfbs reports remove" on storage.objects;
create policy "pfbs reports read"   on storage.objects for select to authenticated using (bucket_id = 'job-reports' and public.is_manager());
create policy "pfbs reports add"    on storage.objects for insert to authenticated with check (bucket_id = 'job-reports' and public.is_manager());
create policy "pfbs reports change" on storage.objects for update to authenticated using (bucket_id = 'job-reports' and public.is_manager());
create policy "pfbs reports remove" on storage.objects for delete to authenticated using (bucket_id = 'job-reports' and public.is_manager());

-- ---------- settings only the office can read ---------------------------
create table if not exists public.private_settings (key text primary key, value text, updated_at timestamptz not null default now(), updated_by text);
alter table public.private_settings enable row level security;   -- no policies: only the functions below can read or write it
revoke all on public.private_settings from anon, authenticated;

create or replace function public.report_hook() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_manager() then raise exception 'Only the office can send service reports.'; end if;
  return (select value from public.private_settings where key = 'report_approve_hook');
end $$;

create or replace function public.set_report_hook(url text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(public.my_role(),'') not in ('Owner','Admin') then raise exception 'Only the owner or admin can change this.'; end if;
  if coalesce(url,'') <> '' and url !~ '^https://hooks\.zapier\.com/' then raise exception 'That does not look like a Zapier webhook link (https://hooks.zapier.com/…).'; end if;
  insert into public.private_settings(key, value, updated_by) values ('report_approve_hook', nullif(trim(url),''), public.my_name())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
  insert into public.admin_log(by_name, area, item, new_value) values (public.my_name(), 'Settings', 'Service report Zap link', case when coalesce(url,'')='' then 'removed' else 'changed' end);
end $$;

-- ---------- crew leads (one list, editable by the office) ---------------
create or replace function public.save_crew_leads(names jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare clean jsonb;
begin
  if not public.is_manager() then raise exception 'Only the office can change the crew list.'; end if;
  select coalesce(jsonb_agg(distinct left(trim(x), 60)), '[]'::jsonb) into clean
    from jsonb_array_elements_text(coalesce(names,'[]'::jsonb)) x where trim(x) <> '';
  if jsonb_array_length(clean) = 0 then raise exception 'Add at least one name.'; end if;
  update public.settings set data = coalesce(data,'{}'::jsonb) || jsonb_build_object('crewLeads', clean) where id = 1;
  return clean;
end $$;

-- ---------- HousecallPro "Job finished" → new report ---------------------
-- Zapier: Webhooks POST to /rest/v1/rpc/zap_report_job with header  Prefer: params=single-object
-- and the same fields as today (client, address, street, city, state, zip, email, contact_first_name,
-- contact_last_name, line_items, notes, start, end, started_at, completed_at, job_id, job_number, employees)
-- plus  token = your integration key.
create or replace function public.zap_report_job(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb := coalesce(payload,'{}'::jsonb) - 'token'; jid text; jnum text; n text; st text; via text; mt text[]; existing uuid; newid uuid; txt text;
begin
  perform public.zap_check(payload->>'token');
  perform set_config('pfbs.actor', 'HousecallPro', true);
  -- HCP sends a Job ID (the long one the CRM stores) and a job number; either one finds the job
  jid  := nullif(trim(coalesce(d->>'job_id', '')), '');
  jnum := nullif(trim(coalesce(d->>'job_number', '')), '');
  jid  := coalesce(jid, jnum);
  if jid is not null then
    select id into existing from public.service_reports where hcp_job in (jid, coalesce(jnum, jid)) order by created_at desc limit 1;
    if existing is not null then
      return jsonb_build_object('ok', true, 'duplicate', true, 'id', existing, 'review_url', 'https://apps.pfbservices.com/reports.html#/r/' || existing);
    end if;
  end if;
  -- link to the PFBS job: the PFBS number anywhere in the job text, or the HCP job number
  txt := concat_ws(' ', d->>'description', d->>'notes', d->>'line_items', d->>'job_description', d->>'tags');
  mt := regexp_match(coalesce(txt,''), 'PFBS[\s#:-]*0*([0-9]{1,6})', 'i');
  if mt is not null then select num into n from public.proposals where num = 'PFBS-' || lpad(mt[1], 4, '0'); end if;
  if n is null and jid is not null then select num into n from public.proposals where hcp_job in (jid, coalesce(jnum, jid)) order by num desc limit 1; end if;
  -- HousecallPro's Zapier trigger has no job description, so also match the job by its street address:
  -- house number + street name, on an open job at that address (scheduled first, then approved, invoiced, recently paid)
  if n is null then
    st := upper(regexp_replace(coalesce(nullif(d->>'street',''), split_part(coalesce(d->>'address',''), ',', 1)), '[^A-Za-z0-9 ]', ' ', 'g'));
    mt := regexp_match(st, '^\s*([0-9]+)\s+(?:(?:N|S|E|W|NORTH|SOUTH|EAST|WEST)\s+)?([A-Z0-9]+)');
    if mt is not null then
      select pr.num into n from public.proposals pr
       where pr.cancelled_on is null
         and (pr.status in ('Approved','Scheduled','Invoiced') or (pr.status = 'Paid' and coalesce(pr.date_paid, current_date) > current_date - 400))
         and upper(regexp_replace(coalesce(pr.site_address,'') || ' ' || coalesce(pr.property,''), '[^A-Za-z0-9 ]', ' ', 'g'))
             ~ ('(^|\s)' || mt[1] || '\s+((N|S|E|W|NORTH|SOUTH|EAST|WEST)\s+)?' || mt[2] || '(\s|$)')
       order by case pr.status when 'Scheduled' then 0 when 'Approved' then 1 when 'Invoiced' then 2 else 3 end, pr.num desc
       limit 1;
      if n is not null then via := 'address'; end if;
    end if;
  end if;
  insert into public.service_reports(num, hcp_job, status, client, address, doc)
  values (n, jid, 'pending', upper(coalesce(d->>'client','')), upper(coalesce(d->>'address', d->>'street','')), jsonb_build_object('_raw', d))
  returning id into newid;
  if n is not null then
    insert into public.proposal_activity(num, by_name, kind, note) values (n, 'HousecallPro', 'note', 'Job finished in HousecallPro: service report started' || coalesce(' (HCP job ' || jid || ')','') || case when via = 'address' then ', matched by address' else '' end);
  end if;
  return jsonb_build_object('ok', true, 'duplicate', false, 'id', newid, 'num', n, 'review_url', 'https://apps.pfbservices.com/reports.html#/r/' || newid,
                            'job_number', coalesce(jnum, jid), 'matched_by', coalesce(via, case when n is null then null else 'number' end), 'client', upper(coalesce(d->>'client','')), 'address', upper(coalesce(d->>'address', d->>'street','')));
end $$;

-- ---------- report approved: show it on the job --------------------------
create or replace function public.report_approved(p_id uuid, p_link text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.service_reports;
begin
  if not public.is_manager() then raise exception 'Only the office can send service reports.'; end if;
  update public.service_reports set status = 'approved', approved_at = now() where id = p_id returning * into r;
  if r.id is null then raise exception 'Report not found.'; end if;
  if r.num is not null then
    update public.proposals set report_sent_on = current_date, report_url = p_link where num = r.num;
    insert into public.proposal_activity(num, by_name, kind, note)
    values (r.num, coalesce(public.my_name(),'Office'), 'note', 'Service report approved and sent to Outlook' || coalesce(' for ' || nullif(r.service_dates,''),''));
  end if;
  return jsonb_build_object('ok', true, 'num', r.num);
end $$;

revoke execute on function public.service_reports_stamp(), public.report_hook(), public.set_report_hook(text), public.save_crew_leads(jsonb),
  public.zap_report_job(jsonb), public.report_approved(uuid, text) from public, anon, authenticated;
grant execute on function public.report_hook(), public.set_report_hook(text), public.save_crew_leads(jsonb), public.report_approved(uuid, text) to authenticated;
grant execute on function public.zap_report_job(jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
