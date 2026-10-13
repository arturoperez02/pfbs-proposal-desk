-- =====================================================================
-- PFBS Proposal Desk — update 018: invoicing
--   • proposals: billing (AP) email, PO#, "client requires a PO#"
--   • invoices: numbered invoices built from the job, never deleted (void instead)
--   • invoice_payments: checks / ACH / cash, partial payments, never deleted (void instead)
--   • an invoice paid in full marks the job Paid with its Date paid (commission starts)
--   • sending an invoice moves an approved/scheduled job to Invoiced
--   • next_invoice_no / set_next_invoice_no: continue numbering from HousecallPro
--   • backups include invoices and payments
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run twice.
-- Needs update 017 first.
-- =====================================================================
do $$ begin
  if to_regclass('public.service_reports') is null then
    raise exception 'Run updates 007 to 017 first, then run this one again.';
  end if;
end $$;

-- ---------- billing details on the job --------------------------------
alter table public.proposals
  add column if not exists billing_email text,
  add column if not exists po_number     text,
  add column if not exists po_required   boolean not null default false;

-- ---------- invoices ---------------------------------------------------
create sequence if not exists public.invoice_no_seq start 1;

create table if not exists public.invoices (
  id              uuid primary key default gen_random_uuid(),
  inv_no          bigint not null unique default nextval('public.invoice_no_seq'),
  num             text references public.proposals(num) on update cascade on delete set null,
  job_no          text,
  status          text not null default 'Draft' check (status in ('Draft','Sent','Paid','Void')),
  invoice_date    date not null default current_date,
  service_date    date,
  terms_days      int  not null default 30 check (terms_days between 0 and 365),
  due_date        date generated always as (invoice_date + terms_days) stored,
  po_number       text,
  bill_to         jsonb not null default '{}'::jsonb,   -- {name, address, email}
  service_address text,
  items           jsonb not null default '[]'::jsonb,   -- [{description, notes, amount}]
  total           numeric(12,2) not null default 0,
  paid            numeric(12,2) not null default 0,
  message         text,
  sent_at         timestamptz,
  sent_to         text,
  void_reason     text,
  created_at      timestamptz not null default now(),
  created_by      text,
  updated_at      timestamptz not null default now(),
  updated_by      text
);
create index if not exists invoices_num_idx    on public.invoices(num);
create index if not exists invoices_status_idx on public.invoices(status, due_date);

create table if not exists public.invoice_payments (
  id            bigserial primary key,
  invoice_id    uuid not null references public.invoices(id) on delete restrict,
  amount        numeric(12,2) not null check (amount > 0),
  method        text not null default 'Check' check (method in ('Check','ACH','Cash','Card','Other')),
  received_on   date not null default current_date,
  deposited_on  date,
  note          text,
  voided        boolean not null default false,
  void_reason   text,
  voided_by     text,
  voided_at     timestamptz,
  recorded_by   text,
  recorded_at   timestamptz not null default now()
);
create index if not exists invoice_payments_inv_idx on public.invoice_payments(invoice_id);

-- totals, stamps, and what an invoice change does to its job
create or replace function public.invoices_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := coalesce(nullif(public.my_name(),''), 'Office');
begin
  new.total := coalesce((select sum(coalesce(nullif(x->>'amount','')::numeric, 0)) from jsonb_array_elements(coalesce(new.items,'[]'::jsonb)) x), 0);
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, who); new.created_at := now(); new.paid := 0; end if;
  if tg_op = 'UPDATE' then
    if coalesce(current_setting('pfbs.paying', true),'') <> '1' then new.paid := old.paid; end if;   -- only payments change what was paid
    if old.status = 'Void' and new.status <> 'Void' then raise exception 'A void invoice cannot be reopened. Create a new invoice.'; end if;
    if new.status = 'Void' and old.status <> 'Void' then
      if old.paid > 0 then raise exception 'This invoice has payments. Void the payments first.'; end if;
      if coalesce(trim(new.void_reason),'') = '' then raise exception 'Give a reason for voiding the invoice.'; end if;
    end if;
    if new.status = 'Sent' and old.status = 'Draft' then new.sent_at := coalesce(new.sent_at, now()); end if;
    if new.status in ('Sent','Paid') then new.status := case when new.paid >= new.total and new.total > 0 then 'Paid' else 'Sent' end; end if;
  end if;
  new.updated_by := who; new.updated_at := now();
  return new;
