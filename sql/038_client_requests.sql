-- =====================================================================
-- PFBS Proposal Desk — update 038: client requests on the job, printed for the crew
--   • proposals.client_requests: what the client asked for before the job ("suite 3979 first, between 6 and 11 PM"),
--     [{id, text, from, at, by, doneAt, doneBy}]. Open ones (no doneAt) print in a red box on page 1 of the job packet.
--   • warehouse_jobs(days) also sends "requests" (open ones only) and "site_notes" (the building's notes from the
--     client page), so the packet the Warehouse prints has them too. Never prices.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 037 first.
-- =====================================================================
do $$ begin
  if to_regclass('public.job_materials_used') is null then
    raise exception 'Run updates 007 to 037 first, then run this one again.';
  end if;
end $$;

alter table public.proposals add column if not exists client_requests jsonb not null default '[]'::jsonb;

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
        'rentals', public.pfbs_rentals(p.parts, p.items),
        'requests', coalesce((select jsonb_agg(jsonb_build_object('text', r->>'text', 'from', r->>'from'))
                                from jsonb_array_elements(case when jsonb_typeof(p.client_requests) = 'array' then p.client_requests else '[]'::jsonb end) r
                               where coalesce(r->>'doneAt', '') = '' and coalesce(r->>'text', '') <> ''), '[]'::jsonb),
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

notify pgrst, 'reload schema';
