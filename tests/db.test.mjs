// Database tests: runs every sql/ update in order (twice, to prove they are safe to re-run) on an in-memory Postgres,
// then checks the service report functions and permissions. Made-up data only.
import { PGlite } from '@electric-sql/pglite'; import fs from 'fs'; import path from 'path'; import assert from 'node:assert/strict'; import { fileURLToPath } from 'url';
const T = path.dirname(fileURLToPath(import.meta.url)), R = path.join(T, '..', 'sql');
const strip = t => t.replace(/notify pgrst, 'reload schema';/g, '');
const db = new PGlite();
await db.exec(`create schema auth; create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt()->>'sub','')::uuid $$; create role authenticated; create role anon; grant usage on schema public, auth to authenticated, anon;
create schema storage; create table storage.buckets(id text primary key, name text, public boolean); create table storage.objects(id serial, bucket_id text, name text, owner uuid, metadata jsonb); alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;`);
await db.exec(strip(fs.readFileSync(path.join(R, '001_schema.sql'), 'utf8')));
await db.exec(fs.readFileSync(path.join(T, 'fixtures', 'seed.sql'), 'utf8'));
await assert.rejects(db.exec(strip(fs.readFileSync(path.join(R, '017_service_reports.sql'), 'utf8'))), /Run updates 007 to 016 first/, '017 must refuse to run early');
const files = fs.readdirSync(R).filter(f => /^\d{3}_.*\.sql$/.test(f) && f !== '001_schema.sql').sort();
for (const pass of [1, 2]) for (const f of files) { try { await db.exec(strip(fs.readFileSync(path.join(R, f), 'utf8'))); } catch (e) { assert.fail(`${f} (run ${pass}): ${e.message}`); } }
const one = async s => (await db.query(s)).rows[0];
const tok = (await one(`select token from integration_keys`)).token;
const zap = async o => (await one(`select zap_report_job('${JSON.stringify({ token: tok, ...o }).replace(/'/g, "''")}'::jsonb) r`)).r;

await assert.rejects(db.query(`select zap_report_job('{"token":"wrong"}')`), undefined, 'bad token refused');
await db.exec(`update proposals set status='Scheduled', site_address='2150 Webster St\nOakland, CA', hcp_job='60123' where num='PFBS-0775'`);
let r = await zap({ job_id: '9001', street: '100 Main St', notes: 'see PFBS 776' });
assert.equal(r.num, 'PFBS-0776', 'links by PFBS number in the text');
assert.equal((await zap({ job_id: '9001' })).duplicate, true, 'same HCP job twice → one report');
assert.equal((await zap({ job_id: '9002', job_number: '60123' })).num, 'PFBS-0775', 'links by HCP job #');
r = await zap({ job_id: '9003', street: '2150 Webster Street', city: 'Oakland', client: 'Demo Client' });
assert.equal(r.num, 'PFBS-0775'); assert.equal(r.matched_by, 'address', 'links by street address');
assert.equal((await zap({ job_id: '9004', street: '21500 Webster St' })).num, null, 'different house number does not link');
assert.equal((await one(`select count(*)::int c from service_reports where doc->'_raw' ? 'token'`)).c, 0, 'token never stored');

await db.exec(`select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","email":"aperez@pfbuildingservices.com"}',false); set role authenticated;`);
assert.equal((await one(`select count(*)::int c from service_reports`)).c, 4, 'owner sees reports');
assert.deepEqual((await one(`select save_crew_leads('["Rigo"," Baldemar ","","Rigo"]') c`)).c, ['Baldemar', 'Rigo']);
await assert.rejects(db.query(`select * from private_settings`), undefined, 'private settings not readable');
const id = (await one(`select id from service_reports where num='PFBS-0775' limit 1`)).id;
await db.query(`select report_approved('${id}','https://example.test/r')`);
await db.exec('reset role');
assert.ok((await one(`select report_sent_on from proposals where num='PFBS-0775'`)).report_sent_on, 'approving marks the job');
await db.exec(`insert into team_members(email,name,role) values ('e@x.com','Test Est','Estimator') on conflict do nothing;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000002","email":"e@x.com"}',false); set role authenticated;`);
assert.equal((await one(`select count(*)::int c from service_reports`)).c, 0, 'estimators cannot see reports');
await db.exec(`reset role; set role anon; select set_config('request.jwt.claims','{}',false)`);
await assert.rejects(db.query(`select * from service_reports`), undefined, 'anonymous blocked');
console.log(`db: all ${files.length} updates ran twice; service report checks passed`);

