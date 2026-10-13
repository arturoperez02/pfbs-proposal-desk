-- =====================================================================
-- PFBS Proposal Desk — update 028: paid HousecallPro invoices as history
--   • import_hcp_paid_invoices: brings HousecallPro's paid invoices in as a record (Settings → Invoicing, same import
--     as the open ones). They are marked paid, keep their HCP job #, and are NOT linked to CRM jobs, so they never
--     change a job's status, its date paid or commission, and never count as money owed or collected.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 027 first.
-- =====================================================================
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'visits' and column_name = 'ext_id') then
    raise exception 'Run updates 007 to 027 first, then run this one again.';
  end if;
end $$;

-- payload: {"invoices":[{inv_no, customer, amount, job_no, sent_on}]}  (amount = the invoice total, when known)
create or replace function public.import_hcp_paid_invoices(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x jsonb; n_new int := 0; n_skip int := 0; no bigint; amt numeric; cl public.clients; d date; vid uuid; jn text; mx bigint;
begin
  if coalesce(public.my_role(),'') not in ('Owner','Admin') then raise exception 'Only the owner or admin can import invoices.'; end if;
  for x in select * from jsonb_array_elements(coalesce(payload->'invoices','[]'::jsonb)) loop
    no := nullif(regexp_replace(coalesce(x->>'inv_no',''), '\D', '', 'g'), '')::bigint;
    if no is null or exists (select 1 from public.invoices where inv_no = no) then n_skip := n_skip + 1; continue; end if;
    amt := nullif(regexp_replace(coalesce(x->>'amount',''), '[^0-9.\-]', '', 'g'), '')::numeric;
    jn := nullif(regexp_replace(coalesce(x->>'job_no',''), '\D', '', 'g'), '');
    d := coalesce(nullif(left(coalesce(x->>'sent_on',''), 10), '')::date, current_date);
    select * into cl from public.clients c where lower(c.name) = lower(trim(x->>'customer')) or lower(trim(x->>'customer')) = any (select lower(a) from unnest(c.aliases) a) limit 1;
    insert into public.invoices(inv_no, num, job_no, status, invoice_date, terms_days, bill_to, items, message, sent_at, source)
    values (no, null, jn, 'Paid', d, 30,
            jsonb_build_object('name', coalesce(cl.name, x->>'customer'), 'address', coalesce(cl.billing_address, ''), 'email', coalesce(cl.billing_email, '')),
            jsonb_build_array(jsonb_build_object('description', 'HousecallPro invoice #' || no || coalesce(' (job #' || jn || ')', '') || ', paid in HousecallPro', 'notes', '', 'amount', coalesce(amt, 0))),
            '', d::timestamptz, 'hcp')
    returning id into vid;
    if coalesce(amt, 0) > 0 then
      perform set_config('pfbs.paying', '1', true);
      update public.invoices set paid = total where id = vid;
      perform set_config('pfbs.paying', '', true);
    end if;
    n_new := n_new + 1;
  end loop;
  select coalesce(max(inv_no),0) into mx from public.invoices;
  if (select case when is_called then last_value + 1 else last_value end from public.invoice_no_seq) <= mx then perform setval('public.invoice_no_seq', mx + 1, false); end if;
  insert into public.admin_log(by_name, area, item, new_value) values (public.my_name(), 'Invoicing', 'Imported paid HousecallPro invoices (history)', n_new || ' imported, ' || n_skip || ' skipped');
  return jsonb_build_object('imported', n_new, 'skipped', n_skip, 'next_invoice_no', public.next_invoice_no());
end $$;
revoke execute on function public.import_hcp_paid_invoices(jsonb) from public, anon, authenticated;
grant execute on function public.import_hcp_paid_invoices(jsonb) to authenticated;

notify pgrst, 'reload schema';
