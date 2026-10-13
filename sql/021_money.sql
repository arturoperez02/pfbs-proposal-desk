-- =====================================================================
-- PFBS Proposal Desk — update 021: money (accountant)
--   • new team role "Accountant": sees and works invoices and payments (and clients); not proposals,
--     estimates or commission
--   • invoices remember where they came from (CRM or HousecallPro)
--   • import_hcp_invoices: brings the open HousecallPro invoices in on switch-over day (Settings → Invoicing)
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 020 first.
-- =====================================================================
do $$ begin
  if to_regclass('public.visits') is null then
    raise exception 'Run updates 007 to 020 first, then run this one again.';
  end if;
end $$;

-- the Accountant role
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'public.team_members'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%role%' loop
    execute format('alter table public.team_members drop constraint %I', c);
  end loop;
end $$;
alter table public.team_members add constraint team_members_role_check
  check (role in ('Owner','Admin','Senior Estimator','Estimator','BD Rep','Accountant'));

create or replace function public.can_money() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_manager() or coalesce(public.my_role(),'') = 'Accountant'
$$;
grant execute on function public.can_money() to authenticated;

drop policy if exists inv_read on public.invoices;   drop policy if exists inv_insert on public.invoices;   drop policy if exists inv_update on public.invoices;
drop policy if exists pay_read on public.invoice_payments; drop policy if exists pay_insert on public.invoice_payments; drop policy if exists pay_update on public.invoice_payments;
create policy inv_read   on public.invoices for select using (public.can_money());
create policy inv_insert on public.invoices for insert with check (public.can_money());
create policy inv_update on public.invoices for update using (public.can_money()) with check (public.can_money());
create policy pay_read   on public.invoice_payments for select using (public.can_money());
create policy pay_insert on public.invoice_payments for insert with check (public.can_money());
create policy pay_update on public.invoice_payments for update using (public.can_money()) with check (public.can_money());

alter table public.invoices add column if not exists source text not null default 'crm';

-- ---------- open HousecallPro invoices → CRM (switch-over day) ----------
-- payload: {"invoices":[{inv_no, customer, amount_due, due_date, job_no, sent_on}]}
create or replace function public.import_hcp_invoices(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x jsonb; n_new int := 0; n_skip int := 0; n_linked int := 0; pnum text; no bigint; cl public.clients; due date; amt numeric; mx bigint;
begin
  if coalesce(public.my_role(),'') not in ('Owner','Admin') then raise exception 'Only the owner or admin can import invoices.'; end if;
  for x in select * from jsonb_array_elements(coalesce(payload->'invoices','[]'::jsonb)) loop
    no := nullif(regexp_replace(coalesce(x->>'inv_no',''), '\D', '', 'g'), '')::bigint;
    amt := nullif(regexp_replace(coalesce(x->>'amount_due',''), '[^0-9.\-]', '', 'g'), '')::numeric;
    if no is null or amt is null or amt <= 0 then n_skip := n_skip + 1; continue; end if;
    if exists (select 1 from public.invoices where inv_no = no) then n_skip := n_skip + 1; continue; end if;
    pnum := null;
    if coalesce(x->>'job_no','') <> '' then select num into pnum from public.proposals where hcp_job = regexp_replace(x->>'job_no', '\D', '', 'g') order by num desc limit 1; end if;
    select * into cl from public.clients c where lower(c.name) = lower(trim(x->>'customer')) or lower(trim(x->>'customer')) = any (select lower(a) from unnest(c.aliases) a) limit 1;
    due := nullif(left(coalesce(x->>'due_date',''), 10), '')::date;
    insert into public.invoices(inv_no, num, job_no, status, invoice_date, terms_days, bill_to, items, message, sent_at, source)
    values (no, pnum, nullif(regexp_replace(coalesce(x->>'job_no',''), '\D', '', 'g'), ''), 'Draft',
            coalesce(due - 30, current_date), 30,
            jsonb_build_object('name', coalesce(cl.name, x->>'customer'), 'address', coalesce(cl.billing_address, ''), 'email', coalesce(cl.billing_email, '')),
            jsonb_build_array(jsonb_build_object('description', 'Balance carried over from HousecallPro invoice #' || no || coalesce(' (job #' || nullif(x->>'job_no','') || ')', ''), 'notes', '', 'amount', amt)),
            '', coalesce(nullif(left(coalesce(x->>'sent_on',''), 10), '')::date, due - 30)::timestamptz, 'hcp');
    update public.invoices set status = 'Sent' where inv_no = no;
    n_new := n_new + 1; if pnum is not null then n_linked := n_linked + 1; end if;
  end loop;
  select coalesce(max(inv_no),0) into mx from public.invoices;
  if (select case when is_called then last_value + 1 else last_value end from public.invoice_no_seq) <= mx then perform setval('public.invoice_no_seq', mx + 1, false); end if;
  insert into public.admin_log(by_name, area, item, new_value) values (public.my_name(), 'Invoicing', 'Imported open HousecallPro invoices', n_new || ' imported, ' || n_skip || ' skipped');
  return jsonb_build_object('imported', n_new, 'skipped', n_skip, 'linked_to_jobs', n_linked, 'next_invoice_no', public.next_invoice_no());
end $$;
revoke execute on function public.import_hcp_invoices(jsonb) from public, anon, authenticated;
grant execute on function public.import_hcp_invoices(jsonb) to authenticated;

notify pgrst, 'reload schema';