// ---------- invoicing (update 018) ----------
{
  const q1 = async s => (await db.query(s)).rows[0];
  await db.exec(`reset role; select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","email":"aperez@pfbuildingservices.com"}',false); set role authenticated;`);
  await db.query(`select set_next_invoice_no(1525)`);
  assert.equal(Number((await q1(`select next_invoice_no() n`)).n), 1525, 'numbering continues from HCP');
  await db.exec(`reset role`); await db.exec(`update proposals set status='Scheduled', date_paid=null where num='PFBS-0778'`);
  await db.exec(`select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","email":"aperez@pfbuildingservices.com"}',false); set role authenticated;`);
  const inv = await q1(`insert into invoices(num, items, bill_to) values ('PFBS-0778', '[{"description":"Window cleaning","amount":1000},{"description":"Lift","amount":"500.50"}]', '{"name":"Demo"}') returning id, inv_no, total, due_date, invoice_date, status`);
  assert.equal(Number(inv.inv_no), 1525); assert.equal(Number(inv.total), 1500.5, 'total from line items'); assert.equal(inv.status, 'Draft');
  assert.equal((inv.due_date - inv.invoice_date) / 864e5, 30, 'Net 30 due date');
  await assert.rejects(db.query(`update invoices set paid = 1500.5 where id='${inv.id}'`).then(async () => { if (Number((await q1(`select paid from invoices where id='${inv.id}'`)).paid) !== 0) throw new Error('paid changed'); throw new Error('ok-no-change'); }), /ok-no-change/, 'paid cannot be typed in');
  await db.query(`update invoices set status='Sent', sent_to='ap@example.com' where id='${inv.id}'`);
  await db.exec('reset role'); assert.equal((await q1(`select status from proposals where num='PFBS-0778'`)).status, 'Invoiced', 'sending moves the job to Invoiced');
  await db.exec(`set role authenticated`);
  await db.query(`insert into invoice_payments(invoice_id, amount, method, received_on) values ('${inv.id}', 1000, 'Check', '2026-10-20')`);
  let i2 = await q1(`select status, paid from invoices where id='${inv.id}'`); assert.equal(i2.status, 'Sent'); assert.equal(Number(i2.paid), 1000, 'partial payment');
  await db.exec('reset role'); assert.equal((await q1(`select status from proposals where num='PFBS-0778'`)).status, 'Invoiced', 'partial does not mark Paid');
  await db.exec(`set role authenticated`);
  await assert.rejects(db.query(`update invoice_payments set amount=5 where invoice_id='${inv.id}'`), /cannot be edited/);
  await assert.rejects(db.query(`delete from invoice_payments where invoice_id='${inv.id}'`), undefined, 'payments cannot be deleted');
  await db.query(`insert into invoice_payments(invoice_id, amount, method, received_on) values ('${inv.id}', 500.50, 'ACH', '2026-10-25')`);
  i2 = await q1(`select status, paid from invoices where id='${inv.id}'`); assert.equal(i2.status, 'Paid');
  await db.exec('reset role'); const pr = await q1(`select status, date_paid from proposals where num='PFBS-0778'`);
  assert.equal(pr.status, 'Paid'); assert.equal(pr.date_paid.toISOString().slice(0, 10), '2026-10-25', 'date paid = last payment received');
  await db.exec(`set role authenticated`);
  await assert.rejects(db.query(`update invoices set status='Void', void_reason='x' where id='${inv.id}'`), /Void the payments first/);
  const pid = (await q1(`select id from invoice_payments where invoice_id='${inv.id}' and amount=500.50`)).id;
  await assert.rejects(db.query(`update invoice_payments set voided=true where id=${pid}`), /reason/);
  await db.query(`update invoice_payments set voided=true, void_reason='bounced' where id=${pid}`);
  i2 = await q1(`select status, paid from invoices where id='${inv.id}'`); assert.equal(i2.status, 'Sent'); assert.equal(Number(i2.paid), 1000, 'void payment reopens balance');
  await assert.rejects(db.query(`delete from invoices where id='${inv.id}'`), undefined, 'invoices cannot be deleted');
  await assert.rejects(db.query(`select set_next_invoice_no(1000)`), /higher than 1525/);
  const n2 = await q1(`insert into invoices(num, items) values ('PFBS-0778','[{"amount":10}]') returning id, inv_no`); assert.equal(Number(n2.inv_no), 1526);
  await db.query(`update invoices set status='Void', void_reason='duplicate' where id='${n2.id}'`);
  await assert.rejects(db.query(`update invoices set status='Draft' where id='${n2.id}'`), /cannot be reopened/);
  await db.exec(`reset role; select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000002","email":"e@x.com"}',false); set role authenticated;`);
  assert.equal((await q1(`select count(*)::int c from invoices`)).c, 0, 'estimators cannot see invoices');
  await db.exec('reset role');
  const bk = await q1(`select backup_json() b`); assert.ok(bk.b.invoices.length === 2 && bk.b.invoice_payments.length === 2, 'backup has invoices');
  console.log('db: invoicing checks passed');
}

