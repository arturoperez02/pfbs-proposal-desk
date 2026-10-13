-- =====================================================================
-- PFBS Proposal Desk — update 026: the warehouse (KitTracker) moves into the CRM
--   • KitTracker's tables, same columns, with a wh_ prefix: inventory, categories, assets, inspections,
--     kit templates, packed jobs and their items, vehicles, locations, keys, repairs, reorders, DI tanks,
--     grab requests, template requests, warehouse settings
--   • who can use them: managers, estimators and the warehouse tablet logins (Settings → Warehouse).
--     A warehouse login still cannot see proposals, clients or money.
--   • the warehouse page (warehouse.html) reads the CRM schedule directly, no second sign-in
-- Run once in Supabase (the CRM project): SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 025 first. The old KitTracker keeps working; copy its data in from CRM Settings → Warehouse.
-- =====================================================================
do $$ begin
  if to_regclass('public.warehouse_logins') is null then
    raise exception 'Run updates 007 to 025 first, then run this one again.';
  end if;
end $$;

create or replace function public.can_warehouse() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role(),'') in ('Owner','Admin','Senior Estimator','Estimator')
      or exists (select 1 from public.warehouse_logins where email = public.my_email())
$$;
grant execute on function public.can_warehouse() to authenticated;

create table if not exists public.wh_app_settings (
  key text primary key, value jsonb not null, updated_at timestamptz default now());
create table if not exists public.wh_categories (
  id uuid primary key default gen_random_uuid(), name text not null, name_es text, color text default '#f5a623', created_at timestamptz default now());