end $$;
drop trigger if exists invoices_stamp on public.invoices;
create trigger invoices_stamp before insert or update on public.invoices for each row execute function public.invoices_stamp();

create or replace function public.invoices_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := coalesce(nullif(public.my_name(),''), 'Office');
begin
  if new.num is null then return new; end if;
  if tg_op = 'INSERT' then
    insert into public.proposal_activity(num, by_name, kind, note) values (new.num, who, 'note', 'Invoice #' || new.inv_no || ' created: $' || to_char(new.total, 'FM999,999,990.00'));
  elsif new.status is distinct from old.status then
    insert into public.proposal_activity(num, by_name, kind, note) values (new.num, who, 'note',
      'Invoice #' || new.inv_no || case new.status when 'Sent' then ' sent' || coalesce(' to ' || nullif(new.sent_to,''), '')
                                                   when 'Paid' then ' paid in full'
                                                   when 'Void' then ' voided: ' || coalesce(new.void_reason,'')
                                                   else ' is ' || new.status end);
  end if;
  if new.status = 'Sent' and (tg_op = 'INSERT' or old.status = 'Draft') then
    update public.proposals set status = 'Invoiced' where num = new.num and status in ('Approved','Scheduled');
  end if;
  if new.status = 'Paid' and (tg_op = 'INSERT' or old.status <> 'Paid') then
    update public.proposals
       set status = 'Paid',
           date_paid = coalesce(date_paid, (select max(received_on) from public.invoice_payments where invoice_id = new.id and not voided), current_date)
     where num = new.num and status in ('Approved','Scheduled','Invoiced');
  end if;
  return new;
end $$;
drop trigger if exists invoices_after on public.invoices;
create trigger invoices_after after insert or update on public.invoices for each row execute function public.invoices_after();

-- payments: recorded once, never edited (only voided), and they keep the invoice's paid amount right
create or replace function public.invoice_payments_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := coalesce(nullif(public.my_name(),''), 'Office'); st text;
begin
  if tg_op = 'INSERT' then
    select status into st from public.invoices where id = new.invoice_id;
    if st is null then raise exception 'Invoice not found.'; end if;
    if st = 'Void' then raise exception 'That invoice is void.'; end if;
    new.recorded_by := who; new.recorded_at := now(); new.voided := false; new.void_reason := null; new.voided_by := null; new.voided_at := null;
    return new;
  end if;
  if old.voided then raise exception 'This payment is already void.'; end if;
  if new.amount <> old.amount or new.invoice_id <> old.invoice_id or new.method <> old.method or new.received_on <> old.received_on then
    raise exception 'Payments cannot be edited. Void it and record it again.';
  end if;
  if new.voided then
    if coalesce(trim(new.void_reason),'') = '' then raise exception 'Give a reason for voiding the payment.'; end if;
    new.voided_by := who; new.voided_at := now();
  end if;
  new.recorded_by := old.recorded_by; new.recorded_at := old.recorded_at;
  return new;
end $$;
drop trigger if exists invoice_payments_guard on public.invoice_payments;
create trigger invoice_payments_guard before insert or update on public.invoice_payments for each row execute function public.invoice_payments_guard();

create or replace function public.invoice_payments_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare inv public.invoices; total_paid numeric; who text := coalesce(nullif(public.my_name(),''), 'Office');
begin
  select coalesce(sum(amount),0) into total_paid from public.invoice_payments where invoice_id = new.invoice_id and not voided;
  perform set_config('pfbs.paying', '1', true);   -- lets this update change 'paid' (normal edits cannot)
  update public.invoices set paid = total_paid,
         status = case when status = 'Void' then 'Void' when total_paid >= total and total > 0 then 'Paid' else (case when status = 'Draft' and total_paid = 0 then 'Draft' else 'Sent' end) end,
         sent_at = case when status = 'Draft' and total_paid > 0 then coalesce(sent_at, now()) else sent_at end,
         updated_by = who, updated_at = now()
   where id = new.invoice_id returning * into inv;
  perform set_config('pfbs.paying', '', true);
  if inv.num is not null then
    insert into public.proposal_activity(num, by_name, kind, note) values (inv.num, who, 'note',
      case when tg_op = 'INSERT'
           then 'Payment recorded on invoice #' || inv.inv_no || ': $' || to_char(new.amount, 'FM999,999,990.00') || ' (' || new.method || ', received ' || to_char(new.received_on, 'MM/DD/YY') || ')'
                || case when inv.paid < inv.total then ' · balance $' || to_char(inv.total - inv.paid, 'FM999,999,990.00') else '' end
           else 'Payment of $' || to_char(new.amount, 'FM999,999,990.00') || ' on invoice #' || inv.inv_no || ' voided: ' || coalesce(new.void_reason,'') end);
  end if;
  return new;
