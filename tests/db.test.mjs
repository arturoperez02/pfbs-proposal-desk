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
