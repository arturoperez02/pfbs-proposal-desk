-- =====================================================================
-- PFBS Proposal Desk — update 042: merge two clients (Arturo 10/28)
--   The same building ended up as two clients ("101 Mission Street" and "CP Mission Owner, LLC").
--   merge_clients(keep, gone) moves everything from "gone" into "keep" in one step:
--   • its proposals / jobs (and so their invoices, visits and reports, which hang off the job)
--   • its buildings: the same street address as one of keep's buildings → combined (jobs point at keep's building,
--     blanks filled, CCs joined); otherwise the building simply moves over
--   • its contacts: the same email as one of keep's contacts → combined (buildings that used it now use keep's);
--     otherwise the contact moves over (keep's company contact stays the company contact)
--   • owners it managed are now managed by keep; billing address / AP email / terms / notes fill keep's blanks;
--     its name and other names become keep's "also known as", so old HousecallPro invoices still find it
--   • gone is archived (never deleted) and remembers where it went (clients.merged_into); admin_log + a note on each job
-- Owner or Admin only (same as Archive). Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 041 first.
-- =====================================================================
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'proposals' and column_name = 'client_schedule') then
    raise exception 'Run updates 007 to 041 first, then run this one again.';
  end if;
end $$;

alter table public.clients add column if not exists merged_into uuid references public.clients(id) on delete set null;

-- street address without the suite / unit / floor, so "101 Mission St., Suite 130" = "101 Mission Street"
create or replace function public.pfbs_street_key(a text) returns text
language sql immutable as $$
  select nullif(trim(regexp_replace(coalesce(public.pfbs_addr_key(a),''), '\s(SUITE|STE|UNIT|APT|FL|FLOOR|RM|ROOM|BLDG|BUILDING|NO)\s.*$|\s(SUITE|STE|UNIT|APT|FL|FLOOR|RM|ROOM)$', '')), '')
$$;

create or replace function public.merge_clients(keep uuid, gone uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  k public.clients; g public.clients; who text := coalesce(nullif(public.my_name(),''), 'Office');
  pr record; kc record; twin uuid; n_jobs int := 0; n_props int := 0; n_props_comb int := 0; n_cont int := 0; n_cont_comb int := 0; n_own int := 0;
  has_cc boolean := exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'properties' and column_name = 'cc_contact_ids');
