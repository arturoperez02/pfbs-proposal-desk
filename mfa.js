// Sign-in: password + 6-digit code from an authenticator app (Microsoft / Google Authenticator), shared by the CRM, Warehouse and
// Service reports pages. The database enforces it (update 035: no code = treated as signed out for anyone who must use one);
// these screens only ask for it. Settings → Security picks the roles that must; anyone can turn it on for themselves.
window.MFA = (() => {
  const css = `.mfa-scr{position:fixed;inset:0;z-index:9999;background:rgba(15,20,40,.72);display:grid;place-items:center;padding:16px;font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
    .mfa-card{background:#fff;color:#1a1f33;border-radius:14px;max-width:420px;width:100%;padding:24px;box-shadow:0 12px 40px rgba(0,0,0,.35)}
    .mfa-card h2{margin:0 0 6px;font-size:21px;color:#1f2a5c} .mfa-card p{margin:6px 0;color:#3b4258} .mfa-card ol{margin:8px 0 8px 20px;padding:0;color:#3b4258}
    .mfa-card input{width:100%;box-sizing:border-box;font:inherit;padding:11px 12px;border:1.5px solid #9aa3bd;border-radius:8px;margin:6px 0}
    .mfa-card input.code{font-size:26px;letter-spacing:.35em;text-align:center;font-variant-numeric:tabular-nums}
    .mfa-card .row{display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:12px;flex-wrap:wrap}
    .mfa-card button{font:inherit;font-weight:700;border-radius:8px;padding:10px 16px;border:0;background:#1f2a5c;color:#fff;cursor:pointer;min-height:44px}
    .mfa-card button.ghost{background:none;color:#1f2a5c;border:1.5px solid #c7cce0} .mfa-card .err{color:#b42318;min-height:20px;font-weight:600}
    .mfa-card .qr{display:block;margin:8px auto;width:190px;height:190px;background:#fff} .mfa-card code{font-size:13px;word-break:break-all;background:#f1f3f9;padding:2px 6px;border-radius:4px}`;
  let styled = false;
  function screen(html) { if (!styled) { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); styled = true; }
    document.getElementById('mfaScr')?.remove(); const d = document.createElement('div'); d.id = 'mfaScr'; d.className = 'mfa-scr'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
    d.innerHTML = `<div class="mfa-card">${html}</div>`; document.body.appendChild(d); d.querySelector('input')?.focus(); return d; }
  const close = () => document.getElementById('mfaScr')?.remove();
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const digits = v => String(v || '').replace(/\D/g, '').slice(0, 6);
  async function status(sb) { try { const r = await sb.rpc('mfa_status'); return r.error ? null : r.data; } catch (_) { return null; } }
  async function factors(sb) { const r = await sb.auth.mfa.listFactors(); return (r.data && r.data.all || []); }
  const signOutBtn = '<button type="button" class="ghost" data-mfa="out">Sign out</button>';
  function wireOut(d, sb) { d.querySelector('[data-mfa="out"]')?.addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); }); }

  // the 6-digit code for someone who already set it up
  function verify(sb, f) { return new Promise(res => {
    const d = screen(`<h2>Enter your 6-digit code</h2><p>Open your authenticator app and type the code shown for <b>PFBS CRM</b>.</p>
      <form><input class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" aria-label="6-digit code" required><div class="err" aria-live="polite"></div>
      <div class="row">${signOutBtn}<button type="submit">Continue</button></div></form>`);
    wireOut(d, sb);
    d.querySelector('form').addEventListener('submit', async e => { e.preventDefault(); const code = digits(d.querySelector('input').value), er = d.querySelector('.err');
      if (code.length !== 6) { er.textContent = 'The code has 6 numbers.'; return; }
      const r = await sb.auth.mfa.challengeAndVerify({ factorId: f.id, code });
      if (r.error) { er.textContent = 'That code didn\'t work. Codes change every 30 seconds: try the new one.'; d.querySelector('input').select(); return; }
      close(); res(true); }); }); }

  // set it up: scan the QR code, type the first code
  function enroll(sb, { required = false } = {}) { return new Promise(async res => {
    for (const f of await factors(sb)) if (f.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: f.id });
    const r = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'PFBS CRM ' + new Date().toISOString().slice(0, 10) });
    if (r.error) { screen(`<h2>Couldn't start the 2-step setup</h2><p>${esc(r.error.message)}</p><div class="row">${signOutBtn}<button type="button" data-mfa="x">OK</button></div>`);
      const d = document.getElementById('mfaScr'); wireOut(d, sb); d.querySelector('[data-mfa="x"]').onclick = () => { close(); res(false); }; return; }
    const t = r.data.totp || {}, qr = /^data:/.test(t.qr_code || '') ? t.qr_code : 'data:image/svg+xml;utf-8,' + encodeURIComponent(t.qr_code || '');
    const d = screen(`<h2>${required ? 'Set up your 6-digit code' : 'Turn on the 6-digit code'}</h2>
      <p>${required ? 'Your role signs in with a password <b>and</b> a code from your phone. One-time setup, about a minute:' : 'One-time setup, about a minute:'}</p>
      <ol><li>Install <b>Microsoft Authenticator</b> or <b>Google Authenticator</b> on your phone.</li><li>In the app, tap <b>+</b> and scan this code:</li></ol>
      <img class="qr" src="${esc(qr)}" alt="QR code to scan with the authenticator app">
      <p style="font-size:13px">Can't scan? Enter this key in the app instead: <code>${esc(t.secret || '')}</code></p>
      <ol start="3"><li>Type the 6-digit code the app shows:</li></ol>
      <form><input class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" aria-label="6-digit code" required><div class="err" aria-live="polite"></div>
      <div class="row">${required ? signOutBtn : '<button type="button" class="ghost" data-mfa="x">Not now</button>'}<button type="submit">Turn it on</button></div></form>`);
    wireOut(d, sb); d.querySelector('[data-mfa="x"]')?.addEventListener('click', async () => { await sb.auth.mfa.unenroll({ factorId: r.data.id }); close(); res(false); });
    d.querySelector('form').addEventListener('submit', async e => { e.preventDefault(); const code = digits(d.querySelector('input').value), er = d.querySelector('.err');
      if (code.length !== 6) { er.textContent = 'The code has 6 numbers.'; return; }
      const v = await sb.auth.mfa.challengeAndVerify({ factorId: r.data.id, code });
      if (v.error) { er.textContent = 'That code didn\'t match. Make sure you scanned this QR code, then try the newest code.'; return; }
      close(); res(true); }); }); }

  // signed in with a password or an emailed link: ask for the code when this person needs it
  async function gate(sb) {
    const a = (await sb.auth.mfa.getAuthenticatorAssuranceLevel()).data || {};
    if (a.currentLevel === 'aal2') return true;
    const ok = (await factors(sb)).find(f => f.status === 'verified' && f.factor_type === 'totp');
    if (ok) return verify(sb, ok);
    const st = await status(sb);
    if (st && st.member && st.required) return enroll(sb, { required: true });
    return true; }

  // create or change the password (after an emailed link, or from "My sign-in")
  function setPassword(sb, { first = false } = {}) { return new Promise(res => {
    const d = screen(`<h2>${first ? 'Create your password' : 'Change your password'}</h2><p>At least 10 characters. A short sentence is easy to remember and hard to guess.</p>
      <form><input type="password" autocomplete="new-password" placeholder="New password" aria-label="New password" required><input type="password" autocomplete="new-password" placeholder="Same password again" aria-label="Same password again" required>
      <div class="err" aria-live="polite"></div><div class="row"><button type="button" class="ghost" data-mfa="x">${first ? 'Later' : 'Cancel'}</button><button type="submit">Save password</button></div></form>`);
    d.querySelector('[data-mfa="x"]').onclick = () => { close(); res(false); };
    d.querySelector('form').addEventListener('submit', async e => { e.preventDefault(); const [p1, p2] = [...d.querySelectorAll('input')].map(i => i.value), er = d.querySelector('.err');
      if (p1.length < 10) { er.textContent = 'Use at least 10 characters.'; return; } if (p1 !== p2) { er.textContent = 'The two passwords don\'t match.'; return; }
      const r = await sb.auth.updateUser({ password: p1 }); if (r.error) { er.textContent = r.error.message; return; }
      close(); res(true); }); }); }

  return { gate, enroll, verify, setPassword, status, factors };
})();
