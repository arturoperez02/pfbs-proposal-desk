// =====================================================================
// PFBS job packet — shared by the CRM (index.html) and the Warehouse (warehouse.html), so it's built in one place.
// Page 1: job sheet (the job: where, when, who, scope, lift, crew notes, photos, "Back from the job" box filled by pen)
// Page 2: kit slip (the stuff: the warehouse kit items with Out / Back boxes). Nothing appears on both pages. Never prices.
// Data in:  JP.open(d | [d, d, …], lang, tr)   (a list prints several packets, each starting on a new page)  d = {job, num, client, address, date, endDate, skipWeekends, start, end, techs[], vehicle,
//           scope[], notes, rentals[{desc,vendor,vendorPhone,reservationNo,deliveryDate,offRentDate}], kit:{items[{name,name_es,qty}]}|null}
//           tr = Spanish translator for scope lines (defaults to JP.toEs with the built-in terms)
// =====================================================================
const ES_TERMS=[['interior & exterior window cleaning','limpieza de ventanas interior y exterior'],['interior and exterior window cleaning','limpieza de ventanas interior y exterior'],
 ['exterior window cleaning','limpieza de ventanas exterior'],['interior window cleaning','limpieza de ventanas interior'],['window cleaning','limpieza de ventanas'],['window washing','lavado de ventanas'],
 ['ground pressure washing','lavado a presión (planta baja)'],['pressure washing','lavado a presión'],['power washing','lavado a presión'],['pressure wash','lavar a presión'],
 ['solar panel cleaning','limpieza de paneles solares'],['solar panels','paneles solares'],['gutter cleaning','limpieza de canaletas'],['graffiti removal','remoción de grafiti'],
 ['high dusting','limpieza de polvo en alturas'],['parking structure','estructura de estacionamiento'],['parking garage','garaje de estacionamiento'],['parking lot','estacionamiento'],
 ['trash enclosure','área de basura'],['trash area','área de basura'],['loading dock','andén de carga'],['all elevations','todas las fachadas'],['all sides','todos los lados'],
 ['swing stage','andamio colgante (swing stage)'],['boom lift','grúa elevadora (boom lift)'],['scissor lift','elevador de tijera'],['bosun chair','silla de contramaestre (bosun chair)'],['rope access','acceso con cuerdas'],
 ['common areas','áreas comunes'],['entry doors','puertas de entrada'],['front entrance','entrada principal'],['roll-up door','puerta enrollable'],['roll up door','puerta enrollable'],['door closer','cierrapuertas'],['electric strike','cerradura eléctrica'],
 ['window','ventana'],['windows','ventanas'],['glass','vidrio'],['frames','marcos'],['screens','mallas'],['skylights','tragaluces'],['skylight','tragaluz'],['awnings','toldos'],['canopy','marquesina'],['canopies','marquesinas'],
 ['sidewalks','banquetas'],['sidewalk','banqueta'],['walkways','pasillos'],['courtyard','patio'],['plaza','plaza'],['entrance','entrada'],['entrances','entradas'],['entry','entrada'],['lobby','vestíbulo'],['storefront','escaparate'],['storefronts','escaparates'],
 ['stairwells','escaleras'],['stairs','escaleras'],['elevator','elevador'],['elevators','elevadores'],['balconies','balcones'],['railings','barandales'],['roof','techo'],['walls','paredes'],['wall','pared'],['floors','pisos'],['floor','piso'],['levels','niveles'],['level','nivel'],
 ['signage','letreros'],['signs','letreros'],['gutters','canaletas'],['dumpster','contenedor de basura'],['carpet','alfombra'],['restrooms','baños'],['restroom','baño'],['offices','oficinas'],['office','oficina'],['building','edificio'],['buildings','edificios'],
 ['cleaning','limpieza'],['clean','limpiar'],['washing','lavado'],['wash','lavar'],['exterior','exterior'],['interior','interior'],['inside','adentro'],['outside','afuera'],['only','solamente'],['and','y'],['with','con'],['of','de'],
 ['monthly','mensual'],['quarterly','trimestral'],['weekly','semanal'],['annual','anual'],['yearly','anual'],['first floor','primer piso'],['ground floor','planta baja'],['north','norte'],['south','sur'],['east','este'],['west','oeste'],['side','lado'],['front','frente'],['back','parte trasera'],['rear','parte trasera']];
