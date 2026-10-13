import { chromium } from 'playwright'; import http from 'http'; import fs from 'fs'; import path from 'path'; import B from './build.mjs';
const srv = http.createServer((q, s) => { const f = path.join(B, decodeURIComponent(q.url.split(/[?#]/)[0]).replace(/^\/$/, '/index.html')); fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); } else { s.writeHead(200, { 'content-type': f.endsWith('.html')?'text/html':f.endsWith('.jpg')?'image/jpeg':'text/javascript' }); s.end(d); } }); });
await new Promise(r => srv.listen(0, r)); const BASE='http://localhost:'+srv.address().port+'/';
const b = await chromium.launch(); const out=[];
const roles=[['aperez@pfbuildingservices.com','Owner'],['o@x.com','Admin'],['e@x.com','Estimator'],['b@x.com','BD Rep'],['acct@x.com','Accountant'],['se@x.com','Senior Estimator']];
for (const [email, role] of roles) for (const w of [1300, 390]) {
  const pg = await b.newPage({ viewport: { width: w, height: 900 } }); const errs=[];
  pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type()==='error' && !/Failed to load resource/.test(m.text())) errs.push('console: '+m.text()); });
  await pg.route(/fonts|firestore|jsdelivr/, r => r.abort());
  await pg.addInitScript(([e, r]) => { window.MOCK_TEAM=[{email:'acct@x.com',name:'Book Keeper',role:'Accountant',active:true},{email:'se@x.com',name:'Sen Est',role:'Senior Estimator',active:true}]; sessionStorage.clear(); }, [email, role]);
  await pg.goto(BASE + '?u=' + encodeURIComponent(email)); await pg.waitForTimeout(900);
  const tabs = await pg.$$eval('#tabs [data-tab]', L => L.filter(x => !x.hidden).map(x => x.dataset.tab));
  for (const t of tabs) { await pg.click('#tabs [data-tab="'+t+'"]').catch(e=>errs.push('click '+t+': '+e.message.slice(0,80))); await pg.waitForTimeout(250);
    const ov = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (ov > 4) errs.push('tab '+t+' scrolls sideways by '+ov+'px');
    if (w===1300 && role==='Owner') await pg.screenshot({ path: '/tmp/claude-0/-home-claude/9c8e974c-f485-5085-8ec8-67b424a6600d/scratchpad/smoke_'+t+'.png' }); }
  // open first proposal + search + new menu
  const first = await pg.$('tr[data-id]'); if (first && tabs.includes('pipeline')) { await pg.click('#tabs [data-tab="pipeline"]'); await pg.waitForTimeout(200); await pg.click('tr[data-id]').catch(()=>{}); await pg.waitForTimeout(400); await pg.click('#closeD').catch(()=>{}); }
  if (await pg.isVisible('#gNew')) { await pg.click('#gNew'); await pg.waitForTimeout(100); await pg.keyboard.press('Escape'); }
  out.push(role+' @'+w+': tabs='+tabs.join(',')+(errs.length?'\n   ERR '+[...new Set(errs)].slice(0,6).join('\n   ERR '):' OK'));
  await pg.close(); }
for (const pgName of ['warehouse.html','reports.html','hub.html']) { const pg=await b.newPage({viewport:{width:390,height:900}}); const errs=[]; pg.on('pageerror', e=>errs.push(e.message)); await pg.route(/fonts|firestore|jsdelivr/, r=>r.abort());
  await pg.addInitScript(() => { window.MOCK_RPC = { can_warehouse: () => ({ data: true, error: null }) }; }); await pg.goto(BASE+pgName); await pg.waitForTimeout(900);
  const ov = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); out.push(pgName+' @390: '+(errs.length?'ERR '+errs.slice(0,3).join(' | '):'OK')+(ov>4?' sideways '+ov+'px':'')); await pg.close(); }
console.log(out.join('\n')); await b.close(); srv.close();