create table if not exists public.wh_inventory_items (
  id uuid primary key default gen_random_uuid(), name text not null, name_es text, category_id uuid, sku text, part_number text,
  tracking_type text default 'bulk', quantity_on_hand integer default 0, low_stock_threshold integer default 2, unit_cost numeric default 0,
  supplier_name text, supplier_sku text, supplier_url text, notes text, created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists public.wh_assets (
  id uuid primary key default gen_random_uuid(), asset_tag text not null, inventory_item_id uuid, serial_number text, status text default 'available',
  purchase_date date, purchase_cost numeric, warranty_expires date, last_inspection date, inspection_interval_days integer default 365,
  notes text, created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists public.wh_inspections (
  id uuid primary key default gen_random_uuid(), asset_id uuid, inventory_item_id uuid, item_name text not null, inspection_date date not null,
  inspector_name text, result text default 'passed', next_due date, notes text, created_at timestamptz default now());
create table if not exists public.wh_templates (
  id uuid primary key default gen_random_uuid(), name text not null, name_es text, job_type text, description text, description_es text,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists public.wh_template_items (
  id uuid primary key default gen_random_uuid(), template_id uuid references public.wh_templates(id) on delete cascade, inventory_item_id uuid,
  item_name text not null, item_name_es text, quantity integer default 1, quantity_mode text default 'per_tech', sort_order integer default 0);
create table if not exists public.wh_jobs (
  id uuid primary key default gen_random_uuid(), hcp_job_number text, template_id uuid, job_type text, tech_names text, num_techs integer default 1,
  site_address text, building_client text, vehicle text, scheduled_date date, notes text, attendant_name text, checked_out_by text,
  status text default 'pending', packed_at timestamptz, picked_up_at timestamptz, returned_at timestamptz, qr_code text,
  has_rental boolean default false, rental_type text, rental_notes text, tech_confirmed boolean default false, tech_confirmed_at timestamptz,
  dispatch_verified boolean not null default false, dispatch_verified_at timestamptz, dispatch_verified_by text, dispatch_notes text,
  visit_id uuid, created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists public.wh_job_items (
  id uuid primary key default gen_random_uuid(), job_id uuid references public.wh_jobs(id) on delete cascade, inventory_item_id uuid, asset_id uuid,
  item_name text not null, item_name_es text, quantity integer default 1, confirmed_qty integer, returned_quantity integer,
  return_condition text, return_notes text, is_oneoff boolean default false, is_removed boolean default false, item_dispatch_status text);
create table if not exists public.wh_vehicles (
  id uuid primary key default gen_random_uuid(), name text not null, type text default 'van', make text, model text, year text, plate text,
  notes text, is_active boolean default true, sort_order integer default 0, created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists public.wh_inventory_locations (
  id uuid primary key default gen_random_uuid(), name text not null, type text default 'warehouse', notes text, sort_order integer default 0,
  is_active boolean default true, created_at timestamptz default now());
create table if not exists public.wh_inventory_location_stock (
  inventory_item_id uuid not null, location_id uuid not null, quantity integer default 0, updated_at timestamptz default now(),
  primary key (inventory_item_id, location_id));
create table if not exists public.wh_key_registry (
  id uuid primary key default gen_random_uuid(), name text not null, client text, qty integer default 1, notes text,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists public.wh_client_keys (
  id uuid primary key default gen_random_uuid(), key_tag text not null, client text, job_id uuid, hcp_job_number text, tech_name text,
  quantity integer default 1, status text default 'out', returned boolean default false, checkout_date timestamptz default now(),
  return_date timestamptz, notes text);
create table if not exists public.wh_repair_tickets (
  id uuid primary key default gen_random_uuid(), asset_id uuid, inventory_item_id uuid, item_name text not null, damage_description text,
  reported_by text, reported_date timestamptz default now(), status text default 'reported', repair_shop text, repair_cost numeric,
  estimated_return date, actual_return date, resolved_at timestamptz, notes text, created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists public.wh_reorder_queue (
  id uuid primary key default gen_random_uuid(), inventory_item_id uuid, item_name text not null, quantity_needed integer default 1,
  status text default 'needed', supplier_url text, notes text, ordered_at timestamptz, received_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists public.wh_di_pairs (
  id text primary key, status text default 'stock', vehicle text, resin text, date_received date, deployed_at timestamptz, retired_at timestamptz,
  last_ppm integer, last_read timestamptz, move_history jsonb default '[]'::jsonb, notes text, created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists public.wh_di_readings (
  id uuid primary key default gen_random_uuid(), pair_id text, ppm integer not null, tech_name text, vehicle text, alert boolean default false,
  notes text, "timestamp" timestamptz default now());
create table if not exists public.wh_grab_requests (
  id text primary key, tech_name text, job text, reason text, note text, items jsonb default '[]'::jsonb, status text default 'pending',
  acknowledged boolean default false, "timestamp" timestamptz default now());
create table if not exists public.wh_template_requests (
  id text primary key, type text default 'template_change', job_id text, job_num text, job_type text, requested_by text,
  items jsonb default '[]'::jsonb, note text, status text default 'pending', "timestamp" timestamptz default now());

create index if not exists wh_jobs_jobno_idx on public.wh_jobs(hcp_job_number);
create index if not exists wh_job_items_job_idx on public.wh_job_items(job_id);
create index if not exists wh_template_items_tpl_idx on public.wh_template_items(template_id);

do $$ declare t text; begin
  foreach t in array array['wh_app_settings','wh_categories','wh_inventory_items','wh_assets','wh_inspections','wh_templates','wh_template_items',
    'wh_jobs','wh_job_items','wh_vehicles','wh_inventory_locations','wh_inventory_location_stock','wh_key_registry','wh_client_keys',
    'wh_repair_tickets','wh_reorder_queue','wh_di_pairs','wh_di_readings','wh_grab_requests','wh_template_requests'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t||'_all', t);
    execute format('create policy %I on public.%I for all using (public.can_warehouse()) with check (public.can_warehouse())', t||'_all', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- the schedule feed: the warehouse page uses the same sign-in as the CRM now
create or replace function public.warehouse_jobs(p_days int default 14) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.can_warehouse()) then
    raise exception 'This login is not set up for the warehouse. Add it in the CRM: Settings → Warehouse.';
  end if;
  return coalesce((
    select jsonb_agg(x order by x->>'visit_date', x->>'start_time') from (
      select jsonb_build_object(
        'id', v.id, 'job_no', coalesce(v.job_no, p.hcp_job), 'num', v.num,
        'visit_date', v.visit_date, 'end_date', v.end_date, 'start_time', v.start_time, 'skip_weekends', v.skip_weekends,
        'client', coalesce(p.client, v.client), 'property', p.property,
        'address', coalesce(nullif(v.address,''), nullif(p.site_address,''), p.property),
        'techs', v.techs, 'work', v.work, 'equipment', v.equipment, 'vehicle', v.vehicle, 'notes', v.notes,
        'scope', public.pfbs_scope(p.items, p.pricing_option)
      ) x
      from public.visits v left join public.proposals p on p.num = v.num
      where v.kind = 'job' and v.status = 'Scheduled'
        and coalesce(v.end_date, v.visit_date) >= current_date - 1
        and v.visit_date <= current_date + greatest(1, least(coalesce(p_days, 14), 60))
    ) q), '[]'::jsonb);
end $$;
revoke execute on function public.warehouse_jobs(int) from public, anon, authenticated;
grant execute on function public.warehouse_jobs(int) to authenticated;

notify pgrst, 'reload schema';
