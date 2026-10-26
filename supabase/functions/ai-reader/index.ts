// PFBS CRM — Supabase Edge Function "ai-reader" (Arturo 10/25)
// Reads paperwork dropped into the CRM with Claude and returns what's on it; the CRM fills the right job and a person
// checks every number before anything is saved:
//   • the daily sign-in sheet ("Informe diario de horas de los empleados"): date, job, supervisor, each person's in / out
//   • a lift / equipment rental company's final invoice (e.g. Cresco): invoice #, dates, site, PO / job reference, total
// The Anthropic key lives only here (Supabase → Edge Functions → Secrets: ANTHROPIC_API_KEY), never in the page or the
// repo. Only signed-in managers / the accountant can call it.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const SHEET = `PF Building Services' daily sign-in sheet, in Spanish: "INFORME DIARIO DE HORAS DE LOS EMPLEADOS".
Header: FECHA (date), TRABAJO (job: a job number and/or a site), NOMBRE DEL SUPERVISOR. Then one row per person:
NOMBRE DEL EMPLEADO | HORA DE ENTRADA (time in) | ENCIERRE UNO (am/pm, one is circled) | HORA DE SALIDA (time out) | ENCIERRE UNO (am/pm) | FIRMA (signature).
Names may be written "LAST, FIRST" or by nickname. Use the circled am/pm; if none is circled or it is unclear, use the most likely
one for a work shift and set "sure" to false. Read only what is written: never invent rows or times.`;
const INVOICE = `an equipment rental company's invoice for a lift (boom lift, scissor lift, swing stage…), for example from Cresco.
Read: the rental company, invoice number, invoice date, the customer PO / job reference, the jobsite address, the equipment,
the contract / reservation number, the delivery date and the off-rent / pick-up date (or the rental period), and the money:
subtotal, tax, total due. Read only what is printed.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') || '' } } });
    const { data: role } = await sb.rpc('my_role');
    if (!['Owner', 'Admin', 'Senior Estimator', 'Accountant'].includes(String(role))) return json({ error: 'Only managers can use the AI reader.' }, 403);

    const { image, mediaType, crew, hint, kind } = await req.json();
    if (!image || typeof image !== 'string') return json({ error: 'No file was sent.' }, 400);
    if (image.length > 12_000_000) return json({ error: 'The file is too big.' }, 413);
    const key = Deno.env.get('ANTHROPIC_API_KEY');
    if (!key) return json({ error: 'ANTHROPIC_API_KEY is not set in Supabase → Edge Functions → Secrets.' }, 500);

    const names = (Array.isArray(crew) ? crew : []).map(String).slice(0, 80);
    const onlySheet = kind === 'timesheet';
    const prompt = `${onlySheet ? `This is ${SHEET}` : `This file is one of two kinds of paperwork. Decide which:
(1) "timesheet": ${SHEET}
(2) "rental_invoice": ${INVOICE}
If it is neither, use "other".`}
Our crew list: ${names.join('; ') || '(none given)'}.
${hint ? `What the office expects: ${JSON.stringify(hint)}.` : ''}
Reply with JSON only, no other text:
{"type":"timesheet" | "rental_invoice" | "other",
 "date":"YYYY-MM-DD or null","job":"what TRABAJO says or null","supervisor":"name or null",
 "rows":[{"name":"as written","match":"the exact name from our crew list, or null","in":"HH:MM 24-hour or null","out":"HH:MM 24-hour or null","signed":true,"sure":true,"note":"anything odd, else empty"}],
 "invoice":{"vendor":null,"invoice_no":null,"invoice_date":"YYYY-MM-DD or null","customer_po":null,"job_ref":null,"site_address":null,"equipment":[],"contract_no":null,"delivered":"YYYY-MM-DD or null","off_rent":"YYYY-MM-DD or null","subtotal":null,"tax":null,"total":null,"sure":true,"note":""}}
Fill "rows" only for a timesheet and "invoice" only for a rental invoice (numbers as plain numbers, no $).`;

    const isPdf = mediaType === 'application/pdf';
    const file = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: image } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } };
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: Deno.env.get('AI_READER_MODEL') || 'claude-sonnet-5-5', max_tokens: 2500,
        messages: [{ role: 'user', content: [file, { type: 'text', text: prompt }] }] }),
    });
    const out = await r.json();
    if (!r.ok) return json({ error: out?.error?.message || `AI error ${r.status}` }, 502);
    const text = (out.content || []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('\n');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: 'The AI could not read this file. Type it in instead.' }, 422);
    const data = JSON.parse(m[0]);
    if (onlySheet) data.type = 'timesheet';
    data.rows = (Array.isArray(data.rows) ? data.rows : []).filter((x: { name?: string }) => x && String(x.name || '').trim());
    return json(data);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
