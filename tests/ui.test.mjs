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
  assert.match(body, /^Hello,\n\nAttached is invoice #\d+ for .+, due net \d+\. Please let me know if you have any questions\.$/, 'invoice email is just the two lines: ' + JSON.stringify(body));
  const pop = pg.waitForEvent('popup', T); await pg.click('dialog [data-a="owa"]'); await (await pop).close(); await pg.waitForTimeout(500);
  let st = await pg.evaluate(() => { const v = DBX.invoices[0], p = DBX.proposals.find(x => x.num === 'PFBS-0970'); return { inv: v.status, job: p.status, po: p.po_number }; });
  assert.deepEqual(st, { inv: 'Sent', job: 'Invoiced', po: 'PO-4455' }, 'sent; job Invoiced; PO# saved back to the job');
  await pg.keyboard.press('Escape'); await pg.click('#tabs [data-tab="orders"]', T); await pg.waitForTimeout(500);
  assert.match(await pg.$eval('#jobsBody', e => e.innerText), /1 open invoice · \$7,715\.00 due/, 'Jobs only points to Money');
  assert.ok(!(await pg.$('#jobsBody [data-oipay]')), 'no invoice list on Jobs');
  await pg.click('#jobsBody [data-gomoney]', T); await pg.waitForTimeout(500);
  await pg.click('[data-mpay]', T); await pg.waitForSelector('dialog.ask [name="amount"]', T);
  await pg.fill('dialog.ask [name="amount"]', '5000'); await pg.selectOption('dialog.ask [name="method"]', 'ACH'); await pg.fill('dialog.ask [name="received_on"]', '2026-10-20');
  await pg.click('dialog.ask [data-a="ok"]'); await pg.waitForTimeout(600);
  assert.match(await pg.$eval('#moneyBody', e => e.innerText), /\$2,715\.00/, 'partial payment leaves the balance');
  await pg.click('[data-mpay]', T); await pg.waitForSelector('dialog.ask [name="amount"]', T);
  assert.equal(await pg.$eval('dialog.ask [name="amount"]', e => e.value), '2715');
  await pg.fill('dialog.ask [name="received_on"]', '2026-10-28'); await pg.click('dialog.ask [data-a="ok"]'); await pg.waitForTimeout(600);
  st = await pg.evaluate(() => { const v = DBX.invoices[0], p = DBX.proposals.find(x => x.num === 'PFBS-0970'); return { inv: v.status, job: p.status, paid: p.date_paid }; });
  assert.deepEqual(st, { inv: 'Paid', job: 'Paid', paid: '2026-10-28' }, 'paid in full marks the job Paid with the last payment date');
  await pg.click('#tabs [data-tab="orders"]', T); await pg.waitForTimeout(400); assert.ok(!/open invoice/i.test(await pg.$eval('#jobsBody', e => e.innerText)), 'no open-invoice line once all are paid');
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

// 7. Clients: import HCP customers in Settings, client page, proposals fill from the client and create new ones on save
{
  const csv = 'First Name,Last Name,Display Name,Mobile Number,Email,Additional Emails,Company,Role,Tags,Notes,ID,Customer Type,Address_1 Street Line 1,Address_1 Street Line 2,Address_1 City,Address_1 State,Address_1 Postal Code,Address_1 Billing?,Address_1 Notes,Address_2 Street Line 1,Address_2 Street Line 2,Address_2 City,Address_2 State,Address_2 Postal Code,Address_2 Billing?,Address_2 Notes\n'
    + "Pat,Demo,Demo Tower,5105550101,pat@demo.example,,Demo Realty,Property Manager,'PO# Required',\"Keys at desk, ask for \"\"Sam\"\"\",111,business,1 Billing Way,Ste 5,Oakland,CA,94612,true,,100 Demo Ave,,Walnut Creek,CA,94596,,Lift needed\n"
    + 'Lee,Demo,Demo Plaza,,lee@demo.example,ap@demo.example,Demo Realty,,,,112,business,200 Demo Blvd,,Oakland,CA,94607,true,,,,,,,,\n'
    + 'Jo,Home,Jo Home,,jo@home.example,,,,,,113,homeowner,9 Home Ct,,Fremont,CA,94538,true,,,,,,,,\n'
    + ',,The Annex c/o Demo Realty,,annex@demo.example,,The Annex c/o Demo Realty,,,,114,business,300 Annex St,,Oakland,CA,94607,,,,,,,,,\n';
  fs.writeFileSync(path.join(B, 'customers.csv'), csv);
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('clients: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(() => { window.MOCK_RPC = { import_clients: ({ payload }) => { window.__imp = (window.__imp || []).concat(payload.clients);
    for (const c of payload.clients) { const id = crypto.randomUUID(); DBX.clients.push({ id, name: c.name, kind: c.kind, aliases: c.aliases, po_required: c.po_required, billing_address: c.billing_address || null, active: true });
      c.contacts.forEach((k, i) => DBX.client_contacts.push({ id: crypto.randomUUID(), client_id: id, ...k, is_primary: i === 0, active: true }));
      c.properties.forEach(pp => DBX.properties.push({ id: crypto.randomUUID(), client_id: id, ...pp, addr_key: pp.address.split('\n')[0].toUpperCase(), active: true })); }
    return { data: { clients_new: payload.clients.length, contacts_new: 3, properties_new: 3, proposals_linked_to_client: 0 }, error: null }; } }; });
  await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="settings"]', T); await pg.waitForTimeout(400);
  await pg.setInputFiles('#clImport', path.join(B, 'customers.csv')); await pg.waitForSelector('dialog.ask', T);
  assert.match(await pg.$eval('dialog.ask', e => e.innerText), /2 clients \(1 companies, 1 homeowners\), 4 contacts, 4 properties/);
  await pg.click('dialog.ask [data-a="ok"]'); await pg.waitForTimeout(600);
  const imp = await pg.evaluate(() => window.__imp); const demo = imp.find(c => c.name === 'Demo Realty');
  assert.deepEqual([demo.contacts.map(k => k.name), demo.po_required, demo.aliases, demo.billing_address, demo.properties.map(x => x.address)],
    [['Pat Demo', 'Lee Demo', 'The Annex c/o Demo Realty'], true, ['Demo Tower', 'Demo Plaza', 'The Annex c/o Demo Realty'], '1 Billing Way Ste 5\nOakland, CA 94612', ['100 Demo Ave\nWalnut Creek, CA 94596', '200 Demo Blvd\nOakland, CA 94607', '300 Annex St\nOakland, CA 94607']], 'people at one company → one client; billing office is not a property');
  assert.equal(demo.notes, 'Keys at desk, ask for "Sam"', 'quoted CSV fields parse');
  assert.ok(demo.properties.some(x => x.name === 'The Annex' && /300 Annex St/.test(x.address)), '"Building c/o Company" → property under that company');
  assert.equal(imp.find(c => c.kind === 'Homeowner').name, 'Jo Home');
  await pg.click('#tabs [data-tab="clients"]', T); await pg.waitForTimeout(300);
  await pg.fill('#clQ', 'walnut'); await pg.waitForTimeout(200);
  assert.deepEqual(await pg.$$eval('#clientsBody tr[data-cl] b', e => e.map(x => x.textContent)), ['Demo Realty'], 'search finds by property address');
  await pg.click('#clientsBody tr[data-cl]', T); await pg.waitForTimeout(300);
  await pg.fill('#cl-bemail', 'ap@demo.example'); await pg.click('#clPAdd'); await pg.fill('#clP tr:last-child [data-pf="name"]', 'Demo Annex'); await pg.fill('#clP tr:last-child [data-pf="address"]', '300 Demo Way\nOakland, CA');
  await pg.click('#clSave'); await pg.waitForTimeout(500);
  assert.equal(await pg.evaluate(() => DBX.clients.find(c => c.name === 'Demo Realty').billing_email), 'ap@demo.example');
  assert.ok(await pg.evaluate(() => DBX.properties.some(p => p.name === 'Demo Annex')), 'property added');
  await pg.click('#clProp', T); await pg.waitForTimeout(400);
  assert.equal(await pg.$eval('#f-client', e => e.value), 'Demo Realty');
  assert.equal(await pg.$eval('#f-contactEmail', e => e.value), 'pat@demo.example'); assert.equal(await pg.$eval('#f-billingEmail', e => e.value), 'ap@demo.example');
  assert.equal(await pg.$eval('#f-poRequired', e => e.value), 'true');
  await pg.fill('#f-property', 'Demo Annex'); await pg.dispatchEvent('#f-property', 'change'); await pg.waitForTimeout(200);
  assert.equal(await pg.$eval('#f-siteAddress', e => e.value), '300 Demo Way\nOakland, CA', 'property fills the site address');
  await pg.click('#cancelD'); await pg.waitForTimeout(300);
  await pg.click('#tabs [data-tab="pipeline"]', T); await pg.waitForTimeout(300); await pg.click('#newBtn', T); await pg.waitForTimeout(400);
  await pg.fill('#f-client', 'Brand New Co'); await pg.dispatchEvent('#f-client', 'change');
  await pg.fill('#f-property', '55 New St'); await pg.fill('#f-siteAddress', '55 New Street\nSan Jose, CA'); await pg.fill('#f-contactName', 'Nia New'); await pg.fill('#f-contactEmail', 'nia@new.example');
  for (const k of ['property', 'siteAddress', 'contactName', 'contactEmail']) await pg.dispatchEvent('#f-' + k, 'change');
  await pg.click('#saveD'); await pg.waitForTimeout(800);
  const made = await pg.evaluate(() => { const c = DBX.clients.find(x => x.name === 'Brand New Co'); return c && { k: DBX.client_contacts.filter(x => x.client_id === c.id).map(x => x.email), p: DBX.properties.filter(x => x.client_id === c.id).map(x => x.name), linked: DBX.proposals.some(x => x.client_id === c.id) }; });
  assert.deepEqual(made, { k: ['nia@new.example'], p: ['55 New St'], linked: true }, 'typed once: client, contact and property created and linked');
  await pg.close();
}

// 8. Schedule: recurring job from its frequency, "only this" vs "this and future", one-time multi-day, crew emails
{
  const rj = { num: 'PFBS-0980', date_sent: '2026-09-01', sent_by: 'Arturo', client: 'Demo Towers', property: '300 Demo Ave', site_address: '300 Demo Ave\nOakland, CA 94612', amount: 1200, status: 'Approved', service: 'Window Cleaning',
    items: [{ type: 'Service', qty: 1, frequency: 'Quarterly', description: 'Exterior windows', amount: 1200 }] };
  const oj = { num: 'PFBS-0981', date_sent: '2026-09-01', sent_by: 'Arturo', client: 'Demo Plaza', property: '400 Demo Blvd', site_address: '400 Demo Blvd\nOakland, CA', amount: 9000, status: 'Approved', items: [{ type: 'Service', qty: 1, description: 'Swing stage glass', amount: 9000 }] };
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('schedule: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort()); await pg.route(/outlook\.office\.com/, r => r.fulfill({ body: 'ok' }));
  await pg.addInitScript(x => { window.MOCK_EXTRA = x; }, [rj, oj]); await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="settings"]', T); await pg.waitForTimeout(300);
  await pg.evaluate(() => { const R = [...document.querySelectorAll('#crewCard tr[data-crew]')]; R[0].querySelector('[data-cf="email"]').value = 'rigo@example.com'; R[1].querySelector('[data-cf="email"]').value = 'bal@example.com'; R[2].remove(); R[3].remove(); });
  await pg.click('#crewCard [data-crewa="add"]'); await pg.evaluate(() => { const R = [...document.querySelectorAll('#crewCard tr[data-crew]')].pop(); R.querySelector('[data-cf="name"]').value = 'Ana Tech'; R.querySelector('[data-cf="email"]').value = 'ana@example.com'; R.querySelector('[data-cf="lang"]').value = 'en'; });
  await pg.click('#saveS'); await pg.waitForTimeout(500);
  await pg.click('#tabs [data-tab="orders"]', T); await pg.waitForTimeout(300);
  await pg.click('[data-schnew="PFBS-0980"]', T); await pg.waitForSelector('dialog.inved', T);
  assert.equal(await pg.$eval('[name="preset"]', e => e.value), 'custom', 'recurring job suggests a custom repeat');
  assert.match(await pg.$eval('[name="num"] option:checked', e => e.textContent), /^Demo Towers · 300 Demo Ave — Exterior windows · \$1,200 · not scheduled · PFBS-0980$/, 'job picker shows client, property and scope');
  assert.match(await pg.$eval('#vScope', e => e.innerText), /Exterior windows/, 'scope of work shown');
  assert.deepEqual([await pg.$eval('[name="every"]', e => e.value), await pg.$eval('[name="unit"]', e => e.value)], ['3', 'month'], 'quarterly → every 3 months');
  await pg.fill('[name="visit_date"]', '2026-11-03'); await pg.selectOption('[name="nth"]', '1'); await pg.selectOption('[name="weekday"]', '2');
  await pg.check('dialog.inved [name="techs"][value="Rigo Perez"]'); await pg.click('dialog.inved [data-a="save"]'); await pg.waitForTimeout(700);
  let dates = await pg.evaluate(() => DBX.visits.filter(v => v.num === 'PFBS-0980').map(v => v.visit_date).sort());
  assert.deepEqual(dates.slice(0, 4), ['2026-11-03', '2027-02-02', '2027-05-04', '2027-08-03'], 'first Tuesday every 3 months');
  assert.equal(await pg.evaluate(() => DBX.proposals.find(x => x.num === 'PFBS-0980').status), 'Scheduled');
  // only this visit
  await pg.click('#tabs [data-tab="schedule"]', T); await pg.waitForTimeout(300);
  for (let i = 0; i < 4; i++) { if ((await pg.$eval('#schedBody b', e => e.textContent)).startsWith('February 2027')) break; await pg.click('#schNext'); await pg.waitForTimeout(100); }
  await pg.click('.vchip:has-text("Demo Towers")', T); await pg.waitForSelector('dialog.inved', T);
  await pg.fill('[name="start_time"]', '06:00'); await pg.click('dialog.inved [data-a="save"]'); await pg.waitForSelector('[name="sc"]', T); await pg.click('dialog.ask [data-a="ok"]'); await pg.waitForTimeout(500);
  let v = await pg.evaluate(() => DBX.visits.filter(v => v.num === 'PFBS-0980').sort((a, b) => a.visit_date.localeCompare(b.visit_date)).map(v => [v.visit_date, v.start_time, v.detached || false, (v.techs || []).join('+')]));
  assert.deepEqual(v.slice(0, 3), [['2026-11-03', '08:00', false, 'Rigo Perez'], ['2027-02-02', '06:00', true, 'Rigo Perez'], ['2027-05-04', '08:00', false, 'Rigo Perez']], 'only this visit changed');
  // this and all future visits
  for (let i = 0; i < 4; i++) { if ((await pg.$eval('#schedBody b', e => e.textContent)).startsWith('May 2027')) break; await pg.click('#schNext'); await pg.waitForTimeout(100); }
  await pg.click('.vchip:has-text("Demo Towers")', T); await pg.waitForSelector('dialog.inved', T);
  await pg.check('dialog.inved [name="techs"][value="Baldemar Cervantes"]'); await pg.click('dialog.inved [data-a="save"]'); await pg.waitForSelector('[name="sc"]', T);
  await pg.check('[name="sc"][value="future"]'); await pg.click('dialog.ask [data-a="ok"]'); await pg.waitForTimeout(700);
  v = await pg.evaluate(() => DBX.visits.filter(v => v.num === 'PFBS-0980').sort((a, b) => a.visit_date.localeCompare(b.visit_date)).map(v => [v.visit_date, (v.techs || []).join('+')]));
  assert.deepEqual(v.slice(0, 4), [['2026-11-03', 'Rigo Perez'], ['2027-02-02', 'Rigo Perez'], ['2027-05-04', 'Rigo Perez+Baldemar Cervantes'], ['2027-08-03', 'Rigo Perez+Baldemar Cervantes']], 'future visits changed, past ones kept');
  assert.equal(await pg.evaluate(() => DBX.visit_series.length), 2, 'old series ended, new one started');
  // one-time multi-day job
  await pg.click('#tabs [data-tab="orders"]', T); await pg.waitForTimeout(300);
  await pg.click('[data-schnew="PFBS-0981"]', T); await pg.waitForSelector('dialog.inved', T);
  assert.equal(await pg.$eval('[name="preset"]', e => e.value), '', 'one-time job does not repeat');
  assert.deepEqual(await pg.$$eval('[name="preset"] option', o => o.map(x => x.textContent)).then(x => [x.length, ...x.slice(0, 3), x[6]]), [7, 'Does not repeat', 'Daily', 'Every weekday (Monday to Friday)', 'Custom'], 'HCP-style repeat menu');
  await pg.fill('[name="visit_date"]', '2026-11-04'); await pg.dispatchEvent('[name="visit_date"]', 'change');
  await pg.check('[name="skip_weekends"]'); await pg.fill('[name="workdays"]', '10'); await pg.dispatchEvent('[name="workdays"]', 'change');
  assert.equal(await pg.$eval('[name="end_date"]', e => e.value), '2026-11-17', '10 work days skipping weekends ends on Tuesday the 17th');
  assert.match(await pg.$eval('[name="preset"] option[value="week"]', e => e.textContent), /Weekly on Wednesday/, 'menu follows the start date'); await pg.check('dialog.inved [name="techs"][value="Ana Tech"]');
  await pg.fill('[name="notes"]', 'Check in at security'); await pg.click('dialog.inved [data-a="save"]'); await pg.waitForTimeout(500);
  // weekly crew email
  await pg.click('#tabs [data-tab="schedule"]', T); await pg.waitForTimeout(200); await pg.click('#schWeek'); await pg.waitForSelector('dialog.ask [name="mon"]', T);
  await pg.fill('dialog.ask [name="mon"]', '2026-11-02'); await pg.click('dialog.ask [data-a="ok"]'); await pg.waitForTimeout(300);
  await pg.click('dialog.ask [data-t="Rigo Perez"]'); await pg.waitForSelector('#cmBody', T);
  const es = await pg.$eval('#cmBody', e => e.value);
  assert.ok(es.startsWith('Hola Rigo,') && /martes, 3 de noviembre de 2026/.test(es) && /300 Demo Ave, Oakland, CA 94612/.test(es) && /Equipo|Trabajo|Limpieza|Alcance del trabajo/.test(es) && !/Exterior window|Window Cleaning/.test(es), 'Spanish weekly email for Rigo');
  assert.equal(await pg.$eval('#cmTo', e => e.value), 'rigo@example.com');
  await pg.click('dialog.ask [data-l="en"]'); assert.ok((await pg.$eval('#cmBody', e => e.value)).startsWith('Hi Rigo,'), 'switch to English');
  await pg.locator('dialog.ask').last().locator('[data-a="x"]').click(); await pg.click('dialog.ask [data-t="Ana Tech"]'); await pg.waitForTimeout(200);
  const en = await pg.$eval('#cmBody', e => e.value);
  assert.ok(/Wednesday, November 4, 2026 – Tuesday, November 17, 2026 \(weekdays only\)/.test(en) && !/Equipment:/.test(en) && /Check in at security/.test(en) && /Scope of work: Swing stage glass/.test(en), 'weekday job, notes and scope in the email (no equipment: the warehouse packs it)');
  await pg.locator('dialog.ask').last().locator('[data-a="x"]').click(); await pg.locator('dialog.ask').last().locator('[data-a="x"]').click();
  await pg.click('#schToday'); for (let i = 0; i < 24; i++) { if ((await pg.$eval('#schedBody b', e => e.textContent)).startsWith('November 2026')) break; await pg.click('#schNext'); await pg.waitForTimeout(80); }
  assert.equal(await pg.$$eval('[data-day="2026-11-07"] .vchip', c => c.filter(x => /Demo Plaza/.test(x.textContent)).length), 0, 'not on Saturday');
  assert.equal(await pg.$$eval('[data-day="2026-11-09"] .vchip', c => c.filter(x => /Demo Plaza/.test(x.textContent)).length), 1, 'back on Monday');
  await pg.screenshot({ path: path.join(B, 'schedule.png') });
  await pg.close();
}

