-- =====================================================================
-- PFBS Proposal Desk — update 022: job numbers, weekday-only jobs, contact per property
--   • every scheduled visit carries a job # (like HousecallPro, where each visit is its own job):
--     until switch-over it is the HCP job # typed on the job; after "Next job #" is set in Settings
--     the CRM numbers jobs itself, continuing after HousecallPro's last number
--   • visits can skip weekends (Mon–Fri jobs that run two weeks)
--   • sending an invoice marks the job's visits up to the service date Done
--   • each property can have its own contact (the property manager for that building)
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 021 first.
-- =====================================================================
do $$ begin
  if to_regprocedure('public.can_money()') is null then
    raise exception 'Run updates 007 to 021 first, then run this one again.';
  end if;
end $$;

alter table public.visits
  add column if not exists job_no        text,
  add column if not exists skip_weekends boolean not null default false;
create index if not exists visits_job_no_idx on public.visits(job_no);
alter table public.properties add column if not exists contact_id uuid references public.client_contacts(id) on delete set null;

create sequence if not exists public.job_no_seq start 1;

-- the visit's job #: the CRM's own number once switched over, otherwise the HCP job # on the job
create or replace function public.visits_job_no() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'job' and coalesce(new.job_no,'') = '' then
    if exists (select 1 from public.private_settings where key = 'crm_job_numbers' and value = 'on') then
      new.job_no := nextval('public.job_no_seq')::text;
    elsif new.num is not null then
      new.job_no := nullif((select hcp_job from public.proposals where num = new.num), '');
    end if;
  end if;
  return new;
end $$;
drop trigger if exists visits_job_no on public.visits;
create trigger visits_job_no before insert on public.visits for each row execute function public.visits_job_no();

create or replace function public.next_job_no() returns bigint
language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from public.private_settings where key = 'crm_job_numbers' and value = 'on')
              then (select case when is_called then last_value + 1 else last_value end from public.job_no_seq) end
