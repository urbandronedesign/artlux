// The tablet PWA, embedded as a single self-contained document (inline CSS + vanilla JS, zero external
// requests — works offline on any tablet browser and ships inside the app bundle, so there's never a
// version-skew between client and server). Served verbatim by server.ts at GET /. Mobile-first, big
// touch targets, dark. Tabs: Control · States · Schedule · Projects · Metrics.
//
// Wire protocol: pairs via POST /pair (PIN → token, cached in localStorage); streams live state over
// EventSource /events?token=…; sends commands/config as JSON POSTs with a Bearer token. The client
// code below intentionally uses NO template literals so it nests safely inside this exported one.

export const CLIENT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0b0d12" />
<title>ArtLux Show Control</title>
<style>
  :root { --bg:#0b0d12; --panel:#151923; --panel2:#1c2230; --line:#2a3244; --fg:#e8ecf4; --fg2:#9aa6bd; --fg3:#5f6b82; --accent:#5b8cff; --ok:#34d399; --warn:#fbbf24; --bad:#f87171; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; overscroll-behavior:none; }
  #app { display:flex; flex-direction:column; height:100dvh; }
  header { display:flex; align-items:center; gap:10px; padding:10px 14px; padding-top:calc(10px + env(safe-area-inset-top)); background:var(--panel); border-bottom:1px solid var(--line); }
  header .title { font-weight:600; letter-spacing:.2px; }
  header .sp { flex:1; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--fg3); }
  .dot.on { background:var(--ok); } .dot.off { background:var(--bad); }
  .lock { font-size:12px; color:var(--warn); display:none; } .lock.show { display:inline; }
  nav { display:flex; gap:2px; background:var(--panel); border-bottom:1px solid var(--line); overflow-x:auto; }
  nav button { flex:1; min-width:78px; background:none; border:none; color:var(--fg2); padding:12px 8px; font-size:13px; font-weight:600; border-bottom:2px solid transparent; }
  nav button.active { color:var(--fg); border-bottom-color:var(--accent); }
  main { flex:1; overflow-y:auto; padding:14px; padding-bottom:calc(20px + env(safe-area-inset-bottom)); }
  h3 { margin:2px 0 10px; font-size:12px; text-transform:uppercase; letter-spacing:.6px; color:var(--fg3); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:10px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:12px; }
  button.tile { background:var(--panel2); border:1px solid var(--line); border-radius:12px; color:var(--fg); padding:16px 12px; font-size:15px; font-weight:600; text-align:left; min-height:64px; display:flex; flex-direction:column; justify-content:space-between; gap:6px; transition:transform .05s; }
  button.tile:active { transform:scale(.97); }
  button.tile .sub { font-size:11px; color:var(--fg2); font-weight:500; }
  button.tile.active { outline:2px solid var(--accent); }
  .accentbar { height:4px; border-radius:2px; background:var(--accent); }
  .row { display:flex; gap:8px; flex-wrap:wrap; }
  .btn { background:var(--panel2); border:1px solid var(--line); color:var(--fg); border-radius:10px; padding:12px 16px; font-size:14px; font-weight:600; }
  .btn.pri { background:var(--accent); border-color:var(--accent); color:#fff; }
  .btn.bad { color:var(--bad); }
  .btn:active { transform:scale(.97); }
  .transport button { flex:1; padding:16px; font-size:16px; }
  input, select { background:var(--panel2); border:1px solid var(--line); color:var(--fg); border-radius:10px; padding:11px 12px; font-size:15px; width:100%; }
  label { font-size:12px; color:var(--fg2); display:block; margin:8px 0 4px; }
  .days { display:flex; gap:5px; } .days button { flex:1; padding:9px 0; border-radius:8px; background:var(--panel2); border:1px solid var(--line); color:var(--fg3); font-size:12px; font-weight:700; }
  .days button.on { background:var(--accent); border-color:var(--accent); color:#fff; }
  .list-item { display:flex; align-items:center; gap:10px; padding:12px; background:var(--panel); border:1px solid var(--line); border-radius:10px; margin-bottom:8px; }
  .list-item .grow { flex:1; min-width:0; }
  .list-item .name { font-weight:600; } .list-item .meta { font-size:12px; color:var(--fg2); }
  .badge { font-size:11px; font-weight:700; padding:3px 7px; border-radius:6px; background:var(--panel2); color:var(--fg2); }
  .badge.now { background:var(--ok); color:#04140c; } .badge.next { background:var(--accent); color:#fff; }
  .sw { width:44px; height:26px; border-radius:14px; background:var(--line); position:relative; flex:none; border:none; }
  .sw.on { background:var(--ok); } .sw i { position:absolute; top:3px; left:3px; width:20px; height:20px; border-radius:50%; background:#fff; transition:left .12s; } .sw.on i { left:21px; }
  .metric { display:flex; flex-direction:column; gap:2px; }
  .metric .v { font-size:26px; font-weight:700; font-variant-numeric:tabular-nums; }
  .metric .k { font-size:11px; color:var(--fg3); text-transform:uppercase; letter-spacing:.5px; }
  .metric .u { font-size:12px; color:var(--fg2); }
  svg.spark { width:100%; height:34px; margin-top:6px; }
  .muted { color:var(--fg3); font-size:13px; }
  .pair { max-width:340px; margin:12vh auto 0; text-align:center; }
  .pair h1 { font-size:20px; margin:0 0 6px; } .pair p { color:var(--fg2); font-size:13px; }
  .pair input { text-align:center; font-size:28px; letter-spacing:10px; margin:18px 0; }
  .err { color:var(--bad); font-size:13px; min-height:18px; }
  .hint { color:var(--fg3); font-size:12px; margin-top:6px; }
</style>
</head>
<body>
<div id="app"></div>
<script>
(function(){
  var LS='artlux.showctl.token';
  var token=localStorage.getItem(LS)||'';
  var es=null, connected=false;
  var snapshot=null, status=null, playlist={enabled:false,entries:[]}, plStatus={}, devices=[], locked=false, mode='editor';
  var tab='control';
  var hist={cpuPct:[],fps:[],pps:[],heapMB:[],lagP99:[],rfps:[],fp99:[],wp99:[]}, lastMetrics=null;
  var app=document.getElementById('app');

  function api(path, body){
    var opts={ method: body?'POST':'GET', headers:{} };
    if(body){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
    if(token) opts.headers['Authorization']='Bearer '+token;
    return fetch(path, opts);
  }
  function cmd(command){ api('/command',{command:command}).then(function(r){ if(r.status===423) flashLocked(); }); }
  function flashLocked(){ locked=true; render(); }

  function queryPin(){ var m=/[?&]pin=([0-9]{4})/.exec(location.search||''); return m?m[1]:''; }
  // ---- pairing ----
  function pairView(){
    app.innerHTML=''+
      '<div class="pair">'+
      '<h1>ArtLux Show Control</h1>'+
      '<p>Enter the PIN shown in the app (Preferences &rsaquo; Show Control, or the Show Control panel).</p>'+
      '<input id="pin" inputmode="numeric" maxlength="4" placeholder="0000" value="'+esc(queryPin())+'" />'+
      '<div class="err" id="perr"></div>'+
      '<button class="btn pri" style="width:100%" data-act="pair">Pair this device</button>'+
      '<div class="hint">Paired once, this tablet reconnects automatically.</div>'+
      '</div>';
    var pin=document.getElementById('pin'); if(pin) pin.focus();
  }
  function doPair(pinOverride){
    var pin=pinOverride||(document.getElementById('pin')||{}).value||'';
    api('/pair',{pin:pin, name:(navigator.platform||'Tablet')}).then(function(r){ return r.json().then(function(j){return {ok:r.ok,j:j};}); })
      .then(function(x){ if(x.ok&&x.j.token){ token=x.j.token; localStorage.setItem(LS,token); connect(); render(); }
        else { var e=document.getElementById('perr'); if(e) e.textContent='Wrong PIN. Check the app and try again.'; } })
      .catch(function(){ var e=document.getElementById('perr'); if(e) e.textContent='Cannot reach the app.'; });
  }

  // ---- SSE ----
  function connect(){
    if(!token) return;
    if(es) es.close();
    es=new EventSource('/events?token='+encodeURIComponent(token));
    es.onopen=function(){ connected=true; paintHeader(); };
    es.onerror=function(){ connected=false; paintHeader(); };
    es.onmessage=function(ev){
      var m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
      if(m.t==='hello'){ locked=m.locked; mode=m.mode; }
      else if(m.t==='snapshot'){ snapshot=m.snapshot; }
      else if(m.t==='status'){ status=m.status; }
      else if(m.t==='metrics'){ lastMetrics=m.metrics; pushHist(m.metrics); }
      else if(m.t==='playlist'){ playlist=m.playlist||playlist; plStatus=m.status||{}; }
      else if(m.t==='devices'){ devices=m.devices||[]; }
      else if(m.t==='locked'){ locked=m.locked; }
      renderIfDynamic(m.t);
      paintHeader();
    };
  }
  function pushHist(mt){
    function add(a,v){ a.push(v||0); if(a.length>60) a.shift(); }
    add(hist.cpuPct, mt.system?mt.system.cpuPct:0);
    add(hist.heapMB, mt.system?mt.system.heapMB:0);
    add(hist.lagP99, mt.system?mt.system.eventLoopLagP99Ms:0);
    add(hist.fps, mt.engine?mt.engine.fps:0);
    add(hist.pps, mt.engine?mt.engine.pps:0);
    add(hist.rfps, mt.render?mt.render.fps:0);
    add(hist.fp99, mt.render?mt.render.frameP99:0);
    add(hist.wp99, mt.render?mt.render.workP99:0);
  }
  // Metrics/status stream constantly; only re-render the tab they affect (avoid nuking form inputs).
  function renderIfDynamic(t){
    if(tab==='metrics' && t==='metrics'){ renderMetrics(); return; }
    if((tab==='control'||tab==='states') && (t==='snapshot'||t==='status'||t==='locked')){ render(); return; }
    if(tab==='projects' && t==='playlist'){ /* keep form; update via full render only if not editing */ render(); return; }
    if(t==='snapshot' && tab==='schedule'){ /* scene list changed rarely; skip to preserve inputs */ }
  }

  // ---- shell ----
  function paintHeader(){
    var d=document.querySelector('header .dot'); if(d){ d.className='dot '+(connected?'on':'off'); }
    var l=document.querySelector('header .lock'); if(l){ l.className='lock '+(locked?'show':''); }
  }
  var TABS=[['control','Control'],['states','States'],['schedule','Schedule'],['projects','Projects'],['metrics','Metrics']];
  function shell(inner){
    var nav=''; for(var i=0;i<TABS.length;i++){ nav+='<button data-act="tab" data-tab="'+TABS[i][0]+'" class="'+(tab===TABS[i][0]?'active':'')+'">'+TABS[i][1]+'</button>'; }
    app.innerHTML=''+
      '<header><span class="dot '+(connected?'on':'off')+'"></span><span class="title">Show Control</span>'+
      '<span class="lock '+(locked?'show':'')+'">&#128274; LOCKED</span><span class="sp"></span>'+
      '<span class="badge">'+mode+'</span></header>'+
      '<nav>'+nav+'</nav><main id="main"></main>';
    document.getElementById('main').innerHTML=inner;
  }

  function esc(s){ s=(s==null?'':String(s)); return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // ---- Control ----
  function renderControl(){
    var s=snapshot||{scenes:[],banks:[]};
    var active=status?status.activeSceneId:null;
    var h='';
    h+='<div class="card transport"><div class="row">'+
       '<button class="btn pri" data-act="tp" data-a="play">&#9654; Play</button>'+
       '<button class="btn" data-act="tp" data-a="pause">&#10074;&#10074; Pause</button>'+
       '<button class="btn" data-act="tp" data-a="stop">&#9632; Stop</button></div></div>';
    h+='<h3>Scenes</h3><div class="grid">';
    if(!s.scenes.length) h+='<div class="muted">No scenes in this project.</div>';
    for(var i=0;i<s.scenes.length;i++){ var sc=s.scenes[i];
      h+='<button class="tile '+(active===sc.id?'active':'')+'" data-act="scene" data-ref="'+esc(sc.id)+'">'+
         '<div class="accentbar" style="background:'+esc(sc.accent||'#5b8cff')+'"></div>'+
         '<span>'+esc(sc.name||'Scene')+'</span></button>'; }
    h+='</div>';
    var bank=s.banks&&s.banks[0];
    if(bank){
      h+='<h3>Cue columns &mdash; '+esc(bank.name)+'</h3><div class="grid">';
      for(var c=0;c<bank.cols;c++){ var has=bank.sceneCells.some(function(x){return x.col===c;})||bank.cues.some(function(q){return q.col===c;});
        if(!has) continue;
        h+='<button class="tile" data-act="col" data-bank="'+esc(bank.id)+'" data-col="'+c+'"><span>Column '+(c+1)+'</span><span class="sub">fire</span></button>'; }
      h+='</div>';
    }
    shell(h);
  }

  // ---- States (FSM) ----
  function renderStates(){
    var fsm=(snapshot&&snapshot.fsm)||{enabled:false,states:[],transitions:[]};
    var cur=status?status.currentStateId:null;
    var manual=fsm.transitions.filter(function(t){ return t.from===cur && t.manual; });
    var curName=''; for(var i=0;i<fsm.states.length;i++){ if(fsm.states[i].id===cur) curName=fsm.states[i].name; }
    var h='';
    h+='<div class="card"><div class="list-item" style="margin:0;border:none;padding:0;background:none">'+
       '<div class="grow"><div class="name">State machine</div><div class="meta">'+(fsm.enabled?('Running &mdash; current: '+esc(curName||'?')):'Disabled')+'</div></div>'+
       '<button class="sw '+(fsm.enabled?'on':'')+'" data-act="fsm" data-on="'+(fsm.enabled?'0':'1')+'"><i></i></button></div></div>';
    h+='<h3>Manual transitions</h3>';
    if(!manual.length) h+='<div class="muted">No manual transitions from the current state.</div>';
    else { h+='<div class="row">'; for(var m=0;m<manual.length;m++){ var t=manual[m]; var to=''; for(var j=0;j<fsm.states.length;j++){ if(fsm.states[j].id===t.to) to=fsm.states[j].name; }
      h+='<button class="btn pri" data-act="trans" data-id="'+esc(t.id)+'">&rarr; '+esc(to||'state')+'</button>'; } h+='</div>'; }
    h+='<h3>Jump to state (test)</h3><div class="grid">';
    for(var k=0;k<fsm.states.length;k++){ var st=fsm.states[k];
      h+='<button class="tile '+(cur===st.id?'active':'')+'" data-act="enter" data-id="'+esc(st.id)+'"><span>'+esc(st.name||'State')+'</span>'+
         '<span class="sub">'+(cur===st.id?'current':'jump here')+'</span></button>'; }
    h+='</div>';
    shell(h);
  }

  // ---- Schedule (in-project) ----
  var schedDraft=null; // {time,days:Set,action}
  function renderSchedule(){
    var sched=(snapshot&&snapshot.schedule)||[];
    var scenes=(snapshot&&snapshot.scenes)||[];
    var h='<h3>In-project schedule</h3>';
    h+='<div class="muted" style="margin-bottom:8px">Fires within the loaded project at a wall-clock time. Runs in broadcast too.</div>';
    if(!sched.length) h+='<div class="muted">No scheduled entries yet.</div>';
    for(var i=0;i<sched.length;i++){ var e=sched[i];
      h+='<div class="list-item"><div class="grow"><div class="name">'+esc(e.time||'--:--')+' &middot; '+esc(actionLabel(e.action,scenes))+'</div>'+
         '<div class="meta">'+daysLabel(e.days)+'</div></div>'+
         '<button class="sw '+(e.enabled?'on':'')+'" data-act="sched-toggle" data-id="'+esc(e.id)+'"><i></i></button>'+
         '<button class="btn bad" data-act="sched-del" data-id="'+esc(e.id)+'">Del</button></div>';
    }
    h+='<div class="card" style="margin-top:12px"><h3>Add entry</h3>'+
       '<label>Time</label><input id="sc-time" type="time" value="09:00" />'+
       '<label>Days (none = every day)</label><div class="days" id="sc-days">'+dayChips()+'</div>'+
       '<label>Action</label><select id="sc-act"><option value="stop">Transport: Stop</option><option value="play">Transport: Play</option>'+
       sceneOptions(scenes)+'</select>'+
       '<button class="btn pri" style="width:100%;margin-top:12px" data-act="sched-add">Add to schedule</button></div>';
    shell(h);
  }
  function actionLabel(a,scenes){ if(!a) return '?'; if(a.kind==='transport') return 'Transport '+a.action; if(a.kind==='recallScene'){ var n=a.ref; for(var i=0;i<scenes.length;i++){ if(scenes[i].id===a.ref) n=scenes[i].name; } return 'Recall '+n; } return a.kind; }
  function sceneOptions(scenes){ var o=''; for(var i=0;i<scenes.length;i++){ o+='<option value="scene:'+esc(scenes[i].id)+'">Recall: '+esc(scenes[i].name)+'</option>'; } return o; }
  function actionFromSelect(v){ if(v==='stop') return {kind:'transport',action:'stop'}; if(v==='play') return {kind:'transport',action:'play'}; if(v.indexOf('scene:')===0) return {kind:'recallScene',ref:v.slice(6)}; return {kind:'transport',action:'stop'}; }

  function addSchedule(){
    var sched=((snapshot&&snapshot.schedule)||[]).slice();
    var time=(document.getElementById('sc-time')||{}).value||'09:00';
    var days=readDays('sc-days');
    var act=actionFromSelect((document.getElementById('sc-act')||{}).value||'stop');
    sched.push({ id:'s'+Date.now(), enabled:true, time:time, days:days, action:act });
    api('/schedule',{schedule:sched});
  }
  function toggleSchedule(id){ var sched=((snapshot&&snapshot.schedule)||[]).map(function(e){ return e.id===id?Object.assign({},e,{enabled:!e.enabled}):e; }); api('/schedule',{schedule:sched}); }
  function delSchedule(id){ var sched=((snapshot&&snapshot.schedule)||[]).filter(function(e){ return e.id!==id; }); api('/schedule',{schedule:sched}); }

  // ---- Projects (playlist) ----
  var scanned=[];
  function renderProjects(){
    var h='<h3>Project playlist &mdash; unattended broadcast</h3>';
    h+='<div class="card"><div class="list-item" style="margin:0;border:none;padding:0;background:none">'+
       '<div class="grow"><div class="name">Playlist</div><div class="meta">'+(playlist.enabled?'Active (switches projects at each time in broadcast)':'Off')+'</div></div>'+
       '<button class="sw '+(playlist.enabled?'on':'')+'" data-act="pl-enable" data-on="'+(playlist.enabled?'0':'1')+'"><i></i></button></div>'+
       '<div class="row" style="margin-top:10px"><button class="btn pri" data-act="pl-start">Start in broadcast now</button></div>'+
       (plStatus.currentPath?('<div class="hint">Now: '+esc(baseName(plStatus.currentPath))+(plStatus.nextPath?('  &middot;  Next: '+esc(baseName(plStatus.nextPath))+' at '+esc(plStatus.nextAt||'')):'')+'</div>'):'')+
       '</div>';
    // scan
    h+='<div class="card" style="margin-top:12px"><h3>Find projects</h3><label>Folder path on the show machine</label>'+
       '<input id="pl-folder" placeholder="C:\\\\Shows" value="'+esc(playlist.folder||'')+'" />'+
       '<button class="btn" style="width:100%;margin-top:8px" data-act="pl-scan">Scan folder</button>';
    if(scanned.length){ h+='<div style="margin-top:10px">'; for(var i=0;i<scanned.length;i++){ var p=scanned[i];
      h+='<div class="list-item"><div class="grow"><div class="name">'+esc(p.name)+'</div><div class="meta">'+(p.isFolder?'portable folder':'file')+'</div></div>'+
         '<button class="btn" data-act="pl-add" data-path="'+esc(p.path)+'" data-name="'+esc(p.name)+'">Add</button>'+
         '<button class="btn" data-act="pl-load" data-path="'+esc(p.path)+'">Load</button></div>'; } h+='</div>'; }
    h+='</div>';
    // playlist entries
    h+='<h3>Playlist ('+playlist.entries.length+')</h3>';
    if(!playlist.entries.length) h+='<div class="muted">Add projects above, each with a time of day.</div>';
    var nowP=plStatus.currentPath, nextP=plStatus.nextPath;
    for(var j=0;j<playlist.entries.length;j++){ var e=playlist.entries[j];
      var badge=''; if(nowP&&samePath(e.projectPath,nowP)) badge='<span class="badge now">NOW</span>'; else if(nextP&&samePath(e.projectPath,nextP)) badge='<span class="badge next">NEXT</span>';
      h+='<div class="list-item"><div class="grow"><div class="name">'+esc(e.time||'--:--')+' &middot; '+esc(e.name||baseName(e.projectPath))+' '+badge+'</div>'+
         '<div class="meta">'+daysLabel(e.days)+'</div></div>'+
         '<button class="sw '+(e.enabled?'on':'')+'" data-act="pl-toggle" data-id="'+esc(e.id)+'"><i></i></button>'+
         '<button class="btn bad" data-act="pl-del" data-id="'+esc(e.id)+'">Del</button></div>';
    }
    // add time for pending
    h+='<div class="card" style="margin-top:12px"><h3>Default time for &ldquo;Add&rdquo;</h3>'+
       '<label>Time</label><input id="pl-time" type="time" value="09:00" />'+
       '<label>Days (none = every day)</label><div class="days" id="pl-days">'+dayChips()+'</div>'+
       '<div class="hint">Set the time, then tap &ldquo;Add&rdquo; on a scanned project above.</div></div>';
    shell(h);
  }
  function scanFolder(){ var f=(document.getElementById('pl-folder')||{}).value||''; api('/scan',{folder:f}).then(function(r){return r.json();}).then(function(j){ scanned=j.projects||[]; savePlaylist(Object.assign({},playlist,{folder:f}),true); renderProjects(); }); }
  function addPlaylist(path,name){ var time=(document.getElementById('pl-time')||{}).value||'09:00'; var days=readDays('pl-days');
    var entries=playlist.entries.slice(); entries.push({ id:'p'+Date.now(), enabled:true, projectPath:path, name:name, time:time, days:days });
    savePlaylist(Object.assign({},playlist,{entries:entries})); }
  function togglePl(id){ var entries=playlist.entries.map(function(e){ return e.id===id?Object.assign({},e,{enabled:!e.enabled}):e; }); savePlaylist(Object.assign({},playlist,{entries:entries})); }
  function delPl(id){ var entries=playlist.entries.filter(function(e){ return e.id!==id; }); savePlaylist(Object.assign({},playlist,{entries:entries})); }
  function enablePl(on){ savePlaylist(Object.assign({},playlist,{enabled:on})); }
  function savePlaylist(p,silent){ playlist=p; api('/playlist',{playlist:p}); if(!silent) renderProjects(); }

  // ---- Metrics ----
  function renderMetrics(){
    var m=lastMetrics; var e=m&&m.engine, r=m&&m.render, sy=m&&m.system;
    function tile(k,v,u,spark,color){ return '<div class="card metric"><div class="k">'+k+'</div><div class="v" style="color:'+(color||'var(--fg)')+'">'+v+'<span class="u"> '+(u||'')+'</span></div>'+(spark?sparkSvg(spark):'')+'</div>'; }
    var up=e?e.up:false;
    var h='<h3>Output engine</h3><div class="grid">';
    h+=tile('Output', e?(up?'LIVE':'down'):'&mdash;', '', null, up?'var(--ok)':'var(--bad)');
    h+=tile('Output FPS', e?fmt(e.fps):'&mdash;','fps',hist.fps);
    h+=tile('Packets/s', e?fmt(e.pps):'&mdash;','pps',hist.pps);
    h+=tile('Universes', e?e.universes:'&mdash;','');
    h+='</div><h3>Renderer</h3><div class="grid">';
    h+=tile('Render FPS', r?fmt(r.fps):'&mdash;','fps',hist.rfps, r&&r.fps>0&&r.fps<50?'var(--warn)':'var(--fg)');
    h+=tile('Frame p99', r?fmt(r.frameP99):'&mdash;','ms',hist.fp99, r&&r.frameP99>25?'var(--warn)':'var(--fg)');
    h+=tile('Work p99', r?fmt(r.workP99):'&mdash;','ms',hist.wp99);
    h+=tile('Long frames', r?r.longFrames:'&mdash;','',null, r&&r.longFrames>3?'var(--bad)':'var(--fg)');
    h+='</div><h3>System</h3><div class="grid">';
    h+=tile('CPU', sy?fmt(sy.cpuPct):'&mdash;','%',hist.cpuPct, sy&&sy.cpuPct>85?'var(--warn)':'var(--fg)');
    h+=tile('RSS', sy?sy.rssMB:'&mdash;','MB');
    h+=tile('Heap', sy?sy.heapMB:'&mdash;','MB',hist.heapMB);
    h+=tile('Loop lag p99', sy?fmt(sy.eventLoopLagP99Ms):'&mdash;','ms',hist.lagP99, sy&&sy.eventLoopLagP99Ms>50?'var(--warn)':'var(--fg)');
    h+='</div><div class="hint" style="margin-top:12px">'+(m?('mode '+esc(m.mode)+' &middot; v'+esc(m.version)):'Waiting for metrics&hellip;')+'</div>';
    shell(h);
  }
  function sparkSvg(a){ if(!a||a.length<2) return ''; var max=1; for(var i=0;i<a.length;i++){ if(a[i]>max) max=a[i]; }
    var n=a.length, pts=''; for(var j=0;j<n;j++){ var x=(j/(n-1))*100; var y=34-(a[j]/max)*32-1; pts+=x.toFixed(1)+','+y.toFixed(1)+' '; }
    return '<svg class="spark" viewBox="0 0 100 34" preserveAspectRatio="none"><polyline fill="none" stroke="var(--accent)" stroke-width="1.5" points="'+pts+'"/></svg>'; }
  function fmt(x){ x=Number(x)||0; return (Math.round(x*10)/10).toString(); }

  // ---- shared helpers ----
  function baseName(p){ if(!p) return ''; p=String(p).replace(/[\\\\/]+$/,''); var i=Math.max(p.lastIndexOf('/'),p.lastIndexOf('\\\\')); return i>=0?p.slice(i+1):p; }
  function samePath(a,b){ return baseName(a).toLowerCase()===baseName(b).toLowerCase() && String(a).toLowerCase()===String(b).toLowerCase(); }
  var DNAMES=['S','M','T','W','T','F','S'];
  function dayChips(){ var o=''; for(var i=0;i<7;i++){ o+='<button type="button" data-day="'+i+'">'+DNAMES[i]+'</button>'; } return o; }
  function readDays(id){ var el=document.getElementById(id); if(!el) return []; var out=[]; var b=el.querySelectorAll('button'); for(var i=0;i<b.length;i++){ if(b[i].classList.contains('on')) out.push(parseInt(b[i].getAttribute('data-day'),10)); } return out; }
  function daysLabel(d){ if(!d||!d.length) return 'Every day'; var names=['Sun','Mon','Tue','Wed','Thu','Fri','Sat']; return d.map(function(x){return names[x];}).join(' '); }

  // ---- render dispatch ----
  function render(){
    if(!token){ pairView(); return; }
    if(tab==='control') renderControl();
    else if(tab==='states') renderStates();
    else if(tab==='schedule') renderSchedule();
    else if(tab==='projects') renderProjects();
    else if(tab==='metrics') renderMetrics();
    paintHeader();
  }

  // ---- one delegated click handler (no inline JS → no quoting hazards) ----
  document.addEventListener('click', function(ev){
    var t=ev.target.closest('[data-act],[data-day]'); if(!t) return;
    if(t.hasAttribute('data-day')){ t.classList.toggle('on'); return; }
    var a=t.getAttribute('data-act');
    if(a==='pair') doPair();
    else if(a==='tab'){ tab=t.getAttribute('data-tab'); render(); }
    else if(a==='tp') cmd({kind:'transport',action:t.getAttribute('data-a')});
    else if(a==='scene') cmd({kind:'recallScene',ref:t.getAttribute('data-ref')});
    else if(a==='col') cmd({kind:'fireColumn',bank:t.getAttribute('data-bank'),col:parseInt(t.getAttribute('data-col'),10)});
    else if(a==='fsm') cmd({kind:'setFsmEnabled',on:t.getAttribute('data-on')==='1'});
    else if(a==='trans') cmd({kind:'triggerTransition',id:t.getAttribute('data-id')});
    else if(a==='enter') cmd({kind:'enterState',id:t.getAttribute('data-id')});
    else if(a==='sched-add') addSchedule();
    else if(a==='sched-toggle') toggleSchedule(t.getAttribute('data-id'));
    else if(a==='sched-del') delSchedule(t.getAttribute('data-id'));
    else if(a==='pl-enable') enablePl(t.getAttribute('data-on')==='1');
    else if(a==='pl-scan') scanFolder();
    else if(a==='pl-add') addPlaylist(t.getAttribute('data-path'),t.getAttribute('data-name'));
    else if(a==='pl-load') api('/playlist/load',{path:t.getAttribute('data-path')});
    else if(a==='pl-start') api('/playlist/start',{});
    else if(a==='pl-toggle') togglePl(t.getAttribute('data-id'));
    else if(a==='pl-del') delPl(t.getAttribute('data-id'));
  });

  render();
  if(token) connect();
  else { var qp=queryPin(); if(qp) doPair(qp); } // one-scan onboarding: auto-pair from the QR's ?pin=
})();
</script>
</body>
</html>`;