const JS_T={
 en:{title:'Job sheet',job:'Job #',client:'Client',site:'Site',when:'Date',time:'Time',team:'Crew',vehicle:'Vehicle',contact:'Site contact',scope:'Scope of work',mat:'Materials',equip:'Equipment',lift:'Lift / rental',company:'Rental company',delivery:'Delivery',reservation:'Reservation #',offrent:'Planned off-rent',notes:'Notes for the crew',none:'None',qty:'Qty',packed:'Packed',photos:'Photos to take',ph:['BEFORE: each side / area before starting','AFTER: the same spots when done','Anything broken, stained or that could not be cleaned','Lift / equipment set-up (safety)'],
     back:'Back from the job — supervisor fills in by hand',finished:'Date finished',techs:'How many techs',hrs:'Hours each (per day)',days:'How many days',total:'Total hours',matLeft:'Materials left over',equipBack:'All equipment returned?',yes:'Yes',no:'No',noMiss:'No, missing:',offCalled:'Lift off-rent called?',offNo:'Off-rent #',issues:'Problems, damage or extra work the client asked for',photosTaken:'Photos taken?',clientOk:'Client walk-through — name',sig:'Signature',sup:'Supervisor',wh:'Warehouse checked in',weekdays:'weekdays only',print:'Print',close:'Close',lang:'Español',kit:'Kit',kitN:n=>`${n} item${n==1?'':'s'} — see the kit slip (page 2)`,kitNone:'Not packed yet. The warehouse adds the kit slip when it packs.',slip:'Kit slip',reqs:'Client requests — read before you start',siteN:'Building notes',from:'from',returned:'Returned',by:'by',checked:'checked in by',keys:'Keys / access cards',warn:'Check before it goes out',scan:'Warehouse: scan this barcode when the kit goes out and when it comes back',item:'Item',out:'Out',backc:'Back',extra:'Additional material needed / not needed',tech:'Tech signature + date',supv:'Supervisor + date'},
 es:{title:'Hoja de trabajo',job:'Trabajo #',client:'Cliente',site:'Lugar',when:'Fecha',time:'Hora',team:'Técnicos',vehicle:'Vehículo',contact:'Contacto en el sitio',scope:'Alcance del trabajo',mat:'Materiales',equip:'Equipo',lift:'Elevador / renta',company:'Compañía de renta',delivery:'Entrega',reservation:'Reservación #',offrent:'Fin de renta planeado',notes:'Notas para el equipo',none:'Ninguno',qty:'Cant.',packed:'Empacado',photos:'Fotos que hay que tomar',ph:['ANTES: cada lado / área antes de empezar','DESPUÉS: los mismos lugares al terminar','Algo roto, manchado o que no se pudo limpiar','Instalación del elevador / equipo (seguridad)'],
     back:'Al regresar del trabajo — el supervisor llena a mano',finished:'Fecha en que terminó',techs:'Cuántos técnicos',hrs:'Horas cada uno (por día)',days:'Cuántos días',total:'Horas en total',matLeft:'Materiales que sobraron',equipBack:'¿Se regresó todo el equipo?',yes:'Sí',no:'No',noMiss:'No, falta:',offCalled:'¿Se llamó para terminar la renta del elevador?',offNo:'# de fin de renta',issues:'Problemas, daños o trabajo extra que pidió el cliente',photosTaken:'¿Se tomaron fotos?',clientOk:'Revisión con el cliente — nombre',sig:'Firma',sup:'Supervisor',wh:'Recibido en el almacén',weekdays:'solo días hábiles',print:'Imprimir',close:'Cerrar',lang:'English',kit:'Kit',kitN:n=>`${n} artículo${n==1?'':'s'} — vea la hoja del kit (página 2)`,kitNone:'Todavía no se empaca. El almacén agrega la hoja del kit al empacarlo.',slip:'Hoja del kit',reqs:'Peticiones del cliente — leer antes de empezar',siteN:'Notas del edificio',from:'de',returned:'Regresó',by:'por',checked:'recibido por',keys:'Llaves / tarjetas',warn:'Revisar antes de que salga',scan:'Almacén: escanee este código cuando sale el kit y cuando regresa',item:'Artículo',out:'Salida',backc:'Regreso',extra:'Material adicional necesario / no necesario',tech:'Firma del técnico + fecha',supv:'Supervisor + fecha'}};