$$;
create or replace function public.set_next_job_no(n bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare mx bigint;
begin
  if coalesce(public.my_role(),'') not in ('Owner','Admin') then raise exception 'Only the owner or admin can change job numbering.'; end if;
  select coalesce(max(nullif(regexp_replace(job_no, '\D', '', 'g'), '')::bigint), 0) into mx from public.visits;
  if n is null or n <= mx then raise exception 'The next job # must be higher than % (the last one used).', mx; end if;
  perform setval('public.job_no_seq', n, false);
  insert into public.private_settings(key, value, updated_by) values ('crm_job_numbers', 'on', public.my_name())
  on conflict (key) do update set value = 'on', updated_at = now(), updated_by = excluded.updated_by;
  insert into public.admin_log(by_name, area, item, new_value) values (public.my_name(), 'Settings', 'Next job #', n::text);
  return n;
end $$;

-- sending an invoice: that job's scheduled visits up to the service date are Done
create or replace function public.invoices_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := coalesce(nullif(public.my_name(),''), 'Office');
begin
  if new.num is null then return new; end if;
  if tg_op = 'INSERT' then
    insert into public.proposal_activity(num, by_name, kind, note) values (new.num, who, 'note', 'Invoice #' || new.inv_no || ' created: $' || to_char(new.total, 'FM999,999,990.00'));
  elsif new.status is distinct from old.status then
    insert into public.proposal_activity(num, by_name, kind, note) values (new.num, who, 'note',
      'Invoice #' || new.inv_no || case new.status when 'Sent' then ' sent' || coalesce(' to ' || nullif(new.sent_to,''), '')
                                                   when 'Paid' then ' paid in full'
                                                   when 'Void' then ' voided: ' || coalesce(new.void_reason,'')
                                                   else ' is ' || new.status end);
  end if;
  if new.status = 'Sent' and (tg_op = 'INSERT' or old.status = 'Draft') then
    update public.proposals set status = 'Invoiced' where num = new.num and status in ('Approved','Scheduled');
    update public.visits set status = 'Done', invoice_id = new.id
     where num = new.num and kind = 'job' and status = 'Scheduled' and invoice_id is null
       and visit_date <= coalesce(new.service_date, current_date);
  end if;
  if new.status = 'Paid' and (tg_op = 'INSERT' or old.status <> 'Paid') then
    update public.proposals
       set status = 'Paid',
           date_paid = coalesce(date_paid, (select max(received_on) from public.invoice_payments where invoice_id = new.id and not voided), current_date)
     where num = new.num and status in ('Approved','Scheduled','Invoiced');
  end if;
  return new;
end $$;

-- import: a property can name its contact (the person HousecallPro listed it under)
create or replace function public.import_clients(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb; x jsonb; cid uuid; n_new int := 0; n_upd int := 0; k_new int := 0; p_new int := 0; nm text; ak text; em text; links jsonb; kid uuid;
begin
  if coalesce(public.my_role(),'') not in ('Owner','Admin') then raise exception 'Only the owner or admin can import clients.'; end if;
  for c in select * from jsonb_array_elements(coalesce(payload->'clients','[]'::jsonb)) loop
    nm := trim(coalesce(c->>'name',''));
    if nm = '' then continue; end if;
    select id into cid from public.clients
     where lower(name) = lower(nm) or lower(nm) = any (select lower(a) from unnest(aliases) a)
        or exists (select 1 from jsonb_array_elements_text(coalesce(c->'aliases','[]'::jsonb)) a where lower(a) = lower(name))
     limit 1;
    if cid is null then
      insert into public.clients(name, kind, billing_address, billing_email, po_required, notes, aliases, hcp_ids)
      values (nm, case when c->>'kind' = 'Homeowner' then 'Homeowner' else 'Business' end, nullif(c->>'billing_address',''), nullif(c->>'billing_email',''),
              coalesce((c->>'po_required')::boolean, false), nullif(c->>'notes',''),
              coalesce(array(select jsonb_array_elements_text(c->'aliases')), '{}'), coalesce(array(select jsonb_array_elements_text(c->'hcp_ids')), '{}'))
      returning id into cid;
      n_new := n_new + 1;
    else
      update public.clients set
        billing_address = coalesce(nullif(billing_address,''), nullif(c->>'billing_address','')),
        billing_email   = coalesce(nullif(billing_email,''), nullif(c->>'billing_email','')),
        po_required     = po_required or coalesce((c->>'po_required')::boolean, false),
        notes           = coalesce(nullif(notes,''), nullif(c->>'notes','')),
        aliases         = array(select distinct unnest(aliases || coalesce(array(select jsonb_array_elements_text(c->'aliases')), '{}'))),
        hcp_ids         = array(select distinct unnest(hcp_ids || coalesce(array(select jsonb_array_elements_text(c->'hcp_ids')), '{}')))
      where id = cid;
      n_upd := n_upd + 1;
    end if;
    for x in select * from jsonb_array_elements(coalesce(c->'contacts','[]'::jsonb)) loop
      em := lower(trim(coalesce(x->>'email','')));
      if not exists (select 1 from public.client_contacts cc where cc.client_id = cid
                      and ((em <> '' and lower(cc.email) = em) or (em = '' and lower(coalesce(cc.name,'')) = lower(trim(coalesce(x->>'name','')))))) then
        insert into public.client_contacts(client_id, name, role, email, emails_extra, phone, hcp_id, is_primary)
        values (cid, nullif(trim(x->>'name'),''), nullif(trim(x->>'role'),''), nullif(trim(x->>'email'),''), nullif(trim(x->>'emails_extra'),''),
                nullif(trim(x->>'phone'),''), nullif(x->>'hcp_id',''), not exists (select 1 from public.client_contacts where client_id = cid));
        k_new := k_new + 1;
      end if;
    end loop;
    for x in select * from jsonb_array_elements(coalesce(c->'properties','[]'::jsonb)) loop
      ak := public.pfbs_addr_key(coalesce(nullif(x->>'address',''), x->>'name'));
      if ak is null then continue; end if;
      kid := null;
      if coalesce(x->>'contact_hcp_id','') <> '' then select id into kid from public.client_contacts where client_id = cid and hcp_id = x->>'contact_hcp_id' limit 1; end if;
      if kid is null and coalesce(x->>'contact_email','') <> '' then select id into kid from public.client_contacts where client_id = cid and lower(email) = lower(x->>'contact_email') limit 1; end if;
      if not exists (select 1 from public.properties where client_id = cid and addr_key = ak) then
        insert into public.properties(client_id, name, address, notes, contact_id) values (cid, nullif(trim(x->>'name'),''), nullif(trim(x->>'address'),''), nullif(trim(x->>'notes'),''), kid);
        p_new := p_new + 1;
      elsif kid is not null then
        update public.properties set contact_id = coalesce(contact_id, kid) where client_id = cid and addr_key = ak;
      end if;
    end loop;
  end loop;
  links := public.link_clients();
  insert into public.admin_log(by_name, area, item, new_value)
  values (public.my_name(), 'Clients', 'Imported from HousecallPro', n_new || ' new clients, ' || n_upd || ' updated, ' || k_new || ' contacts, ' || p_new || ' properties');
  return jsonb_build_object('clients_new', n_new, 'clients_updated', n_upd, 'contacts_new', k_new, 'properties_new', p_new) || links;
end $$;

revoke execute on function public.visits_job_no(), public.next_job_no(), public.set_next_job_no(bigint), public.import_clients(jsonb) from public, anon, authenticated;
grant execute on function public.next_job_no(), public.set_next_job_no(bigint), public.import_clients(jsonb) to authenticated;
grant usage on sequence public.job_no_seq to authenticated;

notify pgrst, 'reload schema';
