-- =====================================================================
-- PFBS Proposal Desk — update 040: field supervisors, client requests on any visit and site maps on the job packet
--   • visits.supervisor: the field supervisor who oversees that visit (only oversees: several jobs the same day is fine,
--     so it never counts as double booked). Supervisors get their own weekly / tomorrow email from the Schedule.
--   • visits.client_request: a client request typed on a visit that has no CRM job (e.g. imported from TechSched).
--     Visits of a CRM job keep their requests on the job (proposals.client_requests, update 038).
--   • warehouse_jobs(days) also sends the supervisor, the visit's own request and the job's site map / photos
--     (path + caption, not the ones unticked for the job packet), so the packet the Warehouse prints has them too. Never prices.
--   • warehouse tablet logins can read the job photos (storage bucket proposal-photos), nothing else.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 039 first.
-- =====================================================================
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'clients' and column_name = 'managed_by') then
    raise exception 'Run updates 007 to 039 first, then run this one again.';
  end if;
end $$;

alter table public.visits add column if not exists supervisor text;
alter table public.visits add column if not exists client_request text;

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
        'supervisor', v.supervisor,
        'scope', public.pfbs_scope(p.items, p.pricing_option),
        'materials', public.pfbs_materials(p.items, p.pricing_option),
        'rentals', public.pfbs_rentals(p.parts, p.items),
        'requests', (select coalesce(jsonb_agg(rq), '[]'::jsonb) from (
                       select jsonb_build_object('text', trim(v.client_request), 'from', null) rq where coalesce(trim(v.client_request), '') <> ''
                       union all
                       select jsonb_build_object('text', r->>'text', 'from', r->>'from')
                         from jsonb_array_elements(case when jsonb_typeof(p.client_requests) = 'array' then p.client_requests else '[]'::jsonb end) r
                        where coalesce(r->>'doneAt', '') = '' and coalesce(r->>'text', '') <> ''
                     ) rr),
        'photos', coalesce((select jsonb_agg(jsonb_build_object('path', ph->>'path', 'caption', ph->>'caption'))
                              from jsonb_array_elements(case when jsonb_typeof(p.photos) = 'array' then p.photos else '[]'::jsonb end) ph
                             where coalesce(ph->>'path', '') <> '' and coalesce(ph->>'crew', 'true') <> 'false'), '[]'::jsonb),
        'site_notes', (select pr.notes from public.properties pr where pr.id = p.property_id)
      ) x
      from public.visits v left join public.proposals p on p.num = v.num
      where v.kind = 'job' and v.status = 'Scheduled'
        and coalesce(v.end_date, v.visit_date) >= current_date - 1
        and v.visit_date <= current_date + greatest(1, least(coalesce(p_days, 14), 60))
    ) q), '[]'::jsonb);
end $$;
revoke execute on function public.warehouse_jobs(int) from public, anon, authenticated;
grant execute on function public.warehouse_jobs(int) to authenticated;

-- the warehouse tablet prints the job packet, which now has the site map / photos
drop policy if exists "pfbs photos warehouse" on storage.objects;
create policy "pfbs photos warehouse" on storage.objects for select to authenticated using (
  bucket_id = 'proposal-photos' and public.can_warehouse()
);

notify pgrst, 'reload schema';
