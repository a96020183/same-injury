'use strict';
(() => {
  const data = globalThis.REPLAY_DATA;
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/\btask\b/gi, word => word[0] === 'T' ? 'Work activity' : 'work activity').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let runName = 'demo', currentView = 'overview', snapshot = 'before', traceLane = '', traceLimit = 30;
  const run = () => data.runs[runName];
  const items = () => snapshot === 'before' ? run().itemsBefore : run().itemsAfter;
  const roleNames = {incident_log:'Injury log',site_list:'Site list',yearly_summary:'Yearly summary',osha_reports:'OSHA reports',dol_inspections:'DOL inspections',dol_links:'DOL links',letters:'Letters',reference:'Reference',other:'Not injury records'};
  const resultNames = {pending:'Identity awaiting review',reported:'Found',reported_differs:'Written differently',in_log:'Found in the log',in_log_differs:'Written differently',outside:'State Plan',review:'A person decides',not_found:'No matching report in the searched sample',not_in_log:'Not found in the log sample',not_required:'Reporting exclusion to review'};
  const isKey = e => ['reject','replan','approve','escalate','merge','fallback','error'].includes(e.kind) || e.agent === 'skeptic' || e.agent === 'evaluator' && e.kind === 'verdict' && !/explanations weighed/.test(e.summary) || e.agent === 'linker' && e.kind === 'verdict' && / → (link|evaluate)/.test(e.summary);
  const announce = text => { $('#announcement').textContent = text; };
  function openDialog(id) { const el = $('#'+id); if (!el.open) { el.showModal(); el.scrollTop = 0; } }
  function closeDialog(id) { $('#'+id).close(); }
  function receiptLinks(qids = []) {
    return `<div class="receipt-links">${[...new Set(qids)].map(q => run().receipts[q] ? `<button class="receipt-link" data-receipt="${esc(q)}">${esc(q)}</button>` : `<span class="receipt-missing">${esc(q)} · not included</span>`).join('')}</div>`;
  }
  function eventHtml(e) {
    const detail = e.detail === undefined ? '' : `<details><summary>Inspect recorded detail</summary><pre>${esc(JSON.stringify(e.detail,null,2))}</pre></details>`;
    return `<li class="event"><div class="event-head"><strong>${esc(e.agent)}</strong><span class="kind ${esc(e.kind)}">${esc(e.kind)}</span>${e.lane ? `<span>${esc(e.lane)}</span>` : ''}<time datetime="${esc(e.t)}">${esc(e.t.slice(11,19))} UTC</time></div><p>${esc(e.summary)}</p>${receiptLinks(e.receipts)}${e.model ? `<p class="model">Recorded model call · ${esc(e.model.lane)} lane<br>Requested: ${esc(e.model.requested)}<br>Served: ${esc(e.model.served)}</p>` : ''}${detail}</li>`;
  }
  function renderIntro() {
    const intro = data.intro;
    $('#intro-records').innerHTML = intro.records.map((r,i) => {
      const text = esc(r.text).replace(esc(r.mark || '___'), `<mark>${esc(r.mark)}</mark>`);
      const sourceLabel = r.id?.startsWith('SIR-SYN') ? 'OSHA report format · SYNTHETIC test record' : r.plain || 'DOL enforcement database';
      return `<article class="rec"><h2>${esc(r.who)}</h2><p class="plain">${esc(sourceLabel)}</p>${r.unknown ? `<div class="question" aria-hidden="true">?</div>` : `<span class="synthetic">SYNTHETIC record</span><div class="id">${esc(r.id)}</div>${(r.subIds || []).map(s=>`<div class="sub">${esc(s)}</div>`).join('')}<div class="sub">${esc(r.date)}</div>`}<p class="text">${text}</p>${i === 0 ? '<button class="ghost" id="opening-case">Open Demo company case</button>' : ''}</article>`;
    }).join('');
    $('#system-types').innerHTML = intro.systems.map(s=>`<div><strong>${esc(s.kind)}</strong><span>${esc(s.what)}</span></div>`).join('');
  }
  function renderSystems() {
    const d = run().discovery;
    $('#source-list').innerHTML = d.sources.map(s=>`<span class="source ${s.kept ? '' : 'excluded'}" title="${esc(s.why)}">${esc(s.name)}</span>`).join('');
    const showExcluded = $('#show-excluded').checked;
    const order = {incident_log:0,site_list:1,yearly_summary:2,osha_reports:3,dol_inspections:4,dol_links:5,letters:6,reference:7,other:8};
    const tables = [...d.tables].filter(t=>showExcluded || t.role !== 'other').sort((a,b)=>(order[a.role] ?? 9)-(order[b.role] ?? 9)||a.fq.localeCompare(b.fq));
    $('#table-list').innerHTML = tables.map(t=>`<article class="tbl ${esc(t.role)}"><h3>${esc(t.fq)}</h3><div class="role">${esc(roleNames[t.role] || t.role)}</div>${t.role === 'incident_log' ? `<dl class="map">${Object.entries(t.map || {}).map(([k,v])=>`<dt>${esc(k.replaceAll('_',' '))}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : `<p>${esc(t.why)}</p>`}</article>`).join('');
    $('#usl-code').textContent = run().usl || run().discovery.usl?.compile || 'No model text included in this recording.';
  }
  function itemHtml(i) {
    return `<button class="item" data-case="${esc(i.lane)}">${i.synthetic ? '<span class="synthetic">SYNTHETIC · invented plant</span>' : ''}<span class="case-head"><strong>${esc(i.plantName || i.site || i.lane)}</strong><time>${esc(i.date)}</time></span><span class="headline">${esc(i.headline)}</span><span class="result">${esc(resultNames[i.column] || i.resultCode || i.column)}</span><span class="lane">${esc(i.lane)}${i.reportId ? ' · '+esc(i.reportId) : ''}</span></button>`;
  }
  function renderStats() {
    const ev = run().trace;
    const stats = [
      [ev.filter(e=>e.kind==='model').length,'recorded model calls'],
      [ev.filter(e=>e.agent==='verifier' && e.kind==='reject').length,'Verifier rejections'],
      [ev.filter(e=>e.kind==='replan').length,'plan revisions'],
      [ev.filter(e=>e.kind==='escalate').length,'escalations']
    ];
    $('#run-stats').innerHTML = stats.map(([v,k])=>`<span><b>${v}</b> ${k}</span>`).join('');
  }
  function renderResults() {
    $('#log-items').innerHTML = items().filter(i=>i.dir==='log').map(itemHtml).join('');
    $('#osha-items').innerHTML = items().filter(i=>i.dir==='osha').map(itemHtml).join('');
    $('#snapshot-note').innerHTML = snapshot === 'before'
      ? '<strong>Before identity approval.</strong> These are the agents’ recorded conclusions. A likely match is not an approved identity. Negative outcomes below are restricted to SYNTHETIC plants.'
      : '<strong>Recorded automatic operator approvals.</strong> The original CLI approved proposals to demonstrate the flow. This was not a human review. Your clicks here do not approve anything.';
    renderStats();
    const c = run().certify;
    $('#certify-body').innerHTML = `<p class="fine">Recorded sample output. Any mismatch shown belongs to a SYNTHETIC plant.</p><pre>${esc(JSON.stringify(c,null,2))}</pre>`;
  }
  function renderScores() {
    const names = {run1:'Sealed run 1',run2:'Sealed run 2',rules:'Rule baseline',keyword:'Keyword baseline'};
    $('#score-rows').innerHTML = Object.entries(names).map(([key,name])=>{const c=data.scores[key].counts;return `<tr><th scope="row">${name}</th><td>${c.t_tp} / ${c.t_gold}</td><td>${c.f_tp} / ${c.f_gold}</td></tr>`;}).join('');
  }
  function setView(view, updateHash = true, focus = true) {
    if (!['overview','systems','results'].includes(view)) return;
    currentView = view;
    document.querySelectorAll('.view').forEach(el=>el.hidden=el.id !== view);
    document.querySelectorAll('.view-nav button').forEach(el=>{if(el.dataset.view===view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
    if(updateHash) history.replaceState(null,'','#'+view);
    if(focus){const heading=$('#'+view+' h1');heading.tabIndex=-1;heading.focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
    announce(`Showing ${view === 'systems' ? 'recorded system discovery' : view === 'results' ? 'recorded case outcomes' : 'overview'}.`);
  }
  function chooseRun(name) {
    runName = name; snapshot = 'before'; traceLane=''; traceLimit=30;
    $('#run-select').value=name;$('#snapshot').value='before';
    $('#run-id').textContent=run().id+' · 27 Oct 2026';
    $('#trace-agent').innerHTML='<option value="">All agents</option>'+[...new Set(run().trace.map(e=>e.agent))].sort().map(a=>`<option>${esc(a)}</option>`).join('');
    renderSystems(); renderResults(); renderTrace();
    announce(`${run().name} recording selected.`);
  }
  function openCase(lane) {
    const i=items().find(x=>x.lane===lane);
    if(!i)return;
    const events=run().trace.filter(e=>e.lane===lane);
    const laneState=run().lanes.find(x=>x.id===lane);
    $('#case-title').textContent=`${i.lane} · ${i.site || 'Case evidence'}`;
    const cited=[...new Set([...(i.receipts || []),...events.flatMap(e=>e.receipts || [])])];
    const evidence=(i.searched || []).map(x=>`<li>${esc(x.label)}${x.found !== undefined ? ` · ${esc(x.found)} found` : ''} ${receiptLinks([x.qid])}</li>`).join('');
    const scan=Object.entries(run().scans).find(([name])=>name.includes(i.site+'_') && (!i.caseId || name.includes('case'+i.caseId+'.')));
    const review=i.synthetic && i.proposalId ? run().reviewers[i.proposalId] : null;
    $('#case-body').innerHTML=`${i.synthetic ? '<span class="synthetic">SYNTHETIC · all fields invented</span>' : '<p class="fine">Composite public records · neutral outcome only</p>'}<p class="case-meta">${esc(i.dir==='log'?'Plant log → OSHA':'OSHA → plant log')} · ${esc(i.date)} · ${esc(run().name)}<br>Snapshot: ${snapshot==='before'?'before identity approval':'after recorded automatic operator approvals'}</p><h3>${esc(i.headline)}</h3><p>${esc(resultNames[i.column] || i.column)}</p><div class="case-detail"><p class="fine"><strong>Recorded product wording.</strong> Approval instructions below describe the original product. This replay performs no approvals.</p>${(i.detail || []).map(d=>`<p>${esc(d)}</p>`).join('')}</div>${i.synthetic ? '<p class="boundary">This conclusion concerns an invented plant. It is a demonstration, not a finding about a real employer.</p>' : ''}<h3>Where the agents searched</h3><ul class="searches">${evidence}</ul><h3>Query receipts cited by this case</h3>${receiptLinks(cited)}${scan ? `<details><summary>View the SYNTHETIC scanned 301 form</summary><img class="case-scan" src="${esc(scan[1])}" width="1000" height="1294" alt="Synthetic OSHA 301 form for ${esc(i.site)}; employee identity fields are blacked out." loading="lazy"></details>` : ''}${laneState?.form301 ? `<details><summary>What the recorded vision model read</summary><pre>${esc(JSON.stringify(laneState.form301,null,2))}</pre></details>` : ''}${review ? `<details><summary>Recorded-data view of the masked identity</summary><p class="fine">Reconstructed offline from the SQL recordings. Invented plant and employer only. This is not an identity approval.</p><pre>${esc(JSON.stringify(review,null,2))}</pre></details>` : ''}<h3>The agents’ exchanges</h3><p class="fine">Original recorded events, in order. The trace can also show model-call metadata and all events.</p><button class="ghost" data-lane-trace="${esc(lane)}">Show this case in the trace</button><ol class="events">${events.filter(e=>e.kind!=='model').map(eventHtml).join('')}</ol>`;
    openDialog('case-dialog');
  }
  function openTrace(lane='') {
    traceLane=lane;traceLimit=30;
    if(lane)$('#trace-agent').value='';
    renderTrace();openDialog('trace-dialog');
  }
  function renderTrace() {
    const agent=$('#trace-agent').value, key=$('#trace-mode').value==='key';
    const filtered=run().trace.filter(e=>(!agent||e.agent===agent)&&(!traceLane||e.lane===traceLane)&&(!key||isKey(e)));
    $('#trace-context').textContent=run().name+' · '+run().id+(traceLane?' · case '+traceLane:'');
    $('#trace-clear').hidden=!traceLane;
    $('#trace-count').textContent=`Showing ${Math.min(traceLimit,filtered.length)} of ${filtered.length} recorded events${key?' · key decisions':''}.`;
    $('#trace-events').innerHTML=filtered.length?filtered.slice(0,traceLimit).map(eventHtml).join(''):'<li class="event"><p>No recorded events match these filters. Choose another agent or show every event.</p></li>';
    $('#trace-more').hidden=filtered.length<=traceLimit;
  }
  function openReceipt(qid) {
    const r=run().receipts[qid];if(!r)return;
    $('#receipt-title').textContent=`${qid} · Query receipt`;
    const result=r.result || {headers:[],data:[]};
    $('#receipt-body').innerHTML=`<p class="receipt-notice"><strong>Offline replay receipt.</strong> Metadata was regenerated in SAMPLE_MODE. ${r.recordedResultVerified?'The query result matches the bundled SQL recording.':'This answer came from the bundled emulator; it is not a recorded live result.'} No query is sent by this website.</p><p>${esc(r.purpose)}</p><div class="receipt-meta"><div><b>Backend during export</b>${esc(r.backend)}</div><div><b>Query identity</b>${esc(r.as)}</div><div><b>Rows in original result</b>${esc(r.rows)}</div><div><b>Agent</b>${esc(r.agent)}</div><div><b>Recorded result timestamp</b>${esc(r.recordedAt || 'Not available')}</div><div><b>Original result hash</b><code>${esc(r.resultSha)}</code></div></div><h3>SQL</h3><pre class="sql">${esc(r.sql)}</pre>${r.error?`<p class="boundary">${esc(r.error)}</p>`:''}<h3>Returned evidence</h3><p class="fine">${result.data.length} of ${r.availableRows} available rows included.${r.truncatedRows ? ' The remaining rows were omitted from the public export.' : ''} Values are shown as recorded; no names are revealed.</p>${result.headers.length ? `<div class="table-scroll" tabindex="0" aria-label="Query result table; scroll for more columns"><table><thead><tr>${result.headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${result.data.length?result.data.map(row=>`<tr>${result.headers.map((_,j)=>`<td>${esc(typeof row[j]==='object'?JSON.stringify(row[j]):row[j])}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="${result.headers.length}">The recorded query returned no rows.</td></tr>`}</tbody></table></div>`:'<p class="fine">This statement has no result table.</p>'}<details><summary>Receipt metadata and source tables</summary><pre>${esc(JSON.stringify({...r,result:undefined},null,2))}</pre></details>`;
    openDialog('receipt-dialog');
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.dataset.close){closeDialog(button.dataset.close);return;}
    if(button.dataset.view){setView(button.dataset.view);return;}
    if(button.dataset.case){openCase(button.dataset.case);return;}
    if(button.dataset.receipt){openReceipt(button.dataset.receipt);return;}
    if(button.dataset.laneTrace){openTrace(button.dataset.laneTrace);return;}
    if(button.id==='opening-case'){chooseRun('demo');openCase('L6');return;}
    if(button.id==='watch-unseen'){chooseRun('unseen');setView('results');openCase('L4');return;}
    if(button.id==='focus-case'){openCase(run().focusLane);return;}
    if(button.id==='trace-open'){openTrace();return;}
    if(button.id==='trace-clear'){traceLane='';traceLimit=30;renderTrace();return;}
    if(button.id==='trace-more'){traceLimit+=30;renderTrace();}
  });
  $('#run-select').addEventListener('change',e=>chooseRun(e.target.value));
  $('#snapshot').addEventListener('change',e=>{snapshot=e.target.value;renderResults();announce(snapshot==='before'?'Showing the recorded pre-approval snapshot.':'Showing recorded automatic operator approvals, not a human review.');});
  $('#show-excluded').addEventListener('change',renderSystems);
  for(const id of ['trace-mode','trace-agent'])$('#'+id).addEventListener('change',()=>{traceLimit=30;renderTrace();});
  window.addEventListener('hashchange',()=>{const view=location.hash.slice(1);if(['overview','systems','results'].includes(view))setView(view,false);});
  renderIntro();renderScores();chooseRun('demo');
  const initial=location.hash.slice(1);setView(['systems','results'].includes(initial)?initial:'overview',false,false);
})();
