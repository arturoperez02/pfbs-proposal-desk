// PFBS CRM — Supabase Edge Function "read-timesheet" (Arturo 10/25)
// Reads a photo of the daily sign-in sheet ("Informe diario de horas de los empleados") with Claude and returns the
// date, job, supervisor and each person's time in / time out. The CRM fills its "Waiting for hours" card with it and a
// person checks every number before saving. The Anthropic key lives only here (Supabase → Edge Functions → Secrets:
// ANTHROPIC_API_KEY), never in the page or the repo. Only signed-in managers / the accountant can call it.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    // who is asking: the CRM user's own sign-in, checked against the team list (same rules as the page)
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') || '' } } });
    const { data: role } = await sb.rpc('my_role');
    if (!['Owner', 'Admin', 'Senior Estimator', 'Accountant'].includes(String(role))) return json({ error: 'Only managers can read sign-in sheets.' }, 403);

    const { image, mediaType, crew, hint } = await req.json();
    if (!image || typeof image !== 'string') return json({ error: 'No picture was sent.' }, 400);
    if (image.length > 8_000_000) return json({ error: 'The picture is too big.' }, 413);
    const key = Deno.env.get('ANTHROPIC_API_KEY');
    if (!key) return json({ error: 'ANTHROPIC_API_KEY is not set in Supabase → Edge Functions → Secrets.' }, 500);

    const names = (Array.isArray(crew) ? crew : []).map(String).slice(0, 80);
    const prompt = `This photo is PF Building Services' daily sign-in sheet, in Spanish: "INFORME DIARIO DE HORAS DE LOS EMPLEADOS".
Header: FECHA (date), TRABAJO (job: a job number and/or a site), NOMBRE DEL SUPERVISOR. Then one row per person:
NOMBRE DEL EMPLEADO | HORA DE ENTRADA (time in) | ENCIERRE UNO (am/pm, one is circled) | HORA DE SALIDA (time out) | ENCIERRE UNO (am/pm) | FIRMA (signature).
Names may be written "LAST, FIRST" or by nickname. Our crew list: ${names.join('; ') || '(none given)'}.
${hint ? `The office expects this job: ${JSON.stringify(hint)}.` : ''}
Read only what is written. Do not invent rows or times. Use the circled am/pm; if none is circled or it is unclear, use the most likely one for a work shift and set "sure" to false.
Reply with JSON only, no other text:
{"date":"YYYY-MM-DD or null","job":"what TRABAJO says or null","supervisor":"name or null",
 "rows":[{"name":"as written","match":"the exact name from our crew list, or null","in":"HH:MM 24-hour or null","out":"HH:MM 24-hour or null","signed":true,"sure":true,"note":"anything odd, else empty"}]}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: Deno.env.get('TIMESHEET_MODEL') || 'claude-sonnet-5-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
          { type: 'text', text: prompt },
        ] }],
      }),
    });
    const out = await r.json();
    if (!r.ok) return json({ error: out?.error?.message || `AI error ${r.status}` }, 502);
    const text = (out.content || []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('\n');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: 'The AI could not read this sheet. Type the hours instead.' }, 422);
    const data = JSON.parse(m[0]);
    data.rows = (Array.isArray(data.rows) ? data.rows : []).filter((x: { name?: string }) => x && String(x.name || '').trim());
    return json(data);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