// 9. Money: aging, partial payment, deposit, CSV, HCP open-invoice import; accountant sees only Money and Clients
{
  const inv = [
    { id: 'a1', inv_no: 1400, num: null, job_no: '9001', status: 'Sent', invoice_date: '2026-07-01', terms_days: 30, due_date: '2026-07-31', total: 1000, paid: 0, items: [{ description: 'x', amount: 1000 }], bill_to: { name: 'Late Co' }, source: 'hcp' },
    { id: 'a2', inv_no: 1401, num: null, status: 'Sent', invoice_date: iso(new Date()), terms_days: 30, due_date: '2099-01-01', total: 500, paid: 0, items: [{ description: 'y', amount: 500 }], bill_to: { name: 'Fresh Co' } } ];
  function iso(d) { return d.toISOString().slice(0, 10); }
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 }, acceptDownloads: true }); pg.on('pageerror', e => errs.push('money: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(x => { window.MOCK_INV = x; window.MOCK_RPC = { import_hcp_invoices: ({ payload }) => { window.__hcpinv = payload.invoices; return { data: { imported: payload.invoices.length, linked_to_jobs: 0, next_invoice_no: 1523 }, error: null }; }, import_hcp_paid_invoices: ({ payload }) => { window.__hcppaid = payload.invoices; return { data: { imported: payload.invoices.length, skipped: 0, next_invoice_no: 1523 }, error: null }; } }; }, inv);
  await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="money"]', T); await pg.waitForTimeout(300);
  const txt = await pg.$eval('#moneyBody', e => e.innerText);
  assert.ok(/Owed to us\s*\$1,500\.00/i.test(txt) && /Past due\s*\$1,000\.00/i.test(txt), 'owed and past due');
  assert.ok(/Late Co[\s\S]*Over 90 days|Late Co\t\t\t\t\$1,000\.00/.test(txt) || /Late Co/.test(txt), 'aging lists the client');
  await pg.click('[data-mpay="a1"]', T); await pg.fill('dialog.ask [name="amount"]', '400'); await pg.click('dialog.ask [data-a="ok"]'); await pg.waitForTimeout(500);
  assert.match(await pg.$eval('#moneyBody', e => e.innerText), /Owed to us\s*\$1,100\.00/i, 'partial payment lowers what is owed');
  assert.match(await pg.$eval('#moneyBody', e => e.innerText), /Not deposited yet\s*\$400\.00/i);
  await pg.click('[data-dep]', T); await pg.waitForTimeout(400);
  assert.match(await pg.$eval('#moneyBody', e => e.innerText), /Not deposited yet\s*\$0\.00/i, 'marked deposited');
  const dl = pg.waitForEvent('download', T); await pg.click('#mCsvPay'); const f = await (await dl).path(); const csv = fs.readFileSync(f, 'utf8');
  assert.ok(/Date received,Deposited,Invoice #,Customer/.test(csv) && /1400,Late Co,9001,Check,400\.00/.test(csv), 'payments CSV');
  // HCP open invoices import
  fs.writeFileSync(path.join(B, 'hcpinv.csv'), 'Invoice #,Customer name,Invoice status,Amount due,Due date,Latest send date,Job #\n1500,Demo Co,Open,$720.00,2026-09-09 12:00:00 -0700,2026-08-10 06:00:00 -0700,="10155"\n1499,Demo Co,Paid,$0.00,,,9000\n');
  await pg.click('#tabs [data-tab="settings"]', T); await pg.waitForTimeout(300);
  await pg.setInputFiles('#invImport', path.join(B, 'hcpinv.csv')); await pg.waitForSelector('dialog.ask', T);
  assert.match(await pg.$eval('dialog.ask', e => e.innerText), /1 open invoices, \$720\.00 still owed/);
  fs.writeFileSync(path.join(B, 'hcpjobs.csv'), 'Job #,Customer name,Job description,Job status,Address,Job created date,Job scheduled start date,Assigned employees,Job amount,Due amount\n9000,Demo Co,Windows,Completed,1 Demo St,,,,$1250.00,$0.00\n10155,Demo Co,Gutter Cleaning,Scheduled,"2344 Harrison St\nOakland, CA",,,,$720.00,$720.00\n');
  pg.on('dialog', d => d.accept());
  await pg.click('dialog.ask [data-a="ok"]'); await pg.waitForSelector('#pfFile', T);
  await pg.setInputFiles('#pfFile', path.join(B, 'hcpjobs.csv')); await pg.click('dialog.ask:has(#pfFile) [data-a="ok"]'); await pg.waitForTimeout(500);
  assert.deepEqual(await pg.evaluate(() => window.__hcpinv.map(x => [x.inv_no, x.job_no, x.amount_due, x.description, x.address])), [['1500', '10155', '$720.00', 'Gutter Cleaning', '2344 Harrison St, Oakland, CA']], 'open ones with what the job was and where');
  assert.deepEqual(await pg.evaluate(() => window.__hcppaid.map(x => [x.inv_no, x.job_no, x.amount])), [['1499', '9000', '$1250.00']], 'paid invoice kept with its job amount (same Jobs file, asked once)');
  await pg.close();
  const pa = await b.newPage({ viewport: { width: 1300, height: 900 } }); pa.on('pageerror', e => errs.push('accountant: ' + e.message));
  await pa.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pa.addInitScript(x => { window.MOCK_TEAM = [{ email: 'acct@x.com', name: 'Book Keeper', role: 'Accountant', active: true }]; window.MOCK_INV = x; }, inv);
  await pa.goto(BASE + '?u=acct@x.com'); await pa.waitForTimeout(900);
  const tabs = await pa.$$eval('#tabs [data-tab]', b => b.filter(x => !x.hidden).map(x => x.dataset.tab));
  assert.deepEqual(tabs, ['money', 'clients'], 'accountant sees Money and Clients only');
  assert.match(await pa.$eval('#moneyBody', e => e.innerText), /Owed to us/i);
  await pa.close();
}

// 10. Refresh keeps the tab; the job # is big on the visit
{
  const jj = { num: 'PFBS-0990', date_sent: '2026-09-01', sent_by: 'Arturo', client: 'Demo Co', property: '9 Demo St', site_address: '9 Demo St', amount: 900, status: 'Approved', hcp_job: '10240', items: [{ type: 'Service', qty: 1, description: 'Windows', amount: 900 }] };
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('jobno: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(x => { window.MOCK_EXTRA = [x]; }, jj); await pg.goto(BASE); await pg.waitForTimeout(800);
  await pg.click('#tabs [data-tab="schedule"]', T); await pg.waitForTimeout(200); await pg.reload(); await pg.waitForTimeout(900);
  assert.equal(await pg.$eval('#tabs [aria-selected="true"]', e => e.dataset.tab), 'schedule', 'refresh stays on Schedule');
  await pg.click('#tabs [data-tab="orders"]', T); await pg.waitForTimeout(300);
  assert.match(await pg.$eval('#jobsBody', e => e.innerText), /#10240 PFBS-0990/, 'Jobs tab leads with the job #');
  await pg.click('[data-schnew="PFBS-0990"]', T); await pg.waitForSelector('dialog.inved', T);
  await pg.click('dialog.inved [data-a="save"]'); await pg.waitForTimeout(500);
  await pg.click('#tabs [data-tab="schedule"]', T); await pg.click('#schToday'); await pg.waitForTimeout(300);
  await pg.click('.vchip:has-text("Demo Co")', T); await pg.waitForSelector('dialog.schedpop .sp-top h3', T);
  assert.match(await pg.$eval('dialog.schedpop .sp-top h3', e => e.textContent), /Job #10240$/);
  assert.ok(await pg.$eval('dialog.schedpop .sp-top h3', e => parseFloat(getComputedStyle(e).fontSize) >= 20), 'big');
  await pg.close();
}

// 11. Convert to job: approve → job # → schedule opens
{
  const sp = { num: 'PFBS-0995', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Demo Co', property: '5 Demo St', site_address: '5 Demo St', amount: 2400, status: 'Sent', items: [{ type: 'Service', qty: 1, description: 'Pressure wash plaza', amount: 2400 }] };
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('convert: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(x => { window.MOCK_EXTRA = [x]; sessionStorage.clear(); }, sp); await pg.goto(BASE); await pg.waitForTimeout(800);
  await pg.click('#tabs [data-tab="pipeline"]');
  await pg.fill('#q', 'PFBS-0995').catch(() => {}); await pg.waitForTimeout(300);
  await pg.click('tr[data-id="PFBS-0995"]', T); await pg.waitForSelector('#convJob', T);
  await pg.click('#convJob'); await pg.waitForSelector('#askJob', T); await pg.fill('#askJob', '10250'); await pg.click('dialog.ask [data-a="ok"]');
  await pg.waitForSelector('dialog.inved [name="visit_date"]', T);
  const st = await pg.evaluate(() => { const p = DBX.proposals.find(x => x.num === 'PFBS-0995'); return [p.status, p.hcp_job]; });
  assert.deepEqual(st, ['Approved', '10250'], 'approved with its job #');
  assert.match(await pg.$eval('[name="num"] option:checked', e => e.textContent), /Demo Co · 5 Demo St — Pressure wash plaza/, 'schedule opens on that job');
  await pg.close();
}

// 12. Home: KPIs, jobs board, job progress in the drawer, on hold
{
  const un = { num: 'PFBS-0996', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Board Unsched Co', property: '7 Board St', amount: 900, status: 'Approved', date_resolved: '2026-10-05', hcp_job: '10260', items: [{ type: 'Service', qty: 1, description: 'Windows', amount: 900 }] };
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('home: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(x => { window.MOCK_EXTRA = [x]; sessionStorage.clear(); }, un); await pg.goto(BASE); await pg.waitForTimeout(900);
  assert.equal(await pg.$eval('#tabs [aria-selected="true"]', e => e.dataset.tab), 'home', 'owner lands on Home');
  const col = await pg.$$eval('.bcol', cs => cs.map(c => [c.querySelector('h4').textContent, c.textContent]));
  const uc = col.find(c => /^Unscheduled/.test(c[0]));
  assert.ok(uc && /Board Unsched Co/.test(uc[1]) && /#10260/.test(uc[1]), 'approved job without visits is Unscheduled with its job #');
  await pg.click('[data-hopen="PFBS-0996"]'); await pg.waitForSelector('.jflow2', T);
  assert.match(await pg.textContent('.dhead .sub'), /Job for Board Unsched Co/, 'drawer says Job for client');
  assert.match(await pg.textContent('.jflow2'), /Schedule.*not scheduled.*Finish.*Invoice.*Pay/s, 'HCP-style steps: Schedule, Finish, Invoice, Pay');
  assert.ok(await pg.$('[data-jf="contract"].now') && !(await pg.$('[data-jf="sched"].now')), 'Contract / PO is the next step after approval');
  assert.equal(await pg.$('#jfJobNo'), null, 'job with a # has no Give-a-number button');
  // scheduling before the contract asks first (Cancel = stay)
  pg.once('dialog', dlg => { assert.match(dlg.message(), /No signed contract/); dlg.dismiss(); }); await pg.click('[data-jf="sched"]'); await pg.waitForTimeout(300);
  assert.ok(!(await pg.$('dialog.schedpop[open]')), 'cancel keeps it unscheduled');
  await pg.click('[data-jf="contract"]'); await pg.waitForSelector('dialog.ask [name="kind"]', T);
  await pg.check('dialog.ask [name="kind"][value="PO received"]'); await pg.fill('dialog.ask [name="po"]', '4455'); await pg.click('dialog.ask [data-a="ok"]'); await pg.waitForTimeout(500);
  const ct = await pg.evaluate(() => { const p = DBX.proposals.find(x => x.num === 'PFBS-0996'); return [p.contract_on, p.contract_note, p.po_number]; });
  assert.ok(ct[0] && ct[1] === 'PO received · PO 4455' && ct[2] === '4455', 'contract / PO saved: ' + JSON.stringify(ct));
  assert.ok(await pg.$('[data-jf="contract"].ok') && await pg.$('[data-jf="sched"].now'), 'then Schedule is next');
  await pg.click('#jfHold'); await pg.fill('dialog.ask [name="why"]', 'Client paused'); await pg.click('dialog.ask [data-a="ok"]');
  await pg.waitForSelector('.holdline', T);
  const h = await pg.evaluate(() => DBX.proposals.find(x => x.num === 'PFBS-0996'));
  assert.equal(h.on_hold_reason, 'Client paused'); assert.ok(h.on_hold_since, 'hold date saved'); assert.equal(h.status, 'Approved', 'hold keeps status');
  await pg.click('#closeD'); await pg.waitForTimeout(200);
  const held = await pg.$$eval('.bcol', cs => cs.find(c => /^On hold/.test(c.querySelector('h4').textContent)).textContent);
  assert.match(held, /Board Unsched Co/, 'held job moves to On hold column');
  await pg.close();
}

// 13. "Give it a job #" for a job approved before the CRM numbered jobs
{
  const nj = { num: 'PFBS-0997', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'No Number Co', property: '8 Test Way', amount: 500, status: 'Approved', date_resolved: '2026-10-12', items: [{ type: 'Service', qty: 1, description: 'Test', amount: 500 }] };
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('give job #: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(x => { window.MOCK_EXTRA = [x]; window.MOCK_RPC = { crm_job_numbers: () => ({ data: true, error: null }),
    assign_job_no: ({ p_num }) => { const p = DBX.proposals.find(y => y.num === p_num); p.hcp_job = '10301'; return { data: '10301', error: null }; } }; }, nj);
  await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('[data-hopen="PFBS-0997"]'); await pg.waitForSelector('#jfJobNo', T);
  await pg.click('#jfJobNo'); await pg.waitForSelector('.dhead .jobno', T);
  assert.match(await pg.textContent('.dhead .jobno'), /Job #10301/, 'job # shows big at the top');
  assert.equal(await pg.$('#jfJobNo'), null, 'button goes away');
  await pg.close();
}

// 14. Settings → Warehouse: add a KitTracker login
{
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('warehouse: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.goto(BASE); await pg.waitForTimeout(800);
  await pg.click('#tabs [data-tab="settings"]'); await pg.waitForSelector('#whAdd', T);
  await pg.fill('#s-wh', 'Warehouse@Example.com'); await pg.click('#whAdd'); await pg.waitForTimeout(300);
  assert.match(await pg.textContent('#whList'), /warehouse@example\.com/, 'login listed (lower case)');
  await pg.close();
}

// 15. A report already started with an empty work list takes the work from the job when opened
{
  const sr = { id: 'sr-empty-1', status: 'pending', num: 'PFBS-0963', created_at: new Date().toISOString(), doc: { client: 'DEMO CLIENT', work: [''], categories: {} } };
  const pg = await page('reports.html?num=PFBS-0963', { sr: [sr], width: 430 });
  await pg.waitForSelector('#f_work', T);
  assert.deepEqual(await pg.$$eval('#f_work input, #f_work textarea', e => e.map(x => x.value).filter(Boolean)), ['EXTERIOR WINDOW CLEANING', 'PRESSURE WASH ENTRY'], 'work filled from the job');
  await pg.close();
}

// 16. Warehouse tab: same sign-in, CRM schedule import, packed kit shows on the CRM job
{
  const today = new Date().toISOString().slice(0, 10);
  const vis = { id: 'v-wh-1', job_no: '10305', num: 'PFBS-0998', visit_date: today, client: 'Kit Co', property: '3 Kit Ave', address: '3 Kit Ave, Fremont', techs: ['Rigo', 'Israel'], work: ['Pressure Washing'], equipment: ['Boom Lift'], materials: [{ desc: 'Degreaser 5 gal', qty: 2 }], vehicle: 'Truck 2', notes: '', scope: ['Wash plaza'] };
  const pg = await b.newPage({ viewport: { width: 1100, height: 900 } }); pg.on('pageerror', e => errs.push('warehouse page: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic|jsdelivr|firestore/, r => r.abort());
  await pg.addInitScript(v => { window.MOCK_RPC = { can_warehouse: () => ({ data: true, error: null }), warehouse_jobs: () => ({ data: [v], error: null }) }; }, vis);
  await pg.goto(BASE + 'warehouse.html'); await pg.waitForTimeout(900);
  assert.equal(await pg.$eval('#device-auth-screen', e => e.style.display), 'none', 'signed-in CRM user goes straight in');
  await pg.waitForSelector('#scheduled-jobs-list .job-card', { state: 'attached', timeout: 8000 });
  const tp = await pg.textContent('#scheduled-jobs-card');
  assert.match(tp, /Jobs to pack/); assert.match(tp, /#10305 — Kit Co/); assert.match(tp, /TODAY/); assert.ok(!/TechSched/.test(tp), 'no TechSched / HCP IDs on the dashboard');
  assert.ok(!(await pg.evaluate(() => document.body.innerHTML.includes('Import from TechSched Schedule'))), 'TechSched import button gone');
  await pg.evaluate(() => openCrmImport()); await pg.waitForSelector('.sched-job-card', T);
  await pg.click('.sched-job-card');
  assert.equal(await pg.$eval('#co-jobnum', e => e.value), '10305'); assert.equal(await pg.$eval('#co-jobnum', e => e.dataset.visit), 'v-wh-1', 'remembers the CRM visit');
  assert.equal(await pg.$eval('#co-names', e => e.value), 'Rigo, Israel');
  const km = await pg.evaluate(() => { templates.push({ id: 'tpw', name: 'Pressure Washing', template_items: [{ item_name: 'Surface cleaner', quantity: 1, quantity_mode: 'fixed' }] }); selectedTemplateIds = ['tpw']; calcKit(); selectedTemplateIds = ['tpw']; calcKit(); return { t: templates.length, m: coJobMaterials.length, items: coItems.map(i => i.name + ':' + i.qty) }; });
  assert.equal(km.m, 1, 'the job\'s materials came over from the CRM');
  const kits = await pg.evaluate(() => { templates.push({ id: 'tw', name: 'Window Cleaning', template_items: [] }, { id: 'tiw', name: 'Interior Window Cleaning', template_items: [] });
    return [jobKitNames('Exterior window cleaning - all elevations').map(n => findTemplate(n).id), jobKitNames('Interior window cleaning').map(n => findTemplate(n).id), jobKitNames('Interior & exterior window cleaning').map(n => findTemplate(n).id)]; });
  assert.deepEqual(kits, [['tw'], ['tiw'], ['tw', 'tiw']], 'interior and exterior window jobs get their own kits');
  const fb = await pg.evaluate(() => { templates.splice(templates.findIndex(t => t.id === 'tiw'), 1); return findTemplate('Interior Window Cleaning').id; });
  assert.equal(fb, 'tw', 'no interior kit yet: falls back to the window kit');
  // one click: all of a day's job packets (tomorrow by default), unpacked ones warn first
  const day = await pg.evaluate(() => scheduledJobsCache[0]?._raw?.visit_date);
  const dmsg = []; const acc = d => { dmsg.push(d.message()); d.accept(); }; pg.on('dialog', acc);
  await pg.evaluate(d => printDayPackets('en', d), day); await pg.waitForSelector('#jsWrap .jspk', T); pg.off('dialog', acc);
  assert.ok(dmsg.some(m => /don't have a packed kit yet/.test(m)), 'warns about jobs without a kit');
  assert.match(await pg.textContent('#jsWrap'), /Job sheet[\s\S]*10305[\s\S]*Not packed yet/, 'packet for the day');
  await pg.click('#jsWrap [data-js="x"]');
  assert.equal(await pg.evaluate(() => { JP.open([{ job: '1', client: 'A' }, { job: '2', client: 'B', kit: { items: [{ name: 'Pole', qty: 1 }] } }], 'en'); return document.querySelectorAll('#jsWrap .jspk').length; }), 2, 'several packets in one print');
  await pg.click('#jsWrap [data-js="x"]');
  // the warehouse prints the whole job packet: page 1 from the CRM schedule, page 2 its kit
  assert.ok(await pg.evaluate(() => printJobPacket({ visit_id: 'v-wh-1', job_items: [{ item_name: 'Surface cleaner', quantity: 1 }, { item_name: 'Old hose', quantity: 1, is_removed: true }] }, 'en')), 'packet printed');
  const wp = await pg.textContent('#jsWrap');
  assert.ok(/Job sheet/.test(wp) && /10305/.test(wp) && /Kit Co/.test(wp) && /Kit slip[\s\S]*Surface cleaner/.test(wp) && !/Old hose/.test(wp) && !/\$/.test(wp), 'warehouse packet: job sheet + kit slip, no prices');
  await pg.click('#jsWrap [data-js="x"]');
  assert.ok(km.items.includes('Degreaser 5 gal:2') && km.items.includes('Surface cleaner:1') && km.items.length === 2, 'materials go into the kit: ' + km.items.join(', '));
  await pg.close();
  const p2 = await b.newPage({ viewport: { width: 1100, height: 900 } }); p2.on('pageerror', e => errs.push('warehouse denied: ' + e.message));
  await p2.route(/fonts\.googleapis|fonts\.gstatic|jsdelivr|firestore/, r => r.abort());
  await p2.addInitScript(() => { window.MOCK_RPC = { can_warehouse: () => ({ data: false, error: null }) }; });
  await p2.goto(BASE + 'warehouse.html?u=nobody@x.com'); await p2.waitForTimeout(700);
  assert.match(await p2.textContent('#da-err'), /not set up for the warehouse/, 'other logins are refused');
  await p2.close();
  // the CRM job shows the kit
  const kj = { num: 'PFBS-0998', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Kit Co', property: '3 Kit Ave', amount: 800, status: 'Scheduled', date_resolved: '2026-10-10', hcp_job: '10305', items: [{ type: 'Service', qty: 1, description: 'Wash plaza', amount: 800 }] };
  const p3 = await b.newPage({ viewport: { width: 1300, height: 950 } }); p3.on('pageerror', e => errs.push('kit on job: ' + e.message));
  await p3.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await p3.addInitScript(x => { window.MOCK_EXTRA = [x]; window.MOCK_KITS = [{ id: 'k1', hcp_job_number: '10305', status: 'packed', packed_at: '2026-10-12T15:00:00Z', tech_names: 'Rigo, Israel' }]; sessionStorage.clear(); }, kj);
  await p3.goto(BASE); await p3.waitForTimeout(900);
  assert.ok(await p3.$('#whTab:not([hidden])'), 'Warehouse tab in the CRM menu');
  await p3.click('[data-hopen="PFBS-0998"]'); await p3.waitForSelector('.jflow2', T);
  assert.match(await p3.textContent('#jfBox'), /Kit packed/, 'kit status on the job');
  assert.equal(await p3.evaluate(() => pfbsToEs('Pressure washing - parking structure')), 'Lavado a presión - estructura de estacionamiento', 'scope in Spanish');
  assert.equal(await p3.evaluate(() => pfbsToEs('Window Cleaning')), 'Limpieza de ventanas');
  await p3.close();
}

// 17. Schedule → Import from TechSched: copies upcoming jobs, links by address, runs again without duplicates
{
  const d1 = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10), old = '2020-01-01';
  const fs = (id, f) => ({ name: 'projects/x/databases/(default)/documents/jobs/' + id, fields: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Array.isArray(v) ? { arrayValue: { values: v.map(x => ({ stringValue: x })) } } : { stringValue: v }])) });
  const docs = [fs('a1', { date: d1, start: '07:00', end: '15:30', address: '44 Import Street, Fremont, CA', client: 'Import Co', jobNum: '513314634', techs: ['Rigo', 'Baldemar Cervantes'], types: ['Pressure Washing'], equipment: ['Boom Lift'], jobStatus: 'scheduled', adminNotes: 'Gate code 1234', rentalCo: 'Sunbelt', pickupDate: d1 }),
    fs('a2', { date: d1, start: '08:00', end: '12:00', address: '9 Nowhere Rd, Hayward', client: 'Walk-in', techs: ['Israel Hernandez'], types: ['Window Cleaning'], jobStatus: 'scheduled' }),
    fs('old', { date: old, address: '1 Old St', techs: [], jobStatus: 'scheduled' }), fs('done', { date: d1, address: '2 Done St', jobStatus: 'complete' })];
  const ij = { num: 'PFBS-0999', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Import Co', property: 'Import Plaza', site_address: '44 Import St\nFremont, CA', amount: 900, status: 'Approved', date_resolved: '2026-10-10', hcp_job: '10310', items: [{ type: 'Service', qty: 1, description: 'Wash plaza', amount: 900 }] };
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('techsched import: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  const team = { fields: { techs: { arrayValue: { values: [{ stringValue: 'Rigo Perez' }, { stringValue: 'Luis Aldana' }] } },
    techEmails: { mapValue: { fields: { 'Luis Aldana': { stringValue: 'luis@example.com' } } } },
    techSkills: { mapValue: { fields: { 'Luis Aldana': { arrayValue: { values: [{ stringValue: 'Swing Stage' }] } } } } },
    vehicles: { arrayValue: { values: [{ stringValue: 'Truck 9' }] } } } };
  await pg.route(/firestore\.googleapis\.com/, r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(/settings\/main/.test(r.request().url()) ? team : { documents: docs }) }));
  await pg.addInitScript(x => { window.MOCK_EXTRA = [x]; sessionStorage.clear(); }, ij);
  await pg.goto(BASE); await pg.waitForTimeout(800);
  await pg.click('#tabs [data-tab="schedule"]'); await pg.click('#schTs'); await pg.waitForSelector('[data-tsi]', T);
  assert.equal(await pg.$$eval('[data-tsi]', x => x.length), 2, 'only upcoming, not completed');
  assert.equal(await pg.$eval('[data-tsp="0"]', e => e.value), 'PFBS-0999', 'linked to the CRM job by street address');
  await pg.click('dialog.inved [data-a="ok"]'); await pg.waitForTimeout(500);
  let V = await pg.evaluate(() => DBX.visits.filter(v => /^techsched:/.test(v.ext_id || '')).map(v => ({ ext: v.ext_id, num: v.num, job: v.job_no, techs: v.techs, on: v.office_notes })));
  assert.equal(V.length, 2);
  const a = V.find(v => v.ext === 'techsched:a1');
  assert.equal(a.num, 'PFBS-0999'); assert.equal(a.job, '10310', 'CRM job #, not the HCP Job ID');
  assert.deepEqual(a.techs, ['Rigo Perez', 'Baldemar Cervantes'], 'tech names matched to the crew list');
  assert.match(a.on, /Sunbelt/, 'rental pickup kept in office notes');
  const crewNow = await pg.evaluate(() => (DBX.settings[0].data || {}).crew || []);
  const luis = crewNow.find(c => c[0] === 'Luis Aldana');
  assert.ok(luis && luis[1] === 'luis@example.com' && luis[3].includes('Swing Stage'), 'TechSched tech added with email and capability');
  assert.ok(((await pg.evaluate(() => DBX.settings[0].data.vehicles)) || []).includes('Truck 9'), 'vehicles merged');
  // capability filter in the visit editor
  await pg.evaluate(() => document.querySelector('[data-vis]')?.click()); await pg.waitForSelector('dialog.inved [name="capf"]', T);
  await pg.selectOption('dialog.inved [name="capf"]', 'Swing Stage'); await pg.waitForTimeout(100);
  const shown = await pg.$$eval('dialog.inved .vtechs [data-tech]', L => L.filter(l => !l.hidden).map(l => l.dataset.tech));
  assert.ok(shown.includes('Luis Aldana') && !shown.includes('Israel Hernandez'), 'only techs who can do it (plus ones already picked): ' + shown.join(','));
  await pg.selectOption('dialog.inved [name="capf"]', ''); await pg.waitForTimeout(50);
  const all = await pg.$$eval('dialog.inved .vtechs [data-tech]', L => L.map(l => l.dataset.tech));
  assert.ok(all.includes('Israel Hernandez') && all.includes('Luis Aldana'), 'every tech on any job is listed');
  await pg.keyboard.press('Escape'); await pg.waitForTimeout(200);
  // run again: no duplicates
  await pg.click('#schTs'); await pg.waitForSelector('[data-tsi]', T); assert.match(await pg.textContent('dialog.inved'), /already imported: will update/);
  await pg.click('dialog.inved [data-a="ok"]'); await pg.waitForTimeout(500);
  assert.equal(await pg.evaluate(() => DBX.visits.filter(v => /^techsched:/.test(v.ext_id || '')).length), 2, 'second run updates, no duplicates');
  await pg.close();
}

// 18. Double booking: same tech, overlapping times (a night shift past midnight included) → orange on the calendar, warning on save
{
  const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const d0 = day(1), d1 = day(2);
  const jj = { num: 'PFBS-1001', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Clash Co', property: '7 Clash St', amount: 500, status: 'Scheduled', date_resolved: '2026-10-10', hcp_job: '10400', items: [{ type: 'Service', qty: 1, description: 'Windows', amount: 500 }] };
  const vis = [{ id: 'n1', num: 'PFBS-1001', kind: 'job', status: 'Scheduled', visit_date: d0, start_time: '22:00', end_time: '06:00', techs: ['Rigo Perez'], work: [], equipment: [] },
               { id: 'n2', num: 'PFBS-1001', kind: 'job', status: 'Scheduled', visit_date: d1, start_time: '05:00', end_time: '09:00', techs: ['Rigo Perez'], work: [], equipment: [] },
               { id: 'n3', num: 'PFBS-1001', kind: 'job', status: 'Scheduled', visit_date: d1, start_time: '10:00', end_time: '14:00', techs: ['Rigo Perez'], work: [], equipment: [] }];
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('double booking: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(([x, v]) => { window.MOCK_EXTRA = [x]; window.MOCK_VIS = v; sessionStorage.clear(); }, [jj, vis]);
  await pg.goto(BASE); await pg.waitForTimeout(800);
  await pg.click('#tabs [data-tab="schedule"]'); await pg.waitForTimeout(300);
  if (!(await pg.$('[data-vis="n2"]'))) { await pg.click('#schNext'); await pg.waitForTimeout(200); }
  assert.ok(await pg.$('.vchip.dbl[data-vis="n2"]'), 'the 5 AM job overlaps the night shift: orange');
  assert.equal(await pg.$('.vchip.dbl[data-vis="n3"]'), null, 'the 10 AM job does not overlap');
  await pg.click('[data-vis="n2"]'); await pg.waitForSelector('dialog.inved', T);
  await pg.click('dialog.inved [data-a="save"]'); await pg.waitForSelector('text=Double booked', T);
  assert.match(await pg.textContent('dialog.ask:last-of-type'), /Rigo Perez/);
  await pg.close();
}

// 19. Visit: job notes shown (office only) with one click to add them for the crew; a new visit carries the last visit's crew notes
{
  const nj = { num: 'PFBS-1002', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Notes Co', property: '8 Note St', amount: 400, status: 'Scheduled', date_resolved: '2026-10-10', hcp_job: '10410', notes: 'Gate code 4321 at the office', items: [{ type: 'Service', qty: 1, description: 'Windows', amount: 400 }] };
  const vis = [{ id: 'm1', num: 'PFBS-1002', kind: 'job', status: 'Done', visit_date: '2026-09-01', start_time: '08:00', end_time: '12:00', techs: [], work: [], equipment: [], notes: 'Park in back' }];
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('visit notes: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(([x, v]) => { window.MOCK_EXTRA = [x]; window.MOCK_VIS = v; sessionStorage.clear(); }, [nj, vis]);
  await pg.goto(BASE); await pg.waitForTimeout(800);
  await pg.click('[data-hopen="PFBS-1002"]'); await pg.waitForSelector('#jfBox', T);
  await pg.evaluate(() => document.querySelector('#visNew, [data-jf="sched"]')?.click()); await pg.waitForSelector('dialog.inved [name="notes"]', T);
  assert.equal(await pg.$eval('dialog.inved [name="notes"]', e => e.value), 'Park in back', 'crew notes carried from the last visit');
  assert.match(await pg.textContent('dialog.inved'), /Gate code 4321/, 'job notes shown');
  await pg.click('dialog.inved [data-a="usenotes"]');
  assert.match(await pg.$eval('dialog.inved [name="notes"]', e => e.value), /Park in back\nGate code 4321/, 'added to crew notes in one click');
  // HCP-style: the schedule pops up with the month calendar beside the form; this job in gold; click a day to move it
  await pg.waitForSelector('dialog.schedpop .sp-cal .sgrid', T);
  assert.ok(await pg.$('dialog.schedpop .sp-cal .vchip.mine'), 'this job shows on the calendar');
  const d0 = await pg.$eval('dialog.inved [name="visit_date"]', e => e.value);
  const pick = await pg.$$eval('dialog.schedpop [data-pday]', (L, d0) => L.map(x => x.dataset.pday).find(x => x !== d0 && x.slice(0, 7) === d0.slice(0, 7)), d0);
  await pg.click(`dialog.schedpop [data-pday="${pick}"]`);
  assert.equal(await pg.$eval('dialog.inved [name="visit_date"]', e => e.value), pick, 'clicking a day sets the date');
  assert.equal(await pg.$eval(`dialog.schedpop [data-pday="${pick}"]`, e => !!e.querySelector('.vchip.mine')), true, 'gold chip moves to the new day');
  await pg.click('dialog.schedpop [data-pc="next"]'); assert.ok(await pg.$('dialog.schedpop .sp-cal .sgrid'), 'next month');
  await pg.close();
}

// 20. Payment reminders: due by the schedule, email opens, sending records it
{
  const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const inv = [{ id: 'r1', inv_no: 1600, num: null, status: 'Sent', invoice_date: day(-40), terms_days: 30, due_date: day(-10), total: 500, paid: 0, bill_to: { name: 'Late Payer Co', email: 'ap@late.example' }, items: [{ description: 'Windows', amount: 500 }], reminders: [] },
               { id: 'r2', inv_no: 1601, num: null, status: 'Sent', invoice_date: day(-5), terms_days: 30, due_date: day(25), total: 300, paid: 0, bill_to: { name: 'Early Co', email: 'ap@early.example' }, items: [{ description: 'Windows', amount: 300 }], reminders: [] }];
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 }, acceptDownloads: true }); pg.on('pageerror', e => errs.push('reminders: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(x => { window.MOCK_INV = x; sessionStorage.clear(); window.open = () => null; }, inv);
  await pg.goto(BASE); await pg.waitForTimeout(800);
  await pg.click('#tabs [data-tab="money"]'); await pg.waitForTimeout(300);
  assert.ok(await pg.$('[data-mrem="r1"][data-day="7"]'), '10 days late → the 7-days-late reminder is due');
  assert.equal(await pg.evaluate(() => !!document.querySelector('[data-mrem="r2"]')), false, 'not due yet → no reminder');
  const dl = pg.waitForEvent('download', T); await pg.click('[data-mrem="r1"]'); await dl; await pg.waitForSelector('#rmBody', T);
  assert.match(await pg.$eval('#rmBody', e => e.value), /(9|10|11) days past due/); assert.ok(!/Best regards/.test(await pg.$eval('#rmBody', e => e.value)), 'no signature');
  await pg.click('dialog.ask [data-a="owa"]'); await pg.waitForTimeout(300);
  assert.deepEqual(await pg.evaluate(() => DBX.invoices.find(v => v.id === 'r1').reminders.map(r => r.day)), [7], 'reminder recorded');
  assert.equal(await pg.evaluate(() => !!document.querySelector('[data-mrem="r1"]')), false, 'and it leaves the list (earlier steps are not offered again)');
  // each invoice once, clickable; filters
  assert.equal(await pg.evaluate(() => document.querySelectorAll('tr[data-mrow="r1"]').length), 1, 'each invoice listed once');
  await pg.click('tr[data-mrow="r1"] td.wrap'); await pg.waitForSelector('dialog.invview', T);
  const iv = await pg.textContent('dialog.invview');
  assert.match(iv, /Invoice #1600/, 'clicking an invoice opens the invoice itself, like HousecallPro');
  assert.match(iv, /Amount due[\s\S]*\$500\.00/); assert.match(iv, /Late Payer Co[\s\S]*ap@late\.example/, 'bill-to with email');
  assert.match(iv, /Activity[\s\S]*Payment reminder emailed/, 'history: the reminder just sent');
  assert.ok(await pg.$('dialog.invview [data-a="print"]') && await pg.$('dialog.invview [data-a="dl"]') && await pg.$('dialog.invview [data-a="pay"]') && await pg.$('dialog.invview [data-a="send"]'), 'Print, Download, Pay, Send');
  await pg.click('dialog.invview [data-a="edit"]'); await pg.waitForSelector('dialog.inved', T); assert.match(await pg.textContent('dialog.inved'), /1600/, 'Edit opens the form');
  await pg.keyboard.press('Escape'); await pg.waitForTimeout(200);
  await pg.click('[data-mf="Overdue"]'); assert.equal(await pg.evaluate(() => [...document.querySelectorAll('tr[data-mrow]')].map(r => r.dataset.mrow).join()), 'r1', 'overdue filter');
  await pg.close();
}

// 21. Top bar: search everything, and "+ New" → Job (approved, then the schedule opens)
{
  const sj = { num: 'PFBS-1003', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Searchable Towers', property: '9 Find St', amount: 700, status: 'Scheduled', date_resolved: '2026-10-10', hcp_job: '10420', items: [{ type: 'Service', qty: 1, description: 'Skylight cleaning', amount: 700 }] };
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('top bar: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(x => { window.MOCK_EXTRA = [x]; sessionStorage.clear(); }, sj);
  await pg.goto(BASE); await pg.waitForTimeout(800);
  assert.ok(await pg.isVisible('#gq'), 'search box in the top bar');
  assert.equal(await pg.$eval('#gq', e => getComputedStyle(e).color), 'rgb(26, 26, 26)', 'typed text is dark on the white box (was white on white)');
  await pg.keyboard.press('/'); await pg.keyboard.type('10420'); await pg.waitForSelector('#gres .gitem', T);
  assert.match(await pg.textContent('#gres'), /Job #10420 · Searchable Towers/, 'finds a job by its job #');
  await pg.fill('#gq', 'skylight'); await pg.waitForTimeout(250); assert.match(await pg.textContent('#gres'), /Searchable Towers/, 'finds by scope of work');
  await pg.keyboard.press('Enter'); await pg.waitForSelector('#drawer:not([hidden]) .jflow2', T);
  assert.match(await pg.textContent('.dhead'), /Job #10420/, 'Enter opens it');
  await pg.click('#closeD'); await pg.waitForTimeout(200);
  await pg.click('#gNew'); assert.deepEqual(await pg.$$eval('#gMenu [data-gnew]', L => L.map(x => x.dataset.gnew)), ['job', 'recurring', 'proposal', 'event', 'customer', 'lead', 'walk'], 'HCP-style New menu');
  await pg.click('[data-gnew="job"]'); await pg.waitForSelector('dialog.jobpage', T);
  // new customer, address, a service and a material, a tech, then Save job
  await pg.click('dialog.jobpage [data-a="newcl"]'); await pg.fill('[name="nc_name"]', 'Walk-in Job Co'); await pg.fill('[name="nc_email"]', 'walk@in.example');
  await pg.fill('[name="site"]', '1 Quick St\nFremont, CA');
  await pg.fill('.jpsvc [data-lf="desc"]', 'Window cleaning'); await pg.fill('.jpsvc [data-lf="qty"]', '2'); await pg.fill('.jpsvc [data-lf="price"]', '150');
  await pg.click('dialog.jobpage [data-a="addmat"]'); await pg.fill('.jpmat [data-lf="desc"]', 'Squeegee rubber'); await pg.fill('.jpmat [data-lf="price"]', '20');
  assert.match(await pg.textContent('.jptot'), /Total\s*\$32\d\.\d\d/, 'running total with tax on materials');
  const tech = await pg.$('.jpteam [name="techs"]'); if (tech) await tech.check();
  await pg.click('dialog.jobpage [data-a="save"]'); await pg.waitForSelector('#drawer:not([hidden])', T); await pg.waitForTimeout(300);
  const made = await pg.evaluate(() => { const p = DBX.proposals.find(x => x.client === 'Walk-in Job Co'); return p && { st: p.status, items: (p.items || []).map(i => [i.description, i.amount]), v: DBX.visits.filter(v => v.num === p.num).length, cl: DBX.clients.some(c => c.name === 'Walk-in Job Co') }; });
  assert.equal(made.st, 'Scheduled', 'Save job → an official job, already Scheduled'); assert.equal(made.v, 1, 'and it is on the schedule'); assert.ok(made.cl, 'customer created once');
  assert.deepEqual(made.items.slice(0, 2), [['Window cleaning', 300], ['Materials: Squeegee rubber', 20]], 'line items: qty × price');
  await pg.close();
}

// 22. Phone width: no tab is wider than the screen (tables scroll inside their card)
{
  const pg = await b.newPage({ viewport: { width: 390, height: 900 } }); pg.on('pageerror', e => errs.push('phone: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort()); await pg.addInitScript(() => sessionStorage.clear());
  await pg.goto(BASE); await pg.waitForTimeout(800);
  const tabs = await pg.$$eval('#tabs [data-tab]', L => L.filter(x => !x.hidden).map(x => x.dataset.tab)), wide = [];
  for (const t of tabs) { await pg.click('#tabs [data-tab="' + t + '"]'); await pg.waitForTimeout(200); const ov = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (ov > 4) wide.push(t + ' +' + ov + 'px'); }
  assert.deepEqual(wide, [], 'no sideways scrolling on a phone');
  await pg.close();
}

// 23. Price book: one list; picking a service or material fills its price (New job, proposals, invoices)
{
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('price book: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(() => { window.MOCK_SETTINGS = { priceBook: [['Gutter cleaning', 450, 'visit', 'Clean and flush gutters']] }; sessionStorage.clear(); });
  await pg.goto(BASE); await pg.waitForTimeout(800);
  await pg.click('#gNew'); await pg.click('[data-gnew="job"]'); await pg.waitForSelector('dialog.jobpage', T);
  await pg.fill('.jpsvc [data-lf="desc"]', 'Gutter cleaning'); await pg.waitForTimeout(100);
  assert.equal(await pg.$eval('.jpsvc [data-lf="price"]', e => e.value), '450', 'typed a price book service → price fills in');
  await pg.click('dialog.jobpage [data-a="pbmat"]'); await pg.waitForSelector('[data-pb]', T);
  const first = await pg.$eval('[data-pb]', e => e.dataset.pb); await pg.click('[data-pb]'); await pg.waitForTimeout(100);
  assert.equal(await pg.$eval('.jpmat [data-lf="desc"]', e => e.value), first, 'material picked from the price book (Material presets, no second list)');
  assert.ok(Number(await pg.$eval('.jpmat [data-lf="price"]', e => e.value)) > 0, 'material priced at cost + markup');
  await pg.keyboard.press('Escape'); await pg.waitForTimeout(200);
  // proposal line: description from the book fills the empty amount
  await pg.click('#tabs [data-tab="pipeline"]'); await pg.click('#newBtn'); await pg.waitForSelector('[data-it="description"]', T);
  await pg.fill('[data-it="amount"]', ''); await pg.fill('[data-it="description"]', 'Gutter cleaning'); await pg.dispatchEvent('[data-it="description"]', 'change');
  assert.equal(await pg.$eval('[data-it="amount"]', e => e.value), '450', 'proposal line priced from the book');
  await pg.close();
}

// 24. Customer page like HousecallPro: summary, tabs, and + Job already set to this customer
{
  const c = { id: 'c-pg', name: 'Page Test Realty', kind: 'Business', aliases: [], active: true, billing_address: '1 Bill St\nOakland, CA', created_at: '2026-09-14T10:00:00Z' };
  const pr = { id: 'p-pg', client_id: 'c-pg', name: 'Page Tower', address: '2 Page St\nOakland, CA', active: true, addr_key: '2 PAGE ST' };
  const k = { id: 'k-pg', client_id: 'c-pg', name: 'Kris Page', email: 'kris@page.example', phone: '5105550000', is_primary: true, active: true };
  const job = { num: 'PFBS-1004', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Page Test Realty', client_id: 'c-pg', property: 'Page Tower', amount: 900, status: 'Scheduled', date_resolved: '2026-10-05', hcp_job: '10430', items: [{ type: 'Service', qty: 1, description: 'Windows', amount: 900 }] };
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('customer page: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic|maps\.google/, r => r.abort());
  await pg.addInitScript(([c, pr, k, job]) => { window.MOCK_CLIENTS = [c]; window.MOCK_PROPS = [pr]; window.MOCK_CONTACTS = [k]; window.MOCK_EXTRA = [job]; try { if (window.name !== 'kept') { sessionStorage.clear(); window.name = 'kept'; } } catch (_) {} }, [c, pr, k, job]);
  await pg.goto(BASE); await pg.waitForTimeout(800);
  await pg.click('#tabs [data-tab="clients"]'); await pg.click('tr[data-cl="c-pg"]'); await pg.waitForSelector('.cltabs', T);
  assert.deepEqual(await pg.$$eval('.cltabs [data-cltab]', L => L.map(x => x.dataset.cltab)), ['profile', 'leads', 'proposals', 'jobs', 'invoices', 'notes'], 'HCP-style tabs');
  assert.match(await pg.textContent('#clientsBody'), /Kris Page/); assert.match(await pg.textContent('#clientsBody'), /Billing/);
  await pg.click('[data-cltab="jobs"]'); assert.match(await pg.textContent('#clientsBody'), /#10430/, 'jobs tab lists the job');
  await pg.reload(); await pg.waitForSelector('.cltabs', T); await pg.waitForTimeout(300);
  assert.equal(await pg.$eval('.cltabs [aria-selected="true"]', e => e.dataset.cltab), 'jobs', 'a refresh keeps the client and its tab');
  assert.match(await pg.textContent('#clientsBody'), /Page Test Realty/);
  await pg.click('[data-clnew="job"]'); await pg.waitForSelector('dialog.jobpage .jpsel:not([hidden])', T);
  assert.match(await pg.textContent('dialog.jobpage .jpsel'), /Page Test Realty/, '+ Job starts with this customer'); assert.match(await pg.$eval('[name="site"]', e => e.value), /2 Page St/, 'its only property fills the address');
  await pg.keyboard.press('Escape'); await pg.waitForTimeout(150);
  await pg.click('[data-cltab="notes"]'); await pg.fill('#cl-notes', 'Gate code 1234'); await pg.click('#clSave'); await pg.waitForTimeout(400);
  assert.equal(await pg.evaluate(() => DBX.clients.find(x => x.id === 'c-pg').notes), 'Gate code 1234', 'notes saved from the Notes tab (other fields untouched)');
  assert.equal(await pg.evaluate(() => DBX.clients.find(x => x.id === 'c-pg').name), 'Page Test Realty');
  await pg.close();
}

// 25. Crew: one row per tech with capability checkboxes; other spellings merge into one tech everywhere; inactive techs leave the pickers
{
  const d0 = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
  const crewS = { crew: [['Rigo Perez', 'rigo@example.com', 'es', ['Swing Stage']], ['Baldemar Cervantes', '', 'es', []], ['Old Tech', '', 'es', [], [], true]], skillOptions: ['Swing Stage', 'Pressure Washing'] };
  const vis = [{ id: 'cr1', kind: 'job', status: 'Scheduled', visit_date: d0, start_time: '08:00', end_time: '12:00', address: '1 Crew St', techs: ['Rigoberto', 'Juan Nuevo'], work: [], equipment: [] },
               { id: 'cr2', kind: 'job', status: 'Scheduled', visit_date: d0, start_time: '13:00', end_time: '15:00', address: '2 Crew St', techs: ['rigo perez'], work: [], equipment: [] }];
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('crew: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(([s, v]) => { window.MOCK_SETTINGS = s; window.MOCK_VIS = v; }, [crewS, vis]);
  await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="settings"]'); await pg.waitForSelector('#crewCard', T);
  assert.ok(await pg.evaluate(() => !!document.querySelector('.savebar #saveS') && !!document.querySelector('.setnav a')), 'Save is always in reach and sections have jump links');
  assert.equal(await pg.$$eval('#crewCard tr[data-crew="0"] [data-cap]', L => L.map(x => x.checked).join()), 'true,false', 'a checkbox per capability');
  assert.match(await pg.textContent('#crewCard tr[data-crew="0"] .capdd summary'), /Swing Stage/, 'capabilities sit in a dropdown that shows what is ticked');
  assert.equal(await pg.$eval('#crewCard tr[data-crew="2"]', e => e.hidden), true, 'inactive techs hidden by default');
  await pg.fill('#crewQ', 'bald'); assert.deepEqual(await pg.$$eval('#crewCard tr[data-crew]', L => L.filter(x => !x.hidden).map(x => x.dataset.crew)), ['1'], 'search finds a tech');
  await pg.fill('#crewQ', ''); await pg.selectOption('#crewCapF', 'Swing Stage'); assert.deepEqual(await pg.$$eval('#crewCard tr[data-crew]', L => L.filter(x => !x.hidden).map(x => x.dataset.crew)), ['0'], 'filter by capability');
  await pg.selectOption('#crewCapF', '');
  await pg.click('#crewCard tr[data-crew="1"] .capdd summary'); await pg.check('#crewCard tr[data-crew="1"] [data-cap="Pressure Washing"]');
  assert.match(await pg.textContent('#crewCard tr[data-crew="1"] .capdd summary'), /Pressure Washing/, 'summary updates when ticked');
  await pg.uncheck('#crewCard tr[data-crew="1"] [data-cap="Pressure Washing"]');
  assert.ok(await pg.evaluate(() => [...document.querySelectorAll('#crewCard [data-crewadd]')].map(x => x.dataset.crewadd).join() === 'Rigoberto,Juan Nuevo'), 'names on the schedule but not in the crew are offered');
  await pg.evaluate(() => { const R = document.querySelector('#crewCard tr[data-crew="0"]'); R.querySelector('[data-cf="aka"]').value = 'Rigoberto'; R.querySelector('[data-cap="Pressure Washing"]').checked = true; });
  await pg.click('#crewCard [data-crewa="cap"]'); await pg.fill('dialog [name="k"]', 'Rope Access'); await pg.click('dialog .btn:not(.ghost)'); await pg.waitForTimeout(150);
  assert.equal(await pg.$eval('#crewCard tr[data-crew="0"] [data-cf="aka"]', e => e.value), 'Rigoberto', 'typing is kept when a capability is added');
  await pg.click('#crewCard [data-crewadd="Juan Nuevo"]'); await pg.waitForTimeout(100);
  await pg.evaluate(() => { const R = [...document.querySelectorAll('#crewCard tr[data-crew]')].pop(); R.querySelector('[data-cap="Rope Access"]').checked = true; });
  await pg.click('#saveS'); await pg.waitForTimeout(800);
  const saved = await pg.evaluate(() => DBX.settings[0].data);
  assert.deepEqual(saved.crew[0], ['Rigo Perez', 'rigo@example.com', 'es', ['Swing Stage', 'Pressure Washing'], ['Rigoberto']]);
  assert.deepEqual(saved.crew[3], ['Juan Nuevo', '', 'es', ['Rope Access']]); assert.deepEqual(saved.skillOptions, ['Swing Stage', 'Pressure Washing', 'Rope Access']);
  assert.deepEqual(await pg.evaluate(() => DBX.visits.filter(v => v.id.startsWith('cr')).map(v => v.techs)), [['Rigo Perez', 'Juan Nuevo'], ['Rigo Perez']], 'other spellings fixed on the visits');
  await pg.click('#tabs [data-tab="schedule"]'); await pg.waitForSelector('#schTech', T);
  assert.deepEqual(await pg.$$eval('#schTech option', L => L.map(o => o.textContent)), ['All techs', 'Rigo Perez', 'Baldemar Cervantes', 'Juan Nuevo'], 'each tech once; inactive left out');
  await pg.click('#schWeek'); await pg.waitForSelector('dialog [name="mon"]', T); await pg.click('dialog .btn:not(.ghost)'); await pg.waitForTimeout(200);
  assert.match(await pg.textContent('dialog.ask:last-of-type'), /Juan Nuevo/, 'weekly crew emails include every tech');
  await pg.close();
}

// 26. Pricing: rentals, materials and tax are costs (only their markup is profit) on every sheet, solar included; client address drop-down on proposals
{
  const est = { sheet: 'SP', units: [{ desc: 'Solar panels', qty: 1386, rate: 1 }], labor: [{ role: 'Expert', hours: 16, rate: 0, wage: 32 }], materials: [{ desc: 'Resin', unit: 80, qty: 1, markup: 0.8 }], taxRate: 0.1075,
    rentals: [{ desc: '40 boom lift', unit: 1920.05, qty: 1, markup: 0.15 }], equipment: [], misc: [] };
  const pr = { num: 'PFBS-1010', date_sent: '2026-10-10', sent_by: 'Arturo', client: 'Addr Test Co', client_id: 'c-ad', property: 'Old', status: 'Sent', items: [{ type: 'Base', qty: 1, description: 'Solar panel cleaning', amount: null, estimate: est }] };
  const c = { id: 'c-ad', name: 'Addr Test Co', kind: 'Business', aliases: [], active: true };
  const props = [{ id: 'pa1', client_id: 'c-ad', name: 'Addr Test Co', address: '3536 Mendo Ave\nSanta Rosa, CA', active: true }, { id: 'pa2', client_id: 'c-ad', name: 'Addr Test Co', address: '39141 Civic Dr\nFremont, CA', active: true, contact_id: 'k-ad' }];
  const k = { id: 'k-ad', client_id: 'c-ad', name: 'Terry Site', email: 'terry@site.example', active: true };
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('pricing: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(([x, c, pp, k]) => { window.MOCK_EXTRA = [x]; window.MOCK_CLIENTS = [c]; window.MOCK_PROPS = pp; window.MOCK_CONTACTS = [k]; window.MOCK_SETTINGS = { est: Object.assign({}, { burden: 0 }) }; }, [pr, c, props, k]);
  await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="pipeline"]'); await pg.waitForTimeout(200); await pg.evaluate(() => document.querySelector('[data-f="all"], [data-filter="all"]')?.click());
  await pg.click('tr[data-id="PFBS-1010"]'); await pg.waitForSelector('#f-propPick', T);
  assert.deepEqual(await pg.$$eval('#f-propPick option', L => L.map(o => o.textContent)), ['— Choose an address —', '3536 Mendo Ave, Santa Rosa, CA', '39141 Civic Dr, Fremont, CA', 'New address (type it below)'], 'the client\'s addresses in a drop-down');
  await pg.selectOption('#f-propPick', 'pa2'); await pg.waitForTimeout(100);
  assert.equal(await pg.$eval('#f-siteAddress', e => e.value), '39141 Civic Dr\nFremont, CA'); assert.equal(await pg.$eval('#f-contactName', e => e.value), 'Terry Site', 'the site contact comes with the address');
  await pg.reload(); await pg.waitForSelector('#f-propPick', T); assert.ok(await pg.evaluate(() => !document.getElementById('drawer').hidden && document.getElementById('drawer').innerText.includes('PFBS-1010')), 'a refresh reopens the proposal');
  await pg.click('[data-est="0"]'); await pg.waitForSelector('#estTot', T);
  assert.equal(await pg.textContent('#estTitle'), 'Pricing');
  const tot = await pg.textContent('#estTot');
  assert.ok(!/price − wages/.test(tot) && /Gross profit margin/.test(tot), 'solar margin counts every cost');
  assert.match(tot, /rentals\/subs markup \$288\.01/, 'only the lift markup is profit');
  assert.match(tot, /materials markup \$64\.00/, 'only the material markup is profit');
  const nums = await pg.$$eval('#estTot dl.key dd', L => L.map(x => Number(x.textContent.replace(/[$,]/g, ''))));
  assert.ok(Math.abs(nums[0] - nums[1] - nums[2] - nums[3]) < 0.01 && Math.abs(nums[1] - (80 + 8.6 + 1920.05)) < 0.02 && Math.abs(nums[2] - 512) < 0.01, 'price = pass-through (lift, resin, tax at cost) + our cost (wages) + profit: ' + nums.join(','));
  const m = Number((await pg.$eval('#estTot .mrow b', e => e.textContent)).replace('%', '')) / 100;
  assert.ok(Math.abs(m - nums[3] / (nums[0] - nums[1])) < 0.006, 'margin = profit ÷ (price − pass-through): ' + m);
  await pg.close();
}

// 27. Proposal: blanks fill from the client record when opened, Today button, Save changes stays put, PDF preview before download
{
  const c = { id: 'c-bl', name: 'Bill Fill Co', kind: 'Business', aliases: [], active: true, billing_address: '3300 Webster St\nOakland, CA 94609', billing_email: 'ap@billfill.example' };
  const pr = { num: 'PFBS-1012', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Bill Fill Co', status: 'Estimating', items: [{ type: 'Base', qty: 1, description: 'Windows', amount: 500 }] };
  const pg = await b.newPage({ viewport: { width: 1300, height: 900 } }); pg.on('pageerror', e => errs.push('proposal open: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(([x, c]) => { window.MOCK_EXTRA = [x]; window.MOCK_CLIENTS = [c]; }, [pr, c]);
  await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="pipeline"]'); await pg.evaluate(() => [...document.querySelectorAll('button')].find(x => /^All/.test(x.textContent.trim()) && x.closest('#pipeBody, #pipeline, main'))?.click());
  await pg.evaluate(() => [...document.querySelectorAll('[data-f], [data-filter]')].find(x => /^All/.test(x.textContent.trim()))?.click());
  await pg.click('tr[data-id="PFBS-1012"]'); await pg.waitForSelector('#f-billAddress', T);
  assert.equal(await pg.$eval('#f-billAddress', e => e.value), '3300 Webster St\nOakland, CA 94609', 'billing address comes from the client record');
  assert.equal(await pg.$eval('#f-billingEmail', e => e.value), 'ap@billfill.example');
  await pg.click('#dsToday'); const td = await pg.evaluate(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); });
  assert.equal(await pg.$eval('#f-dateSent', e => e.value), td, 'Today sets the date');
  await pg.evaluate(() => { document.querySelector('#drawer .dbody').scrollTop = 500; }); const before = await pg.evaluate(() => document.querySelector('#drawer .dbody').scrollTop);
  await pg.click('#saveD'); await pg.waitForTimeout(900);
  assert.ok(await pg.evaluate(() => !document.getElementById('drawer').hidden), 'Save changes keeps the proposal open');
  assert.equal(await pg.evaluate(() => document.querySelector('#drawer .dbody').scrollTop), before, '…at the same spot');
  assert.equal(await pg.evaluate(() => DBX.proposals.find(x => x.num === 'PFBS-1012').bill_address), '3300 Webster St\nOakland, CA 94609', 'filled billing saved');
  await pg.click('#pdfD'); await pg.waitForSelector('dialog.pdfprev iframe', T);
  const dl = pg.waitForEvent('download', T); await pg.click('dialog.pdfprev [data-a="dl"]'); assert.match((await dl).suggestedFilename(), /PFBS-1012/, 'download after preview');
  await pg.close();
}

// 28. Approving asks which add-ons the client accepted; going out with unpriced lines warns first
{
  const pr = { num: 'PFBS-1013', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Addon Co', status: 'Sent', items: [{ type: 'Base', qty: 1, description: 'Windows', amount: 500 }, { type: 'Add-on', qty: 1, description: 'Carport solar', amount: 4600 }] };
  const dr = { num: 'PFBS-1014', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Draft Co', status: 'Estimating', items: [{ type: 'Base', qty: 1, description: 'Gutters', amount: 300 }] };
  const pg = await b.newPage({ viewport: { width: 1300, height: 900 } }); pg.on('pageerror', e => errs.push('add-ons: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(x => { window.MOCK_EXTRA = x; }, [pr, dr]);
  await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="pipeline"]'); await pg.click('tr[data-id="PFBS-1013"]'); await pg.waitForSelector('#convJob', T);
  await pg.click('#convJob'); await pg.waitForSelector('dialog [data-ai]', T);
  await pg.check('dialog [data-ai="1"]'); await pg.click('dialog [data-a="ok"]');
  await pg.waitForSelector('#askJob', T); await pg.fill('#askJob', '10260'); await pg.click('dialog.ask [data-a="ok"]'); await pg.waitForTimeout(1200);
  const row = await pg.evaluate(() => DBX.proposals.find(x => x.num === 'PFBS-1013'));
  assert.ok(['Approved', 'Scheduled'].includes(row.status) && row.items[1].accepted === true && Number(row.amount) === 5100, 'add-on accepted on approval, job amount includes it: ' + row.status + ' ' + row.amount);
  await pg.evaluate(() => sessionStorage.setItem('pfbs.open', 'PFBS-1014')); await pg.reload(); await pg.waitForTimeout(1200);
  let msg = ''; pg.once('dialog', async d => { msg = d.message(); await d.dismiss(); });
  await pg.evaluate(() => [...document.querySelectorAll('#drawer button')].find(x => x.textContent.trim() === 'Sent')?.click()); await pg.waitForTimeout(300);
  assert.match(msg, /Not priced yet: Gutters/, 'warns before sending unpriced lines');
  await pg.close();
}

// 29. A lift in the pricing follows the job: rental to reserve on approval, LIFT on the schedule, the visit editor, Home and the crew email
{
  const est = { sheet: 'SP', units: [{ desc: 'Solar panels', qty: 1000, rate: 2 }], labor: [{ role: 'Expert', hours: 8, rate: 0, wage: 32 }], materials: [], taxRate: 0, rentals: [{ desc: "40' Boom Lift", unit: 1900, qty: 1, markup: 0.25 }], equipment: [{ desc: 'Hot water pressure washer', unit: 75, qty: 1, markup: 0.2 }, { desc: 'Water tank', unit: 40, qty: 0, markup: 0 }], misc: [] };
  const pr = { num: 'PFBS-1015', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Lift Co', status: 'Sent', items: [{ type: 'Base', qty: 1, description: 'Carport solar', amount: 4375, estimate: est }] };
  const pg = await b.newPage({ viewport: { width: 1300, height: 900 } }); pg.on('pageerror', e => errs.push('lift: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(x => { window.MOCK_EXTRA = [x]; }, pr);
  await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="pipeline"]'); await pg.click('tr[data-id="PFBS-1015"]'); await pg.waitForSelector('#convJob', T);
  await pg.click('#convJob'); await pg.waitForSelector('#askJob', T); await pg.fill('#askJob', '10270'); await pg.click('dialog.ask [data-a="ok"]');
  await pg.waitForSelector('dialog.inved [name="visit_date"]', T);
  const parts = await pg.evaluate(() => DBX.proposals.find(x => x.num === 'PFBS-1015').parts || []);
  assert.ok(parts.some(x => x.kind === 'rental' && x.status === 'To reserve' && /Boom Lift/.test(x.desc)), 'approval puts the lift on the job as To reserve');
  assert.match(await pg.textContent('dialog.inved'), /Lift \/ rental[\s\S]*Boom Lift: To reserve[\s\S]*Not reserved yet/, 'visit editor shows the lift to reserve');
  await pg.fill('dialog.inved [name="visit_date"]', new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10));
  assert.match(await pg.textContent('#vEquip'), /Equipment[\s\S]*Hot water pressure washer/, 'equipment shows as named in the pricing');
  assert.ok(!/Water tank/.test(await pg.textContent('#vEquip')) && !(await pg.$('dialog.inved [name="equipment"]')), 'only lines with a qty; no checkboxes');
  await pg.check('dialog.inved [name="techs"] >> nth=0'); await pg.click('dialog.inved [data-a="save"]'); await pg.waitForTimeout(800);
  assert.deepEqual(await pg.evaluate(() => DBX.visits.find(x => x.num === 'PFBS-1015').equipment), ['Hot water pressure washer', "40' Boom Lift"], 'the visit keeps the pricing equipment + lift for the warehouse');
  await pg.click('#tabs [data-tab="schedule"]'); await pg.waitForTimeout(300);
  if (!(await pg.$('.vchip .clift.todo'))) { await pg.click('#schNext'); await pg.waitForTimeout(200); }
  assert.ok(await pg.$('.vchip .clift.todo'), 'LIFT tag on the schedule chip');
  await pg.click('#tabs [data-tab="home"]'); await pg.waitForTimeout(200); assert.match(await pg.textContent('#homeBody'), /Lifts \/ rentals to handle/);
  await pg.close();
}

// 29b. A job approved without its lift on the job (pricing changed later): Home alerts, and opening the job puts it on as To reserve
{
  const est = { sheet: 'WC', labor: [{ role: 'Expert', hours: 40, rate: 75 }], materials: [], taxRate: 0, rentals: [{ desc: "65' Boom Lift", unit: 2000, qty: 1, markup: 0.25 }], equipment: [], misc: [] };
  const pr = { num: 'PFBS-1016', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Late Lift Co', status: 'Approved', date_resolved: '2026-10-10', hcp_job: '10238', parts: [], items: [{ type: 'Base', qty: 1, description: 'Perimeter windows', amount: 9338, estimate: est }] };
  const pg = await b.newPage({ viewport: { width: 1300, height: 900 } }); pg.on('pageerror', e => errs.push('late lift: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(x => { window.MOCK_EXTRA = [x]; window.MOCK_KITS = [{ id: 'kk1', visit_id: 'lv1', status: 'packed' }]; window.MOCK_KIT_ITEMS = [{ job_id: 'kk1', item_name: 'WFS Resin Refill', quantity: 1 }, { job_id: 'kk1', item_name: 'Squeegee 18"', quantity: 2 }, { job_id: 'kk1', item_name: 'Squeegee old', quantity: 1, is_removed: true }, { job_id: 'kk1', item_name: 'Water-fed pole', quantity: 2 }]; window.MOCK_VIS = [{ id: 'lv1', num: 'PFBS-1016', kind: 'job', status: 'Scheduled', visit_date: '2026-12-28', start_time: '06:00', end_time: '14:30', techs: ['Rigo Perez'], work: [], equipment: [], notes: 'Gate code 4455' }]; sessionStorage.clear(); }, pr);
  await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="home"]'); await pg.waitForTimeout(200);
  assert.match(await pg.textContent('#homeBody'), /Lifts \/ rentals to handle[\s\S]*Late Lift Co/, 'Home flags the lift even before it is saved on the job');
  await pg.click('#tabs [data-tab="orders"]'); await pg.waitForTimeout(300);
  assert.match(await pg.textContent('#ordersBody'), /Late Lift Co[\s\S]*65' Boom Lift[\s\S]*Not reserved yet/, 'Parts & rentals lists it too');
  // reserve it right from the list: pop-up, saved onto the job, no need to open it
  await pg.click('#ordersBody tr[data-rq="PFBS-1016"] td:nth-child(2)'); await pg.waitForSelector('dialog.ask [name="reservationNo"]', T);
  assert.equal(await pg.$eval('dialog.ask [name="status"]', e => e.value), 'Reserved', 'next step is preselected');
  assert.ok(await pg.$('dialog.ask .rflow [data-rs="Reserved"].ok') && !(await pg.$('dialog.ask select[name="status"]')), 'icon steps, no dropdown');
  await pg.click('dialog.ask [data-rs="Delivered"]'); assert.equal(await pg.$eval('dialog.ask [name="status"]', e => e.value), 'Delivered', 'click a step to move there');
  await pg.click('dialog.ask [data-rs="Delivered"]'); assert.equal(await pg.$eval('dialog.ask [name="status"]', e => e.value), 'Reserved', 'click it again to go back one');
  await pg.fill('dialog.ask [name="vendor"]', 'Sunbelt'); await pg.fill('dialog.ask [name="reservationNo"]', 'R-5521'); await pg.fill('dialog.ask [name="deliveryDate"]', '2026-12-27');
  await pg.click('dialog.ask [data-a="ok"]'); await pg.waitForTimeout(500);
  const rq = await pg.evaluate(() => (DBX.proposals.find(x => x.num === 'PFBS-1016').parts || []).find(x => x.kind === 'rental'));
  assert.ok(rq && rq.status === 'Reserved' && rq.reservationNo === 'R-5521' && rq.vendor === 'Sunbelt' && rq.deliveryDate === '2026-12-27' && rq.reservedOn, 'saved on the job as Reserved');
  assert.ok(await pg.$('#view-orders:not([hidden])') && !(await pg.$('#drawer:not([hidden])')), 'stayed on the list');
  assert.doesNotMatch(await pg.textContent('#ordersBody'), /Not reserved yet/, 'no longer needs action');
  await pg.click('#ordChips [data-of="All"]'); await pg.waitForTimeout(200); assert.ok(await pg.$('#ordersBody tr[data-rq="PFBS-1016"] .rmini .ok'), 'list shows the step icons');
  await pg.click('#ordersBody a[data-open="PFBS-1016"]'); await pg.waitForSelector('.rtitem [data-rs="Delivered"]', T);
  await pg.click('.rtitem [data-rs="Delivered"]'); await pg.waitForTimeout(500);
  assert.equal(await pg.evaluate(() => DBX.proposals.find(x => x.num === 'PFBS-1016').parts.find(x => x.kind === 'rental').status), 'Delivered', 'job tab: click the icon to move the lift on');
  await pg.evaluate(() => document.getElementById('closeD')?.click()); await pg.waitForTimeout(200);
  await pg.click('#tabs [data-tab="home"]'); await pg.waitForTimeout(200);
  await pg.click('[data-hopen="PFBS-1016"]'); await pg.waitForTimeout(700);
  const parts = await pg.evaluate(() => DBX.proposals.find(x => x.num === 'PFBS-1016').parts || []);
  assert.equal(parts.filter(x => x.kind === 'rental').length, 1, 'opening the job does not add the lift twice');
  // printed job packet: page 1 job sheet (no materials list), page 2 the warehouse kit slip, EN / ES, nothing repeated
  await pg.click('#jfSheet'); await pg.waitForSelector('#jsWrap .jspage', T);
  let js = await pg.textContent('#jsWrap');
  assert.ok(/Hoja de trabajo|Job sheet/.test(js) && /65' Boom Lift/.test(js) && /Sunbelt/.test(js) && /R-5521/.test(js), 'sheet shows the lift with its reservation');
  await pg.click('#jsWrap [data-js="en"]'); js = await pg.textContent('#jsWrap');
  assert.ok(/Job sheet/.test(js) && /Scope of work[\s\S]*Perimeter windows/.test(js) && /Back from the job/.test(js) && !/\$|9,338/.test(js) && /Gate code 4455/.test(js) && /Rigo Perez/.test(js) && !/Site contact|Contacto/.test(js), 'English sheet: scope, crew, notes, back-from-job, no prices, no site contact');
  assert.ok(/Kit[\s\S]*3 items — see the kit slip \(page 2\)/.test(js) && (await pg.$$('#jsWrap .jspage')).length === 2, 'kit line on page 1, kit slip on page 2');
  const p2 = await pg.textContent('#jsWrap .jsp2'); assert.ok(/Kit slip/.test(p2) && /WFS Resin Refill/.test(p2) && /Squeegee/.test(p2) && !/Squeegee old/.test(p2) && !/Rigo Perez|Gate code|Village/.test(p2), 'kit slip: items only, removed ones left out, no repeated job info');
  assert.ok(!/Materials|PACKED|Packed/.test(await pg.textContent('#jsWrap .jspage:not(.jsp2)')), 'page 1 no longer lists materials');
  await pg.click('#jsWrap [data-js="es"]'); assert.match(await pg.textContent('#jsWrap'), /Alcance del trabajo[\s\S]*Al regresar del trabajo[\s\S]*Hoja del kit/, 'Spanish toggle');
  await pg.click('#jsWrap [data-js="x"]'); assert.ok(!(await pg.$('#jsWrap')), 'closes');
  await pg.close();
}

// 30. Click a column heading to sort (biggest first, click again for smallest); stays sorted after a redraw
{
  const mk = (n, a) => ({ num: n, date_sent: '2026-10-0' + (a % 9 + 1), sent_by: 'Arturo', client: 'Sort Co ' + n, status: 'Sent', items: [{ type: 'Base', qty: 1, description: 'Windows', amount: a }] });
  const pg = await b.newPage({ viewport: { width: 1300, height: 900 } }); pg.on('pageerror', e => errs.push('sort: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(x => { window.MOCK_EXTRA = x; }, [mk('PFBS-1101', 700), mk('PFBS-1102', 90000), mk('PFBS-1103', 5)]);
  await pg.goto(BASE); await pg.waitForTimeout(900); await pg.click('#tabs [data-tab="pipeline"]'); await pg.waitForTimeout(300);
  const th = await pg.evaluateHandle(() => [...document.querySelectorAll('main table thead th')].find(x => x.offsetParent && /^Amount/i.test(x.textContent.trim())));
  const amounts = () => pg.evaluate(() => { const t = [...document.querySelectorAll('main table')].find(x => x.offsetParent && [...x.querySelectorAll('thead th')].some(h => /^Amount/i.test(h.textContent.trim()))); const c = [...t.querySelectorAll('thead th')].findIndex(h => /^Amount/i.test(h.textContent.trim())); return [...t.tBodies[0].rows].map(r => Number(r.cells[c].textContent.replace(/[$,]/g, ''))).filter(Number.isFinite); });
  await th.click(); let a = await amounts(); assert.ok(a.every((x, i) => i === 0 || a[i - 1] >= x), 'biggest first: ' + a.slice(0, 6));
  await th.click(); a = await amounts(); assert.ok(a.every((x, i) => i === 0 || a[i - 1] <= x), 'then smallest first: ' + a.slice(0, 6));
  await pg.click('#tabs [data-tab="leads"]'); await pg.click('#tabs [data-tab="pipeline"]'); await pg.waitForTimeout(300);
  a = await amounts(); assert.ok(a.every((x, i) => i === 0 || a[i - 1] <= x), 'still sorted after coming back');
  await pg.close();
}

// 30. Click a column heading to sort (biggest first, click again for smallest); reminder plan shown and "client confirmed" skips until due
{
  const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const inv = [{ id: 's1', inv_no: 1700, num: null, status: 'Sent', invoice_date: day(-28), terms_days: 30, due_date: day(2), total: 800, paid: 0, bill_to: { name: 'Soon Co', email: 'ap@soon.example' }, items: [{ description: 'Windows', amount: 800 }] }];
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 }, acceptDownloads: true }); pg.on('pageerror', e => errs.push('sort/remind: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(x => { window.MOCK_INV = x; window.open = () => null; }, inv);
  await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="pipeline"]'); await pg.waitForTimeout(300);
  const amts = () => pg.$$eval('#pipeline table tbody tr, main table tbody tr', R => R.filter(r => r.offsetParent && r.cells.length > 3).map(r => [...r.closest('table').querySelectorAll('thead th')].findIndex(th => /amount/i.test(th.textContent))).slice(0, 1));
  const col = (await amts())[0]; assert.ok(col >= 0, 'pipeline has an Amount column');
  const vals = () => pg.evaluate(c => { const t = [...document.querySelectorAll('table')].find(t => t.offsetParent && [...t.querySelectorAll('thead th')].some(th => /amount/i.test(th.textContent))); return [...t.tBodies[0].rows].map(r => Number((r.cells[c]?.innerText || '').replace(/[$,]/g, ''))).filter(n => !isNaN(n)); }, col);
  await pg.evaluate(c => { const t = [...document.querySelectorAll('table')].find(t => t.offsetParent && [...t.querySelectorAll('thead th')].some(th => /amount/i.test(th.textContent))); t.querySelectorAll('thead th')[c].click(); }, col); await pg.waitForTimeout(100);
  let v = await vals(); assert.ok(v.length > 2 && v.every((x, i) => i === 0 || v[i - 1] >= x), 'biggest first: ' + v.slice(0, 5));
  await pg.evaluate(c => { const t = [...document.querySelectorAll('table')].find(t => t.offsetParent && [...t.querySelectorAll('thead th')].some(th => /amount/i.test(th.textContent))); t.querySelectorAll('thead th')[c].click(); }, col); await pg.waitForTimeout(100);
  v = await vals(); assert.ok(v.every((x, i) => i === 0 || v[i - 1] <= x), 'click again: smallest first');
  await pg.click('#tabs [data-tab="money"]'); await pg.waitForTimeout(300);
  const dl = pg.waitForEvent('download', T); await pg.click('[data-mrem="s1"]'); await dl; await pg.waitForSelector('#rmBody', T);
  assert.match(await pg.textContent('dialog.ask'), /Payment reminders[\s\S]*before due[\s\S]*on the due date[\s\S]*days late/, 'reminder plan shown');
  await pg.click('dialog.ask [data-a="skip"]'); await pg.waitForSelector('dialog [name="why"]', T); await pg.click('dialog:last-of-type .btn:not(.ghost)'); await pg.waitForTimeout(400);
  const r = await pg.evaluate(() => DBX.invoices.find(x => x.id === 's1').reminders);
  assert.ok(r.length === 1 && r[0].skipped && r[0].day === 0, 'skipped through the due date: ' + JSON.stringify(r));
  assert.equal(await pg.evaluate(() => !!document.querySelector('[data-mrem="s1"]')), false, 'no reminder until it is late');
  await pg.close();
}

// 31. A reminder for an imported HCP invoice with no email takes it from the client record and keeps it
{
  const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const inv = [{ id: 'h1', inv_no: 1510, num: null, status: 'Sent', source: 'hcp', invoice_date: day(-40), terms_days: 30, due_date: day(-10), total: 900, paid: 0, bill_to: { name: 'Fire District', email: '' }, items: [{ description: 'Windows', amount: 900 }] }];
  const c = { id: 'c-fd', name: 'Fire District', kind: 'Business', aliases: [], active: true, billing_email: 'ap@fire.example' };
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 }, acceptDownloads: true }); pg.on('pageerror', e => errs.push('hcp reminder: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(([x, c]) => { window.MOCK_INV = x; window.MOCK_CLIENTS = [c]; window.open = () => null; }, [inv, c]);
  await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="money"]'); await pg.waitForTimeout(300);
  const dl = pg.waitForEvent('download', T); await pg.click('[data-mrem="h1"]'); await dl; await pg.waitForSelector('#rmTo', T);
  assert.equal(await pg.$eval('#rmTo', e => e.value), 'ap@fire.example', 'email from the client record');
  assert.equal(await pg.evaluate(() => DBX.invoices.find(x => x.id === 'h1').bill_to.email), 'ap@fire.example', 'saved on the invoice');
  await pg.close();
}

// 32. My to-do (per person), Data check, Profit by client / service, Contracts up for renewal
{
  const td = new Date(), y = td.getFullYear(), d = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const start = new Date(y - 1, td.getMonth(), td.getDate() + 30).toISOString().slice(0, 10);
  const rows = [
    { num: 'PFBS-1020', date_sent: d(-20), sent_by: 'Test Est', client: 'Todo Co', status: 'Lead', items: [] },
    { num: 'PFBS-1021', date_sent: d(-10), sent_by: 'Arturo', client: 'Sched Co', status: 'Approved', date_resolved: d(-3), hcp_job: '10601', items: [{ type: 'Base', qty: 1, description: 'Exterior window cleaning', amount: 1000 }], amount: 1000, gp: 600 },
    { num: 'PFBS-1022', date_sent: start, sent_by: 'Arturo', client: 'Renew Co', status: 'Paid', date_resolved: start, date_paid: start, term_months: 12, hcp_job: '10602',
      items: [{ type: 'Base', qty: 1, frequency: 'Monthly', description: 'Monthly window washing', amount: 1000 }], amount: 1000, gp: 500 } ];
  const cls = [{ id: 'c-a', name: 'Glued Address Co', kind: 'Business', aliases: [], active: true, billing_address: '1 Main DrFremont, CA 94538', billing_email: 'ap@glued.example' },
               { id: 'c-b', name: 'No Email Co', kind: 'Business', aliases: [], active: true, billing_address: '2 Main St\nOakland, CA 94612' },
               { id: 'c-c', name: 'Renew Co', kind: 'Business', aliases: [], active: true, billing_address: '3 Main St\nOakland, CA 94612', billing_email: 'ap@renew.example' },
               { id: 'c-d', name: 'Renew Co LLC', kind: 'Business', aliases: [], active: true, billing_address: '3 Main St\nOakland, CA 94612', billing_email: 'ap@renew.example' }];
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('todo/profit: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(([x, c]) => { window.MOCK_EXTRA = x; window.MOCK_CLIENTS = c; }, [rows, cls]);
  await pg.goto(BASE); await pg.waitForTimeout(1000);
  await pg.click('#tabs [data-tab="home"]'); await pg.waitForTimeout(300);
  assert.ok(await pg.$('#todo-home [data-tdg="Jobs to schedule"]'), 'groups start as counts');
  await pg.click('#todo-home [data-tdg="Jobs to schedule"]');
  const todo = await pg.textContent('#todo-home');
  assert.match(todo, /My to-do/); assert.match(todo, /Jobs to schedule[\s\S]*PFBS-1021/, 'owner sees the job to schedule');
  assert.ok(!/PFBS-1020/.test(todo), "the estimator's lead is not on the owner's list");
  await pg.click('#todo-home [data-tdsnooze*="PFBS-1021"]'); assert.ok(!/PFBS-1021/.test(await pg.textContent('#todo-home')), 'snooze hides it');
  assert.match(await pg.textContent('#todo-home'), /1 hidden/); await pg.click('#todo-home [data-tdunhide]');
  assert.match(await pg.textContent('#homeBody'), /Last week[\s\S]*Proposals sent[\s\S]*Won/, 'Monday snapshot');
  assert.match(await pg.textContent('#hRenew'), /Renew Co/, 'renewal list'); assert.match(await pg.textContent('#hRenew'), /\$12,600/, 'annual with the 5% increase');
  await pg.click('[data-renew="PFBS-1022"]'); await pg.waitForTimeout(900);
  const ren = await pg.evaluate(() => DBX.proposals.find(x => x.renewal_of === 'PFBS-1022'));
  assert.ok(ren && Number(ren.items[0].amount) === 1050, 'renewal proposal at +5%');
  await pg.keyboard.press('Escape'); await pg.evaluate(() => document.getElementById('closeD')?.click());
  await pg.click('#tabs [data-tab="clients"]'); await pg.waitForTimeout(300); await pg.click('#clCheck'); await pg.waitForTimeout(150);
  const dc = await pg.textContent('#clientsBody');
  assert.match(dc, /No email at all[\s\S]*No Email Co/); assert.match(dc, /Addresses that look wrong[\s\S]*Glued Address Co/); assert.match(dc, /Possible duplicates[\s\S]*Renew Co LLC/);
  await pg.click('#tabs [data-tab="sales"]'); await pg.waitForTimeout(300);
  if (!(await pg.$('#profitBox table'))) await pg.evaluate(() => document.querySelector('#salesKind [data-kind="team"]')?.click());
  await pg.waitForSelector('#profitBox table', T); await pg.click('#profitBox [data-pper="all"]');
  const pt = await pg.textContent('#profitBox');
  assert.match(pt, /Sched Co[\s\S]*\$1,000[\s\S]*\$600[\s\S]*60%/, 'planned profit and margin by client');
  await pg.click('#profitBox [data-pby="service"]'); assert.match(await pg.textContent('#profitBox'), /Window/i, 'by service');
  await pg.close();
  // the estimator's own to-do on Sales
  const pe = await b.newPage({ viewport: { width: 1300, height: 950 } }); pe.on('pageerror', e => errs.push('todo est: ' + e.message));
  await pe.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort()); await pe.addInitScript(([x]) => { window.MOCK_EXTRA = x; }, [rows]);
  await pe.goto(BASE + '?u=e@x.com'); await pe.waitForTimeout(1000);
  await pe.click('#todo-sales [data-tdg="Leads to price"]');
  assert.match(await pe.textContent('#todo-sales'), /Leads to price[\s\S]*PFBS-1020/, "estimator sees their lead");
  await pe.close();
  // CRM start date: older items leave everyone's list
  const ps = await b.newPage({ viewport: { width: 1300, height: 950 } }); ps.on('pageerror', e => errs.push('todo start: ' + e.message));
  await ps.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort()); await ps.addInitScript(([x, st]) => { window.MOCK_EXTRA = x; window.MOCK_SETTINGS = { crmStart: st }; }, [rows, d(-1)]);
  await ps.goto(BASE); await ps.waitForTimeout(1000); await ps.click('#tabs [data-tab="home"]'); await ps.waitForTimeout(300);
  assert.ok(!(await ps.$('#todo-home [data-tdg="Jobs to schedule"]')) && !(await ps.$('#todo-home [data-tdg="Follow-ups due"]')), 'approved / sent before the start date: not on the list');
  assert.match(await ps.textContent('#todo-home'), /counting from/);
  await ps.close();
}

// 34. Job steps like HousecallPro: Finish marks the visit done; sending the invoice on a one-time job finishes it too (even if the visit is dated later)
{
  const d = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const jobs = [{ num: 'PFBS-1030', date_sent: d(-9), sent_by: 'Arturo', client: 'Finish Co', status: 'Scheduled', date_resolved: d(-5), hcp_job: '10700', bill_address: '1 A St', billing_email: 'ap@finish.example', items: [{ type: 'Base', qty: 1, description: 'Windows', amount: 400 }], amount: 400 },
                { num: 'PFBS-1031', date_sent: d(-9), sent_by: 'Arturo', client: 'Early Bill Co', status: 'Scheduled', date_resolved: d(-5), hcp_job: '10701', bill_address: '2 B St', billing_email: 'ap@early.example', items: [{ type: 'Base', qty: 1, description: 'Gutters', amount: 300 }], amount: 300 }];
  const vis = [{ id: 'fv1', num: 'PFBS-1030', kind: 'job', status: 'Scheduled', visit_date: d(-1), start_time: '08:00', techs: ['Rigo Perez'], work: [], equipment: [] },
               { id: 'fv2', num: 'PFBS-1031', kind: 'job', status: 'Scheduled', visit_date: d(5), start_time: '08:00', techs: ['Rigo Perez'], work: [], equipment: [] }];
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 }, acceptDownloads: true }); pg.on('pageerror', e => errs.push('job steps: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(([j, v]) => { window.MOCK_EXTRA = j; window.MOCK_VIS = v; window.MOCK_SR = [{ id: 'srd1', num: 'PFBS-1030', status: 'pending', client: 'Finish Co', created_at: new Date().toISOString() }]; window.open = () => null; }, [jobs, vis]);
  await pg.goto(BASE); await pg.waitForTimeout(1000);
  await pg.click('#tabs [data-tab="home"]'); await pg.click('[data-hopen="PFBS-1030"]'); await pg.waitForSelector('.jflow2', T);
  assert.ok(!/OMW|Start/.test(await pg.textContent('.jflow2')), 'no OMW / Start');
  pg.once('dialog', dlg => dlg.accept()); await pg.click('[data-jf="finish"]'); await pg.waitForTimeout(500);
  assert.equal(await pg.evaluate(() => DBX.visits.find(v => v.id === 'fv1').status), 'Done', 'Finish marks the visit done');
  assert.ok(await pg.$('#jfBox a[href*="reports.html?num=PFBS-1030"]'), 'finished job offers the service report');
  await pg.evaluate(() => document.getElementById('closeD')?.click()); await pg.waitForTimeout(200);
  await pg.click('#tabs [data-tab="orders"]'); await pg.waitForTimeout(400);
  assert.match(await pg.$eval('#jobsBody', e => e.innerText), /Service reports to send \(\d+\)[\s\S]*PFBS-1030/, 'finished job is on Service reports to send');
  assert.ok(await pg.$('#jobsBody tr[data-qrow="PFBS-1030"]'), 'finished job is on Log actual hours');
  assert.equal(await pg.$eval('#jobsBody tr[data-qrow="PFBS-1030"] [data-qa="start"]', e => e.value), d(-1), 'start date filled from the schedule');
  await pg.click('#tabs [data-tab="home"]'); await pg.click('[data-hopen="PFBS-1030"]'); await pg.waitForSelector('.jflow2', T);
  // UNDO above Finish and Schedule, like HCP
  const msgs = []; const acc = dlg => { msgs.push(dlg.message()); dlg.accept(); }; pg.on('dialog', acc);
  await pg.waitForSelector('[data-jfu="finish"]', T); await pg.click('[data-jfu="finish"]'); await pg.waitForTimeout(700); pg.off('dialog', acc);
  assert.ok(msgs.some(m => /unsent service report draft/.test(m)), 'undo finish offers to delete the draft report');
  assert.equal(await pg.evaluate(() => DBX.service_reports.filter(r => r.num === 'PFBS-1030').length), 0, 'draft report deleted');
  assert.equal(await pg.evaluate(() => DBX.visits.find(v => v.id === 'fv1').status), 'Scheduled', 'Undo finish puts the visit back');
  assert.ok(!(await pg.$('[data-jfu="finish"]')), 'no finish undo once nothing is finished');
  pg.once('dialog', dlg => dlg.accept()); await pg.click('[data-jfu="sched"]'); await pg.waitForTimeout(500);
  assert.equal(await pg.evaluate(() => DBX.visits.filter(v => v.num === 'PFBS-1030').length), 0, 'Undo schedule takes the visit off the schedule');
  assert.equal(await pg.evaluate(() => DBX.proposals.find(x => x.num === 'PFBS-1030').status), 'Approved', 'job back to unscheduled');
  assert.ok(await pg.$('[data-jf="contract"].now'), 'back to unscheduled: Contract / PO is the next step again');
  await pg.evaluate(() => document.getElementById('closeD')?.click()); await pg.waitForTimeout(200);
  await pg.click('[data-hopen="PFBS-1031"]'); await pg.waitForSelector('.jflow2', T); await pg.click('[data-jf="inv"]'); await pg.waitForSelector('dialog.inved', T);
  const dl = pg.waitForEvent('download', T); await pg.click('dialog.inved [data-a="send"]'); await dl; await pg.waitForSelector('#ivTo', T);
  await pg.click('dialog.ask [data-a="owa"]'); await pg.waitForTimeout(600);
  assert.equal(await pg.evaluate(() => DBX.visits.find(v => v.id === 'fv2').status), 'Done', 'sending the invoice finished the job');
  await pg.close();
}

// 35. HCP's "Copy to new job" / copy a proposal: same client + lines, none of the old one's history
{
  const d = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const src = { num: 'PFBS-1040', date_sent: d(-20), sent_by: 'Arturo', client: 'Copy Co', property: '5 Copy Way', site_address: '5 Copy Way, Fremont', status: 'Paid', date_resolved: d(-15), date_paid: d(-2), hcp_job: '10800', contact_email: 'pm@copy.example',
    items: [{ type: 'Base', qty: 1, description: 'Exterior windows', amount: 900 }, { type: 'Add-on', qty: 1, description: 'Screens', amount: 100, accepted: true }], amount: 1000 };
  const vis = [{ id: 'cv1', num: 'PFBS-1040', kind: 'job', status: 'Done', visit_date: d(-16), start_time: '08:00', techs: ['Rigo Perez'], work: [], equipment: [] }];
  const pg = await b.newPage({ viewport: { width: 1300, height: 950 } }); pg.on('pageerror', e => errs.push('copy: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(([j, v]) => { window.MOCK_EXTRA = [j]; window.MOCK_VIS = v; sessionStorage.clear(); }, [src, vis]);
  await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="orders"]'); await pg.waitForTimeout(300); await pg.click('tr[data-id="PFBS-1040"]'); await pg.waitForSelector('#dMore', T);
  await pg.click('#dMore'); assert.ok(await pg.isVisible('#dMenu [data-copy="job"]'), 'menu opens');
  pg.once('dialog', dlg => dlg.accept()); await pg.click('#dMenu [data-copy="job"]'); await pg.waitForTimeout(800);
  const nj = await pg.evaluate(() => DBX.proposals.filter(x => x.client === 'Copy Co' && x.num !== 'PFBS-1040').pop());
  assert.ok(nj && nj.status === 'Approved' && !nj.date_paid && !nj.hcp_job && nj.items.length === 2 && nj.items[1].accepted === true && nj.site_address === '5 Copy Way, Fremont', 'new job: same lines, no paid date or old job #');
  assert.equal(await pg.evaluate(n => DBX.visits.filter(v => v.num === n).length, nj.num), 0, 'no visits copied');
  assert.match(await pg.textContent('#dTitle'), new RegExp(nj.num), 'the new job opens');
  await pg.click('#dMore'); pg.once('dialog', dlg => dlg.accept()); await pg.click('#dMenu [data-copy="prop"]'); await pg.waitForTimeout(800);
  const np = await pg.evaluate(() => DBX.proposals.filter(x => x.client === 'Copy Co').pop());
  assert.ok(np.status === 'Estimating' && !np.date_sent && np.items[1].accepted === false, 'new proposal: not sent, add-ons not accepted yet');
  await pg.close();
}

// 36. Autosave: an open proposal / job saves itself after you stop typing; closing right away still saves; new ones still need Create
{
  const pr = { num: 'PFBS-1050', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Auto Co', status: 'Approved', hcp_job: '10900', items: [{ type: 'Base', qty: 1, description: 'Windows', amount: 500 }], amount: 500 };
  const pg = await b.newPage({ viewport: { width: 1300, height: 900 } }); pg.on('pageerror', e => errs.push('autosave: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(x => { window.MOCK_EXTRA = [x]; sessionStorage.clear(); }, pr);
  await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="orders"]'); await pg.waitForTimeout(300); await pg.evaluate(() => document.querySelector('[data-open="PFBS-1050"],tr[data-id="PFBS-1050"]')?.click());
  await pg.waitForSelector('#drawer:not([hidden])', T); await pg.evaluate(() => document.querySelector('#drawer [data-dtab="prop"],#drawer [data-tab2="prop"]')?.click());
  await pg.waitForSelector('#f-contactPhone', T);
  await pg.fill('#f-contactPhone', '510-555-0101'); await pg.dispatchEvent('#f-contactPhone', 'change'); await pg.waitForTimeout(2600);
  assert.equal(await pg.evaluate(() => DBX.proposals.find(x => x.num === 'PFBS-1050').contact_phone), '510-555-0101', 'saved without clicking Save');
  assert.match(await pg.textContent('#dmsg'), /All changes saved/);
  await pg.fill('#f-contactPhone', '510-555-0202'); await pg.dispatchEvent('#f-contactPhone', 'change');
  await pg.evaluate(() => document.getElementById('closeD').click()); await pg.waitForTimeout(800);
  assert.equal(await pg.evaluate(() => DBX.proposals.find(x => x.num === 'PFBS-1050').contact_phone), '510-555-0202', 'closing right away still saves');
  await pg.close();
}

// 37. Pricing guardrails: a lift under PFBS equipment offers "Move to rentals"; a line priced below its pricing asks before it goes out
{
  const est = { sheet: 'WC', labor: [{ role: 'Expert', hours: 40, rate: 75 }], materials: [], taxRate: 0, rentals: [], equipment: [{ desc: "65' Telescopic Boom Lift", unit: 4000, qty: 1, markup: 0.25 }], misc: [] };
  const pr = { num: 'PFBS-1060', date_sent: null, sent_by: 'Arturo', client: 'Guard Co', property: '1 Guard St', site_address: '1 Guard St', contact_name: 'Ann', contact_email: 'ann@guard.example', status: 'Estimating', items: [{ type: 'Base', qty: 1, description: 'Perimeter windows', amount: 6685, estimate: est }], amount: 6685 };
  const pg = await b.newPage({ viewport: { width: 1300, height: 900 } }); pg.on('pageerror', e => errs.push('guardrails: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(x => { window.MOCK_EXTRA = [x]; sessionStorage.clear(); }, pr);
  await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="pipeline"]'); await pg.waitForTimeout(200); await pg.evaluate(() => [...document.querySelectorAll('[data-f], [data-filter]')].find(x => /^All/.test(x.textContent.trim()))?.click()); await pg.waitForTimeout(200);
  await pg.click('tr[data-id="PFBS-1060"]'); await pg.waitForSelector('[data-est="0"]', T);
  await pg.click('[data-est="0"]'); await pg.waitForSelector('#estTot', T);
  assert.match(await pg.textContent('#eqLiftWarn'), /looks like a rented lift/, 'lift under PFBS equipment is flagged');
  await pg.click('[data-eqmove="0"]'); await pg.waitForTimeout(200);
  assert.equal(await pg.$eval('#eqLiftWarn', e => e.textContent.trim()), '', 'moved: no more warning');
  assert.ok(await pg.$('[data-e="rentals.0.desc"]'), 'now under Subcontractors / rentals');
  await pg.click('#estClose'); await pg.waitForTimeout(300);
  const msgs = []; pg.on('dialog', d => { msgs.push(d.message()); d.dismiss(); });
  await pg.evaluate(() => document.querySelector('#drawer [data-st="Sent"]')?.click()); await pg.waitForTimeout(400);
  assert.ok(msgs.some(m => /below its pricing[\s\S]*Perimeter windows: proposal \$6,685\.00, pricing \$/.test(m)), 'asks before sending a line priced below its pricing: ' + msgs.join(' | '));
  await pg.waitForTimeout(1600); assert.equal(await pg.evaluate(() => DBX.proposals.find(x => x.num === 'PFBS-1060').status), 'Estimating', 'cancel keeps it from going out'); assert.ok(!(await pg.$('#drawer [data-st="Sent"].on')), 'Sent not selected');
  await pg.close();
}

// 38. Settings → Switch-over checklist: automatic steps tick themselves, the owner ticks the rest
{
  const pg = await b.newPage({ viewport: { width: 1300, height: 900 } }); pg.on('pageerror', e => errs.push('switch-over: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await pg.addInitScript(() => sessionStorage.clear());
  await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="settings"]'); await pg.waitForSelector('#swCard', T);
  assert.equal(await pg.evaluate(() => document.querySelector('#settingsBody h3.setsec')?.textContent), 'Switch-over', 'first section at the top, with its own jump link');
  assert.match(await pg.textContent('#swCard'), /Switch-over to the CRM[\s\S]*Daily backups on[\s\S]*HousecallPro cancelled/);
  await pg.click('#swCard [data-sw="backups"]'); await pg.waitForTimeout(300);
  assert.ok(await pg.evaluate(() => !!DBX.settings[0].data.switchover?.backups), 'saved');
  assert.match(await pg.textContent('#swCard li.done'), /Daily backups on/, 'ticked');
  await pg.close();
}

// 39. Won job: status chips tucked away (job steps drive it); 📁 Save to client folder puts the PDFs in SharePoint in one click
{
  const pg = await b.newPage({ viewport: { width: 1300, height: 900 } }); pg.on('pageerror', e => errs.push('sp save: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  const pr = { num: 'PFBS-1070', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Folder Test Co', property: '9 Elm St', service: 'Window Cleaning', status: 'Approved', date_resolved: '2026-10-10', hcp_job: '10970', items: [{ type: 'Base', qty: 1, description: 'Exterior windows', amount: 1200, estimate: { labor: [], materials: [] } }] };
  await pg.addInitScript(x => { window.MOCK_EXTRA = [x]; sessionStorage.clear(); sessionStorage.setItem('pfbs.open', 'PFBS-1070'); }, pr);
  // stand-ins for Microsoft sign-in and SharePoint (Graph)
  await pg.route(/msal-browser/, r => r.fulfill({ contentType: 'text/javascript', body: 'window.msal={PublicClientApplication:class{getAllAccounts(){return [{username:"a"}]} async acquireTokenSilent(){return {accessToken:"t"}} async acquireTokenPopup(){return {accessToken:"t"}}}}' }));
  const up = [], mk = [];
  await pg.route(/graph\.microsoft\.com/, r => { const u = decodeURIComponent(r.request().url()), m = r.request().method(), j = o => r.fulfill({ contentType: 'application/json', body: JSON.stringify(o) });
    if (m === 'PUT') { up.push(u); return j({ id: 'x' }); }
    if (m === 'POST') { mk.push(u); return j({}); }
    if (/\/drives\?/.test(u)) return j({ value: [{ id: 'd1', name: 'Clients', webUrl: 'https://x.sharepoint.com/sites/team/Clients' }] });
    if (/root\/children/.test(u)) return j({ value: [{ name: 'Folder Test Co', folder: {} }, { name: 'Other Client', folder: {} }] });
    if (/root:\/Folder Test Co:\/children/.test(u)) return j({ value: [{ name: '9 Elm St', folder: {} }] });
    if (/root:\/Folder Test Co\/9 Elm St\/Window Cleaning\?/.test(u)) return j({ id: 'f1', webUrl: 'https://x.sharepoint.com/sites/team/Clients/Folder%20Test%20Co/9%20Elm%20St/Window%20Cleaning' });
    if (/\/shares\//.test(u)) return j({ id: 'f1', parentReference: { driveId: 'd1' } });
    return r.fulfill({ status: 404, body: '{}' }); });
  await pg.goto(BASE + (BASE.includes('?') ? '&' : '?') + 'sp=1'); await pg.waitForSelector('#dMore', T);
  assert.ok(await pg.$eval('#drawer .stages', e => e.hidden), 'status chips hidden on a job');
  await pg.click('[data-stshow]'); assert.ok(!(await pg.$eval('#drawer .stages', e => e.hidden)), 'Change by hand shows them');
  await pg.click('#dMore'); await pg.click('#spSaveD'); await pg.waitForTimeout(2500);
  assert.equal(up.length, 2, 'proposal + pricing PDFs uploaded: ' + JSON.stringify(up));
  assert.ok(up.some(u => /items\/f1:\/WC Proposal \d+-\d+-\d{4} 9 Elm St - PFBS-1070\.pdf/.test(u)) && up.some(u => /WC Pricing \d+-\d+-\d{4} 9 Elm St - PFBS-1070\.pdf/.test(u)), 'both into the found folder: ' + JSON.stringify(up));
  assert.ok(mk.length, 'service folder made if missing');
  assert.match(await pg.evaluate(() => DBX.proposals.find(x => x.num === 'PFBS-1070').folder_link), /Folder%20Test%20Co/, 'folder remembered on the job');
  await pg.close();
}

// 40. Filed automatically in the client's SharePoint folder: the approved service report (+ photos), the contract / PO file,
//     and 📁 Save to client folder re-files everything the job has (proposal, pricing, sent invoices, sent reports)
{
  const FOLDER = 'https://x.sharepoint.com/sites/team/Clients/Demo%20Client/9%20Oak%20St/Window%20Cleaning';
  const fakeSp = async (pg, up) => {
    await pg.route(/msal-browser/, r => r.fulfill({ contentType: 'text/javascript', body: 'window.msal={PublicClientApplication:class{getAllAccounts(){return [{username:"a"}]} async acquireTokenSilent(){return {accessToken:"t"}} async acquireTokenPopup(){return {accessToken:"t"}}}}' }));
    await pg.route(/graph\.microsoft\.com/, r => { const u = decodeURIComponent(r.request().url()), m = r.request().method(), j = o => r.fulfill({ contentType: 'application/json', body: JSON.stringify(o) });
      if (m === 'PUT') { up.push(u.replace(/^.*\/items\//, '').replace(/:\/content.*$/, '')); return j({ id: 'x' }); }
      if (m === 'POST') return j({});
      if (/\/drives\?/.test(u)) return j({ value: [{ id: 'd1', name: 'Clients', webUrl: 'https://x.sharepoint.com/sites/team/Clients' }] });
      if (/\/shares\//.test(u)) return j({ id: 'f1', parentReference: { driveId: 'd1' } });
      if (/items\/f1:\/(Photos |Site photos)/.test(u)) return j({ id: 'ph1' });
      return r.fulfill({ status: 404, body: '{}' }); });
  };
  // (a) approving a service report files the PDF and its photos
  const pg = await b.newPage({ viewport: { width: 430, height: 900 }, acceptDownloads: true }); pg.on('pageerror', e => errs.push('sp report: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic|open-meteo/, r => r.abort());
  const up = []; await fakeSp(pg, up);
  await pg.addInitScript(([x, F]) => { window.MOCK_EXTRA = [{ ...x, service: 'Window Cleaning', folder_link: F }]; window.MOCK_RPC = { report_approved: () => ({ data: { ok: true }, error: null }) }; }, [job, FOLDER]);
  await pg.goto(BASE + 'reports.html?num=PFBS-0963&sp=1'); await pg.waitForTimeout(1000);
  await pg.setInputFiles('#file', path.join(B, 'logo.jpg')); await pg.waitForTimeout(1500);
  await pg.click('#approve', T); await pg.click('.overlay [data-a="1"]', T); await pg.waitForSelector('#emTo', T); await pg.waitForTimeout(1500);
  assert.ok(up.some(u => /^f1:\/WC Service Report \d+-\d+-\d{4} 9 Oak Plaza - PFBS-0963\.pdf$/.test(u)), 'report PDF filed: ' + JSON.stringify(up));
  assert.ok(up.some(u => /^ph1:\/01.*\.jpg$/.test(u)), 'photo filed in Photos <date>: ' + JSON.stringify(up));
  assert.ok(await pg.evaluate(() => DBX.proposal_activity.some(a => a.num === 'PFBS-0963' && /Service report saved to SharePoint/.test(a.note))), 'noted on the job');
  await pg.close();

  // (b) the CRM: contract file → folder; Save to client folder re-files invoices + reports too
  const pc = await b.newPage({ viewport: { width: 1300, height: 900 }, acceptDownloads: true }); pc.on('pageerror', e => errs.push('sp job: ' + e.message));
  await pc.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  const up2 = []; await fakeSp(pc, up2);
  const pr = { num: 'PFBS-1071', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Demo Client', property: '9 Oak St', service: 'Window Cleaning', status: 'Invoiced', date_resolved: '2026-10-10', hcp_job: '10971', folder_link: FOLDER, photos: [{ path: 'PFBS-1071/1.jpg', caption: 'Front entrance' }], items: [{ type: 'Base', qty: 1, description: 'Exterior windows', amount: 1200 }] };
  const inv = [{ id: 'i71', inv_no: 5001, num: 'PFBS-1071', status: 'Sent', invoice_date: '2026-10-27', terms_days: 30, due_date: '2099-01-01', total: 1200, paid: 0, items: [{ description: 'Exterior windows', amount: 1200 }], bill_to: { name: 'Demo Client', email: 'ap@example.com' } }];
  const sr = [{ id: 'sr71', num: 'PFBS-1071', status: 'approved', approved_at: '2026-10-24T20:00:00Z', doc: { service_dates: '10/24/2026', pdf: { path: 'pdf/sr71/1/x.pdf' }, photos: [] } }];
  await pc.addInitScript(([x, i, r]) => { window.MOCK_EXTRA = [x]; window.MOCK_INV = i; window.MOCK_SR = r; window.__ST = { 'pdf/sr71/1/x.pdf': new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' }), 'PFBS-1071/1.jpg': new Blob(['jpg'], { type: 'image/jpeg' }) }; sessionStorage.clear(); sessionStorage.setItem('pfbs.open', 'PFBS-1071'); }, [pr, inv, sr]);
  await pc.goto(BASE + '?sp=1'); await pc.waitForSelector('#dMore', T); await pc.waitForTimeout(500);
  await pc.click('[data-jf="contract"]'); await pc.waitForSelector('dialog.ask input[type="file"]', T);
  await pc.setInputFiles('dialog.ask input[type="file"]', { name: 'signed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 signed') });
  await pc.click('dialog.ask [data-a="ok"]'); await pc.waitForTimeout(1500);
  assert.ok(up2.some(u => /^f1:\/WC Contract \d+-\d+-\d{4} 9 Oak St - PFBS-1071\.pdf$/.test(u)), 'contract filed: ' + JSON.stringify(up2));
  up2.length = 0;
  await pc.click('#dMore'); await pc.click('#spSaveD'); await pc.waitForTimeout(3000);
  assert.ok(up2.some(u => /WC Proposal .* - PFBS-1071\.pdf$/.test(u)), 'proposal: ' + JSON.stringify(up2));
  assert.ok(up2.some(u => /WC Invoice 5001 10-27-2026 9 Oak St - PFBS-1071\.pdf$/.test(u)), 'sent invoice: ' + JSON.stringify(up2));
  assert.ok(up2.some(u => /WC Service Report 10-24-2026 9 Oak St - PFBS-1071\.pdf$/.test(u)), 'sent report: ' + JSON.stringify(up2));
  assert.ok(up2.some(u => /^ph1:\/01 Front entrance\.jpg$/.test(u)), 'site photo in Site photos: ' + JSON.stringify(up2));
  await pc.close();
}

// 41. Catch up old reminders in one go; File all jobs in SharePoint; short Contract label
{
  const d0 = new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10);
  const inv = [{ id: 'h1', inv_no: 900, source: 'hcp', status: 'Sent', invoice_date: d0, due_date: d0, terms_days: 0, total: 100, paid: 0, items: [], bill_to: { name: 'Old Co' } },
    { id: 'h2', inv_no: 901, source: 'hcp', status: 'Sent', invoice_date: d0, due_date: d0, terms_days: 0, total: 200, paid: 0, items: [], bill_to: { name: 'Old Co' } },
    { id: 'c1', inv_no: 1600, status: 'Sent', invoice_date: d0, due_date: d0, terms_days: 0, total: 300, paid: 0, items: [], bill_to: { name: 'New Co' } }];
  const pg = await b.newPage({ viewport: { width: 1300, height: 900 } }); pg.on('pageerror', e => errs.push('catch-up: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  const up = [];
  await pg.route(/msal-browser/, r => r.fulfill({ contentType: 'text/javascript', body: 'window.msal={PublicClientApplication:class{getAllAccounts(){return [{username:"a"}]} async acquireTokenSilent(){return {accessToken:"t"}} async acquireTokenPopup(){return {accessToken:"t"}}}}' }));
  await pg.route(/graph\.microsoft\.com/, r => { const u = decodeURIComponent(r.request().url()), m = r.request().method(), j = o => r.fulfill({ contentType: 'application/json', body: JSON.stringify(o) });
    if (m === 'PUT') { up.push(u); return j({ id: 'x' }); } if (m === 'POST') return j({});
    if (/\/drives\?/.test(u)) return j({ value: [{ id: 'd1', name: 'Clients', webUrl: 'https://x.sharepoint.com/sites/team/Clients' }] });
    if (/\/shares\//.test(u)) return j({ id: 'f1', parentReference: { driveId: 'd1' } });
    if (/root\/children/.test(u)) return j({ value: [] });
    return r.fulfill({ status: 404, body: '{}' }); });
  const jobA = { num: 'PFBS-1072', date_sent: '2026-10-01', sent_by: 'Arturo', client: 'Filed Co', property: '1 A St', service: 'Window Cleaning', status: 'Scheduled', date_resolved: '2026-10-10', hcp_job: '10972', contract_on: '2026-10-11', contract_note: 'Approved by email (no contract)', folder_link: 'https://x.sharepoint.com/sites/team/Clients/Filed%20Co/1%20A%20St/Window%20Cleaning', items: [{ type: 'Base', qty: 1, description: 'Windows', amount: 500 }] };
  const jobB = { ...jobA, num: 'PFBS-1073', client: 'Nowhere Co', property: '2 B St', hcp_job: '10973', folder_link: null, contract_on: null, contract_note: null };
  await pg.addInitScript(([i, a, c]) => { window.MOCK_INV = i; window.MOCK_EXTRA = [a, c]; if (!sessionStorage.getItem('t41')) { sessionStorage.clear(); sessionStorage.setItem('t41', '1'); } }, [inv, jobA, jobB]);
  await pg.goto(BASE + '?sp=1'); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="money"]'); await pg.waitForTimeout(400);
  await pg.click('[data-mf="Reminder due"]'); await pg.waitForSelector('[data-mcatch]', T);
  await pg.click('[data-mcatch]'); await pg.waitForSelector('dialog.ask [name="which"]', T); await pg.click('dialog.ask [data-a="ok"]'); await pg.waitForTimeout(600);
  const rem = await pg.evaluate(() => Object.fromEntries(DBX.invoices.filter(v => ['h1', 'h2', 'c1'].includes(v.id)).map(v => [v.id, (v.reminders || []).length])));
  assert.deepEqual(rem, { h1: 1, h2: 1, c1: 0 }, 'only the HousecallPro ones skipped: ' + JSON.stringify(rem));
  await pg.evaluate(() => { sessionStorage.setItem('pfbs.open', 'PFBS-1072'); }); await pg.reload(); await pg.waitForSelector('#jfBox', T);
  assert.match(await pg.textContent('#jfBox'), /By email/, 'short contract label');
  await pg.click('#closeD'); await pg.click('#tabs [data-tab="settings"]'); await pg.waitForSelector('[data-spall]', T);
  await pg.click('[data-spall]'); await pg.waitForSelector('dialog.ask [name="which"]', T); await pg.click('dialog.ask [data-a="ok"]');
  await pg.waitForSelector('dialog.ask >> text=Some jobs need a folder picked', T);
  assert.match(await pg.textContent('dialog.ask'), /PFBS-1073/, 'lists the job with no folder');
  assert.ok(up.some(u => /WC Proposal .* - PFBS-1072\.pdf/.test(u)), 'filed the job with a folder: ' + JSON.stringify(up));
  await pg.click('[data-pickfolder="PFBS-1073"]'); await pg.waitForSelector('#spClient', T);
  assert.equal(await pg.textContent('#dTitle'), 'PFBS-1073', 'Pick folder opens that job on its folder picker');
  assert.match(await pg.textContent('#spBox'), /Open the Clients library in SharePoint/, 'link to browse the library');
  await pg.click('#closeD'); await pg.click('#tabs [data-tab="home"]'); await pg.waitForSelector('[data-tdg="Jobs with no client folder"]', T);
  await pg.click('[data-tdg="Jobs with no client folder"]'); await pg.click('[data-td-folder="PFBS-1073"]'); await pg.waitForSelector('#spClient', T);
  await pg.close();
}

// 42. Site walk sheet: printed with the job's info and the Pricing boxes; the notes photo files in the client folder
{
  const ctx = await b.newContext({ viewport: { width: 1300, height: 900 } });
  const pg = await ctx.newPage(); pg.on('pageerror', e => errs.push('site walk: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  const up = [];
  await pg.route(/msal-browser/, r => r.fulfill({ contentType: 'text/javascript', body: 'window.msal={PublicClientApplication:class{getAllAccounts(){return [{username:"a"}]} async acquireTokenSilent(){return {accessToken:"t"}} async acquireTokenPopup(){return {accessToken:"t"}}}}' }));
  await pg.route(/graph\.microsoft\.com/, r => { const u = decodeURIComponent(r.request().url()), m = r.request().method(), j = o => r.fulfill({ contentType: 'application/json', body: JSON.stringify(o) });
    if (m === 'PUT') { up.push(u); return j({ id: 'x' }); } if (m === 'POST') return j({});
    if (/\/drives\?/.test(u)) return j({ value: [{ id: 'd1', name: 'Clients', webUrl: 'https://x.sharepoint.com/sites/team/Clients' }] });
    if (/\/shares\//.test(u)) return j({ id: 'f1', parentReference: { driveId: 'd1' } });
    return r.fulfill({ status: 404, body: '{}' }); });
  const pr = { num: 'PFBS-1074', date_sent: '2026-10-18', sent_by: 'Arturo', client: 'Walk Co', property: 'Tower One', site_address: '5 Main St\nOakland, CA', contact_name: 'Pat Site', service: 'Window Cleaning', status: 'Estimating', folder_link: 'https://x.sharepoint.com/sites/team/Clients/Walk%20Co/5%20Main%20St/Window%20Cleaning', items: [{ type: 'Base', qty: 1, description: 'Exterior window cleaning', amount: '' }] };
  await pg.addInitScript(x => { window.MOCK_EXTRA = [x]; sessionStorage.clear(); sessionStorage.setItem('pfbs.open', 'PFBS-1074'); }, pr);
  await pg.goto(BASE + '?sp=1'); await pg.waitForSelector('#dMore', T);
  await pg.click('#dMore'); await pg.click('#swSheet'); await pg.waitForSelector('dialog.ask [name="wc"]', T);
  assert.ok(await pg.$eval('dialog.ask [name="wc"]', e => e.checked) && !(await pg.$eval('dialog.ask [name="pw"]', e => e.checked)), 'window cleaning picked from the job');
  const pop = ctx.waitForEvent('page'); await pg.click('dialog.ask [data-a="ok"]'); const sh = await pop; await sh.waitForLoadState();
  const txt = await sh.textContent('body');
  assert.match(txt, /Site walk · PFBS-1074[\s\S]*Walk Co[\s\S]*Tower One[\s\S]*5 Main St, Oakland[\s\S]*Pat Site[\s\S]*# of drops[\s\S]*3-prong[\s\S]*4-prong[\s\S]*1-wire[\s\S]*2-wire/, 'filled in, with the pricing boxes');
  assert.ok(!/Pressure washing/.test(txt), 'only the services picked'); assert.match(txt, /Estimator\s*Arturo/, "the job's estimator, not who prints it"); await sh.close();
  await pg.click('#dMore'); await pg.click('#swFile'); await pg.waitForSelector('dialog.ask input[type="file"]', T);
  await pg.setInputFiles('dialog.ask input[type="file"]', [{ name: 'a.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('x') }, { name: 'b.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('y') }]);
  await pg.click('dialog.ask [data-a="ok"]'); await pg.waitForTimeout(1500);
  assert.ok(up.some(u => /WC Site Walk p1 \d+-\d+-\d{4} Tower One - PFBS-1074\.jpg/.test(u)) && up.some(u => /Site Walk p2/.test(u)), 'both pages filed: ' + JSON.stringify(up));
  await pg.click('#closeD'); await pg.click('#gNew'); const pop2 = ctx.waitForEvent('page'); await pg.click('[data-gnew="walk"]'); await pg.click('dialog.ask [data-a="ok"]');
  const blank = await pop2; await blank.waitForLoadState(); assert.match(await blank.textContent('body'), /Pressure washing[\s\S]*Gates/, 'blank sheet has every service');
  await ctx.close();
}

// 43. Business cards → prospects: each photo is read, checked, and saved in one go (the reader is a stand-in here)
{
  const pg = await b.newPage({ viewport: { width: 1300, height: 900 } }); pg.on('pageerror', e => errs.push('cards: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  const T1 = 'Jane Q. Example\nProperty Manager\nACME REALTY GROUP\n123 Main Street\nOakland, CA 94607\nM: (510) 555-0199\njane.example@acmerealty.com';
  const T2 = 'SAMPLE PROPERTIES\nJohn Doe\nChief Engineer\njdoe@sampleprops.com';
  await pg.route(/tesseract\.min\.js/, r => r.fulfill({ contentType: 'text/javascript', body: `window.Tesseract={createWorker:async()=>{let n=0;const T=[${JSON.stringify(T1)},${JSON.stringify(T2)}];return {recognize:async()=>({data:{text:T[n++]||''}}),terminate:async()=>{}};}};` }));
  await pg.addInitScript(() => { sessionStorage.clear(); window.open = u => { window.__opened = (window.__opened || []).concat(u); return null; }; });
  pg.on('dialog', d => d.accept());
  await pg.goto(BASE); await pg.waitForTimeout(900);
  await pg.click('#tabs [data-tab="leads"]'); await pg.waitForSelector('#cardBtn', T); await pg.click('#cardBtn');
  await pg.fill('#csEvent', 'Test Expo'); await pg.selectOption('#csRep', { index: 1 });
  const jpg = fs.readFileSync(path.join(B, 'logo.jpg'));
  await pg.setInputFiles('#csFiles', [{ name: 'a.jpg', mimeType: 'image/jpeg', buffer: jpg }, { name: 'b.jpg', mimeType: 'image/jpeg', buffer: jpg }]);
  await pg.waitForFunction(() => /Save 2 as prospects/.test(document.querySelector('.cardscan [data-a="save"]').textContent), null, T);
  assert.equal(await pg.$eval('.cscard[data-i="0"] [data-k="email"]', e => e.value), 'jane.example@acmerealty.com');
  await pg.fill('.cscard[data-i="1"] [data-k="contact_title"]', 'Chief Engineer (fixed)');
  await pg.click('.cardscan [data-a="save"]'); await pg.waitForTimeout(800);
  const rows = await pg.evaluate(() => DBX.prospects.filter(x => /Expo/.test(x.notes || '')).map(x => [x.company, x.contact_name, x.contact_title, x.phone, x.stage]));
  assert.deepEqual(rows, [['ACME REALTY GROUP', 'Jane Q. Example', 'Property Manager', '(510) 555-0199', 'New'], ['SAMPLE PROPERTIES', 'John Doe', 'Chief Engineer (fixed)', null, 'New']], JSON.stringify(rows));
  await pg.waitForSelector('#efList', T);   // said yes to "send the great meeting you email now?"
  assert.match(await pg.textContent('#efMsg'), /2 met · 0 emailed · 2 to go/);
  await pg.click('.cardscan [data-a="next"]'); await pg.waitForTimeout(300); await pg.click('.cardscan [data-a="next"]'); await pg.waitForTimeout(300);
  const op = await pg.evaluate(() => window.__opened || []);
  assert.ok(op.length === 2 && /to=jane\.example%40acmerealty\.com/.test(op[0]) && /Hi%20Jane%2C%0A%0AIt%20was%20great%20meeting%20you%20at%20Test%20Expo/.test(op[0]), 'personal email per person: ' + op[0]);
  const st = await pg.evaluate(() => DBX.prospects.filter(x => /Expo/.test(x.notes || '')).map(x => [x.stage, (x.touches || []).map(t => t.kind).join('+')]));
  assert.deepEqual(st, [['Contacted', 'Met+Email'], ['Contacted', 'Met+Email']], JSON.stringify(st));
  assert.match(await pg.textContent('#efMsg'), /2 emailed · 0 to go/);
  await pg.close();
}

// 44. Offline-safe saving: changes typed with no connection stay on this computer and save by themselves when it's back
{
  const ctx = await b.newContext({ viewport: { width: 1300, height: 900 } }); const pg = await ctx.newPage(); pg.on('pageerror', e => errs.push('offline: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  const pr = { num: 'PFBS-1075', date_sent: '2026-10-18', sent_by: 'Arturo', client: 'Offline Co', property: '1 Net St', status: 'Estimating', notes: '', items: [{ type: 'Base', qty: 1, description: 'Windows', amount: 900 }] };
  await pg.addInitScript(x => { window.MOCK_EXTRA = [x]; if (!sessionStorage.getItem('t44')) { sessionStorage.clear(); localStorage.removeItem('pfbs.offline'); sessionStorage.setItem('t44', '1'); } sessionStorage.setItem('pfbs.open', 'PFBS-1075'); }, pr);
  await pg.goto(BASE); await pg.waitForSelector('#f-notes', T);
  await ctx.setOffline(true); await pg.waitForTimeout(200);
  assert.ok(await pg.$eval('#offBar', e => !e.hidden && /Offline/.test(e.textContent)), 'banner says offline');
  await pg.fill('#f-notes', 'typed with no internet'); await pg.waitForTimeout(2600);
  assert.match(await pg.textContent('#dmsg'), /kept on this computer/);
  assert.equal(await pg.evaluate(() => DBX.proposals.find(x => x.num === 'PFBS-1075').notes), '', 'not in the database yet');
  assert.match(await pg.evaluate(() => localStorage.getItem('pfbs.offline')), /typed with no internet/, 'kept on this computer');
  await pg.click('#closeD'); await pg.waitForTimeout(300);
  assert.match(await pg.textContent('#offBar'), /1 proposal/, 'still waiting after closing it');
  await ctx.setOffline(false); await pg.waitForTimeout(1500);
  assert.equal(await pg.evaluate(() => DBX.proposals.find(x => x.num === 'PFBS-1075').notes), 'typed with no internet', 'saved when the connection came back');
  assert.ok(await pg.$eval('#offBar', e => e.hidden), 'banner gone');
  assert.equal(await pg.evaluate(() => localStorage.getItem('pfbs.offline')), '{}');
  assert.ok(await pg.evaluate(() => DBX.proposal_activity.some(a => a.num === 'PFBS-1075' && /made offline saved/.test(a.note))), 'noted on the job');
  await ctx.close();
}

// 45. Sign-in: password, first-time / forgot link → create a password, and the 6-digit code (set up, then asked each sign-in)
{
  const mk = async (init, url = '') => { const pg = await b.newPage({ viewport: { width: 1300, height: 900 } }); pg.on('pageerror', e => errs.push('signin: ' + e.message));
    await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort()); await pg.addInitScript(init); await pg.goto(BASE + url); return pg; };
  // (a) the sign-in screen: password, or a link for first time / forgot
  let pg = await mk(() => { window.MOCK_NOSESSION = true; sessionStorage.clear(); });
  await pg.waitForSelector('#pwForm', T);
  await pg.fill('#loginEmail', 'Pat@PFBuildingServices.com'); await pg.fill('#loginPw', 'a long password'); await pg.click('#pwForm button[type="submit"]'); await pg.waitForTimeout(200);
  assert.deepEqual(await pg.evaluate(() => window.__signin), { email: 'pat@pfbuildingservices.com', password: 'a long password' });
  await pg.click('#linkBtn'); await pg.waitForTimeout(200); assert.match(await pg.textContent('#loginMsg'), /Check pat@pfbuildingservices\.com for the link/);
  await pg.close();
  // (b) a role that must use the code, not set up yet: setup screen first, the CRM only after a right code
  pg = await mk(() => { sessionStorage.clear(); window.MOCK_RPC = { mfa_status: () => ({ data: { member: true, required: true, enrolled: false, aal: 'aal1' }, error: null }) }; });
  await pg.waitForSelector('#mfaScr img.qr', T);
  assert.match(await pg.textContent('#mfaScr'), /Set up your 6-digit code[\s\S]*TESTSECRET/);
  assert.ok(await pg.$eval('#who', e => e.hidden), 'nothing loads before the code');
  await pg.fill('#mfaScr input.code', '111111'); await pg.click('#mfaScr button[type="submit"]'); await pg.waitForTimeout(200);
  assert.match(await pg.textContent('#mfaScr .err'), /didn't match/);
  await pg.fill('#mfaScr input.code', '123 456'); await pg.click('#mfaScr button[type="submit"]');
  await pg.waitForSelector('#whoName', { state: 'visible', ...T }); assert.ok(!(await pg.$('#mfaScr')), 'in after the right code');
  await pg.close();
  // (c) code already set up: asked for it; (d) came from the emailed link: create a password next
  pg = await mk(() => { sessionStorage.clear(); window.MOCK_FACTORS = [{ id: 'f1', status: 'verified', factor_type: 'totp', friendly_name: 'PFBS CRM' }]; }, '?setpw=1');
  await pg.waitForSelector('#mfaScr input.code', T); assert.match(await pg.textContent('#mfaScr'), /Enter your 6-digit code/);
  await pg.fill('#mfaScr input.code', '123456'); await pg.click('#mfaScr button[type="submit"]');
  await pg.waitForSelector('#mfaScr input[type="password"]', T); assert.match(await pg.textContent('#mfaScr'), /Create your password/);
  const pw = await pg.$$('#mfaScr input[type="password"]'); await pw[0].fill('short'); await pw[1].fill('short'); await pg.click('#mfaScr button[type="submit"]');
  assert.match(await pg.textContent('#mfaScr .err'), /at least 10/);
  await pw[0].fill('blue truck on a roof'); await pw[1].fill('blue truck on a roof'); await pg.click('#mfaScr button[type="submit"]');
  await pg.waitForSelector('#whoName', { state: 'visible', ...T });
  assert.equal(await pg.evaluate(() => window.__pw), 'blue truck on a roof'); assert.ok(!/setpw/.test(pg.url()), 'link flag cleared');
  // (e) Settings → Team: require the code for a role (only once the owner has their own)
  await pg.click('#tabs [data-tab="settings"]'); await pg.waitForSelector('[data-mfarole="Accountant"]', T);
  await pg.check('[data-mfarole="Owner"]'); await pg.check('[data-mfarole="Accountant"]'); await pg.waitForTimeout(300);
  assert.deepEqual(await pg.evaluate(() => DBX.settings[0].data.mfaRoles), ['Owner', 'Accountant']);
  await pg.close();
  pg = await mk(() => { sessionStorage.clear(); window.MOCK_AAL = { currentLevel: 'aal1', nextLevel: 'aal1' }; });
  await pg.waitForSelector('#whoName', { state: 'visible', ...T }); await pg.click('#tabs [data-tab="settings"]'); await pg.waitForSelector('[data-mfarole="Owner"]', T);
  await pg.click('[data-mfarole="Owner"]'); await pg.waitForTimeout(300);
  assert.ok(!(await pg.evaluate(() => (DBX.settings[0].data.mfaRoles || []).includes('Owner'))), 'owner without their own code cannot lock themselves out');
  await pg.close();
}

// 46. Owner resets a lost-phone code; anyone sends feedback from where they are; Owner / Admin read it and mark it done
{
  const pg = await b.newPage({ viewport: { width: 1300, height: 900 } }); pg.on('pageerror', e => errs.push('feedback: ' + e.message));
  await pg.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort()); pg.on('dialog', d => d.type() === 'prompt' ? d.accept('Fixed the colors') : d.accept());
  await pg.addInitScript(() => { sessionStorage.clear(); window.MOCK_RPC = { reset_mfa: a => { window.__reset = a.p_email; return { data: 1, error: null }; } }; });
  await pg.goto(BASE); await pg.waitForSelector('#whoName', { state: 'visible', ...T });
  await pg.click('#tabs [data-tab="settings"]'); await pg.waitForSelector('[data-mfareset="e@x.com"]', T);
  assert.ok(!(await pg.$('[data-mfareset="aperez@pfbuildingservices.com"]')), 'not on your own row');
  await pg.click('[data-mfareset="e@x.com"]'); await pg.waitForTimeout(300);
  assert.equal(await pg.evaluate(() => window.__reset), 'e@x.com'); assert.match(await pg.textContent('#toast'), /reset/);
  await pg.click('#fbBtn'); await pg.waitForSelector('#fbMsg', T);
  assert.match(await pg.textContent('dialog.ask'), /From: Arturo · Settings/);
  await pg.fill('#fbMsg', 'The lift chip is hard to see'); await pg.click('dialog.ask [data-a="send"]'); await pg.waitForTimeout(400);
  assert.deepEqual(await pg.evaluate(() => DBX.feedback.map(x => [x.page, x.message])), [['Settings', 'The lift chip is hard to see']]);
  assert.match(await pg.textContent('dialog.ask'), /Inbox[\s\S]*1 new[\s\S]*The lift chip is hard to see/, 'owner sees it in the inbox');
  await pg.click('dialog.ask [data-fbdone]'); await pg.waitForTimeout(400);
  assert.deepEqual(await pg.evaluate(() => [DBX.feedback[0].done_by, DBX.feedback[0].reply]), ['Arturo', 'Fixed the colors']);
  await pg.close();
}

await b.close(); srv.close();
assert.deepEqual(errs, [], 'no page errors');
console.log('ui: CRM tabs, report from job, approve & email, HCP report, access checks, invoicing, home board passed');
