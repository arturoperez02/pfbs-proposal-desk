// SharePoint client folders, shared by the CRM (index.html) and service reports (reports.html) so it's built once.
// Needs SP_CLIENT_ID + SP_TENANT_ID in config.js (Entra app "PFBS Proposal Desk", Single-page application, no secret).
// Microsoft sign-in happens once per browser and is remembered (localStorage), so later saves are silent.
window.SP = (() => {
  const C = () => { const c = window.PFBS_CONFIG || {};
    return { clientId: c.SP_CLIENT_ID || '', tenant: c.SP_TENANT_ID || '', site: c.SP_SITE || 'pfwindowcleaning.sharepoint.com:/sites/team', library: c.SP_LIBRARY || 'Clients' }; };
  const SCOPES = ['Files.ReadWrite.All', 'Sites.ReadWrite.All'];
  // service → short code at the front of file names, and → its folder name under the property (folder names as they are in SharePoint)
  const CODE = {'Window Cleaning':'WC','Pressure Wash':'PW','Solar Panel Cleaning':'SP','Janitorial':'JAN','Gutter Cleaning':'GC','Graffiti Removal':'GR','Gates & Doors':'GD','Lights - Decor':'LD','Multiple services':'MULTI'};
  const FOLDER = {'Window Cleaning':'Window Cleaning','Pressure Wash':'Presure Wash','Solar Panel Cleaning':'Solar Panel Cleaning','Gates & Doors':'G&D','Gutter Cleaning':'Gutter Cleaning','Janitorial':'Janitorial','Graffiti Removal':'Graffiti Removal','Lights - Decor':'Lights - Decor'};
  let app = null, drv = null;
  const S = { who: () => '' };   // set by the page: the signed-in person's email (picks their Microsoft account)
  const on = () => { const c = C(); return !!(c.clientId && c.tenant); };
  const loadScript = src => new Promise((ok, bad) => { const e = document.createElement('script'); e.src = src; e.onload = ok; e.onerror = () => bad(new Error('Could not load ' + src)); document.head.appendChild(e); });
  async function token() {
    const c = C();
    if (!app) { if (!window.msal) await loadScript('https://cdn.jsdelivr.net/npm/@azure/msal-browser@2.38.3/lib/msal-browser.min.js');
      app = new msal.PublicClientApplication({ auth: { clientId: c.clientId, authority: 'https://login.microsoftonline.com/' + c.tenant, redirectUri: new URL('auth.html', location.href).href }, cache: { cacheLocation: 'localStorage' } });
      if (app.initialize) await app.initialize(); }
    const me = String(S.who() || '').toLowerCase(), all = app.getAllAccounts(), acct = all.find(a => (a.username || '').toLowerCase() === me) || all[0];
    if (acct) { try { return (await app.acquireTokenSilent({ scopes: SCOPES, account: acct })).accessToken; } catch (_) {} }
    return (await app.acquireTokenPopup({ scopes: SCOPES, loginHint: me || undefined })).accessToken;
  }
  async function graph(path, opt = {}) {
    const tok = await token(), r = await fetch(path.startsWith('http') ? path : 'https://graph.microsoft.com/v1.0' + path, { ...opt, headers: { Authorization: 'Bearer ' + tok, ...(opt.headers || {}) } });
    if (!r.ok) { let m = r.status + ''; try { m = (await r.json()).error?.message || m; } catch (_) {} const e = new Error(m); e.status = r.status; throw e; }
    return r.status === 204 ? null : r.json();
  }
  async function drive() { if (drv) return drv; const c = C(), d = await graph(`/sites/${c.site}:/drives?$select=id,name,webUrl`);
    drv = (d.value || []).find(x => x.name === c.library || decodeURIComponent(x.webUrl || '').endsWith('/' + c.library)); if (!drv) throw new Error(`Library "${c.library}" not found on the site`); return drv; }
  const encPath = p => p.split('/').map(encodeURIComponent).join('/');
  async function children(path) { const d = await drive();
    try { const r = await graph(`/drives/${d.id}/root${path ? ':/' + encPath(path) + ':' : ''}/children?$select=name,folder&$top=500`); return (r.value || []).filter(x => x.folder).map(x => x.name).sort((a, b) => a.localeCompare(b)); }
    catch (e) { if (e.status === 404) return []; throw e; } }
  function bestMatch(list, ...hints) { const n = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    for (const h of hints) { const k = n(h); if (!k) continue;
      const hit = list.find(x => n(x) === k) || list.find(x => n(x).startsWith(k) || k.startsWith(n(x)) && n(x).length > 3) || list.find(x => n(x).includes(k.split(' ').slice(0, 2).join(' ')));
      if (hit) return hit; }
    return ''; }
  // make the folders along a path (Clients/<client>/<property>/<service>) if missing; returns {id, webUrl}
  async function ensure(path) { const d = await drive(); let parent = '';
    for (const part of path.split('/').filter(Boolean)) {
      try { await graph(`/drives/${d.id}/root${parent ? ':/' + encPath(parent) + ':' : ''}/children`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: part, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) }); }
      catch (e) { if (e.status !== 409) throw e; }
      parent = parent ? parent + '/' + part : part; }
    return graph(`/drives/${d.id}/root:/${encPath(parent)}?$select=id,webUrl`); }
  // the folder for a job without asking: the client folder and property folder already in SharePoint (service folder made if missing)
  async function find(client, propHints, svc) {
    const cl = bestMatch(await children(''), client); if (!cl) return '';
    const pr = bestMatch(await children(cl), ...propHints); if (!pr) return '';
    return (await ensure([cl, pr, FOLDER[svc] || ''].filter(Boolean).join('/'))).webUrl; }
  // a folder (by its web link), or a subfolder of it made if missing (e.g. "Photos 10-24-2026") → where files go
  async function target(folderUrl, sub) {
    const d = await drive(), share = 'u!' + btoa(unescape(encodeURIComponent(folderUrl))).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
    const folder = await graph(`/shares/${share}/driveItem?$select=id,parentReference`), driveId = folder.parentReference?.driveId || d.id;
    let pid = folder.id;
    if (sub) { try { await graph(`/drives/${driveId}/items/${pid}/children`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: sub, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) }); } catch (e) { if (e.status !== 409) throw e; }
      pid = (await graph(`/drives/${driveId}/items/${pid}:/${encodeURIComponent(sub)}?$select=id`)).id; }
    return { driveId, pid }; }
  const put = (t, name, blob) => graph(`/drives/${t.driveId}/items/${t.pid}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=replace`, { method: 'PUT', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
  // put a file in a folder; same name = replaced
  async function upload(blob, name, folderUrl, sub) { return put(await target(folderUrl, sub), name, blob); }
  // every file is named the same way, so the folder sorts by service, then kind of paper, then date:
  // "WC Proposal 10-9-2026 100 Village Ln Foster City - PFBS-0801.pdf", "WC Service Report 10-24-2026 …", "WC Invoice 10238 10-27-2026 …"
  const place = s => String(s || '').replace(/[^A-Za-z0-9 ]+/g, '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const mdy = d => `${d.getMonth() + 1}-${d.getDate()}-${d.getFullYear()}`;
  function name(code, kind, date, where, num, ext = 'pdf') { return `${code} ${kind} ${mdy(date || new Date())} ${place(where)} - ${num || 'NEW'}.${ext}`; }
  const isLink = u => /^https:\/\/[^/]*sharepoint\.com\//.test(u || '');
  // the service date of a report: the last date in "10/24/2026 – 10/25/2026" (the finish day), else the day it was approved
  function repDate(rep) { const all = [...String(rep.service_dates || '').matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g)], m = all[all.length - 1];
    if (m) return new Date(+m[3], m[1] - 1, +m[2]); const i = String(rep.service_dates || '').match(/(\d{4})-(\d{2})-(\d{2})/);
    if (i) return new Date(+i[1], i[2] - 1, +i[3]); return rep.approved_at ? new Date(rep.approved_at) : new Date(); }
  // the job's folder link; if it has none yet, find the client + property folders and remember it on the job
  async function jobFolder(sb, job) {
    if (isLink(job.folder_link)) return job.folder_link;
    const url = await find(job.client, [String(job.site_address || '').split(/\n|,/)[0], job.property], job.service);
    if (url && job.num) { await sb.from('proposals').update({ folder_link: url }).eq('num', job.num); job.folder_link = url; }
    return url; }
  // a service report into the job's folder: its PDF, and (photos: true) the full-size photos in "Photos <date>"
  // rep: {id, pdf:{path}, service_dates, approved_at, photos:[{id, caption}]}; job: {num, service, code, client, property, site_address, folder_link}
  async function saveReport(sb, rep, job, o = {}) {
    const folder = await jobFolder(sb, job); if (!folder) return { folder: '', saved: [] };
    const when = repDate(rep), code = job.code || CODE[job.service] || 'SR', saved = [], bucket = sb.storage.from('job-reports');
    let pdf = o.pdf; if (!pdf && rep.pdf?.path) pdf = (await bucket.download(rep.pdf.path)).data;
    if (pdf) { const n = name(code, 'Service Report', when, job.property || job.client, job.num); await upload(new Blob([pdf], { type: 'application/pdf' }), n, folder); saved.push(n); }
    const phs = o.photos ? (rep.photos || []) : [];
    if (phs.length) { const t = await target(folder, 'Photos ' + mdy(when)); let k = 0;
      for (const [i, ph] of phs.entries()) { const { data } = await bucket.download(`photos/${rep.id}/${ph.id}.jpg`); if (!data) continue;
        await put(t, `${String(i + 1).padStart(2, '0')}${ph.caption ? ' ' + place(ph.caption) : ''}.jpg`, new Blob([data], { type: 'image/jpeg' })); k++; }
      if (k) saved.push(`${k} photo${k > 1 ? 's' : ''} (Photos ${mdy(when)})`); }
    return { folder, saved }; }
  return { jobFolder, saveReport, repDate, target, put, on, C, SCOPES, CODE, FOLDER, S, token, graph, drive, children, bestMatch, ensure, find, upload, name, place, mdy, isLink };
})();
