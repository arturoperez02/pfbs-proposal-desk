// Business cards → prospects (Leads → 📇 Scan cards). Reading happens on the phone / computer with Tesseract (free, no keys);
// parse() turns the text into fields. Nothing leaves the browser until the person reviews and saves.
window.CARDS = (() => {
  const OCR_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  let worker = null;
  const load = src => new Promise((ok, bad) => { const e = document.createElement('script'); e.src = src; e.onload = ok; e.onerror = () => bad(new Error('Could not load the card reader. Check the connection.')); document.head.appendChild(e); });
  // smaller, grey picture = faster and usually better reading; if the browser can't decode it, the file goes as is
  async function prep(file) {
    try { const bmp = await createImageBitmap(file), k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); const g = c.getContext('2d'); g.filter = 'grayscale(1) contrast(1.4)'; g.drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', 0.9)); }
    catch (_) { return file; } }
  async function read(file) {
    if (!window.Tesseract) await load(OCR_SRC);
    if (!worker) worker = await Tesseract.createWorker('eng');
    const { data } = await worker.recognize(await prep(file)); return data.text || ''; }
  async function done() { if (worker) { try { await worker.terminate(); } catch (_) {} worker = null; } }

  const TITLE = /\b(president|vice|vp|ceo|cfo|coo|owner|founder|partner|principal|director|manager|mgr|supervisor|superintendent|engineer|coordinator|administrator|admin|assistant|associate|agent|broker|executive|officer|chief|head|lead|specialist|consultant|representative|rep|sales|facilities|facility|property|operations|maintenance|portfolio|asset|leasing|chair)\b/i;
  const COMPANY = /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co\.|company|group|management|mgmt|properties|property|realty|real estate|partners|associates|holdings|services|solutions|ventures|investments|development|builders|construction|cbre|jll|cushman|colliers|newmark|transwestern|hines|boma|ltd|trust|capital|equities|commercial)\b/i;
  const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const WEB = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|us|biz|co|io|info)\b(?:\/\S*)?/i;
  const PHONE = /(?:\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g;
  const STREET = /^\s*\d{1,6}\s+\S+.*\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|way|ln|lane|ct|court|pl|place|pkwy|parkway|hwy|highway|cir|circle|plaza|ctr|center|sq|square|suite|ste|floor|fl)\b/i;
  const CITY = /\b[A-Za-z .'-]+,?\s+(CA|California|NV|OR|WA|AZ|TX|NY)\b\.?\s*\d{5}(-\d{4})?/;
  const cap = s => s.replace(/\s+/g, ' ').trim();
  // "M: (510) 555-1234" → "(510) 555-1234"; the mobile number first when the card says which one it is
  function phones(t) { const out = []; for (const line of t.split('\n')) { let m; PHONE.lastIndex = 0;
      while ((m = PHONE.exec(line))) { const n = `(${m[1]}) ${m[2]}-${m[3]}`, mob = /\b(m|c|cell|mobile|mob)\b\s*[:.]?\s*[(+\d]/i.test(line.slice(0, m.index + 2)); if (!out.some(x => x.n === n)) out.push({ n, mob }); } }
    return out.sort((a, b) => b.mob - a.mob).map(x => x.n); }
  function parse(text) {
    const raw = String(text || '').replace(/[|_~`•·]+/g, ' ').split('\n').map(cap).filter(l => l.length > 1);
    const all = raw.join('\n'), email = (all.match(EMAIL) || [''])[0].replace(/[.,;]+$/, '');
    const webM = raw.map(l => l.replace(EMAIL, '')).join('\n').match(WEB), website = webM ? webM[0].replace(/[.,;]+$/, '') : '';
    const ph = phones(all);
    const used = new Set(), mark = l => used.add(l);
    let address = ''; const si = raw.findIndex(l => STREET.test(l) && !EMAIL.test(l));
    if (si >= 0) { const next = raw[si + 1] || '', same = CITY.test(raw[si]); address = same ? raw[si] : (CITY.test(next) ? raw[si] + ', ' + next : raw[si]); mark(raw[si]); if (!same && CITY.test(next)) mark(next); }
    else { const ci = raw.findIndex(l => CITY.test(l)); if (ci >= 0) { address = raw[ci]; mark(raw[ci]); } }
    const free = raw.filter(l => !used.has(l) && !EMAIL.test(l) && !(website && l.includes(website.replace(/^https?:\/\//, ''))) && !/\d{3}\D{0,3}\d{4}/.test(l));
    const isName = l => /^[A-Z][a-zA-Z'’.-]+(\s+[A-Z]\.?)?(\s+[A-Z][a-zA-Z'’.-]+){1,2}(,?\s*(Jr|Sr|II|III|CPM|RPA|PE)\.?)?$/.test(l) && !COMPANY.test(l) && !TITLE.test(l);
    let name = free.find(isName) || ''; if (name) mark(name);
    let title = free.find(l => !used.has(l) && TITLE.test(l) && !COMPANY.test(l.replace(/\bproperty\b|\bfacilit(y|ies)\b/ig, ''))) || ''; if (title) mark(title);
    let company = free.find(l => !used.has(l) && COMPANY.test(l)) || '';
    if (!company) { const dom = (email.split('@')[1] || website.replace(/^https?:\/\//, '').replace(/^www\./, '')).split('.')[0] || '';
      if (dom && !/^(gmail|yahoo|hotmail|outlook|icloud|aol|comcast|att|sbcglobal|me|live|msn)$/i.test(dom)) {
        const hit = free.find(l => !used.has(l) && l.replace(/[^a-z]/gi, '').toLowerCase().startsWith(dom.toLowerCase().slice(0, 4)));
        company = hit || (dom.length <= 5 ? dom.toUpperCase() : dom.charAt(0).toUpperCase() + dom.slice(1)); } }
    if (!company) company = free.filter(l => !used.has(l) && /[A-Za-z]{3}/.test(l)).sort((a, b) => (b.replace(/[^A-Z]/g, '').length / b.length) - (a.replace(/[^A-Z]/g, '').length / a.length))[0] || '';
    if (!name && email) { const u = email.split('@')[0].split(/[._-]/).filter(x => /^[a-z]{2,}$/i.test(x)); if (u.length >= 2) name = u.slice(0, 2).map(x => x[0].toUpperCase() + x.slice(1).toLowerCase()).join(' '); }
    return { company, contact_name: name, contact_title: title, email, phone: ph.slice(0, 2).join(' / '), address, website }; }
  return { read, done, parse, prep };
})();
