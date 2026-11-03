-- =====================================================================
-- PFBS Proposal Desk — update 043: Admins can add new services to the price book (Arturo 11/3)
--   New job → "Add new services to the price book" only saved for the Owner: Settings can only be changed by the
--   Owner, so when Oscar (Admin) saved a job with a new service it quietly wasn't added.
--   add_price_book(items) adds services (rows [name, price, unit, description]) whose name isn't in the book yet,
--   and nothing else in Settings. Owner or Admin. Logged in Settings → Change log.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice. Needs update 042 first.
-- =====================================================================
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'clients' and column_name = 'merged_into') then
    raise exception 'Run updates 007 to 042 first, then run this one again.';
  end if;
end $$;

create or replace function public.add_price_book(items jsonb, base jsonb default '[]'::jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  who text := coalesce(nullif(public.my_name(),''), 'Office');
  book jsonb; it jsonb; added int := 0; names text := '';
begin
  if coalesce(public.my_role(),'') not in ('Owner','Admin') then raise exception 'Only the owner or admin can add to the price book.'; end if;
  if jsonb_typeof(items) <> 'array' then raise exception 'items must be a list'; end if;
  select coalesce(nullif(data->'priceBook','[]'::jsonb), case when jsonb_typeof(base) = 'array' then base else '[]'::jsonb end, '[]'::jsonb)
    into book from public.settings where id = 1 for update;
  if book is null then raise exception 'Settings are missing.'; end if;
  for it in select * from jsonb_array_elements(items) loop
    continue when jsonb_typeof(it) <> 'array' or coalesce(trim(it->>0),'') = '';
    continue when exists (select 1 from jsonb_array_elements(book) b where lower(trim(b->>0)) = lower(trim(it->>0)));
    book := book || jsonb_build_array(jsonb_build_array(left(trim(it->>0), 200), coalesce(it->1, '""'::jsonb), coalesce(it->>2, ''), coalesce(it->>3, '')));
    added := added + 1; names := names || case when names = '' then '' else ', ' end || trim(it->>0);
  end loop;
  if added > 0 then
    update public.settings set data = jsonb_set(coalesce(data,'{}'::jsonb), '{priceBook}', book), updated_at = now(), updated_by = who where id = 1;
    insert into public.admin_log(by_name, area, item, old_value, new_value) values (who, 'Settings', 'Price book: added ' || added || ' service' || case when added = 1 then '' else 's' end, null, names);
  end if;
  return added;
end $$;
grant execute on function public.add_price_book(jsonb, jsonb) to authenticated;
notify pgrst, 'reload schema';