const JP = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const day = d => { const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(d||'')); return m ? new Date(+m[1], +m[2]-1, +m[3]) : null; };
  const dLong = (d,lang) => { const x=day(d); return x ? x.toLocaleDateString(lang==='es'?'es-MX':'en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'}) : ''; };
  const t12 = (t,lang) => { if(!t) return ''; const [h,m]=String(t).split(':').map(Number); const s=`${(h%12)||12}:${String(m||0).padStart(2,'0')} ${h<12?'AM':'PM'}`; return lang==='es'?s.replace('AM','a.m.').replace('PM','p.m.'):s; };
  function toEs(text, extra){
    const all=[...(extra||[]), ...ES_TERMS].sort((a,b)=>b[0].length-a[0].length), e2=x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const re=new RegExp('\\b('+all.map(x=>e2(x[0])).join('|')+')\\b','gi'), map=new Map(all.map(x=>[x[0].toLowerCase(),x[1]]));
    const out=String(text||'').replace(re, m=>map.get(m.toLowerCase())||m); return out.charAt(0).toUpperCase()+out.slice(1); }
  // the kit slip's barcode (Code128 of the job #, same kind as the warehouse item labels): the warehouse scanner reads it
  // into Home → Scan a kit or Returns → Scan to open that kit (Picked up / Return); drawn after the page is on screen
  function drawQR(w){ if(!window.JsBarcode) return; w.querySelectorAll('svg[data-bc]').forEach(c=>{ try{ JsBarcode(c, c.dataset.bc, {format:'CODE128', height:38, width:2, displayValue:true, fontSize:12, margin:2}); }catch(e){} }); }
  function html(d, lang, tr){
    const t=JS_T[lang], es=x=>lang==='es'?(tr||toEs)(x):x, box='<span class="jsb"></span>', line='<span class="jsl"></span>';
    const dts=dLong(d.date,lang)+(d.endDate&&d.endDate!==d.date?' – '+dLong(d.endDate,lang)+(d.skipWeekends?` (${t.weekdays})`:''):'');
    const R=d.rentals||[], sc=d.scope||[], items=(d.kit&&d.kit.items)||[], job=d.job?`<div class="jsjob">${t.job} ${esc(d.job)}</div>`:d.blank?`<div class="jsjob">${t.job} ${line}</div>`:'';
    const B=x=>d.blank?'<span class="jsl" style="min-width:260px"></span>':x;   // blank paper form: lines to write on
    return `<div class="jspage">
   <div class="jshead"><img src="reports-logo.jpg" alt="PF Building Services"><div><div class="jst">${t.title}</div>${job}</div></div>
   <table class="jskv"><tr><th>${t.client}</th><td>${B(esc(d.client||''))}</td></tr>
     <tr><th>${t.site}</th><td>${B(esc(d.address||'').replace(/\n/g,'<br>'))}</td></tr>
     <tr><th>${t.when}</th><td>${B(esc(dts))}</td></tr><tr><th>${t.time}</th><td>${B(esc(t12(d.start,lang))+(d.end?' – '+esc(t12(d.end,lang)):''))}</td></tr>
     <tr><th>${t.team}</th><td>${B(esc((d.techs||[]).join(', ')||'—')+(d.vehicle?` &nbsp;·&nbsp; ${t.vehicle}: ${esc(d.vehicle)}`:''))}</td></tr></table>
   ${(d.requests||[]).length||d.siteNotes?`<div class="jsreq">${(d.requests||[]).length?`<h4>⚠ ${t.reqs}</h4><ul class="jschk">${d.requests.map(r=>`<li>${box} <b>${esc(r.text)}</b>${r.from?` <span class="jsfrom">(${t.from} ${esc(r.from)})</span>`:''}</li>`).join('')}</ul>`:''}${d.siteNotes?`<h4>${t.siteN}</h4><p>${esc(d.siteNotes).replace(/\n/g,'<br>')}</p>`:''}</div>`:''}
   <h4>${t.scope}</h4>${sc.length?`<ul>${sc.map(x=>`<li>${esc(es(x))}</li>`).join('')}</ul>`:d.blank?`<div class="jsrow">${line}${line}${line}</div>`:`<p>${t.none}</p>`}
   <h4>${t.kit}</h4><p>${d.blank?esc(t.kitN('__')):items.length?esc(t.kitN(items.length)):esc(t.kitNone)}</p>
   ${R.length?`<h4>${t.lift}</h4>${R.map(x=>`<div class="jslift"><b>${esc(x.desc||'')}</b><div class="jsl2"><span>${t.company}: <b>${esc(x.vendor||'—')}</b>${x.vendorPhone?' · '+esc(x.vendorPhone):''}</span><span>${t.reservation} <b>${esc(x.reservationNo||'—')}</b></span><span>${t.delivery}: <b>${x.deliveryDate?esc(dLong(x.deliveryDate,lang)):'—'}</b></span><span>${t.offrent}: <b>${x.offRentDate?esc(dLong(x.offRentDate,lang)):'—'}</b></span></div></div>`).join('')}`:''}
   ${d.notes?`<h4>${t.notes}</h4><p class="jsnote">${esc(d.notes).replace(/\n/g,'<br>')}</p>`:''}
   <h4>${t.photos}</h4><ul class="jschk">${t.ph.map(x=>`<li>${box} ${x}</li>`).join('')}</ul>
   <div class="jsback"><h4>${t.back}</h4>
     <div class="jsrow"><span>${t.finished}: ${line}</span><span>${t.days}: ${line}</span></div>
     <div class="jsrow"><span>${t.techs}: ${line}</span><span>${t.hrs}: ${line}</span><span>${t.total}: ${line}</span></div>
     ${R.length?`<div class="jsrow"><span>${t.offCalled} ${box} ${t.yes} ${box} ${t.no}</span><span>${t.offNo}: ${line}</span></div>`:''}
     <div class="jsrow"><span>${t.photosTaken} ${box} ${t.yes} ${box} ${t.no}</span></div>
     <div class="jsrow"><span>${t.issues}:</span></div><div class="jsbig"></div>
     <div class="jsrow"><span>${t.clientOk}: ${line}</span><span>${t.sig}: ${line}</span></div>
     <div class="jsrow"><span>${t.sup}: ${line}</span><span>${t.sig}: ${line}</span><span>${t.wh}: ${line}</span></div></div>
   <div class="jsfoot">PF Building Services${d.num?' · '+esc(d.num):''}${d.job?' · '+t.job+' '+esc(d.job):''}</div></div>
   ${items.length?`<div class="jspage jsp2"><div class="jshead"><div class="jst" style="text-align:left">${t.slip}</div>${d.kit&&(d.job||d.kit.id)?`<div class="jsbcw"><svg class="jsbc" data-bc="${esc(String(d.job||d.kit.id).replace(/^#/,''))}"></svg><small>${esc(t.scan)}</small></div>`:''}${job}</div>
     ${d.kit&&d.kit.returned?`<p class="jsret">✓ ${t.returned} ${esc(d.kit.returned.on||'')}${d.kit.returned.by?' · '+t.by+' '+esc(d.kit.returned.by):''}${d.kit.returned.att?' · '+t.checked+' '+esc(d.kit.returned.att):''}</p>`:''}
     <table class="jsgrid jskit"><tr><th>${t.item}</th><th class="n">${t.qty}</th><th class="c">${t.out}</th><th class="c">${t.backc}</th></tr>
     ${items.map(x=>`<tr><td>${x.name?esc(lang==='es'?(x.name_es&&x.name_es!==x.name?x.name_es:(tr||toEs)(x.name)):x.name):'&nbsp;'}${x.note?`<div class="jsitn">${esc(x.note)}</div>`:''}</td><td class="n">${x.name?esc(String(x.qty??1)):''}</td><td class="c">${x.back!=null?'✓':box}</td><td class="c ${x.bad?'jsbad':''}">${x.back!=null?`<b>${esc(x.back)}</b>`:box}</td></tr>`).join('')}</table>
     ${(d.kit.keys||[]).length?`<h4>${t.keys}</h4><table class="jsgrid jskit">${d.kit.keys.map(k=>`<tr><td>🔑 ${esc(k.tag)}</td><td class="n">${esc(String(k.qty??1))}</td><td class="c">${box}</td><td class="c">${box}</td></tr>`).join('')}</table>`:''}
     ${(d.kit.warnings||[]).length?`<h4>⚠ ${t.warn}</h4><ul>${d.kit.warnings.map(w=>`<li><b>${esc(w)}</b></li>`).join('')}</ul>`:''}
     <h4>${t.extra}</h4><table class="jsgrid jskit jsextra"><tr><th>${t.item}</th><th class="n">${t.qty}</th><th class="c">${t.out}</th><th class="c">${t.backc}</th></tr>${('<tr><td></td><td class="n"></td><td class="c">'+box+'</td><td class="c">'+box+'</td></tr>').repeat(5)}</table>
     <div class="jsrow" style="margin-top:22px"><span>${t.tech}: ${line}</span><span>${t.supv}: ${line}</span></div>
     <div class="jsfoot">PF Building Services${d.num?' · '+esc(d.num):''}</div></div>`:''}`; }
  const CSS=`#jsWrap{position:fixed;inset:0;z-index:200;background:#e9ebf0;overflow:auto;padding:0 0 30px} .jsbar{position:sticky;top:0;z-index:2;display:flex;gap:8px;align-items:center;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--line)} .jsbar .seg{display:inline-flex;gap:4px}
.jspage{background:#fff;color:#111;max-width:8in;margin:16px auto;padding:.45in .5in;box-shadow:0 2px 12px rgba(0,0,0,.12);font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.3}
.jshead{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #1F2A5C;padding-bottom:6px;margin-bottom:6px} .jshead img{height:40px} .jst{font-size:22px;font-weight:800;color:#1F2A5C;text-align:right} .jsjob{font-size:26px;font-weight:800;text-align:right}
.jspage h4{margin:9px 0 3px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#1F2A5C;border-bottom:1px solid #bbb;padding-bottom:2px} .jspage ul{margin:2px 0 0 18px;padding:0} .jspage p{margin:2px 0}
.jskv{width:100%;border-collapse:collapse} .jskv th{text-align:left;width:120px;vertical-align:top;padding:2px 6px 2px 0;color:#444} .jskv td{padding:2px 0;font-weight:600}
.jscols{display:grid;grid-template-columns:1fr 1fr;gap:16px} .jsgrid{width:100%;border-collapse:collapse} .jsgrid th{text-align:left;font-size:11px;color:#555;border-bottom:1px solid #ccc} .jsgrid td{border-bottom:1px solid #e3e3e3;padding:3px 4px 3px 0} .jsgrid .n{width:44px;font-weight:700} .jsgrid .c{width:52px;text-align:center}
.jsb{display:inline-block;width:14px;height:14px;border:1.5px solid #222;border-radius:2px;vertical-align:middle} .jsl{display:inline-block;min-width:110px;border-bottom:1px solid #222;height:14px;vertical-align:bottom;margin:0 2px} .jschk{list-style:none;margin-left:0!important} .jschk li{margin:3px 0}
.jsback{margin-top:14px;border:2px solid #1F2A5C;border-radius:6px;padding:4px 10px 10px} .jsback h4{border:0;margin-top:6px} .jsrow{display:flex;flex-wrap:wrap;gap:6px 22px;margin:7px 0} .jsbig{height:46px;border:1px solid #999;border-radius:4px} .jsnote{background:#f5f5f5;padding:6px 8px;border-radius:4px} .jslift{border-bottom:1px solid #e3e3e3;padding:4px 0} .jsl2{display:grid;grid-template-columns:1fr 1fr;gap:2px 16px;margin-top:2px} .jsp2{break-before:page;page-break-before:always} .jskit td{padding:6px 4px 6px 0} .jsextra td{height:22px;border-bottom:1px solid #999} .jsret{font-weight:700;color:#166534;margin:4px 0 6px} .jsreq{border:3px solid #b42318;border-radius:6px;padding:2px 10px 8px;margin:10px 0 4px} .jsreq h4{color:#b42318;border-color:#f3c0bb} .jsreq b{font-size:13px} .jsfrom{font-size:10px;color:#555} .jsitn{font-size:10px;color:#555} .jsbad{color:#b42318} .jsgrid .c b{font-size:11px;white-space:nowrap} .jsextra td.n{border-left:1px solid #ddd} .jsfoot{margin-top:10px;font-size:10px;color:#777;text-align:center} .jsbcw{display:flex;flex-direction:column;align-items:center;max-width:240px} .jsbcw svg{max-width:220px;height:auto} .jsbcw small{font-size:9px;color:#444;line-height:1.2;text-align:center}
@media print{ html:has(body.jsopen), body.jsopen{background:#fff!important} body.jsopen > *:not(#jsWrap){display:none!important} #jsWrap{position:static;background:#fff;overflow:visible;padding:0} #jsWrap .noprint{display:none!important} .jspage{box-shadow:none;margin:0;max-width:none;padding:0} @page{margin:.4in} }
@media (max-width:700px){ .jspage{padding:16px} .jscols{grid-template-columns:1fr} }
 .jspk+.jspk > .jspage:first-child{break-before:page;page-break-before:always} @media print{ body.jsopen > #jsWrap{display:block!important} body.jsopen > #print-area{display:none!important} } .jsbar .jsbtn{font:inherit;font-weight:700;font-size:14px;padding:8px 14px;border-radius:8px;border:1px solid #1F2A5C;background:#fff;color:#1F2A5C;cursor:pointer} .jsbar .jsbtn.on{background:#1F2A5C;color:#fff}`;
  function open(d, lang, tr){
    if(!document.getElementById('jsCss')){ const st=document.createElement('style'); st.id='jsCss'; st.textContent=CSS; document.head.appendChild(st); }
    document.getElementById('jsWrap')?.remove();
    const w=document.createElement('div'); w.id='jsWrap';
    const draw=()=>{ const t=JS_T[lang]; w.innerHTML=`<div class="jsbar noprint"><button type="button" class="jsbtn" data-js="x">${t.close}</button><span style="flex:1"></span>
      <button type="button" class="jsbtn ${lang==='en'?'on':''}" data-js="en">English</button><button type="button" class="jsbtn ${lang==='es'?'on':''}" data-js="es">Español</button>
      <button type="button" class="jsbtn on" data-js="print">🖨 ${t.print}</button></div>${Array.isArray(d)?d.map(x=>`<div class="jspk">${html(x, lang, tr)}</div>`).join(''):html(d, lang, tr)}`; };
    draw(); document.body.appendChild(w); document.body.classList.add('jsopen'); drawQR(w);
    w.addEventListener('click', e=>{ const a=e.target.closest('[data-js]')?.dataset.js; if(!a) return;
      if(a==='x'){ w.remove(); document.body.classList.remove('jsopen'); }
      if(a==='en'||a==='es'){ lang=a; draw(); drawQR(w); }
      if(a==='print') window.print(); });
    return w; }
  return { open, html, toEs, esc };
})();
