// The browser document for the root worker dashboard.
// Kept separate from the HTTP server so the route code stays small and the
// worker can keep this UI dependency-free: one Node process, no build step.

export function renderDashboardHtml() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local Worker Dashboard</title>
<style>
:root{--bg:#0f172a;--panel:#1e293b;--panel2:#172235;--border:#334155;--text:#f8fafc;--muted:#94a3b8;--primary:#38bdf8;--ok:#10b981;--warn:#f59e0b;--bad:#ef4444;--shadow:0 18px 45px #02061766}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#183252 0,#0f172a 40%);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}main{max-width:1320px;margin:0 auto;padding:28px 22px 44px}.top{display:flex;gap:18px;align-items:flex-start;justify-content:space-between;margin-bottom:22px}.eyebrow{color:var(--primary);font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.title{margin:4px 0 5px;font-size:clamp(25px,4vw,38px);letter-spacing:-.04em}.subtitle{color:var(--muted);margin:0}.top-actions{display:flex;align-items:center;gap:12px}.live{display:flex;align-items:center;gap:8px;color:var(--muted);white-space:nowrap}.dot{width:9px;height:9px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 4px #10b9811f}.dot.bad{background:var(--bad);box-shadow:0 0 0 4px #ef44441f}.button{border:1px solid var(--border);background:#1e293bcc;color:var(--text);border-radius:9px;padding:9px 13px;cursor:pointer}.button:hover{border-color:var(--primary);color:var(--primary)}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px}.card{background:linear-gradient(145deg,#1e293bf2,#172235e6);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);padding:17px}.metric-label,.label{color:var(--muted);font-size:12px}.metric{font-size:29px;font-weight:760;letter-spacing:-.04em;margin-top:4px}.metric small{font-size:13px;font-weight:500;color:var(--muted);letter-spacing:0}.section{margin-top:17px}.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}.section-title{font-size:17px;margin:0}.section-note{color:var(--muted);font-size:12px}.lanes{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.lane{padding:15px}.lane-head,.row{display:flex;align-items:center;justify-content:space-between;gap:9px}.lane-name{font-weight:750;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pill{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:750;white-space:nowrap}.pill.ok{color:#6ee7b7;background:#064e3b}.pill.warn{color:#fcd34d;background:#78350f}.pill.bad{color:#fca5a5;background:#7f1d1d}.pill.neutral{color:#bae6fd;background:#164e63}.types{color:var(--muted);font-size:11px;line-height:1.5;margin:9px 0 13px;min-height:32px}.current{border:1px solid #38bdf833;background:#0c4a6e26;border-radius:9px;padding:9px;margin-bottom:11px}.current strong{display:block;color:var(--primary);font-size:12px}.current span{color:var(--muted);font-size:12px}.muted{color:var(--muted)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.mini-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.mini{padding-top:8px;border-top:1px solid #33415599}.mini .value{display:block;font-weight:700;margin-top:2px}.two{display:grid;grid-template-columns:1.2fr .8fr;gap:13px}.table-wrap{overflow:auto}.table{width:100%;border-collapse:collapse;min-width:640px}.table th{text-align:left;color:var(--muted);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:8px 9px;border-bottom:1px solid var(--border)}.table td{padding:11px 9px;border-bottom:1px solid #33415580;vertical-align:top}.table tr:last-child td{border-bottom:0}.local{color:var(--primary);font-weight:700}.ok-text{color:#6ee7b7}.bad-text{color:#fca5a5}.warn-text{color:#fcd34d}.empty{color:var(--muted);padding:17px 4px}.events{display:grid;gap:7px;max-height:330px;overflow:auto}.event{display:grid;grid-template-columns:70px 62px 1fr;gap:8px;align-items:start;padding:8px 0;border-bottom:1px solid #33415580}.event:last-child{border-bottom:0}.event time,.event-kind{color:var(--muted);font-size:11px}.event-kind{font-weight:750;text-transform:uppercase}.event-kind.error{color:#fca5a5}.event-kind.warn{color:#fcd34d}.event-kind.job{color:#6ee7b7}.error-banner{display:none;border:1px solid #ef444466;background:#7f1d1d33;color:#fecaca;border-radius:10px;padding:10px 12px;margin:0 0 15px}.footer{color:var(--muted);font-size:11px;margin-top:20px;text-align:right}@media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.two{grid-template-columns:1fr}}@media(max-width:560px){main{padding:20px 13px 32px}.top{display:block}.top-actions{margin-top:15px;justify-content:space-between}.grid{grid-template-columns:1fr 1fr}.metric{font-size:23px}.event{grid-template-columns:58px 48px 1fr}}
</style>
</head>
<body>
<main>
  <header class="top">
    <div><div class="eyebrow">Local worker / operations</div><h1 class="title">Worker Dashboard</h1><p class="subtitle" id="identity">Loading worker identity…</p></div>
    <div class="top-actions"><div class="live"><span class="dot" id="live-dot"></span><span id="refresh-label">Connecting…</span></div><a class="button" href="/setup">Setup &amp; health</a><button class="button" id="refresh" type="button">Refresh</button></div>
  </header>
  <div class="error-banner" id="error-banner"></div>
  <section class="grid" id="metrics"></section>
  <section class="section card"><div class="section-head"><h2 class="section-title">Local lanes</h2><span class="section-note" id="lane-note"></span></div><div class="lanes" id="lanes"><div class="empty">Waiting for the worker snapshot…</div></div></section>
  <section class="section two">
    <div class="card"><div class="section-head"><h2 class="section-title">Cloud workers</h2><span class="section-note" id="cloud-note"></span></div><div class="table-wrap"><table class="table"><thead><tr><th>Worker</th><th>Status</th><th>Last seen</th><th>Address</th><th>Types</th></tr></thead><tbody id="workers"></tbody></table></div></div>
    <div class="card"><div class="section-head"><h2 class="section-title">Google Search bridge</h2><span class="section-note">loopback service</span></div><div id="gsearch"><div class="empty">Waiting for bridge status…</div></div></div>
  </section>
  <section class="section card"><div class="section-head"><h2 class="section-title">Recent activity</h2><span class="section-note">Payloads and results are never shown</span></div><div class="events" id="events"><div class="empty">No activity yet.</div></div></section>
  <div class="footer" id="footer">Read-only dashboard · refreshes every 3 seconds</div>
</main>
<script>
(function(){
  'use strict';
  var $=function(id){return document.getElementById(id)};
  var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
  var n=function(v){return Number.isFinite(Number(v))?Number(v):0};
  var duration=function(ms){var s=Math.max(0,Math.round(n(ms)/1000));if(s<60)return s+'s';var m=Math.floor(s/60),r=String(s%60).padStart(2,'0');return m+'m '+r+'s'};
  var ago=function(sec){if(sec==null)return 'unknown';sec=Math.max(0,Math.round(n(sec)));if(sec<60)return sec+'s ago';var m=Math.floor(sec/60);return m<60?m+'m ago':Math.floor(m/60)+'h '+String(m%60).padStart(2,'0')+'m ago'};
  var untilText=function(iso){var ms=Date.parse(iso)-Date.now();if(!Number.isFinite(ms))return 'reset time unknown';if(ms<=0)return 'reset due — reconnecting';var s=Math.ceil(ms/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h+'h '+String(m).padStart(2,'0')+'m '+String(s%60).padStart(2,'0')+'s'};
  var when=function(v){try{return new Date(v).toLocaleTimeString()}catch(e){return '—'}};
  var pill=function(text,tone){return '<span class="pill '+tone+'">'+esc(text)+'</span>'};
  var stateTone=function(s){return s==='running'?'neutral':s==='backoff'||s==='cooldown'?'warn':s==='stopped'?'bad':s==='idle'?'ok':'neutral'};
  var stateText=function(s){return s==='polling'?'WAITING':s==='cooldown'?'QUOTA COOLDOWN':String(s||'UNKNOWN').toUpperCase()};
  var refreshLabel=function(){return $('refresh-label').textContent};
  function renderMetrics(s){
    var w=s.local.worker,t=s.local.totals,c=s.cloud||{},q=c.counts||{};
    var cards=[
      ['Worker',esc(w.name),'<small>'+esc(w.hostname||'local process')+'</small>'],
      ['Cloud queue',n(q.pending)+' pending','<small>'+n(q.running)+' running</small>'],
      ['Local lanes',n(t.running)+' running','<small>'+n(t.idle)+' waiting · '+n(t.cooldown)+' quota cooldown · '+n(t.backoff)+' backoff</small>'],
      ['Jobs completed',n(t.jobsDone),'<small>'+n(t.jobsFailed)+' failed</small>'],
      ['Average duration',t.avgJobMs==null?'—':duration(t.avgJobMs),'<small>completed jobs</small>'],
      ['Process uptime',duration(n(w.uptimeSec)*1000),'<small>PID '+esc(w.pid)+'</small>'],
      ['Memory RSS',Math.round(n(w.memory&&w.memory.rssBytes)/1048576)+' MB','<small>heap '+Math.round(n(w.memory&&w.memory.heapUsedBytes)/1048576)+' MB</small>'],
      ['Search extension',s.gsearch&&s.gsearch.extension&&s.gsearch.extension.connected?'Connected':'Offline','<small>'+n(s.gsearch&&s.gsearch.queued)+' queued</small>']
    ];
    $('metrics').innerHTML=cards.map(function(c){return '<div class="card"><div class="metric-label">'+c[0]+'</div><div class="metric">'+c[1]+'</div><div class="muted">'+c[2]+'</div></div>'}).join('');
    $('identity').textContent=w.name+' · '+w.node+' · '+w.platform+'/'+w.arch;
    $('lane-note').textContent=n(t.lanes)+' configured · '+n(t.claimed)+' finished';
  }
  function renderLanes(lanes){
    if(!lanes||!lanes.length){$('lanes').innerHTML='<div class="empty">No lanes registered.</div>';return}
    $('lanes').innerHTML=lanes.map(function(l){
      var cur=l.current,last=l.last;
      var body=cur?'<div class="current"><strong>'+esc(cur.type)+'</strong><span>Job '+esc(cur.id||'—')+' · running '+duration(cur.elapsedMs)+'</span></div>':'<div class="current"><strong>'+stateText(l.state)+'</strong><span>'+ (l.state==='cooldown'?'Quota reached · waiting for refresh in '+esc(untilText(l.cooldownUntil))+' · reset at '+esc(new Date(l.cooldownUntil).toLocaleString()):l.state==='backoff'?'Retry at '+esc(when(l.nextPollAt)): 'No job in hand')+'</span></div>';
      var lastText=last?(last.ok?'<span class="ok-text">OK</span>':'<span class="bad-text">FAILED</span>')+' · '+esc(last.type)+' · '+duration(last.durationMs):'<span class="muted">No completed job</span>';
      return '<article class="lane card"><div class="lane-head"><span class="lane-name" title="'+esc(l.name)+'">'+esc(l.name)+'</span>'+pill(stateText(l.state),stateTone(l.state))+'</div><div class="types">'+esc(l.types.join(' · '))+(l.session?' · session '+esc(l.session):'')+'</div>'+body+'<div class="mini-grid"><div class="mini"><span class="label">Last job</span><span class="value">'+lastText+'</span></div><div class="mini"><span class="label">Poll errors</span><span class="value">'+n(l.errors)+' · '+n(l.polls)+' polls</span></div></div>'+(l.cooldownReason?'<div class="muted" style="margin-top:10px">'+esc(l.cooldownReason)+'</div>':'')+(l.lastError?'<div class="muted" style="margin-top:10px" title="'+esc(l.lastError)+'">'+esc(l.lastError)+'</div>':'')+'</article>';
    }).join('');
  }
  function renderWorkers(c){
    var rows=c&&c.workers||[];
    $('cloud-note').textContent=c&&c.ok?'Updated '+when(c.lastSuccessAt):'Cloud status unavailable';
    $('workers').innerHTML=rows.length?rows.map(function(w){var cooling=w.state==='cooldown';return '<tr><td class="'+(w.isLocal?'local':'')+'">'+esc(w.name)+(w.isLocal?' · local':'')+'</td><td>'+pill(cooling?'QUOTA COOLDOWN':w.online?'ONLINE':'STALE',cooling?'warn':w.online?'ok':'warn')+(cooling?'<div class="muted">Quota reached · waiting '+esc(untilText(w.cooldownUntil))+'</div>':'')+'</td><td>'+esc(ago(w.ageSec))+'</td><td class="mono">'+esc(w.ip||'unknown')+'</td><td class="muted">'+esc((w.types||[]).join(', '))+'</td></tr>'}).join(''):'<tr><td colspan="5" class="empty">'+esc(c&&c.error||'No workers reported by the cloud broker.')+'</td></tr>';
  }
  function renderGsearch(g){
    if(!g){$('gsearch').innerHTML='<div class="empty">No bridge snapshot.</div>';return}
    var ext=g.extension||{};
    $('gsearch').innerHTML='<div class="row" style="margin:10px 0 16px"><span class="label">Listener</span>'+pill(g.listening?'LISTENING':'OFFLINE',g.listening?'ok':'bad')+'</div><div class="row" style="margin:10px 0 16px"><span class="label">Extension</span>'+pill(ext.connected?'CONNECTED':'DISCONNECTED',ext.connected?'ok':'warn')+'</div><div class="mini-grid"><div class="mini"><span class="label">Port</span><span class="value mono">'+esc(g.port)+'</span></div><div class="mini"><span class="label">Queue</span><span class="value">'+n(g.queued)+(g.busy?' · busy':'')+'</span></div></div>'+(ext.since?'<div class="muted" style="margin-top:15px">Connected '+esc(when(ext.since))+(ext.version?' · '+esc(ext.version):'')+'</div>':'');
  }
  function renderEvents(events){
    $('events').innerHTML=events&&events.length?events.map(function(e){return '<div class="event"><time>'+esc(when(e.at))+'</time><span class="event-kind '+esc(e.kind)+'">'+esc(e.kind)+'</span><span>'+esc(e.message)+'</span></div>'}).join(''):'<div class="empty">No activity yet.</div>';
  }
  async function load(){
    try{
      var r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw new Error('status endpoint returned '+r.status);
      var s=await r.json();renderMetrics(s);renderLanes(s.local.lanes);renderWorkers(s.cloud);renderGsearch(s.gsearch);renderEvents(s.local.events);
      $('error-banner').style.display=s.cloud&&s.cloud.ok?'none':'block';$('error-banner').textContent=s.cloud&&s.cloud.error?'Cloud broker: '+s.cloud.error:'Cloud broker status is unavailable';
      $('live-dot').className='dot';$('refresh-label').textContent='Updated '+when(s.at);$('footer').textContent='Read-only dashboard · last refresh '+when(s.at)+' · auto-refresh every 3 seconds';
    }catch(e){$('live-dot').className='dot bad';$('refresh-label').textContent='Offline';$('error-banner').style.display='block';$('error-banner').textContent='Dashboard status unavailable: '+e.message}
  }
  $('refresh').addEventListener('click',load);load();setInterval(function(){if(!document.hidden)load()},3000);
})();
</script>
</body>
</html>`;
}

/** The device setup & health checklist page: /setup. */
export function renderSetupHtml() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local Worker — Setup &amp; Health</title>
<style>
:root{--bg:#0f172a;--panel:#1e293b;--panel2:#172235;--border:#334155;--text:#f8fafc;--muted:#94a3b8;--primary:#38bdf8;--ok:#10b981;--warn:#f59e0b;--bad:#ef4444;--shadow:0 18px 45px #02061766}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#183252 0,#0f172a 40%);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}main{max-width:1080px;margin:0 auto;padding:28px 22px 44px}.top{display:flex;gap:18px;align-items:flex-start;justify-content:space-between;margin-bottom:22px}.eyebrow{color:var(--primary);font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.title{margin:4px 0 5px;font-size:clamp(25px,4vw,36px);letter-spacing:-.04em}.subtitle{color:var(--muted);margin:0}.top-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}.live{display:flex;align-items:center;gap:8px;color:var(--muted);white-space:nowrap}.dot{width:9px;height:9px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 4px #10b9811f}.dot.bad{background:var(--bad);box-shadow:0 0 0 4px #ef44411f}.button{border:1px solid var(--border);background:#1e293bcc;color:var(--text);border-radius:9px;padding:9px 13px;cursor:pointer;text-decoration:none;display:inline-block}.button:hover{border-color:var(--primary);color:var(--primary)}.button[disabled]{opacity:.55;cursor:wait}
.banner{border:1px solid var(--border);border-radius:14px;padding:18px 20px;margin-bottom:16px;background:linear-gradient(145deg,#1e293bf2,#172235e6);box-shadow:var(--shadow)}.banner.ok{border-color:#10b98166}.banner.warn{border-color:#f59e0b66}.banner.bad{border-color:#ef444466}.banner-head{display:flex;align-items:center;gap:12px}.banner-state{font-size:22px;font-weight:800;letter-spacing:-.03em}.banner-sub{color:var(--muted);font-size:12.5px;margin-top:4px}.reasons{margin:12px 0 0;padding:0;list-style:none;display:grid;gap:5px}.reasons li{color:#fcd9d9;font-size:13px}.banner.warn .reasons li{color:#fde8c0}
.section{margin-top:16px}.card{background:linear-gradient(145deg,#1e293bf2,#172235e6);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);padding:17px}.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}.section-title{font-size:16px;margin:0}.section-note{color:var(--muted);font-size:12px}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.chip{border:1px solid var(--border);border-radius:999px;padding:2px 9px;font-size:11px;color:var(--muted);white-space:nowrap}
.check{display:grid;grid-template-columns:26px 1fr auto;gap:10px;align-items:start;padding:11px 0;border-bottom:1px solid #33415580}.check:last-child{border-bottom:0}.mark{width:22px;height:22px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;margin-top:1px}.mark.ok{color:#6ee7b7;background:#064e3b}.mark.warn{color:#fcd34d;background:#78350f}.mark.bad{color:#fca5a5;background:#7f1d1d}.mark.unknown{color:#bae6fd;background:#164e63}.check-label{font-weight:700}.check-detail{color:var(--muted);font-size:12.5px;margin-top:2px;word-break:break-word}.check-fix{color:#93c5fd;font-size:12px;margin-top:4px}.pill{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:10.5px;font-weight:750;white-space:nowrap}.pill.required{color:#fca5a5;background:#7f1d1d}.pill.optional{color:#fcd34d;background:#78350f}.pill.inactive{color:#94a3b8;background:#1e293b}.pill.deep{color:#bae6fd;background:#164e63}
.muted{color:var(--muted)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.empty{color:var(--muted);padding:14px 4px}.footer{color:var(--muted);font-size:11px;margin-top:20px;text-align:right}
@media(max-width:640px){main{padding:20px 13px 32px}.top{display:block}.top-actions{margin-top:14px;justify-content:flex-start}.check{grid-template-columns:26px 1fr}.check>.pill{grid-column:2;justify-self:start;margin-top:6px}}
</style>
</head>
<body>
<main>
  <header class="top">
    <div><div class="eyebrow">Local worker / setup</div><h1 class="title">Setup &amp; Health</h1><p class="subtitle" id="identity">Is this device installed and healthy for the work it claims?</p></div>
    <div class="top-actions"><div class="live"><span class="dot" id="live-dot"></span><span id="refresh-label">Connecting…</span></div><a class="button" href="/">Dashboard</a><button class="button" id="refresh" type="button">Refresh</button><button class="button" id="deep" type="button">Run deep checks</button></div>
  </header>
  <div class="banner" id="banner"><div class="banner-head"><span class="banner-state" id="banner-state">Checking…</span></div><div class="banner-sub" id="banner-sub"></div><ul class="reasons" id="reasons"></ul></div>
  <section class="card"><div class="section-head"><h2 class="section-title">This device claims</h2><span class="section-note">checks are judged against these job types</span></div><div class="chips" id="types"><span class="chip">loading…</span></div></section>
  <div id="groups"></div>
  <section class="section card"><div class="section-head"><h2 class="section-title">Deep checks</h2><span class="section-note" id="deep-note">real handshakes &amp; session probes — run on demand, never auto-refreshed</span></div><div id="deep"><div class="empty">Not run yet. Deep checks spawn real processes (Pi, Scrapling MCP, Obscura MCP, LinkedIn session) and can take a few minutes.</div></div></section>
  <div class="footer" id="footer">Read-only checklist · fast layer refreshes every 5 seconds</div>
</main>
<script>
(function(){
  'use strict';
  var $=function(id){return document.getElementById(id)};
  var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
  var when=function(v){try{var d=new Date(v);return isNaN(d)?'—':d.toLocaleTimeString()}catch(e){return '—'}};
  var ago=function(ms){var s=Math.max(0,Math.round(Number(ms)/1000));if(s<60)return s+'s';var m=Math.floor(s/60);return m<60?m+'m '+(s%60)+'s':Math.floor(m/60)+'h '+(m%60)+'m'};
  var mark={ok:['✓','ok'],warn:['!','warn'],bad:['✗','bad'],unknown:['?','unknown']};
  var sevPill={required:'<span class="pill required">REQUIRED</span>',optional:'<span class="pill optional">OPTIONAL</span>',inactive:'<span class="pill inactive">NOT NEEDED</span>'};
  function row(c,extra){var m=mark[c.state]||mark.unknown;return '<div class="check"><span class="mark '+m[1]+'">'+m[0]+'</span><div><div class="check-label">'+esc(c.label)+'</div><div class="check-detail">'+esc(c.detail||c.note||'')+'</div>'+(c.remediation?'<div class="check-fix">Fix: '+esc(c.remediation)+'</div>':'')+'</div>'+(extra||'')+(sevPill[c.severity]||'')+'</div>'}
  function banner(s){var b=$('banner');b.className='banner '+(s.overall.state==='ready'?'ok':s.overall.state==='degraded'?'warn':'bad');
    $('banner-state').textContent=s.overall.state==='ready'?'Setup completed and healthy':s.overall.state==='degraded'?'Setup complete with warnings':'Setup incomplete';
    $('reasons').innerHTML=(s.overall.reasons||[]).map(function(r){return '<li>'+esc(r)+'</li>'}).join('');
    var groupsOk=(s.checks||[]).filter(function(c){return c.severity!=='inactive'&&c.state==='ok'}).length,groupsAll=(s.checks||[]).filter(function(c){return c.severity!=='inactive'}).length;
    $('banner-sub').textContent=groupsOk+' of '+groupsAll+' relevant checks passed · fast layer updated '+when(s.at);}
  function render(s){
    banner(s);
    $('types').innerHTML=(s.claimedTypes&&s.claimedTypes.length?s.claimedTypes:['(no job types claimed)']).map(function(t){return '<span class="chip">'+esc(t)+'</span>'}).join('');
    var groups=s.groups||[];var html='';
    for(var i=0;i<groups.length;i++){var g=groups[i];var rows=(s.checks||[]).filter(function(c){return c.group===g.id});
      if(!rows.length)continue;
      html+='<section class="section card"><div class="section-head"><h2 class="section-title">'+esc(g.label)+'</h2><span class="section-note">'+rows.length+' checks</span></div>'+rows.map(function(c){return row(c)}).join('')+'</section>';}
    $('groups').innerHTML=html;
    var d=s.deep;
    if(d){$('deep-note').textContent='ran '+when(d.ranAt)+' · took '+ago(d.durationMs);
      $('deep').innerHTML=(d.error?'<div class="empty">Deep checks failed: '+esc(d.error)+'</div>':(d.checks||[]).length?d.checks.map(function(c){return row(c,'<span class="pill deep">DEEP</span>')}).join(''):'<div class="empty">No deep checks apply to this device.</div>');}
    $('live-dot').className='dot';$('refresh-label').textContent='Updated '+when(s.at);
    $('footer').textContent='Read-only checklist · fast layer updated '+when(s.at)+' · deep layer '+(d?'from '+when(d.ranAt):'not run');
  }
  async function load(){try{var r=await fetch('/api/setup',{cache:'no-store'});if(!r.ok)throw new Error('/api/setup returned '+r.status);render(await r.json());}catch(e){$('live-dot').className='dot bad';$('refresh-label').textContent='Offline';$('banner').className='banner bad';$('banner-state').textContent='Checklist unavailable';$('reasons').innerHTML='<li>'+esc(e.message)+'</li>';}}
  async function loadDeep(){var b=$('deep');b.disabled=true;var old=b.textContent;b.textContent='Running… can take a few minutes';
    try{var r=await fetch('/api/setup?deep=1',{cache:'no-store'});if(!r.ok)throw new Error('/api/setup?deep=1 returned '+r.status);render(await r.json());}
    catch(e){$('deep').innerHTML='<div class="empty">Deep checks failed: '+esc(e.message)+'</div>';}
    finally{b.disabled=false;b.textContent=old;}}
  $('refresh').addEventListener('click',load);$('deep').addEventListener('click',loadDeep);load();setInterval(function(){if(!document.hidden)load()},5000);
})();
</script>
</body>
</html>`;
}
