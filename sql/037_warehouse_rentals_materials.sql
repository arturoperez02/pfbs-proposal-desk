-- =====================================================================
-- PFBS Proposal Desk — update 037: lifts are run from the CRM, the warehouse only sees them; materials used go back to the job
--   • warehouse_rentals(): the lifts / rentals on open jobs (job #, client, site, lift, step, delivery / off-rent dates,
--     rental company, reservation #; never costs). The Warehouse Rentals tab and dashboard show this, view only.
--     The CRM job (Job tab → Parts & rentals) stays the one place where a lift's step changes.
--   • job_materials_used: when a kit comes back, the warehouse records what went out and what came back
--     (one row per kit, updated if the return is redone). The CRM job's actual materials cost uses it.
--   • warehouse_record_used(kit, visit, job #, items): the warehouse's only way to write it (finds the job by visit or job #).
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 036 first.
-- =====================================================================
do $$ begin
  if to_regclass('public.feedback') is null then
    raise exception 'Run updates 007 to 036 first, then run this one again.';
  end if;
end $$;

create or replace function public.warehouse_rentals() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_warehouse() then raise exception 'This login is not set up for the warehouse.'; end if;
  return coalesce((
    select jsonb_agg(x order by x->>'next_visit' nulls last, x->>'num') from (
      select jsonb_build_object(
        'num', p.num, 'job_no', p.hcp_job, 'status', p.status,
        'client', coalesce(p.client, ''), 'property', coalesce(p.property, ''),
        'address', coalesce(nullif(p.site_address, ''), p.property, ''),
        'next_visit', (select min(v.visit_date) from public.visits v where v.num = p.num and v.status = 'Scheduled' and coalesce(v.end_date, v.visit_date) >= current_date),
        'last_visit', (select max(coalesce(v.end_date, v.visit_date)) from public.visits v where v.num = p.num),
        'rentals', case when exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p.parts) = 'array' then p.parts else '[]'::jsonb end) r where r->>'kind' = 'rental')
          then (select jsonb_agg(jsonb_build_object('desc', coalesce(nullif(r->>'desc',''), 'Lift rental'), 'qty', r->>'qty', 'status', coalesce(nullif(r->>'status',''), 'To reserve'),
                     'vendor', r->>'vendor', 'vendorPhone', r->>'vendorPhone', 'reservationNo', r->>'reservationNo', 'offRentNo', r->>'offRentNo',
                     'deliveryDate', r->>'deliveryDate', 'offRentDate', r->>'offRentDate', 'deliveredOn', r->>'deliveredOn', 'pickedUpOn', r->>'pickedUpOn'))
                  from jsonb_array_elements(p.parts) r where r->>'kind' = 'rental')
          when p.status in ('Approved', 'Scheduled') then public.pfbs_rentals(p.parts, p.items)
          else '[]'::jsonb end
      ) x
      from public.proposals p
      where p.status in ('Approved', 'Scheduled', 'Invoiced', 'Paid')
    ) q
    where jsonb_array_length(coalesce(x->'rentals', '[]'::jsonb)) > 0
      and exists (select 1 from jsonb_array_elements(x->'rentals') r
                   where coalesce(r->>'status', 'To reserve') <> 'Picked up'
                      or coalesce(nullif(r->>'pickedUpOn', ''), '1900-01-01')::date >= current_date - 14)
  ), '[]'::jsonb);
end $$;
revoke execute on function public.warehouse_rentals() from public, anon;
grant execute on function public.warehouse_rentals() to authenticated;

create table if not exists public.job_materials_used (
  kit_id      uuid primary key,
  visit_id    uuid,
  num         text,
  job_no      text,
  items       jsonb not null default '[]'::jsonb,   -- [{name, out, back, unit_cost}]
  recorded_at timestamptz not null default now(),
  recorded_by text
);
create index if not exists job_materials_used_num on public.job_materials_used(num);
alter table public.job_materials_used enable row level security;
drop policy if exists jmu_read on public.job_materials_used;
create policy jmu_read on public.job_materials_used for select using (public.my_role() is not null or public.can_warehouse());
grant select on public.job_materials_used to authenticated;

create or replace function public.warehouse_record_used(p_kit uuid, p_visit uuid, p_job_no text, p_items jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare n text; j text := nullif(regexp_replace(coalesce(p_job_no, ''), '^#', ''), '');
begin
  if not public.can_warehouse() then raise exception 'This login is not set up for the warehouse.'; end if;
  if p_kit is null then raise exception 'No kit.'; end if;
  if p_visit is not null then select v.num into n from public.visits v where v.id = p_visit; end if;
  if n is null and j is not null then
    select coalesce((select v.num from public.visits v where v.job_no = j and v.num is not null order by v.visit_date desc limit 1),
                    (select p.num from public.proposals p where p.hcp_job = j order by p.num desc limit 1)) into n;
  end if;
  insert into public.job_materials_used(kit_id, visit_id, num, job_no, items, recorded_by)
  values (p_kit, p_visit, n, j, case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end, coalesce(public.my_name(), public.my_email()))
  on conflict (kit_id) do update set visit_id = excluded.visit_id, num = excluded.num, job_no = excluded.job_no, items = excluded.items,
                                     recorded_at = now(), recorded_by = excluded.recorded_by;
  return n;
end $$;
revoke execute on function public.warehouse_record_used(uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.warehouse_record_used(uuid, uuid, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
