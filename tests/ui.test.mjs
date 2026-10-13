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

// 5. Invoicing: from a scheduled job → PO# check → PDF + email → partial and full payment → job Paid
{
  const sj = { num: 'PFBS-0970', date_sent: '2026-09-01', sent_by: 'Arturo', client: 'Demo Towers', property: '100 Demo Ave', site_address: '100 Demo Ave\nWalnut Creek, CA 94596', bill_address: '2120 Billing Blvd\nWalnut Creek, CA 94596',
    contact_name: 'Ana Demo', contact_email: 'ana@example.com', billing_email: 'ap@example.com', po_required: true, amount: 7715, status: 'Scheduled', date_resolved: '2026-09-05', hcp_job: '10100',
    items: [{ type: 'Service', qty: 1, frequency: 'One-time', description: 'Exterior perimeter glass\n- Includes boom rental 85ft', amount: 7215 }, { type: 'Add-on', qty: 1, description: 'Skylights', amount: 500, accepted: true }, { type: 'Add-on', qty: 1, description: 'Gutters', amount: 300 }] };
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 }, acceptDownloads: true }); pg.on('pageerror', e => errs.push('invoice: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort()); await pg.route(/outlook\.office\.com/, r => r.fulfill({ body: 'ok' }));
  await pg.addInitScript(x => { window.MOCK_EXTRA = [x]; }, sj); await pg.goto(BASE); await pg.waitForTimeout(1000);
  await pg.click('#tabs [data-tab="orders"]', T); await pg.waitForTimeout(400);
  await pg.click('[data-invnew="PFBS-0970"]', T); await pg.waitForSelector('dialog.inved', T);
  const lines = await pg.$$eval('dialog.inved .invrow', r => r.map(x => [x.querySelector('[data-f="description"]').value, x.querySelector('[data-f="amount"]').value, x.querySelector('[data-f="notes"]').value]));
  assert.deepEqual(lines, [['Exterior perimeter glass', '7215', '- Includes boom rental 85ft'], ['Skylights', '500', '']], 'lines from accepted scope, notes kept, declined add-on left out');
  assert.equal(await pg.$eval('#invTot', e => e.textContent), '$7,715.00');
  assert.equal(await pg.$eval('[name="bill_email"]', e => e.value), 'ap@example.com', 'bills the AP email, not the site contact');
  assert.equal(await pg.$eval('[name="job_no"]', e => e.value), '10100');
  await pg.click('dialog.inved [data-a="send"]'); await pg.waitForTimeout(300);
  assert.match(await pg.$eval('#toast', e => e.textContent), /requires a PO#/, 'PO# required blocks sending');
  await pg.fill('[name="po_number"]', 'PO-4455');
  const dl = pg.waitForEvent('download', T); await pg.click('dialog.inved [data-a="send"]');
  assert.equal((await dl).suggestedFilename(), 'Invoice 1525 - 100 Demo Ave.pdf');
  await pg.waitForSelector('#ivTo', T);
  assert.equal(await pg.$eval('#ivTo', e => e.value), 'ap@example.com');
  assert.match(await pg.$eval('#ivSubj', e => e.value), /^Invoice #1525 from PF Building Services – 100 Demo Ave \(PO PO-4455\)$/);
  const body = await pg.$eval('#ivBody', e => e.value); assert.ok(body.startsWith('Hello,') && !/Best regards|Arturo/.test(body), 'no signature');
  const pop = pg.waitForEvent('popup', T); await pg.click('dialog [data-a="owa"]'); await (await pop).close(); await pg.waitForTimeout(500);
  let st = await pg.evaluate(() => { const v = DBX.invoices[0], p = DBX.proposals.find(x => x.num === 'PFBS-0970'); return { inv: v.status, job: p.status, po: p.po_number }; });
  assert.deepEqual(st, { inv: 'Sent', job: 'Invoiced', po: 'PO-4455' }, 'sent; job Invoiced; PO# saved back to the job');
  await pg.keyboard.press('Escape'); await pg.click('#tabs [data-tab="orders"]', T); await pg.waitForTimeout(500);
  assert.match(await pg.$eval('#jobsBody', e => e.innerText), /Open invoices \(1\) · \$7,715\.00 due/);
  await pg.click('[data-oipay]', T); await pg.waitForSelector('dialog.ask [name="amount"]', T);
  await pg.fill('dialog.ask [name="amount"]', '5000'); await pg.selectOption('dialog.ask [name="method"]', 'ACH'); await pg.fill('dialog.ask [name="received_on"]', '2026-10-20');
  await pg.click('dialog.ask [data-a="ok"]'); await pg.waitForTimeout(600);
  assert.match(await pg.$eval('#jobsBody', e => e.innerText), /\$2,715\.00/, 'partial payment leaves the balance');
  await pg.click('[data-oipay]', T); await pg.waitForSelector('dialog.ask [name="amount"]', T);
  assert.equal(await pg.$eval('dialog.ask [name="amount"]', e => e.value), '2715');
  await pg.fill('dialog.ask [name="received_on"]', '2026-10-28'); await pg.click('dialog.ask [data-a="ok"]'); await pg.waitForTimeout(600);
  st = await pg.evaluate(() => { const v = DBX.invoices[0], p = DBX.proposals.find(x => x.num === 'PFBS-0970'); return { inv: v.status, job: p.status, paid: p.date_paid }; });
  assert.deepEqual(st, { inv: 'Paid', job: 'Paid', paid: '2026-10-28' }, 'paid in full marks the job Paid with the last payment date');
  assert.match(await pg.$eval('#jobsBody', e => e.innerText), /No open invoices/);
  await pg.screenshot({ path: path.join(B, 'jobs_invoices.png'), fullPage: true });
  await pg.close();
}

// 6. PO# per service: every line needs one when the client requires a PO#
{
  const sj = { num: 'PFBS-0971', date_sent: '2026-09-01', sent_by: 'Arturo', client: 'Demo Towers', property: '200 Demo Ave', site_address: '200 Demo Ave', contact_name: 'Ana Demo', contact_email: 'ana@example.com', billing_email: 'ap@example.com',
    po_required: true, amount: 900, status: 'Scheduled', items: [{ type: 'Service', qty: 1, description: 'Windows', amount: 600 }, { type: 'Service', qty: 1, description: 'Pressure wash', amount: 300 }] };
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 }, acceptDownloads: true }); pg.on('pageerror', e => errs.push('po: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(x => { window.MOCK_EXTRA = [x]; }, sj); await pg.goto(BASE); await pg.waitForTimeout(1000);
  await pg.click('#tabs [data-tab="orders"]', T); await pg.waitForTimeout(400); await pg.click('[data-invnew="PFBS-0971"]', T); await pg.waitForSelector('dialog.inved', T);
  assert.equal(await pg.isVisible('dialog.inved .invrow [data-f="po"]'), false, 'PO boxes hidden until ticked');
  await pg.check('#invLinePo'); const po = pg.locator('dialog.inved .invrow [data-f="po"]');
  await po.nth(0).fill('PO-111'); await pg.click('dialog.inved [data-a="send"]'); await pg.waitForTimeout(300);
  assert.match(await pg.$eval('#toast', e => e.textContent), /every service/);
  await po.nth(1).fill('PO-222'); const dl = pg.waitForEvent('download', T); await pg.click('dialog.inved [data-a="send"]'); await dl;
  await pg.waitForSelector('#ivSubj', T); assert.match(await pg.$eval('#ivSubj', e => e.value), /\(PO PO-111, PO-222\)$/);
  assert.deepEqual(await pg.evaluate(() => DBX.invoices.at(-1).items.map(i => i.po)), ['PO-111', 'PO-222']);
  await pg.close();
}

await b.close(); srv.close();
assert.deepEqual(errs, [], 'no page errors');
console.log('ui: CRM tabs, report from job, approve & email, HCP report, access checks, invoicing passed');
