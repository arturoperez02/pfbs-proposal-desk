-- =====================================================================
-- PFBS Proposal Desk — update 008: photos on proposals
--   • proposals.photos: the photos that print on the client PDF ({path, caption})
--   • a private storage bucket "proposal-photos" (files live at <PFBS #>/<file>.jpg)
--   • only signed-in team members who can see the proposal can see its photos
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- =====================================================================

alter table public.proposals add column if not exists photos jsonb not null default '[]'::jsonb;

insert into storage.buckets (id, name, public)
values ('proposal-photos', 'proposal-photos', false)
on conflict (id) do nothing;

drop policy if exists "pfbs photos read"   on storage.objects;
drop policy if exists "pfbs photos add"    on storage.objects;
drop policy if exists "pfbs photos remove" on storage.objects;

-- see a photo if you can see its proposal (the proposals table's own rules apply inside this check)
create policy "pfbs photos read" on storage.objects for select to authenticated using (
  bucket_id = 'proposal-photos'
  and exists (select 1 from public.proposals p where p.num = (storage.foldername(name))[1])
);
-- add a photo to a proposal you can see, if you are on the team
create policy "pfbs photos add" on storage.objects for insert to authenticated with check (
  bucket_id = 'proposal-photos'
  and public.my_role() is not null
  and exists (select 1 from public.proposals p where p.num = (storage.foldername(name))[1])
);
-- remove: managers, or whoever uploaded it
create policy "pfbs photos remove" on storage.objects for delete to authenticated using (
  bucket_id = 'proposal-photos'
  and (public.is_manager() or owner = auth.uid())
);

notify pgrst, 'reload schema';
