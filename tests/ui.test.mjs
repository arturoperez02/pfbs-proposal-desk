// Page tests in a real browser with the database swapped for tests/mock.js (made-up data).
import { chromium } from 'playwright'; import http from 'http'; import fs from 'fs'; import path from 'path'; import assert from 'node:assert/strict';
import B from './build.mjs';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.jpg': 'image/jpeg' };
const srv = http.createServer((q, s) => { const f = path.join(B, decodeURIComponent(q.url.split(/[?#]/)[0]).replace(/^\/$/, '/index.html'));
  fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); } else { s.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); s.end(d); } }); });
await new Promise(r => srv.listen(0, r)); const BASE = `http://localhost:${srv.address().port}/`;
const opt = process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {};
const b = await chromium.launch(opt); const errs = []; const T = { timeout: 8000 };
const job = { num: 'PFBS-0963', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Demo Client', property: '9 Oak Plaza', site_address: '9 Oak St\nOakland, CA 94607', contact_name: 'Nancy Demo', contact_email: 'nancy@example.com', amount: 4000, status: 'Invoiced', hcp_job: '55501',
  items: [{ description: 'Exterior window cleaning', type: 'Base' }, { description: 'Pressure wash entry', type: 'Add-on', accepted: true }, { description: 'Gutter', type: 'Add-on' }] };
async function page(u, { sr = [], email = '', width = 1300 } = {}) {
  const pg = await b.newPage({ viewport: { width, height: 900 }, acceptDownloads: true }); pg.on('pageerror', e => { if (!/^\?next=/.test(new URL(pg.url()).search)) errs.push(u + ': ' + e.message); });
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.route(/open-meteo/, r => r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: r.request().url().includes('geocoding') ? '{"results":[{"latitude":37.8,"longitude":-122.27}]}' : '{"daily":{"weather_code":[0],"temperature_2m_max":[68]}}' }));
  await pg.addInitScript(([x, s, e]) => { window.MOCK_EXTRA = x; window.MOCK_SR = s; if (e) window.MOCK_EMAIL = e; window.MOCK_RPC = { report_approved: a => { window.__appr = a; return { data: { ok: true }, error: null }; }, save_crew_leads: a => ({ data: a.names, error: null }) }; }, [[job], sr, email]);
  await pg.goto(BASE + u); await pg.waitForTimeout(1000); return pg; }
const val = (pg, s) => pg.$eval(s, e => e.value);

// 1. CRM loads and every tab renders
let pg = await page('');
for (const t of ['pipeline', 'leads', 'sales', 'orders', 'comm', 'settings']) { await pg.click(`#tabs [data-tab="${t}"]`, T); await pg.waitForTimeout(250); }
await pg.click('#tabs [data-tab="orders"]', T); await pg.waitForTimeout(300);
assert.ok(await pg.$('#jobsBody a[href="reports.html?num=PFBS-0963"]'), 'Jobs lists the unsent report with Write report');
await pg.close();

// 2. Write a report from the job, add a photo, approve → PDF downloads and the email opens
pg = await page('reports.html?num=PFBS-0963', { width: 430 });
assert.equal(await val(pg, '#f_client'), 'DEMO CLIENT'); assert.equal(await val(pg, '#f_email_to'), 'nancy@example.com');
assert.deepEqual(await pg.$$eval('#f_work input, #f_work textarea', e => e.map(x => x.value)), ['EXTERIOR WINDOW CLEANING', 'PRESSURE WASH ENTRY'], 'scope from accepted lines');
await pg.setInputFiles('#file', path.join(B, 'logo.jpg')); await pg.waitForTimeout(1500);
const dl = pg.waitForEvent('download', T);
await pg.click('#approve', T); await pg.click('.overlay [data-a="1"]', T);
assert.match((await dl).suggestedFilename(), /\.pdf$/);
await pg.waitForSelector('#emTo', T);
assert.equal(await val(pg, '#emTo'), 'nancy@example.com');
assert.ok(!/Best regards|Oscar Perez/.test(await val(pg, '#emBody')), 'no signature in the body (Outlook adds it)');
assert.ok(await pg.evaluate(() => window.__appr && window.__appr.p_id), 'report_approved called');
await pg.close();

// 3. A report started by HousecallPro: CRM contact email beats HCP billing email; finish day is the service date
pg = await page('reports.html#/r/41111111-2222-3333-4444-555555555555', { width: 430, sr: [{ id: '41111111-2222-3333-4444-555555555555', num: 'PFBS-0963', hcp_job: '471142602', status: 'pending', created_at: '2026-10-12T22:30:00Z',
  doc: { _raw: { contact_first_name: 'Kim', street: '9 Oak St', city: 'Oakland', state: 'CA', job_id: '471142602', client: 'Demo HQ', email: 'billing@example.com' } } }] });
assert.equal(await val(pg, '#f_email_to'), 'nancy@example.com'); assert.equal(await val(pg, '#f_ds'), '2026-10-12'); assert.match(await val(pg, '#f_weather'), /CLEAR/);
await pg.close();

// 4. Only the office can open reports; no session goes to the CRM login
pg = await page('reports.html?u=e@x.com', { email: 'e@x.com' }); assert.match(await pg.$eval('body', e => e.innerText), /for the office/); await pg.close();

await b.close(); srv.close();
assert.deepEqual(errs, [], 'no page errors');
console.log('ui: CRM tabs, report from job, approve & email, HCP report, access checks passed');
