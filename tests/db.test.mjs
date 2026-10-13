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