// ---------- clients (update 019) ----------
{
  const q1 = async s => (await db.query(s)).rows[0];
  await db.exec('reset role');
  assert.equal((await q1(`select pfbs_addr_key('2150 Webster Street, Oakland, CA') k`)).k, '2150 WEBSTER ST');
  assert.equal((await q1(`select pfbs_addr_key('100 Village Ln.\nFoster City') k`)).k, '100 VILLAGE LN');
  await db.exec(`update proposals set client='Acme Property Group', site_address='100 Test Plaza\nOakland, CA' where num='PFBS-0772'`);
  await db.exec(`select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","email":"aperez@pfbuildingservices.com"}',false); set role authenticated;`);
  const payload = { clients: [
    { name: 'Acme Property Group', aliases: ['Acme Tower'], po_required: true, billing_email: 'ap@acme.example', billing_address: '1 Billing Way\nOakland, CA',
      contacts: [{ name: 'Pat Demo', email: 'pat@acme.example', role: 'Property Manager' }, { name: 'Pat Demo', email: 'PAT@acme.example' }],
      properties: [{ name: 'Acme Tower', address: '100 Test Plaza, Oakland, CA 94612' }, { name: 'Acme Tower', address: '100 Test Plaza' }, { name: 'Annex', address: '200 Test Plaza' }] },
    { name: 'Jo Homeowner', kind: 'Homeowner', contacts: [{ name: 'Jo Homeowner', phone: '5105550000' }], properties: [{ address: '9 Home Ct' }] } ] };
  let r = (await q1(`select import_clients('${JSON.stringify(payload)}'::jsonb) r`)).r;
  assert.deepEqual([r.clients_new, r.clients_updated, r.contacts_new, r.properties_new], [2, 0, 2, 3], 'dedupes contacts by email and properties by address');
  assert.ok(r.proposals_linked_to_client >= 1 && r.proposals_linked_to_property >= 1, 'existing proposals linked');
  r = (await q1(`select import_clients('${JSON.stringify(payload)}'::jsonb) r`)).r;
  assert.deepEqual([r.clients_new, r.clients_updated, r.contacts_new, r.properties_new], [0, 2, 0, 0], 'importing twice adds nothing');
  const c = await q1(`select po_required, billing_email, (select count(*)::int from client_contacts where client_id=c.id and is_primary) prim from clients c where name='Acme Property Group'`);
  assert.equal(c.po_required, true); assert.equal(c.prim, 1, 'one primary contact');
  await assert.rejects(db.query(`insert into clients(name) values ('  acme property group ')`), /unique|duplicate/i, 'no duplicate client names');
  await db.exec(`reset role; select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000002","email":"e@x.com"}',false); set role authenticated;`);
  assert.ok((await q1(`select count(*)::int c from clients`)).c >= 2, 'estimators can see clients');
  await db.query(`insert into clients(name) values ('New From Estimator')`);
  await assert.rejects(db.query(`select import_clients('{}'::jsonb)`), /owner or admin/);
  await assert.rejects(db.query(`delete from clients where name='New From Estimator'`).then(async () => { if ((await q1(`select count(*)::int c from clients where name='New From Estimator'`)).c) throw new Error('kept'); }), /kept/, 'only the owner deletes');
  await db.exec('reset role');
  console.log('db: clients checks passed');
}

