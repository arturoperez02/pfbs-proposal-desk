-- =====================================================================
-- PFBS Proposal Desk — update 032: the warehouse gets the job's materials
--   • pfbs_materials(items, pick): the materials from the job's pricing (lines the client accepted, with a qty),
--     added up by name, e.g. [{"desc":"WFS Resin Refill","qty":1}]
--   • warehouse_jobs(days) now also sends "materials", so "Import from CRM Schedule" puts them in the kit
--     (one list: the kit slip, no repeating on the job sheet)
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 031 first.
-- (also sends end_time and the job's lifts, so the Warehouse can print the whole job packet)
-- =====================================================================
do $$ begin
  if to_regprocedure('public.set_next_proposal_no(bigint)') is null then
    raise exception 'Run updates 007 to 031 first, then run this one again.';
  end if;
end $$;

create or replace function public.pfbs_materials(items jsonb, pick text) returns jsonb
language sql immutable set search_path = public as $$
  with it as (select i, n from jsonb_array_elements(case when jsonb_typeof(items) = 'array' then items else '[]'::jsonb end) with ordinality t(i, n)),
  grp as (select i->>'group' g, min(n) n from it where coalesce(i->>'type','') <> 'Add-on' and coalesce(i->>'group','') <> '' group by 1),
  chosen as (select g from grp where g = any (string_to_array(coalesce(pick,''), '||'))),
  picked as (select g from chosen union all select g from (select g from grp order by n limit 1) f where not exists (select 1 from chosen)),
  counted as (select i, n from it
     where case when i->>'type' = 'Add-on' then coalesce((i->>'accepted')::boolean, false)
                else coalesce(i->>'group','') = '' or i->>'group' in (select g from picked) end),
  mats as (select trim(m->>'desc') d, case when (m->>'qty') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' then (m->>'qty')::numeric else 0 end q, c.n
             from counted c, jsonb_array_elements(case when jsonb_typeof(c.i->'estimate'->'materials') = 'array' then c.i->'estimate'->'materials' else '[]'::jsonb end) m),
  summed as (select min(d) d, sum(q) q, min(n) n from mats where coalesce(d,'') <> '' and q > 0 group by lower(d))
  select coalesce(jsonb_agg(jsonb_build_object('desc', d, 'qty', q) order by n, d), '[]'::jsonb) from summed
$$;

-- the job's lifts for the job sheet: the ones saved on the job (company, reservation #, dates; never costs),
-- or, if none are saved yet, the lift names from the pricing
create or replace function public.pfbs_rentals(parts jsonb, items jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(
    (select jsonb_agg(jsonb_build_object('desc', r->>'desc', 'vendor', r->>'vendor', 'vendorPhone', r->>'vendorPhone', 'reservationNo', r->>'reservationNo',
                                         'deliveryDate', r->>'deliveryDate', 'offRentDate', r->>'offRentDate', 'status', r->>'status'))
       from jsonb_array_elements(case when jsonb_typeof(parts) = 'array' then parts else '[]'::jsonb end) r where r->>'kind' = 'rental'),
    (select jsonb_agg(jsonb_build_object('desc', coalesce(nullif(r->>'desc',''), 'Lift rental')))
       from jsonb_array_elements(case when jsonb_typeof(items) = 'array' then items else '[]'::jsonb end) i,
            jsonb_array_elements(case when jsonb_typeof(i->'estimate'->'rentals') = 'array' then i->'estimate'->'rentals' else '[]'::jsonb end) r
      where (r->>'qty') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' and (r->>'qty')::numeric > 0),
    '[]'::jsonb)
$$;

create or replace function public.warehouse_jobs(p_days int default 14) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_manager() or exists (select 1 from public.warehouse_logins where email = lower(public.my_email()))) then
    raise exception 'This login is not set up for the warehouse. Add it in the CRM: Settings → Warehouse.';
  end if;
  return coalesce((
    select jsonb_agg(x order by x->>'visit_date', x->>'start_time') from (
      select jsonb_build_object(
        'id', v.id, 'job_no', coalesce(v.job_no, p.hcp_job), 'num', v.num,
        'visit_date', v.visit_date, 'end_date', v.end_date, 'start_time', v.start_time, 'end_time', v.end_time, 'skip_weekends', v.skip_weekends,
        'client', coalesce(p.client, v.client), 'property', p.property,
        'address', coalesce(nullif(v.address,''), nullif(p.site_address,''), p.property),
        'techs', v.techs, 'work', v.work, 'equipment', v.equipment, 'vehicle', v.vehicle, 'notes', v.notes,
        'scope', public.pfbs_scope(p.items, p.pricing_option),
        'materials', public.pfbs_materials(p.items, p.pricing_option),
        'rentals', public.pfbs_rentals(p.parts, p.items)
      ) x
      from public.visits v left join public.proposals p on p.num = v.num
      where v.kind = 'job' and v.status = 'Scheduled'
        and coalesce(v.end_date, v.visit_date) >= current_date - 1
        and v.visit_date <= current_date + greatest(1, least(coalesce(p_days, 14), 60))
    ) q), '[]'::jsonb);
end $$;
revoke execute on function public.warehouse_jobs(int) from public, anon, authenticated;
grant execute on function public.warehouse_jobs(int) to authenticated;
revoke execute on function public.pfbs_materials(jsonb, text) from public, anon;
grant execute on function public.pfbs_materials(jsonb, text) to authenticated;
revoke execute on function public.pfbs_rentals(jsonb, jsonb) from public, anon;
grant execute on function public.pfbs_rentals(jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';
