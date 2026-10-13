-- =====================================================================
-- PFBS Proposal Desk — update 019: clients, contacts and properties
--   • clients: one per company (or homeowner), with billing address, AP email, PO# required, payment terms
--   • client_contacts: the people at each client (property managers, AP, owners)
--   • properties: each client's buildings / job sites (a client can have dozens)
--   • proposals link to a client and a property (the text fields stay, so nothing breaks)
--   • import_clients: brings in the HousecallPro customer export (run from Settings in the app); safe to repeat
--   • link_clients: connects existing proposals to their client and property
--   • nothing is deleted by the team: clients, contacts and properties are archived (active = false)
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 018 first.
-- =====================================================================
do $$ begin
  if to_regclass('public.invoices') is null then
    raise exception 'Run updates 007 to 018 first, then run this one again.';
  end if;
end $$;

-- street address → a key that ignores punctuation, case and Street/St, so "2150 Webster Street" = "2150 WEBSTER ST"
create or replace function public.pfbs_addr_key(a text) returns text
language sql immutable as $$
  select nullif(trim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    ' ' || upper(regexp_replace(split_part(split_part(coalesce(a,''), E'\n', 1), ',', 1), '[^A-Za-z0-9 ]', ' ', 'g')) || ' ',
    ' STREET ', ' ST ', 'g'), ' AVENUE ', ' AVE ', 'g'), ' BOULEVARD ', ' BLVD ', 'g'), ' DRIVE ', ' DR ', 'g'), ' ROAD ', ' RD ', 'g'),
    ' LANE ', ' LN ', 'g'), ' COURT ', ' CT ', 'g'), ' PLACE ', ' PL ', 'g'), ' PARKWAY ', ' PKWY ', 'g'), '\s+', ' ', 'g')), '')
$$;

create table if not exists public.clients (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  kind            text not null default 'Business' check (kind in ('Business','Homeowner')),
  billing_address text,
  billing_email   text,
  po_required     boolean not null default false,
  terms_days      int check (terms_days between 0 and 365),
  notes           text,
  aliases         text[] not null default '{}',
  hcp_ids         text[] not null default '{}',
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  created_by      text,
  updated_at      timestamptz not null default now(),
  updated_by      text
);
create unique index if not exists clients_name_uq on public.clients (lower(trim(name)));