// ---------- schedule (update 020) ----------
{
  const q1 = async s => (await db.query(s)).rows[0];
  await db.exec(`reset role; update proposals set status='Approved' where num='PFBS-0779'`);
  await db.exec(`select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","email":"aperez@pfbuildingservices.com"}',false); set role authenticated;`);
  const s = await q1(`insert into visit_series(num, rule, starts) values ('PFBS-0779','{"every":3,"unit":"month","mode":"nth","nth":1,"weekday":2}','2026-11-03') returning id, created_by`);
  assert.equal(s.created_by, 'Arturo');
  await db.query(`insert into visits(num, series_id, occ_date, visit_date, techs) values ('PFBS-0779','${s.id}','2026-11-03','2026-11-03','{Rigo,Baldemar}')`);
  await db.exec('reset role'); assert.equal((await q1(`select status from proposals where num='PFBS-0779'`)).status, 'Scheduled', 'first visit schedules an approved job');
  await assert.rejects(db.query(`insert into visits(visit_date, end_date) values ('2026-11-05','2026-11-04')`), /check/i, 'end after start');
  await db.exec(`select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000002","email":"e@x.com"}',false); set role authenticated;`);
  assert.equal((await q1(`select count(*)::int c from visits`)).c, 1, 'everyone can see the schedule');
  await assert.rejects(db.query(`insert into visits(visit_date) values ('2026-11-10')`), /row-level security|policy/i, 'only the office schedules');
  await db.exec('reset role');
  assert.equal((await q1(`select jsonb_array_length(backup_json()->'visits') n`)).n, 1);
  console.log('db: schedule checks passed');
}

// ---------- money (update 021) ----------
{
  const q1 = async s => (await db.query(s)).rows[0];
  await db.exec(`reset role; update proposals set hcp_job='10155', status='Invoiced' where num='PFBS-0780'; insert into team_members(email,name,role) values ('acct@x.com','Book Keeper','Accountant') on conflict do nothing;`);
  await db.exec(`select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","email":"aperez@pfbuildingservices.com"}',false); set role authenticated;`);
  const pl = { invoices: [{ inv_no: '1500', customer: 'Acme Property Group', amount_due: '$720.00', due_date: '2026-09-09 12:00:00 -0700', job_no: '10155' }, { inv_no: '1501', customer: 'Nobody', amount_due: '$0.00' }, { inv_no: '1502', customer: 'Someone New', amount_due: '1,200.50', due_date: '2026-11-05' }] };
  let r = (await q1(`select import_hcp_invoices('${JSON.stringify(pl)}'::jsonb) r`)).r;
  assert.deepEqual([r.imported, r.skipped, r.linked_to_jobs], [2, 1, 1]);
  r = (await q1(`select import_hcp_invoices('${JSON.stringify(pl)}'::jsonb) r`)).r; assert.equal(r.imported, 0, 'importing twice adds nothing');
  const i = await q1(`select status, total, due_date, source, num, bill_to->>'name' n from invoices where inv_no=1500`);
  assert.deepEqual([i.status, Number(i.total), i.due_date.toISOString().slice(0, 10), i.source, i.num, i.n], ['Sent', 720, '2026-09-09', 'hcp', 'PFBS-0780', 'Acme Property Group']);
  assert.ok(Number((await q1(`select next_invoice_no() n`)).n) > 1526, 'numbering stays ahead of imported numbers');
  await db.exec(`reset role; select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000003","email":"acct@x.com"}',false); set role authenticated;`);
  assert.ok((await q1(`select count(*)::int c from invoices`)).c >= 3, 'accountant sees invoices');
  assert.equal(await db.query(`select count(*)::int c from proposals`).then(r => r.rows[0].c, () => 0), 0, 'accountant does not see proposals');
  const id = (await q1(`select id from invoices where inv_no=1500`)).id;
  await db.query(`insert into invoice_payments(invoice_id, amount, method, received_on) values ('${id}', 720, 'Check', '2026-10-01')`);
  assert.equal((await q1(`select status from invoices where inv_no=1500`)).status, 'Paid', 'accountant records payments');
  await assert.rejects(db.query(`select import_hcp_invoices('{}'::jsonb)`), /owner or admin/);
  await db.exec('reset role');
  console.log('db: money checks passed');
}