end $$;
drop trigger if exists invoice_payments_after on public.invoice_payments;
create trigger invoice_payments_after after insert or update on public.invoice_payments for each row execute function public.invoice_payments_after();

-- ---------- who can see and do what ------------------------------------
alter table public.invoices enable row level security;
alter table public.invoice_payments enable row level security;
drop policy if exists inv_read on public.invoices;   drop policy if exists inv_insert on public.invoices;   drop policy if exists inv_update on public.invoices;
drop policy if exists pay_read on public.invoice_payments; drop policy if exists pay_insert on public.invoice_payments; drop policy if exists pay_update on public.invoice_payments;
create policy inv_read   on public.invoices for select using (public.is_manager());
create policy inv_insert on public.invoices for insert with check (public.is_manager());
create policy inv_update on public.invoices for update using (public.is_manager()) with check (public.is_manager());
create policy pay_read   on public.invoice_payments for select using (public.is_manager());
create policy pay_insert on public.invoice_payments for insert with check (public.is_manager());
create policy pay_update on public.invoice_payments for update using (public.is_manager()) with check (public.is_manager());
grant select, insert, update on public.invoices, public.invoice_payments to authenticated;   -- no delete: void instead
grant usage on sequence public.invoice_no_seq, public.invoice_payments_id_seq to authenticated;
revoke all on public.invoices, public.invoice_payments from anon;

-- ---------- invoice numbering (continue from HousecallPro) --------------
create or replace function public.next_invoice_no() returns bigint
language sql stable security definer set search_path = public as $$
  select case when is_called then last_value + 1 else last_value end from public.invoice_no_seq
$$;
create or replace function public.set_next_invoice_no(n bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare mx bigint;
begin
  if coalesce(public.my_role(),'') not in ('Owner','Admin') then raise exception 'Only the owner or admin can change invoice numbering.'; end if;
  select coalesce(max(inv_no),0) into mx from public.invoices;
  if n is null or n <= mx then raise exception 'The next invoice # must be higher than % (the last one used).', mx; end if;
  perform setval('public.invoice_no_seq', n, false);
  insert into public.admin_log(by_name, area, item, new_value) values (public.my_name(), 'Settings', 'Next invoice #', n::text);
  return n;
end $$;

-- ---------- backups include invoices ------------------------------------
create or replace function public.backup_json() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'app', 'PFBS Proposal Desk', 'exported_at', now(),
    'proposals',          coalesce((select jsonb_agg(to_jsonb(x) order by x.num) from public.proposals x), '[]'),
    'proposal_activity',  coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.proposal_activity x), '[]'),
    'prospects',          coalesce((select jsonb_agg(to_jsonb(x)) from public.prospects x), '[]'),
    'team_members',       coalesce((select jsonb_agg(to_jsonb(x)) from public.team_members x), '[]'),
    'settings',           coalesce((select jsonb_agg(to_jsonb(x)) from public.settings x), '[]'),
    'commission_payouts', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.commission_payouts x), '[]'),
    'admin_log',          coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.admin_log x), '[]'),
    'deleted_proposals',  coalesce((select jsonb_agg(to_jsonb(x)) from public.deleted_proposals x), '[]'),
    'invoices',           coalesce((select jsonb_agg(to_jsonb(x) order by x.inv_no) from public.invoices x), '[]'),
    'invoice_payments',   coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.invoice_payments x), '[]'),
    'service_reports',    coalesce((select jsonb_agg(to_jsonb(x) - 'doc' || jsonb_build_object('doc', x.doc - '_raw')) from public.service_reports x), '[]'))
$$;

revoke execute on function public.invoices_stamp(), public.invoices_after(), public.invoice_payments_guard(), public.invoice_payments_after(),
  public.next_invoice_no(), public.set_next_invoice_no(bigint), public.backup_json() from public, anon, authenticated;
grant execute on function public.next_invoice_no(), public.set_next_invoice_no(bigint) to authenticated;

notify pgrst, 'reload schema';