begin
  if coalesce(public.my_role(),'') not in ('Owner','Admin') then raise exception 'Only the owner or admin can merge clients.'; end if;
  if keep is null or gone is null or keep = gone then raise exception 'Pick two different clients.'; end if;
  select * into k from public.clients where id = keep for update;
  select * into g from public.clients where id = gone for update;
  if k.id is null or g.id is null then raise exception 'One of those clients no longer exists.'; end if;
  if g.merged_into is not null then raise exception '% was already merged.', g.name; end if;

  -- contacts: same email → one contact; else move it over
  for kc in select * from public.client_contacts where client_id = gone loop
    select id into twin from public.client_contacts
     where client_id = keep and coalesce(trim(email),'') <> '' and lower(trim(email)) = lower(trim(coalesce(kc.email,''))) order by active desc limit 1;
    if twin is not null then
      update public.client_contacts set
        name = coalesce(nullif(name,''), kc.name), role = coalesce(nullif(role,''), kc.role), phone = coalesce(nullif(phone,''), kc.phone),
        emails_extra = coalesce(nullif(emails_extra,''), kc.emails_extra), notes = coalesce(nullif(notes,''), kc.notes), active = active or kc.active
       where id = twin;
      update public.properties set contact_id = twin where contact_id = kc.id;
      if has_cc then
        execute 'update public.properties set cc_contact_ids = array(select distinct case when x = $1 then $2 else x end from unnest(cc_contact_ids) x) where $1 = any(cc_contact_ids)' using kc.id, twin;
      end if;
      update public.client_contacts set active = false, is_primary = false, client_id = keep where id = kc.id;
      n_cont_comb := n_cont_comb + 1;
    else
      update public.client_contacts set client_id = keep,
        is_primary = kc.is_primary and not exists (select 1 from public.client_contacts where client_id = keep and is_primary and active)
       where id = kc.id;
      if kc.active then n_cont := n_cont + 1; end if;
    end if;
  end loop;

  -- buildings: same street → one building; else move it over
  for pr in select * from public.properties where client_id = gone loop
    select id into twin from public.properties
     where client_id = keep and public.pfbs_street_key(coalesce(nullif(address,''), name)) = public.pfbs_street_key(coalesce(nullif(pr.address,''), pr.name))
       and public.pfbs_street_key(coalesce(nullif(pr.address,''), pr.name)) is not null
     order by active desc limit 1;
    if twin is not null then
      update public.properties set
        name = coalesce(nullif(name,''), pr.name), address = coalesce(nullif(address,''), pr.address),
        notes = case when coalesce(notes,'') = '' then pr.notes when coalesce(pr.notes,'') = '' or notes = pr.notes then notes else notes || E'\n' || pr.notes end,
        contact_id = coalesce(contact_id, pr.contact_id), active = active or pr.active
       where id = twin;
      if has_cc then
        execute 'update public.properties t set cc_contact_ids = array(select distinct x from unnest(t.cc_contact_ids || s.cc_contact_ids) x where x is distinct from t.contact_id)
                   from public.properties s where t.id = $1 and s.id = $2' using twin, pr.id;
      end if;
      update public.proposals set property_id = twin where property_id = pr.id;
      update public.properties set active = false, client_id = keep where id = pr.id;
      n_props_comb := n_props_comb + 1;
    else
      update public.properties set client_id = keep where id = pr.id;
      if pr.active then n_props := n_props + 1; end if;
    end if;
  end loop;

  -- jobs / proposals (linked, or only named the old way)
  with moved as (
    update public.proposals set client_id = keep
     where client_id = gone
        or (client_id is null and coalesce(trim(client),'') <> ''
            and (lower(trim(client)) = lower(g.name) or lower(trim(client)) = any (select lower(a) from unnest(g.aliases) a)))
    returning num)
  insert into public.proposal_activity(num, by_name, kind, note)
  select num, who, 'note', 'Client merged: ' || g.name || ' → ' || k.name from moved;
  get diagnostics n_jobs = row_count;

  -- owners it managed
  update public.clients set managed_by = keep where managed_by = gone and id <> keep;
  get diagnostics n_own = row_count;

  -- keep fills its blanks; gone's names become keep's other names
  update public.clients set
    billing_address = coalesce(nullif(billing_address,''), g.billing_address),
    billing_email   = coalesce(nullif(billing_email,''), g.billing_email),
    po_required     = po_required or g.po_required,
    terms_days      = coalesce(terms_days, g.terms_days),
    notes           = case when coalesce(notes,'') = '' then g.notes when coalesce(g.notes,'') = '' or notes = g.notes then notes else notes || E'\n' || g.notes end,
    managed_by      = case when managed_by = gone then null when managed_by is null and g.managed_by is distinct from keep then g.managed_by else managed_by end,
    aliases         = array(select distinct a from unnest(aliases || g.name || g.aliases) a where lower(trim(a)) <> lower(k.name) and trim(a) <> ''),
    hcp_ids         = array(select distinct unnest(hcp_ids || g.hcp_ids)),
    active          = true
   where id = keep;

  update public.clients set active = false, merged_into = keep, managed_by = null,
    notes = 'Merged into ' || k.name || ' on ' || to_char(now() at time zone 'America/Los_Angeles', 'MM/DD/YYYY') || ' by ' || who || coalesce(E'\n' || nullif(notes,''), '')
   where id = gone;

  insert into public.admin_log(by_name, area, item, old_value, new_value)
  values (who, 'Clients', 'Merged ' || g.name || ' into ' || k.name, g.name,
          n_jobs || ' proposals/jobs, ' || (n_props + n_props_comb) || ' buildings (' || n_props_comb || ' combined), '
          || (n_cont + n_cont_comb) || ' contacts (' || n_cont_comb || ' combined), ' || n_own || ' owners');

  return jsonb_build_object('jobs', n_jobs, 'properties', n_props, 'properties_combined', n_props_comb,
                            'contacts', n_cont, 'contacts_combined', n_cont_comb, 'owners', n_own, 'keep', k.name, 'gone', g.name);
end $$;

revoke execute on function public.merge_clients(uuid, uuid) from public, anon;
grant execute on function public.merge_clients(uuid, uuid) to authenticated;
grant execute on function public.pfbs_street_key(text) to authenticated;

notify pgrst, 'reload schema';