create table if not exists public.client_contacts (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  name          text,
  role          text,
  email         text,
  emails_extra  text,
  phone         text,
  is_primary    boolean not null default false,
  notes         text,
  hcp_id        text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists client_contacts_client_idx on public.client_contacts(client_id);

create table if not exists public.properties (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  name        text,
  address     text,
  addr_key    text,
  notes       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists properties_client_idx on public.properties(client_id);
create index if not exists properties_addr_idx on public.properties(addr_key);

alter table public.proposals
  add column if not exists client_id   uuid references public.clients(id) on delete set null,
  add column if not exists property_id uuid references public.properties(id) on delete set null;
create index if not exists proposals_client_idx on public.proposals(client_id);

-- stamps
create or replace function public.clients_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := coalesce(nullif(public.my_name(),''), 'Office');
begin
  new.name := trim(new.name);
  if new.name = '' then raise exception 'A client needs a name.'; end if;
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, who); new.created_at := now(); end if;
  new.updated_by := who; new.updated_at := now();
  return new;
end $$;
drop trigger if exists clients_stamp on public.clients;
create trigger clients_stamp before insert or update on public.clients for each row execute function public.clients_stamp();

create or replace function public.properties_key() returns trigger
language plpgsql as $$
begin
  new.addr_key := public.pfbs_addr_key(coalesce(nullif(new.address,''), new.name));
  return new;
end $$;
drop trigger if exists properties_key on public.properties;
create trigger properties_key before insert or update on public.properties for each row execute function public.properties_key();

-- who can see and change: the whole team (BD reps and estimators add clients); only the owner deletes
alter table public.clients enable row level security;
alter table public.client_contacts enable row level security;
alter table public.properties enable row level security;
do $$ declare t text; begin
  foreach t in array array['clients','client_contacts','properties'] loop
    execute format('drop policy if exists %I on public.%I', t||'_read', t);
    execute format('drop policy if exists %I on public.%I', t||'_insert', t);
    execute format('drop policy if exists %I on public.%I', t||'_update', t);
    execute format('drop policy if exists %I on public.%I', t||'_delete', t);
    execute format('create policy %I on public.%I for select using (public.my_role() is not null)', t||'_read', t);
    execute format('create policy %I on public.%I for insert with check (public.my_role() is not null)', t||'_insert', t);
    execute format('create policy %I on public.%I for update using (public.my_role() is not null) with check (public.my_role() is not null)', t||'_update', t);
    execute format('create policy %I on public.%I for delete using (public.my_role() = ''Owner'')', t||'_delete', t);
  end loop;
end $$;
grant select, insert, update, delete on public.clients, public.client_contacts, public.properties to authenticated;
revoke all on public.clients, public.client_contacts, public.properties from anon;

-- ---------- connect proposals to clients and properties -----------------
create or replace function public.link_clients() returns jsonb
language plpgsql security definer set search_path = public as $$
declare nc int; np int;
begin
  if coalesce(public.my_role(),'') not in ('Owner','Admin') then raise exception 'Only the owner or admin can do this.'; end if;
  update public.proposals p set client_id = c.id
    from public.clients c
   where p.client_id is null and coalesce(trim(p.client),'') <> ''
     and (lower(trim(p.client)) = lower(c.name) or lower(trim(p.client)) = any (select lower(x) from unnest(c.aliases) x));
  get diagnostics nc = row_count;
  update public.proposals p set property_id = pr.id
    from public.properties pr
   where p.property_id is null and p.client_id = pr.client_id and pr.addr_key is not null
     and pr.addr_key in (public.pfbs_addr_key(p.site_address), public.pfbs_addr_key(p.property));
  get diagnostics np = row_count;
  return jsonb_build_object('proposals_linked_to_client', nc, 'proposals_linked_to_property', np);
end $$;

-- ---------- import (HousecallPro customer export, grouped in the app) ----
-- payload: {"clients":[{name, kind, billing_address, billing_email, po_required, notes, aliases[], hcp_ids[],
--            contacts:[{name, role, email, emails_extra, phone, hcp_id}], properties:[{name, address, notes}]}]}
create or replace function public.import_clients(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb; x jsonb; cid uuid; n_new int := 0; n_upd int := 0; k_new int := 0; p_new int := 0; nm text; ak text; em text; links jsonb;
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
      if not exists (select 1 from public.properties where client_id = cid and addr_key = ak) then
        insert into public.properties(client_id, name, address, notes) values (cid, nullif(trim(x->>'name'),''), nullif(trim(x->>'address'),''), nullif(trim(x->>'notes'),''));
        p_new := p_new + 1;
      end if;
    end loop;
  end loop;
  links := public.link_clients();
  insert into public.admin_log(by_name, area, item, new_value)
  values (public.my_name(), 'Clients', 'Imported from HousecallPro', n_new || ' new clients, ' || n_upd || ' updated, ' || k_new || ' contacts, ' || p_new || ' properties');
  return jsonb_build_object('clients_new', n_new, 'clients_updated', n_upd, 'contacts_new', k_new, 'properties_new', p_new) || links;
end $$;

-- ---------- backups include clients -------------------------------------
create or replace function public.backup_json() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'app', 'PFBS Proposal Desk', 'exported_at', now(),
    'proposals',          coalesce((select jsonb_agg(to_jsonb(x) order by x.num) from public.proposals x), '[]'),
    'proposal_activity',  coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.proposal_activity x), '[]'),
    'prospects',          coalesce((select jsonb_agg(to_jsonb(x)) from public.prospects x), '[]'),
    'team_members',       coalesce((select jsonb_agg(to_jsonb(x)) from public.team_members x), '[]'),
    'settings',           coalesce((select jsonb_agg(to_jsonb(x)) from public.settings x), '[]'),
    'commission_payouts', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.commission_payouts x), '[]'),
    'admin_log',          coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.admin_log x), '[]'),
    'deleted_proposals',  coalesce((select jsonb_agg(to_jsonb(x)) from public.deleted_proposals x), '[]'),
    'invoices',           coalesce((select jsonb_agg(to_jsonb(x) order by x.inv_no) from public.invoices x), '[]'),
    'invoice_payments',   coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.invoice_payments x), '[]'),
    'service_reports',    coalesce((select jsonb_agg(to_jsonb(x) - 'doc' || jsonb_build_object('doc', x.doc - '_raw')) from public.service_reports x), '[]'),
    'clients',            coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from public.clients x), '[]'),
    'client_contacts',    coalesce((select jsonb_agg(to_jsonb(x)) from public.client_contacts x), '[]'),
    'properties',         coalesce((select jsonb_agg(to_jsonb(x)) from public.properties x), '[]'))
$$;

revoke execute on function public.clients_stamp(), public.link_clients(), public.import_clients(jsonb), public.backup_json() from public, anon, authenticated;
grant execute on function public.link_clients(), public.import_clients(jsonb) to authenticated;
grant execute on function public.pfbs_addr_key(text) to authenticated;

notify pgrst, 'reload schema';