// ---------- job numbers, invoices close visits, property contacts (update 022) ----------
{
  const q1 = async s => (await db.query(s)).rows[0];
  await db.exec(`reset role; update proposals set hcp_job='10200', status='Scheduled' where num='PFBS-0781'`);
  await db.exec(`select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","email":"aperez@pfbuildingservices.com"}',false); set role authenticated;`);
  let v = await q1(`insert into visits(num, visit_date) values ('PFBS-0781','2026-10-05') returning job_no`);
  assert.equal(v.job_no, '10200', 'before switch-over: the HCP job #');
  assert.equal((await q1(`select next_job_no() n`)).n, null);
  await db.query(`select set_next_job_no(10300)`);
  v = await q1(`insert into visits(num, visit_date) values ('PFBS-0781','2026-10-20') returning job_no`); assert.equal(v.job_no, '10300', 'after: CRM numbers');
  v = await q1(`insert into visits(num, visit_date) values ('PFBS-0781','2026-11-20') returning job_no`); assert.equal(v.job_no, '10301');
  assert.equal((await q1(`insert into visits(kind, title, visit_date) values ('event','Site walk','2026-10-21') returning job_no`)).job_no, null, 'events get no job #');
  await assert.rejects(db.query(`select set_next_job_no(10000)`), /higher than 10301/);
  const inv = await q1(`insert into invoices(num, items, service_date) values ('PFBS-0781','[{"amount":100}]','2026-10-20') returning id`);
  await db.query(`update invoices set status='Sent' where id='${inv.id}'`);
  const st = (await db.query(`select visit_date::text d, status from visits where num='PFBS-0781' order by visit_date`)).rows.map(r => r.d + ' ' + r.status);
  assert.deepEqual(st, ['2026-10-05 Done', '2026-10-20 Done', '2026-11-20 Scheduled'], 'sent invoice closes visits up to the service date');
  // property contact on import
  const pl = { clients: [{ name: 'Bayshore Owner LLC', contacts: [{ name: 'Rich Demo', email: 'rich@demo.example', hcp_id: '777' }], properties: [{ address: '1699 Demo Hwy', contact_hcp_id: '777' }] }] };
  await db.query(`select import_clients('${JSON.stringify(pl)}'::jsonb)`);
  assert.equal((await q1(`select c.name from properties p join client_contacts c on c.id=p.contact_id where p.address='1699 Demo Hwy'`)).name, 'Rich Demo', 'property linked to its manager');
  await db.exec('reset role');
  console.log('db: job numbers & property contacts passed');
}
// ---------- job # at approval (update 023) ----------
{
  const q1 = async s => (await db.query(s)).rows[0];
  await db.exec(`select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","email":"aperez@pfbuildingservices.com"}',false); set role authenticated;`);
  await db.exec(`reset role; update proposals set status='Sent', hcp_job=null where num in ('PFBS-0782','PFBS-0783')`);
  await db.exec(`update proposals set status='Approved' where num='PFBS-0782'`);
  const jn = (await q1(`select hcp_job from proposals where num='PFBS-0782'`)).hcp_job;
  assert.ok(/^\d+$/.test(jn) && Number(jn) >= 10302, 'approval gives the job its number: ' + jn);
  await db.exec(`update proposals set status='Approved', hcp_job='99999' where num='PFBS-0783'`);
  assert.equal((await q1(`select hcp_job from proposals where num='PFBS-0783'`)).hcp_job, '99999', 'a typed job # is kept');
  const a = await q1(`insert into visits(num, visit_date) values ('PFBS-0782','2026-12-01') returning job_no`);
  const b2 = await q1(`insert into visits(num, visit_date) values ('PFBS-0782','2027-03-01') returning job_no`);
  assert.equal(a.job_no, jn, 'first visit = the job #'); assert.ok(b2.job_no !== jn && Number(b2.job_no) > Number(jn), 'next recurring visit gets its own #');
  console.log('db: job # at approval passed');
}
// ---------- on hold (update 024) ----------
{
  await db.exec(`reset role; update proposals set on_hold_since='2026-10-12', on_hold_reason='Client paused' where num='PFBS-0782'`);
  const r = (await db.query(`select status, on_hold_reason from proposals where num='PFBS-0782'`)).rows[0];
  assert.equal(r.on_hold_reason, 'Client paused'); assert.equal(r.status, 'Scheduled', 'hold keeps the status');
  console.log('db: on hold passed');
}
// ---------- give an old approved job its job # (update 024) ----------
{
  const q1 = async x => (await db.query(x)).rows[0];
  await db.exec(`reset role; update private_settings set value='off' where key='crm_job_numbers'; update proposals set status='Approved', hcp_job=null where num='PFBS-0784'`);
  await db.exec(`insert into visits(num, visit_date) values ('PFBS-0784','2026-12-02'), ('PFBS-0784','2027-01-02')`);
  assert.equal((await q1(`select hcp_job from proposals where num='PFBS-0784'`)).hcp_job, null, 'no number while numbering is off');
  await db.exec(`update private_settings set value='on' where key='crm_job_numbers'`);
  await db.exec(`select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","email":"aperez@pfbuildingservices.com"}',false); set role authenticated;`);
  const jn = (await q1(`select assign_job_no('PFBS-0784') j`)).j;
  assert.ok(/^\d+$/.test(jn), 'gets a number: ' + jn);
  assert.equal((await q1(`select assign_job_no('PFBS-0784') j`)).j, jn, 'asking twice keeps the same number');
  await db.exec(`reset role`);
  const vs = (await db.query(`select job_no from visits where num='PFBS-0784' order by visit_date`)).rows.map(r => r.job_no);
  assert.equal(vs[0], jn, 'first visit gets the job #'); assert.ok(vs[1] && vs[1] !== jn, 'later visit gets its own');
  await db.exec(`update proposals set status='Sent', hcp_job=null where num='PFBS-0785'`);
  await db.exec(`select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","email":"aperez@pfbuildingservices.com"}',false); set role authenticated;`);
  await assert.rejects(db.query(`select assign_job_no('PFBS-0785')`), /Approve the proposal first/, 'not approved: refused');
  await db.exec('reset role');
  console.log('db: give a job its # passed');
}
// ---------- KitTracker reads the schedule (update 025) ----------
{
  const claims = e => `select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000aa","email":"${e}"}',false); set role authenticated;`;
  await db.exec(`reset role; update proposals set items='[{"type":"Service","description":"Exterior windows\\nall elevations","group":"A"},{"type":"Service","description":"Option B line","group":"B"},{"type":"Add-on","description":"Gutter","accepted":true},{"type":"Add-on","description":"Skylights"}]'::jsonb, pricing_option=null where num='PFBS-0784'`);
  await db.exec(`update visits set visit_date=current_date + 2, techs='{Rigo}', work='{Pressure Washing}' where num='PFBS-0784' and visit_date='2026-12-02'`);
  await db.exec(claims('warehouse@example.com'));
  await assert.rejects(db.query(`select warehouse_jobs(14)`), /not set up for the warehouse/, 'unknown login refused');
  await assert.rejects(db.query(`select * from proposals limit 1`).then(r => { if (r.rows.length) throw new Error('leak'); throw new Error('none'); }), /none|permission/, 'warehouse login sees no proposals');
  await db.exec(`reset role; insert into warehouse_logins(email) values ('warehouse@example.com') on conflict do nothing`);
  await db.exec(claims('warehouse@example.com'));
  const L = (await db.query(`select warehouse_jobs(14) j`)).rows[0].j;
  await db.exec('reset role');
  const x = L.find(v => v.num === 'PFBS-0784');
  assert.ok(x && x.job_no && x.techs[0] === 'Rigo' && x.work[0] === 'Pressure Washing', 'visit in the feed with job #, techs, work');
  assert.deepEqual(x.scope, ['Exterior windows', 'Gutter'], 'scope = first option + accepted add-ons, first line only');
  console.log('db: warehouse feed passed');
}
// ---------- the warehouse inside the CRM (update 026) ----------
{
  const as = e => `reset role; select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000ab","email":"${e}"}',false); set role authenticated;`;
  await db.exec(as('warehouse@example.com'));
  await db.exec(`insert into wh_jobs(hcp_job_number, status) values ('10305','packed')`);
  assert.equal((await db.query(`select count(*)::int n from wh_jobs`)).rows[0].n, 1, 'tablet login can pack');
  assert.equal(await db.query(`select count(*)::int n from proposals`).then(r => r.rows[0].n, () => 0), 0, 'tablet login still sees no proposals');
  await db.exec(as('stranger@example.com'));
  assert.equal((await db.query(`select count(*)::int n from wh_jobs`)).rows[0].n, 0, 'stranger sees nothing');
  await assert.rejects(db.query(`insert into wh_jobs(status) values ('packed')`), /row-level security/, 'stranger cannot write');
  await db.exec(as('aperez@pfbuildingservices.com'));
  assert.equal((await db.query(`select count(*)::int n from wh_jobs`)).rows[0].n, 1, 'owner sees the warehouse');
  await db.exec('reset role');
  console.log('db: warehouse tables passed');
}
// ---------- paid HousecallPro invoices as history (update 028) ----------
{
  const owner = `select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","email":"aperez@pfbuildingservices.com"}',false); set role authenticated;`;
  await db.exec('reset role');
  const snap = async () => JSON.stringify((await db.query(`select num, status, date_paid from proposals order by num`)).rows);
  const before = await snap();
  await db.exec(owner);
  const pl = { invoices: [{ inv_no: '901', customer: 'X Co', amount: '$1,250.00', job_no: '10302', sent_on: '2025-05-01 10:00:00 -0700' }, { inv_no: '902', customer: 'X Co', amount: '', job_no: '9', sent_on: '' }] };
  const r = (await db.query(`select import_hcp_paid_invoices($1::jsonb) j`, [JSON.stringify(pl)])).rows[0].j;
  assert.equal(r.imported, 2);
  assert.equal((await db.query(`select import_hcp_paid_invoices($1::jsonb) j`, [JSON.stringify({ invoices: [{ inv_no: '901', amount: '5' }] })])).rows[0].j.skipped, 1, 'second run skips');
  await db.exec('reset role');
  const v = (await db.query(`select inv_no, status, total::float t, paid::float p, num from invoices where inv_no in (901,902) order by inv_no`)).rows;
  assert.deepEqual(v.map(x => [x.status, x.t, x.p, x.num]), [['Paid', 1250, 1250, null], ['Paid', 0, 0, null]], 'history: paid, not linked to a CRM job');
  assert.equal(await snap(), before, 'no job changed');
  console.log('db: paid HCP invoices passed');
}
// ---------- HCP invoices with job details (update 030) ----------
{
  await db.exec(`select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","email":"aperez@pfbuildingservices.com"}',false); set role authenticated;`);
  await db.query(`select import_hcp_invoices($1::jsonb)`, [JSON.stringify({ invoices: [{ inv_no: '905', customer: 'X Co', amount_due: '$300.00', due_date: '2026-11-01', job_no: '777', description: 'Gutter Cleaning', address: '1 Main St, Oakland' }] })]);
  const u = (await db.query(`select hcp_invoice_details($1::jsonb) j`, [JSON.stringify({ jobs: [{ job_no: '9', description: 'Windows', address: '2 Side St', amount: '$400.00' }, { job_no: '777', description: 'Gutters (new)', amount: '$999' }] })])).rows[0].j;
  await db.exec('reset role');
  const r = (await db.query(`select inv_no, status, total::float t, paid::float p, items->0->>'description' d, items->0->>'notes' n from invoices where inv_no in (902,905) order by inv_no`)).rows;
  assert.equal(u.updated, 2);
  assert.deepEqual([r[0].status, r[0].t, r[0].p, r[0].d], ['Paid', 400, 400, 'Windows'], 'paid history filled with its job amount');
  assert.deepEqual([r[1].status, r[1].t, r[1].d], ['Sent', 300, 'Gutters (new)'], 'open invoice keeps its balance, gets the job description');
  assert.match(r[1].n, /HousecallPro invoice #905, job #777/);
  console.log('db: HCP invoice details passed');
}
// ---------- proposal numbers start at 0803 (update 031) ----------
{
  assert.ok(Number((await one(`select next_proposal_no() n`)).n) >= 803, 'next proposal # is at least 0803');
  const mx = Number((await one(`select max_proposal_no() n`)).n);
  await db.exec(`select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","email":"aperez@pfbuildingservices.com"}',false); set role authenticated;`);
  await assert.rejects(db.query(`select set_next_proposal_no(5)`), /higher than/, 'cannot go back to a used number');
  await db.query(`select set_next_proposal_no($1)`, [Math.max(mx + 1, 803)]);
  await db.exec('reset role');
  assert.equal(Number((await one(`select next_proposal_no() n`)).n), Math.max(mx + 1, 803));
  console.log('db: proposal numbers passed');
}
// ---------- the warehouse gets the job's materials (update 032) ----------
{
  const items = [
    { type: 'Base', description: 'Exterior windows', estimate: { materials: [{ desc: 'WFS Resin Refill', qty: 1 }, { desc: 'Squeegee rubber', qty: '0' }] } },
    { type: 'Base', description: 'Interior windows', estimate: { materials: [{ desc: 'wfs resin refill', qty: 2 }, { desc: 'Drop cloth', qty: 3 }] } },
    { type: 'Add-on', description: 'Screens', estimate: { materials: [{ desc: 'Screen brush', qty: 1 }] } },
    { type: 'Add-on', description: 'Gutters', accepted: true, estimate: { materials: [{ desc: 'Bags', qty: 10 }] } }];
  const m = (await db.query(`select pfbs_materials($1::jsonb, null) m`, [JSON.stringify(items)])).rows[0].m;
  assert.deepEqual(m.map(x => [x.desc, Number(x.qty)]), [['WFS Resin Refill', 3], ['Drop cloth', 3], ['Bags', 10]], 'counted lines only, added up by name, no zero qty, not-accepted add-ons left out');
  console.log('db: warehouse materials passed');
}
{
  const parts = [{ kind: 'rental', desc: "65' Boom Lift", vendor: 'Sunbelt', reservationNo: 'R-1', estCost: 2000, finalCost: 2100 }, { desc: 'Resin', status: 'To order' }];
  const r = (await db.query(`select pfbs_rentals($1::jsonb, '[]'::jsonb) r`, [JSON.stringify(parts)])).rows[0].r;
  assert.deepEqual([r.length, r[0].desc, r[0].vendor, r[0].reservationNo, 'estCost' in r[0], 'finalCost' in r[0]], [1, "65' Boom Lift", 'Sunbelt', 'R-1', false, false], 'saved lifts, never costs');
  const r2 = (await db.query(`select pfbs_rentals('[]'::jsonb, $1::jsonb) r`, [JSON.stringify([{ estimate: { rentals: [{ desc: '25 scissor', qty: 1, unit: 300 }, { desc: 'unused', qty: 0 }] } }])])).rows[0].r;
  assert.deepEqual(r2.map(x => x.desc), ['25 scissor'], 'falls back to the lifts in the pricing');
  console.log('db: warehouse job packet data passed');
}
// ---------- open HCP invoices link to their CRM job by job # (update 033) ----------
{
  const q1 = async (s, p) => (await db.query(s, p)).rows[0];
  await db.exec('reset role');
  await db.exec(`insert into proposals(num, client, status, date_sent, sent_by) values ('PFBS-7033','Link Co','Approved','2026-10-01','Arturo'), ('PFBS-7034','Visit Co','Scheduled','2026-10-01','Arturo')`);
  await db.exec(`insert into invoices(inv_no, job_no, status, items, bill_to, source) values (99031,'55123','Sent','[{"description":"HCP balance","amount":400}]','{"name":"Link Co"}','hcp'),
                 (99032,'55124','Sent','[{"description":"HCP balance","amount":250}]','{"name":"Visit Co"}','hcp'), (99033,'55123','Paid','[{"description":"old paid","amount":90}]','{"name":"Link Co"}','hcp')`);
  assert.equal((await q1(`select num from invoices where inv_no=99031`)).num, null, 'no job with that # yet');
  await db.exec(`update proposals set hcp_job='55123' where num='PFBS-7033'`);
  assert.equal((await q1(`select num from invoices where inv_no=99031`)).num, 'PFBS-7033', 'job # given later links the open HCP invoice');
  assert.equal((await q1(`select num from invoices where inv_no=99033`)).num, null, 'paid history is never linked');
  await db.exec(`insert into visits(num, kind, visit_date, job_no, status) values ('PFBS-7034','job','2026-10-05','55124','Done')`);
  assert.equal((await q1(`select num from invoices where inv_no=99032`)).num, 'PFBS-7034', 'a visit\'s job # links too');
  await db.exec(`select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","email":"aperez@pfbuildingservices.com"}',false); set role authenticated;`);
  const id = (await q1(`select id from invoices where inv_no=99031`)).id;
  await db.query(`insert into invoice_payments(invoice_id, amount, method, received_on) values ($1, 400, 'Check', '2026-10-30')`, [id]);
  await db.exec('reset role');
  const p = await q1(`select status, date_paid::text d from proposals where num='PFBS-7033'`);
  assert.deepEqual([p.status, p.d], ['Paid', '2026-10-30'], 'paying the HCP invoice in Money marks the job Paid with the payment date');
  console.log('db: HCP invoices link to jobs passed');
}
