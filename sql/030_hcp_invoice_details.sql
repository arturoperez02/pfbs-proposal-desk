-- =====================================================================
-- PFBS Proposal Desk — update 030: HousecallPro invoices with their job details
--   • HousecallPro's invoice export has no line items, so the import now takes the job description and address from
--     HCP's Jobs export (matched by job #): "Gutter Cleaning · 2344 Harrison St, Oakland" instead of just a balance
--   • hcp_invoice_details: fills in invoices that were already imported (Settings → Invoicing → Fill in details);
--     open invoices keep their balance; paid history gets its job's amount when it had none
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 029 first.
-- =====================================================================
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'invoices' and column_name = 'reminders') then
    raise exception 'Run updates 007 to 029 first, then run this one again.';
  end if;
end $$;

create or replace function public.hcp_line(no bigint, jn text, descr text, addr text, amt numeric, paid boolean) returns jsonb
language sql immutable as $$
  select jsonb_build_array(jsonb_build_object(
    'description', coalesce(nullif(trim(descr),''), case when paid then 'HousecallPro invoice #' || no || ', paid in HousecallPro' else 'Balance carried over from HousecallPro invoice #' || no end),
    'notes', concat_ws(' · ', nullif(trim(addr),''), 'HousecallPro invoice #' || no || coalesce(', job #' || jn, '') || case when paid then ', paid in HousecallPro' else '' end),
    'amount', coalesce(amt, 0)))
$$;

create or replace function public.import_hcp_invoices(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x jsonb; n_new int := 0; n_skip int := 0; n_linked int := 0; pnum text; no bigint; cl public.clients; due date; amt numeric; mx bigint; jn text;
begin
  if coalesce(public.my_role(),'') not in ('Owner','Admin') then raise exception 'Only the owner or admin can import invoices.'; end if;
  for x in select * from jsonb_array_elements(coalesce(payload->'invoices','[]'::jsonb)) loop
    no := nullif(regexp_replace(coalesce(x->>'inv_no',''), '\D', '', 'g'), '')::bigint;
    amt := nullif(regexp_replace(coalesce(x->>'amount_due',''), '[^0-9.\-]', '', 'g'), '')::numeric;
    if no is null or amt is null or amt <= 0 then n_skip := n_skip + 1; continue; end if;
    if exists (select 1 from public.invoices where inv_no = no) then n_skip := n_skip + 1; continue; end if;
    jn := nullif(regexp_replace(coalesce(x->>'job_no',''), '\D', '', 'g'), '');
    pnum := null;
    if jn is not null then select num into pnum from public.proposals where hcp_job = jn order by num desc limit 1; end if;
    select * into cl from public.clients c where lower(c.name) = lower(trim(x->>'customer')) or lower(trim(x->>'customer')) = any (select lower(a) from unnest(c.aliases) a) limit 1;
    due := nullif(left(coalesce(x->>'due_date',''), 10), '')::date;
    insert into public.invoices(inv_no, num, job_no, status, invoice_date, terms_days, bill_to, items, message, sent_at, source)
    values (no, pnum, jn, 'Draft', coalesce(due - 30, current_date), 30,
            jsonb_build_object('name', coalesce(cl.name, x->>'customer'), 'address', coalesce(cl.billing_address, ''), 'email', coalesce(cl.billing_email, '')),
            public.hcp_line(no, jn, x->>'description', x->>'address', amt, false),
            '', coalesce(nullif(left(coalesce(x->>'sent_on',''), 10), '')::date, due - 30)::timestamptz, 'hcp');
    update public.invoices set status = 'Sent' where inv_no = no;
    n_new := n_new + 1; if pnum is not null then n_linked := n_linked + 1; end if;
  end loop;
  select coalesce(max(inv_no),0) into mx from public.invoices;
  if (select case when is_called then last_value + 1 else last_value end from public.invoice_no_seq) <= mx then perform setval('public.invoice_no_seq', mx + 1, false); end if;
  insert into public.admin_log(by_name, area, item, new_value) values (public.my_name(), 'Invoicing', 'Imported open HousecallPro invoices', n_new || ' imported, ' || n_skip || ' skipped');
  return jsonb_build_object('imported', n_new, 'skipped', n_skip, 'linked_to_jobs', n_linked, 'next_invoice_no', public.next_invoice_no());
end $$;

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
            public.hcp_line(no, jn, x->>'description', x->>'address', amt, true), '', d::timestamptz, 'hcp')
    returning id into vid;
    if coalesce(amt, 0) > 0 then
      perform set_config('pfbs.paying', '1', true); update public.invoices set paid = total where id = vid; perform set_config('pfbs.paying', '', true);
    end if;
    n_new := n_new + 1;
  end loop;
  select coalesce(max(inv_no),0) into mx from public.invoices;
  if (select case when is_called then last_value + 1 else last_value end from public.invoice_no_seq) <= mx then perform setval('public.invoice_no_seq', mx + 1, false); end if;
  insert into public.admin_log(by_name, area, item, new_value) values (public.my_name(), 'Invoicing', 'Imported paid HousecallPro invoices (history)', n_new || ' imported, ' || n_skip || ' skipped');
  return jsonb_build_object('imported', n_new, 'skipped', n_skip, 'next_invoice_no', public.next_invoice_no());
end $$;

-- fill in invoices imported before (payload: {"jobs":[{job_no, description, address, amount}]})
create or replace function public.hcp_invoice_details(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x jsonb; v public.invoices; n int := 0; amt numeric; jn text; keep numeric; is_hist boolean;
begin
  if coalesce(public.my_role(),'') not in ('Owner','Admin') then raise exception 'Only the owner or admin can do this.'; end if;
  for x in select * from jsonb_array_elements(coalesce(payload->'jobs','[]'::jsonb)) loop
    jn := nullif(regexp_replace(coalesce(x->>'job_no',''), '\D', '', 'g'), ''); if jn is null then continue; end if;
    amt := nullif(regexp_replace(coalesce(x->>'amount',''), '[^0-9.\-]', '', 'g'), '')::numeric;
    for v in select * from public.invoices where source = 'hcp' and job_no = jn and status <> 'Void' loop
      is_hist := v.status = 'Paid' and v.num is null;
      keep := case when is_hist and coalesce(v.total,0) = 0 then amt else v.total end;   -- open invoices keep their balance
      update public.invoices set items = public.hcp_line(v.inv_no, jn, x->>'description', x->>'address', keep, is_hist) where id = v.id;
      if is_hist and coalesce(v.total,0) = 0 and coalesce(amt,0) > 0 then
        perform set_config('pfbs.paying', '1', true); update public.invoices set paid = total where id = v.id; perform set_config('pfbs.paying', '', true);
      end if;
      n := n + 1;
    end loop;
  end loop;
  return jsonb_build_object('updated', n);
end $$;

revoke execute on function public.import_hcp_invoices(jsonb), public.import_hcp_paid_invoices(jsonb), public.hcp_invoice_details(jsonb) from public, anon, authenticated;
grant execute on function public.import_hcp_invoices(jsonb), public.import_hcp_paid_invoices(jsonb), public.hcp_invoice_details(jsonb) to authenticated;

notify pgrst, 'reload schema';
