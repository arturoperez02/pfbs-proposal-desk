// Copies the app pages into tests/.build with the database swapped for mock.js (made-up data) and local PDF libraries.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const T = path.dirname(fileURLToPath(import.meta.url)), R = path.join(T, '..'), B = path.join(T, '.build');
fs.mkdirSync(B, { recursive: true });
const cfg = '<script>window.PFBS_CONFIG={SUPABASE_URL:"https://x.supabase.co",SUPABASE_ANON_KEY:"k",...(new URLSearchParams(location.search).has("sp")?{SP_CLIENT_ID:"c",SP_TENANT_ID:"t"}:{})}; window.MOCK_EMAIL=new URLSearchParams(location.search).get("u")||"";</script>';
const swap = s => s
  .replace('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>', '<script src="mock.js"></script>')
  .replace('<script src="config.js"></script>', cfg)
  .replace('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js', 'jspdf.umd.min.js')
  .replace('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', 'jspdf.umd.min.js')
  .replace('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js', 'jspdf.plugin.autotable.min.js');
let idx = swap(fs.readFileSync(path.join(R, 'index.html'), 'utf8'));
idx = idx.replace('if(data && data[0]) COLS=new Set(Object.keys(data[0]));', '/* mock: all columns */');
fs.writeFileSync(path.join(B, 'index.html'), idx);
fs.writeFileSync(path.join(B, 'reports.html'), swap(fs.readFileSync(path.join(R, 'reports.html'), 'utf8')));
fs.writeFileSync(path.join(B, 'warehouse.html'), swap(fs.readFileSync(path.join(R, 'warehouse.html'), 'utf8')));
for (const f of ['logo.jpg', 'reports-logo.jpg', 'jobsheet.js', 'sp.js', 'cards.js']) fs.copyFileSync(path.join(R, f), path.join(B, f));
fs.copyFileSync(path.join(T, 'mock.js'), path.join(B, 'mock.js'));
for (const f of fs.readdirSync(path.join(T, 'vendor'))) fs.copyFileSync(path.join(T, 'vendor', f), path.join(B, f));
export default B;
