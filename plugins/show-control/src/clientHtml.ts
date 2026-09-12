// The tablet PWA, embedded as a single self-contained document (inline CSS + vanilla JS, zero external
// requests — works offline on any tablet browser and ships inside the app bundle, so there's never a
// version-skew between client and server). Served verbatim by server.ts at GET /. Mobile-first, big
// touch targets, dark. Tabs: Control · States · Schedule · Projects · Metrics.
//
// Wire protocol: pairs via POST /pair (PIN → token, cached in localStorage); streams live state over
// EventSource /events?token=…; sends commands/config as JSON POSTs with a Bearer token. The client
// code below intentionally uses NO template literals so it nests safely inside this exported one.

import { WORDMARK, ICON_MARK } from '../../../shared/brandMarks';

// The app wordmark, inline. It has to be inline for two independent reasons: this document makes no
// external requests, and `currentColor` only inherits into an inline <svg> — an <img> could not pick
// up the tablet client's own palette. All-double-quoted so it nests safely inside the single-quoted
// strings the client code below builds its markup with.
const WORDMARK_SVG =
  `<svg viewBox="0 0 ${WORDMARK.width} ${WORDMARK.height}" fill="currentColor" role="img" aria-label="ARTLux"><path d="${WORDMARK.path}"/></svg>`;

export const CLIENT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0b0d12" />
<title>ARTLux Show Control</title>
<!-- Inline so the tab/home-screen icon survives a tablet that has no route back to the app for
     assets. iOS ignores SVG for apple-touch-icon, so both point at the rasterised tile: without
     this, "Add to Home Screen" left the operator with a blank, unlabelled square. -->
<link rel="icon" href="${ICON_MARK.png180}" />
<link rel="apple-touch-icon" href="${ICON_MARK.png180}" />
<meta name="apple-mobile-web-app-title" content="ARTLux" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<style>
  :root { --bg:#0b0d12; --panel:#151923; --panel2:#1c2230; --line:#2a3244; --fg:#e8ecf4; --fg2:#9aa6bd; --fg3:#5f6b82; --accent:#5b8cff; --ok:#34d399; --warn:#fbbf24; --bad:#f87171; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; overscroll-behavior:none; }
  #app { display:flex; flex-direction:column; height:100dvh; }
  header { display:flex; align-items:center; gap:10px; padding:10px 14px; padding-top:calc(10px + env(safe-area-inset-top)); background:var(--panel); border-bottom:1px solid var(--line); }
  header .title { display:flex; align-items:center; gap:8px; font-weight:600; letter-spacing:.2px; }
  /* The wordmark is a tight ink box, so height alone sizes it; width:auto keeps the aspect. */
  header .title svg { height:13px; width:auto; display:block; color:var(--fg); }
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
  /* A tappable list row. 'button' so it is keyboard- and screen-reader-reachable; the spans are
     block so the two lines stack the way the div-based rows next to them do. */
  .row-btn { background:none; border:none; color:inherit; text-align:left; padding:0; font:inherit; flex:1; min-width:0; }
  .row-btn .name, .row-btn .meta { display:block; }
  .list-item.spent { opacity:.5; }
  /* The editor. A bottom sheet, because on a tablet held in two hands the bottom is where the thumbs
     are — and because it covers the list, which is what stops a background repaint from being felt. */
  .sheet { position:fixed; inset:0; z-index:50; background:rgba(4,6,10,.72); display:flex; align-items:flex-end; justify-content:center; }
  .sheet .body { width:100%; max-width:560px; max-height:92dvh; overflow-y:auto; background:var(--panel); border:1px solid var(--line); border-radius:16px 16px 0 0; padding:16px; padding-bottom:calc(16px + env(safe-area-inset-bottom)); }
  .sheet h2 { margin:0 0 4px; font-size:17px; }
  .seg { display:flex; gap:5px; }
  .seg button { flex:1; padding:11px 0; border-radius:9px; background:var(--panel2); border:1px solid var(--line); color:var(--fg2); font-size:13px; font-weight:700; }
  .seg button.on { background:var(--accent); border-color:var(--accent); color:#fff; }
  .sheet .foot { display:flex; gap:8px; margin-top:18px; }
  .sheet .foot .btn { flex:1; }
  .pair { max-width:340px; margin:12vh auto 0; text-align:center; }
  .pair h1 { font-size:20px; margin:0 0 6px; } .pair p { color:var(--fg2); font-size:13px; }
  .pair .brand svg { height:26px; width:auto; margin:0 auto 10px; color:var(--fg); }
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
  // The projects this machine can load. STREAMED from the app (the server scans and caches), not a
  // local variable as before — which is why the list used to vanish on every reconnect and tab switch.
  var scan={root:'',projects:[],truncated:false}, projFilter='';
  // The one open editor, if any: { kind:'pl'|'sched', isNew, draft }. Also the repaint interlock —
  // see renderIfDynamic.
  var editor=null;
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
      '<div class="brand">${WORDMARK_SVG}</div>'+
      '<h1>Show Control</h1>'+
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
    es.onopen=function(){
      connected=true;
      // IT CAME BACK. EventSource reconnects on its own, so a successful open after a restart is
      // the most reliable "the new process is serving" signal there is — better than a timer, which
      // would drop the operator back onto a dead remote if the relaunch happened to be slow.
      if(stopping==='restart'){ stopping=null; render(); return; }
      paintHeader();
    };
    es.onerror=function(){ connected=false; paintHeader(); };
    es.onmessage=function(ev){
      var m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
      if(m.t==='hello'){ locked=m.locked; mode=m.mode; }
      else if(m.t==='snapshot'){ snapshot=m.snapshot; }
      else if(m.t==='status'){ status=m.status; }
      else if(m.t==='metrics'){ lastMetrics=m.metrics; pushHist(m.metrics); }
      else if(m.t==='playlist'){ playlist=m.playlist||playlist; plStatus=m.status||{}; }
      else if(m.t==='projects'){ scan=m.scan||scan; }
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
  // Metrics/status stream constantly; only re-render the tab they affect.
  //
  // THIS FUNCTION IS WHY THE PAGE WAS UNUSABLE. The scheduler pushes a 'playlist' event every 5
  // seconds whether or not anything changed, and this answered it with a full render() — rebuilding
  // the Projects tab, and with it the folder field, the time input and the day chips, every five
  // seconds, under the operator's finger. The 'schedule' tab had the opposite bug: it deliberately
  // skipped 'snapshot', so adding an entry visibly did nothing at all.
  //
  // Three rules now: an open editor is never repainted; a tab repaints only when its OWN data
  // changed; and nothing repaints while a field has focus.
  function renderIfDynamic(t){
    if(editor||ask||stopping) return;
    if(tab==='metrics'){ if(t==='metrics') renderMetrics(); return; }
    if(t==='metrics') return;
    // Control and States go through the same changed-compare as the rest. They used to repaint on
    // EVERY status event — 2 Hz, forever — and the status payload that drives that is mostly the
    // playhead, which neither tab draws. Two hundred wasted DOM rebuilds a minute, each one a
    // chance to lose a scroll position, a tap or a focus.
    if(tab==='control'||tab==='states'){ if(t==='snapshot'||t==='status'||t==='locked') renderIfChanged(); return; }
    if(tab==='projects'){ if(t==='playlist'||t==='projects'||t==='locked') renderIfChanged(); return; }
    if(tab==='schedule'){ if(t==='snapshot'||t==='locked') renderIfChanged(); return; }
  }
  var lastPaint='';
  function renderIfChanged(){
    // Never rebuild the DOM a finger is in. The change is not lost: the next push re-evaluates, and
    // the signature still differs, so it lands as soon as the field is left.
    var ae=document.activeElement;
    if(ae&&(ae.tagName==='INPUT'||ae.tagName==='SELECT'||ae.tagName==='TEXTAREA')) return;
    // Per tab, and DELIBERATELY NARROW: the whole point is to exclude the fields that change every
    // tick but are never drawn (status.playhead, status.ts). A field added to a tab's markup must be
    // added here too, or the tab will stop repainting when it changes.
    var sig;
    if(tab==='control') sig=JSON.stringify([
      (snapshot&&snapshot.scenes)||null,(snapshot&&snapshot.banks)||null,!!snapshot,
      status?[status.activeSceneId,!!status.booting,status.bootPending||0,!!status.held]:null,
      locked,mode]);
    else if(tab==='states') sig=JSON.stringify([
      (snapshot&&snapshot.fsm)||null,status?status.currentStateId:null,locked]);
    else if(tab==='projects') sig=JSON.stringify([
      playlist,plStatus.currentPath,plStatus.nextPath,plStatus.nextAt,scan.root,(scan.projects||[]).length,locked]);
    else sig=JSON.stringify([(snapshot&&snapshot.schedule)||[],locked]);
    if(sig===lastPaint) return;
    lastPaint=sig;
    render();
  }

  // ---- shell ----
  function paintHeader(){
    var d=document.querySelector('header .dot'); if(d){ d.className='dot '+(connected?'on':'off'); }
    var l=document.querySelector('header .lock'); if(l){ l.className='lock '+(locked?'show':''); }
  }
  var TABS=[['control','Control'],['states','States'],['schedule','Schedule'],['projects','Projects'],['metrics','Metrics']];
  // KEEP THE SCROLL. This function replaces <main> outright, so every repaint used to send the page
  // back to the top — and on the Control tab, which repainted on the 2 Hz status stream, that made
  // anything below the fold literally unreachable: you scrolled, and half a second later you were
  // back at the top. Restored only when the SAME tab is being redrawn; switching tabs starts at the
  // top, which is what a tab switch should do.
  var shellTab=null, shellScroll=0;
  function shell(inner){
    var prev=document.getElementById('main');
    if(prev&&shellTab===tab) shellScroll=prev.scrollTop; else shellScroll=0;
    var nav=''; for(var i=0;i<TABS.length;i++){ nav+='<button data-act="tab" data-tab="'+TABS[i][0]+'" class="'+(tab===TABS[i][0]?'active':'')+'">'+TABS[i][1]+'</button>'; }
    app.innerHTML=''+
      '<header><span class="dot '+(connected?'on':'off')+'"></span><span class="title">${WORDMARK_SVG}<span>Show Control</span></span>'+
      '<span class="lock '+(locked?'show':'')+'">&#128274; LOCKED</span><span class="sp"></span>'+
      '<span class="badge">'+mode+'</span></header>'+
      '<nav>'+nav+'</nav><main id="main"></main>';
    var main=document.getElementById('main');
    main.innerHTML=inner;
    if(shellScroll) main.scrollTop=shellScroll;
    shellTab=tab;
    // EVERY tab, one place. An overlay that each renderer has to remember to draw is an overlay that
    // exists on the tabs it was written for and silently does not on the others.
    paintSheets();
  }

  function esc(s){ s=(s==null?'':String(s)); return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // ---- Control ----
  function renderControl(){
    var s=snapshot||{scenes:[],banks:[]};
    var active=status?status.activeSceneId:null;
    var h='';
    // THE SHOW IS LOADING, NOT STOPPED. A cold start (launch, a watchdog relaunch, the playlist's next
    // show) holds the state machine until the opening content is decoded, and that is indistinguishable
    // from a stopped show on this screen — same dead transport, no current state. Say so, or an operator
    // starts pressing GO over a gate that was about to open on its own a second later.
    if(status&&status.booting) h+='<div class="card" style="border-color:var(--warn)"><div class="name">Loading show content&hellip;</div>'+
      '<div class="meta">The show starts by itself when it is ready'+(status.bootPending?(' &mdash; '+status.bootPending+' item(s) left'):'')+'.</div></div>';
    // …AND THE MIRROR-IMAGE CASE. A HELD state is playing (bed, automation, the frozen picture on the
    // wall) with a stopped timecode — indistinguishable here from a show that has hung. It is waiting
    // for a trigger, so an operator's correct action is usually to wait, not to press anything.
    else if(status&&status.held) h+='<div class="card" style="border-color:var(--warn)"><div class="name">Holding &mdash; this state has finished</div>'+
      '<div class="meta">The last frame is held and the show is still running. Waiting for a trigger.</div></div>';
    h+='<div class="card transport"><div class="row">'+
       '<button class="btn pri" data-act="tp" data-a="play">&#9654; Play</button>'+
       '<button class="btn" data-act="tp" data-a="pause">&#10074;&#10074; Pause</button>'+
       '<button class="btn" data-act="tp" data-a="stop">&#9632; Stop</button></div></div>';
    h+='<h3>Scenes</h3><div class="grid">';
    // TWO DIFFERENT NOTHINGS. An empty scene list is a fact about the project; NO SNAPSHOT YET is a
    // fact about this connection, and reporting the second as the first sends an operator to look for
    // a problem in their project that is not there (it did — a venue, an install whose desktop Show
    // Deck listed every scene while the phone said the project had none).
    if(!s.scenes.length) h+='<div class="muted">'+(snapshot?'No scenes in this project.':'Waiting for the app to send the show&hellip;')+'</div>';
    for(var i=0;i<s.scenes.length;i++){ var sc=s.scenes[i];
      h+='<button class="tile '+(active===sc.id?'active':'')+'" data-act="scene" data-ref="'+esc(sc.id)+'">'+
         '<div class="accentbar" style="background:'+esc(sc.accent||'#5b8cff')+'"></div>'+
         '<span>'+esc(sc.name||'Scene')+'</span></button>'; }
    h+='</div>';
    // Every bank (was banks[0] only): the per-cue fire tiles. Banks with no cues are skipped.
    //
    // NO COLUMN TILES. There used to be a second grid of "Column 1 … Column n" buttons per bank —
    // a convenience for firing a whole column at once — and they were removed at the owner's
    // request (2026-09-12): unused here, and they doubled the length of a screen you have to scroll
    // on a tablet. The fireColumn COMMAND is untouched: it is still in ShowCommand, still
    // dispatched, and still reachable from OSC and from a scheduled entry — only the buttons are
    // gone, so bringing them back is a UI change and nothing more.
    var banks=s.banks||[];
    for(var b=0;b<banks.length;b++){ var bank=banks[b];
      var cues=bank.cues||[];
      if(!cues.length) continue;
      h+='<h3>'+esc(bank.name||'Bank')+'</h3>';
      h+='<div class="grid">';
      for(var k=0;k<cues.length;k++){ var cue=cues[k];
        h+='<button class="tile" data-act="cue" data-ref="'+esc(cue.id)+'">'+
           '<div class="accentbar" style="background:'+esc(cue.color||'#5b8cff')+'"></div>'+
           '<span>'+esc(cue.name||'Cue')+'</span><span class="sub">fire</span></button>'; }
      h+='</div>';
    }
    h+=powerCard();
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

  // ---- Power: stopping and restarting the machine's show ---------------------------------------
  // A BROADCAST INSTALL HAS NO UI AT ALL. There is a tray item and Ctrl+Shift+Q, and both of them
  // assume somebody is standing at the machine — which is the one thing a venue remote assumes you
  // are not. The tablet is therefore the only way to end a show from the room it is playing in.
  //
  // Restart sits next to Shut down on purpose: it is the recovery an operator actually wants nine
  // times in ten (a wedged show comes back in a clean process), so the irreversible button is not
  // the only one within reach.
  var stopping=null; // 'shutdown' | 'restart' — the app is on its way out; see render()

  function powerCard(){
    return '<h3 style="margin-top:18px">This machine</h3>'+
      '<div class="card"><div class="meta" style="color:var(--fg2)">'+
      (mode==='broadcast'
        ? 'Running as a show, with no window on the machine.'
        : 'Running the editor on the machine.')+'</div>'+
      '<div class="row" style="margin-top:10px">'+
      '<button class="btn" data-act="pw-restart">&#8635; Restart the app</button>'+
      '<button class="btn bad" data-act="pw-shutdown">&#9211; Shut down</button>'+
      '</div></div>';
  }
  function askRestart(){
    confirmThen('Restart the app?',
      'The show stops and comes back in a fresh process, on the same project. Outputs go dark for a few seconds.',
      'Restart', false, function(){ power('/restart','restart'); });
  }
  function askShutdown(){
    confirmThen('Shut down ArtLux?',
      'The show stops and the app closes. It will NOT start again by itself — including after a reboot — '
      + 'until someone starts it on the machine. Fixtures hold their last frame.',
      'Shut it down', true, function(){ power('/shutdown','shutdown'); });
  }
  // ONLY SAY IT IS STOPPING ONCE THE APP HAS ACCEPTED. The first version set the screen and then
  // fired the request, so a LOCKED remote (423) showed "Shutting down" over a show that was still
  // running perfectly — the one lie this screen must never tell. Same 423 handling as every other
  // command on this page.
  function power(path,state){
    api(path,{}).then(function(r){
      if(r.status===423){ flashLocked(); return; }
      if(!r.ok) return;
      stopping=state; render();
    }).catch(function(){ /* no answer: the app is already gone, or the network is. Stay put. */ });
  }

  // A SHUT-DOWN TABLET MUST NOT JUST GO GREY. Losing the SSE stream is what a flat battery, a wifi
  // drop and a dead machine all look like, so say which one this is — and say how it comes back,
  // because after a deliberate shutdown nothing on this tablet can start it again.
  function stoppingView(){
    var down=stopping==='shutdown';
    app.innerHTML='<div class="pair">'+
      '<div class="brand">${WORDMARK_SVG}</div>'+
      '<h1>'+(down?'Shutting down':'Restarting')+'</h1>'+
      '<p>'+(down
        ? 'The show has been stopped and the app is closing. Start ArtLux on the machine to bring it back &mdash; it will not return on its own.'
        : 'The show is coming back in a fresh process. This page reconnects by itself when it does.')+'</p>'+
      (down?'':'<div class="hint">Usually a few seconds.</div>')+
      '<button class="btn" style="width:100%;margin-top:16px" data-act="pw-back">Back to the remote</button>'+
      '</div>';
  }

  // ---- scheme helpers: FORMATTING ONLY ---------------------------------------------------------
  // The client never decides WHEN anything fires. That is recurrence.ts, in the app, for both
  // scheduling layers — a scheme is evaluated once, in the app, and the two layers cannot disagree.
  // What is duplicated here is only how a scheme READS BACK on a row, so a drift here mislabels a
  // line and cannot mis-fire a show.
  function p2(n){ return n<10?('0'+n):(''+n); }
  function todayYMD(){ var d=new Date(); return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); }
  function nowHM(){ var d=new Date(); return p2(d.getHours())+':'+p2(d.getMinutes()); }
  function repeatOf(e){ if(e.repeat==='daily'||e.repeat==='weekly'||e.repeat==='once') return e.repeat; return (e.days&&e.days.length)?'weekly':'daily'; }
  function describeRepeat(e){
    var m=repeatOf(e);
    if(m==='once') return e.date?('Once on '+e.date):'Once (no date set)';
    if(m==='weekly'&&e.days&&e.days.length) return e.days.slice().sort(function(a,b){return a-b;}).map(function(i){return DFULL[i];}).join(' ');
    return 'Every day';
  }
  // A one-off whose moment has passed is inert. Saying so on the row is the difference between "why
  // is this not firing" and "of course, it already ran".
  function isSpent(e){ if(repeatOf(e)!=='once') return false; if(!e.date) return true; return (e.date+' '+(e.time||'00:00'))<=(todayYMD()+' '+nowHM()); }
  // Spent one-offs sink; everything else reads down the clock.
  function cmpEntries(a,b){ var sa=isSpent(a)?1:0, sb=isSpent(b)?1:0; if(sa!==sb) return sa-sb; return String(a.time||'').localeCompare(String(b.time||'')); }

  // ---- THE editor: one sheet for a scheduled project AND a scheduled action --------------------
  // Both layers are "a thing that happens at a time, on a scheme", so they get one form. Before
  // this, neither could be edited at all: changing a time meant deleting the entry and rebuilding it
  // from a default-time field parked at the bottom of the page.
  function openEditor(kind,draft,isNew){ editor={kind:kind,isNew:!!isNew,draft:draft}; render(); }
  function segBtn(v,label,cur){ return '<button type="button" data-act="ed-rep" data-rep="'+v+'" class="'+(cur===v?'on':'')+'">'+label+'</button>'; }

  function editorHtml(){
    var d=editor.draft, k=editor.kind, m=repeatOf(d);
    var h='<div class="sheet"><div class="body">';
    h+='<h2>'+(editor.isNew?'Schedule':'Edit')+' '+(k==='pl'?'a project':'an action')+'</h2>';
    h+='<div class="muted" style="margin-bottom:6px">'+(k==='pl'
        ? 'Loads this whole project on the show machine, unattended.'
        : 'Runs inside whichever project is loaded.')+'</div>';
    if(k==='pl') h+='<label>Project</label><select id="ed-proj">'+projectOptions(d.projectPath)+'</select>';
    else         h+='<label>Action</label><select id="ed-act">'+actionOptions(d.action)+'</select>';
    h+='<label>Repeat</label><div class="seg" id="ed-rep">'+segBtn('daily','Daily',m)+segBtn('weekly','Weekly',m)+segBtn('once','Once',m)+'</div>';
    if(m==='weekly') h+='<label>Days</label><div class="days" id="ed-days">'+dayChips(d.days)+'</div>';
    if(m==='once')   h+='<label>Date</label><input id="ed-date" type="date" value="'+esc(d.date||todayYMD())+'" />';
    h+='<label>Time</label><input id="ed-time" type="time" value="'+esc(d.time||'09:00')+'" />';
    h+='<label>Label (optional)</label><input id="ed-name" value="'+esc(d.name||'')+'" placeholder="'+esc(k==='pl'?baseName(d.projectPath||''):'')+'" />';
    h+='<div class="list-item" style="margin-top:12px"><div class="grow"><div class="name">Enabled</div>'+
       '<div class="meta">'+(d.enabled?'Will fire at the time above':'Saved, but inactive')+'</div></div>'+
       '<button class="sw '+(d.enabled?'on':'')+'" data-act="ed-enable"><i></i></button></div>';
    h+='<div class="foot"><button class="btn" data-act="ed-cancel">Cancel</button>'+
       (editor.isNew?'':'<button class="btn bad" data-act="ed-del">Delete</button>')+
       '<button class="btn pri" data-act="ed-save">Save</button></div>';
    return h+'</div></div>';
  }

  // Pull every field currently ON SCREEN back into the draft. Called before ANY re-render of the
  // sheet (switching Daily to Once re-renders it), or the time you just typed would be lost by the
  // very act of choosing a scheme for it.
  function readEditor(){
    if(!editor) return;
    var d=editor.draft, x;
    function v(id){ var el=document.getElementById(id); return el?el.value:undefined; }
    if((x=v('ed-time'))!==undefined) d.time=x;
    if((x=v('ed-name'))!==undefined) d.name=x;
    if((x=v('ed-date'))!==undefined) d.date=x;
    if((x=v('ed-proj'))!==undefined) d.projectPath=x;
    if((x=v('ed-act'))!==undefined) d.action=actionFromSelect(x);
    if(document.getElementById('ed-days')) d.days=readDays('ed-days');
  }

  function saveEditor(){
    readEditor();
    var d=editor.draft, k=editor.kind, m=repeatOf(d);
    if(m==='once'&&!d.date) d.date=todayYMD();
    // Keep the record honest: 'days' IS the scheme to anything that predates 'repeat', so a daily or
    // one-off entry must not carry leftover weekdays.
    if(m!=='weekly') d.days=[];
    if(m!=='once') delete d.date;
    if(k==='pl'){
      if(!d.projectPath) return;                      // nothing to load — refuse rather than save a dud
      var entries=playlist.entries.slice(), i=indexById(entries,d.id);
      if(i<0) entries.push(d); else entries[i]=d;
      editor=null;
      savePlaylist(Object.assign({},playlist,{entries:entries}));
    } else {
      var sc=((snapshot&&snapshot.schedule)||[]).slice(), j=indexById(sc,d.id);
      if(j<0) sc.push(d); else sc[j]=d;
      editor=null;
      commitSchedule(sc);
    }
  }
  function deleteEditor(){
    var d=editor.draft, k=editor.kind;
    editor=null;
    if(k==='pl') savePlaylist(Object.assign({},playlist,{entries:playlist.entries.filter(function(x){return x.id!==d.id;})}));
    else commitSchedule(((snapshot&&snapshot.schedule)||[]).filter(function(x){return x.id!==d.id;}));
  }
  function indexById(arr,id){ for(var i=0;i<arr.length;i++){ if(arr[i].id===id) return i; } return -1; }
  function findById(arr,id){ var i=indexById(arr||[],id); return i<0?null:arr[i]; }
  // An edit works on a COPY. Editing the live object would mutate the model behind the list, so
  // Cancel would cancel nothing.
  function cloneOf(e){ return JSON.parse(JSON.stringify(e)); }

  // ---- Schedule (in-project) --------------------------------------------------------------------
  // This round-trips through the app (host.show then ProjectData.schedule) and returns on the next
  // snapshot about a second later. Paint it locally at once, or Save looks ignored.
  function commitSchedule(sc){ if(snapshot) snapshot.schedule=sc; api('/schedule',{schedule:sc}); render(); }

  function renderSchedule(){
    var sched=((snapshot&&snapshot.schedule)||[]).slice().sort(cmpEntries);
    var h='<h3>Inside this project</h3>';
    h+='<div class="muted" style="margin-bottom:10px">Wall-clock actions saved with the project. They run in broadcast too.</div>';
    if(!sched.length) h+='<div class="muted">Nothing scheduled yet.</div>';
    for(var i=0;i<sched.length;i++){
      var e=sched[i], sp=isSpent(e);
      h+='<div class="list-item'+(sp?' spent':'')+'">'+
         '<button class="row-btn" data-act="sched-edit" data-id="'+esc(e.id)+'">'+
           '<span class="name">'+esc(e.time||'--:--')+' &middot; '+esc(actionLabel(e.action))+'</span>'+
           '<span class="meta">'+esc(describeRepeat(e))+(sp?' &middot; already ran':'')+'</span></button>'+
         '<button class="sw '+(e.enabled?'on':'')+'" data-act="sched-toggle" data-id="'+esc(e.id)+'"><i></i></button>'+
         '<button class="btn" data-act="sched-edit" data-id="'+esc(e.id)+'">Edit</button></div>';
    }
    h+='<button class="btn pri" style="width:100%;margin-top:14px" data-act="sched-new">Add an action</button>';
    shell(h);
  }
  function newSchedule(){ openEditor('sched',{id:'s'+Date.now(),enabled:true,time:'09:00',days:[],repeat:'daily',action:{kind:'transport',action:'stop'}},true); }
  function editSchedule(id){ var e=findById((snapshot&&snapshot.schedule)||[],id); if(e) openEditor('sched',cloneOf(e),false); }
  function toggleSchedule(id){ commitSchedule(((snapshot&&snapshot.schedule)||[]).map(function(e){ return e.id===id?Object.assign({},e,{enabled:!e.enabled}):e; })); }

  function actionLabel(a){
    if(!a) return '?';
    if(a.kind==='transport') return 'Transport '+a.action;
    var scenes=(snapshot&&snapshot.scenes)||[], banks=(snapshot&&snapshot.banks)||[], i, b, cs, c;
    if(a.kind==='recallScene'){ for(i=0;i<scenes.length;i++){ if(scenes[i].id===a.ref) return 'Recall '+scenes[i].name; } return 'Recall '+a.ref; }
    if(a.kind==='fireCue'){ for(b=0;b<banks.length;b++){ cs=banks[b].cues||[]; for(c=0;c<cs.length;c++){ if(cs[c].id===a.ref) return 'Fire '+cs[c].name; } } return 'Fire '+a.ref; }
    return a.kind;
  }
  function actionValue(a){
    if(!a) return 'stop';
    if(a.kind==='transport') return a.action;
    if(a.kind==='recallScene') return 'scene:'+a.ref;
    if(a.kind==='fireCue') return 'cue:'+a.ref;
    return 'stop';
  }
  function actionOptions(cur){
    var v=actionValue(cur), scenes=(snapshot&&snapshot.scenes)||[], banks=(snapshot&&snapshot.banks)||[], i, b, cs, c;
    function opt(val,lab){ return '<option value="'+esc(val)+'"'+(val===v?' selected':'')+'>'+esc(lab)+'</option>'; }
    var o=opt('play','Transport: Play')+opt('pause','Transport: Pause')+opt('stop','Transport: Stop');
    for(i=0;i<scenes.length;i++) o+=opt('scene:'+scenes[i].id,'Recall scene: '+scenes[i].name);
    for(b=0;b<banks.length;b++){ cs=banks[b].cues||[]; for(c=0;c<cs.length;c++) o+=opt('cue:'+cs[c].id,'Fire cue: '+cs[c].name); }
    return o;
  }
  function actionFromSelect(v){
    if(v==='play'||v==='pause'||v==='stop') return {kind:'transport',action:v};
    if(v.indexOf('scene:')===0) return {kind:'recallScene',ref:v.slice(6)};
    if(v.indexOf('cue:')===0) return {kind:'fireCue',ref:v.slice(4)};
    return {kind:'transport',action:'stop'};
  }

  // ---- Projects (the unattended playlist) -------------------------------------------------------
  function renderProjects(){
    var nowP=plStatus.currentPath, nextP=plStatus.nextPath;
    var h='<div class="card"><div class="list-item" style="margin:0;border:none;padding:0;background:none">'+
      '<div class="grow"><div class="name">Unattended switching</div>'+
      '<div class="meta">'+(playlist.enabled?'On &mdash; the machine loads whichever project is due':'Off &mdash; nothing below will fire')+'</div></div>'+
      '<button class="sw '+(playlist.enabled?'on':'')+'" data-act="pl-enable" data-on="'+(playlist.enabled?'0':'1')+'"><i></i></button></div>'+
      '<div class="hint" style="margin-top:8px">Now: <b>'+esc(nowP?baseName(nowP):'\u2014')+'</b>'+
      (nextP?('<br/>Next: <b>'+esc(baseName(nextP))+'</b> '+esc(plStatus.nextAt||'')):'')+'</div>'+
      '<div class="row" style="margin-top:10px"><button class="btn" data-act="pl-start">Start in broadcast now</button></div></div>';

    var entries=playlist.entries.slice().sort(cmpEntries);
    h+='<h3 style="margin-top:16px">Scheduled ('+entries.length+')</h3>';
    if(!entries.length) h+='<div class="muted">Nothing scheduled. Pick a project below and tap Schedule.</div>';
    for(var i=0;i<entries.length;i++){
      var e=entries[i], sp=isSpent(e), badge='';
      if(nowP&&samePath(e.projectPath,nowP)) badge=' <span class="badge now">NOW</span>';
      else if(nextP&&samePath(e.projectPath,nextP)) badge=' <span class="badge next">NEXT</span>';
      h+='<div class="list-item'+(sp?' spent':'')+'">'+
         '<button class="row-btn" data-act="pl-edit" data-id="'+esc(e.id)+'">'+
           '<span class="name">'+esc(e.time||'--:--')+' &middot; '+esc(e.name||baseName(e.projectPath))+badge+'</span>'+
           '<span class="meta">'+esc(describeRepeat(e))+(sp?' &middot; already ran':'')+'</span></button>'+
         '<button class="sw '+(e.enabled?'on':'')+'" data-act="pl-toggle" data-id="'+esc(e.id)+'"><i></i></button>'+
         '<button class="btn" data-act="pl-edit" data-id="'+esc(e.id)+'">Edit</button></div>';
    }

    h+='<h3 style="margin-top:16px">Projects on this machine</h3>';
    h+='<div class="card"><label>Folder &mdash; scanned including every subfolder</label>'+
       '<div class="row"><input id="pl-folder" style="flex:1;min-width:0" placeholder="D:\\\\Shows" value="'+esc(scan.root||playlist.folder||'')+'" />'+
       '<button class="btn" data-act="pl-scan">Scan</button></div>';
    if((scan.projects||[]).length>8) h+='<input id="pl-filter" placeholder="Filter by name&hellip;" value="'+esc(projFilter)+'" style="margin-top:8px" />';
    h+='<div id="pl-projects" style="margin-top:8px">'+projectRows()+'</div></div>';
    shell(h);
  }

  // Its own function because it is repainted ALONE on every keystroke of the filter — the
  // surrounding form, and the caret in the filter itself, have to survive typing.
  function projectRows(){
    var list=scan.projects||[], f=projFilter.toLowerCase(), h='', shown=0;
    for(var i=0;i<list.length;i++){
      var p=list[i];
      if(f && (p.name+' '+(p.rel||'')).toLowerCase().indexOf(f)<0) continue;
      shown++;
      h+='<div class="list-item"><div class="grow"><div class="name">'+esc(p.name)+'</div>'+
         '<div class="meta">'+(p.rel?esc(p.rel)+' &middot; ':'')+(p.isFolder?'portable folder':'file')+'</div></div>'+
         '<button class="btn" data-act="pl-add" data-path="'+esc(p.path)+'" data-name="'+esc(p.name)+'">Schedule</button>'+
         '<button class="btn" data-act="pl-load" data-path="'+esc(p.path)+'" data-name="'+esc(p.name)+'">Load</button></div>';
    }
    if(!list.length) return '<div class="muted">No projects yet. Type the folder your shows live in and tap Scan &mdash; subfolders are included.</div>';
    if(!shown) return '<div class="muted">No project matches that filter.</div>';
    // A silently-capped scan looks exactly like "that project is not there", which is the worst thing
    // a project picker can say.
    if(scan.truncated) h+='<div class="hint">Stopped after '+list.length+' projects &mdash; point at a narrower folder to see the rest.</div>';
    return h;
  }

  function projectOptions(cur){
    var list=scan.projects||[], o='', found=false, i, p, sel;
    for(i=0;i<list.length;i++){
      p=list[i]; sel=samePath(p.path,cur); if(sel) found=true;
      o+='<option value="'+esc(p.path)+'"'+(sel?' selected':'')+'>'+esc(p.rel?(p.rel+' / '+p.name):p.name)+'</option>';
    }
    // An entry can point at a project the current scan does not cover (another folder, a drive that
    // is offline). Keep it selectable, or editing the TIME of such an entry would silently repoint it
    // at whatever happens to be first in the list.
    if(cur&&!found) o='<option value="'+esc(cur)+'" selected>'+esc(baseName(cur))+' (not in the scanned folder)</option>'+o;
    if(!o) o='<option value="">(scan a folder first)</option>';
    return o;
  }

  function scanFolder(){
    var f=(document.getElementById('pl-folder')||{}).value||'';
    var box=document.getElementById('pl-projects');
    if(box) box.innerHTML='<div class="muted">Scanning '+esc(f)+' and its subfolders&hellip;</div>';
    api('/scan',{folder:f}).then(function(r){ return r.json(); }).then(function(j){
      if(j&&j.projects) scan=j;
      projFilter=''; render();
    }).catch(function(){ var b=document.getElementById('pl-projects'); if(b) b.innerHTML='<div class="muted">Could not scan that folder.</div>'; });
  }

  function newPlaylistEntry(path,name){ openEditor('pl',{id:'p'+Date.now(),enabled:true,projectPath:path,name:name||'',time:'09:00',days:[],repeat:'daily'},true); }
  function editPlaylistEntry(id){ var e=findById(playlist.entries,id); if(e) openEditor('pl',cloneOf(e),false); }
  function togglePl(id){ savePlaylist(Object.assign({},playlist,{entries:playlist.entries.map(function(e){ return e.id===id?Object.assign({},e,{enabled:!e.enabled}):e; })})); }
  function enablePl(on){ savePlaylist(Object.assign({},playlist,{enabled:on})); }
  function savePlaylist(p){ playlist=p; api('/playlist',{playlist:p}); render(); }
  // Loading RELAUNCHES the machine into broadcast on that project — it stops whatever is running in
  // front of an audience. Sitting next to a "Schedule" button on a touch screen, that is one mis-tap
  // away, so it asks. In the page, never the browser's own dialog: a native confirm is unthemed,
  // blocks the JS thread (the SSE stream with it) and, behind a fullscreen projector on the show
  // machine, can hang an operator mid-show. Same rule the app itself is held to.
  // { title, text, label, danger, run } — 'run' is a plain closure, so ONE sheet serves every
  // irreversible action on this page instead of each one growing its own dialog.
  var ask=null;
  function confirmThen(title,text,label,danger,run){ ask={title:title,text:text,label:label,danger:!!danger,run:run}; render(); }
  function loadNow(path,name){
    confirmThen('Load a different project?',
      'Load "'+(name||baseName(path))+'" now? The app restarts in broadcast mode and the show that is running stops.',
      'Load it', true, function(){ api('/playlist/load',{path:path}); });
  }
  function askHtml(){
    return '<div class="sheet"><div class="body">'+
      '<h2>'+esc(ask.title)+'</h2>'+
      '<div class="muted" style="margin:6px 0 4px">'+esc(ask.text)+'</div>'+
      '<div class="foot"><button class="btn" data-act="ask-no">Cancel</button>'+
      '<button class="btn '+(ask.danger?'bad':'pri')+'" data-act="ask-yes">'+esc(ask.label)+'</button></div></div></div>';
  }

  // An open sheet is appended AFTER shell() rewrites <main>, so every render keeps it on screen.
  function paintSheets(){
    if(editor) app.insertAdjacentHTML('beforeend', editorHtml());
    if(ask) app.insertAdjacentHTML('beforeend', askHtml());
  }

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
    // ⚠ THESE THRESHOLDS MUST NOT ASSUME A 60 Hz ENGINE. Both were absolute (fps<50, p99>25ms) and
    // both cried wolf the moment the engine gained a configurable rate: a perfectly healthy 30 Hz show
    // reads 30 fps with a ~33 ms p99, so an unattended venue's health tiles sat permanently amber —
    // which is worse than no indicator, because it teaches the operator to ignore the colour.
    // Judged against the show's OWN period instead: a p99 past two frame periods is real hitching at
    // any rate, and the rate itself is only alarming when the loop has actually stopped (fps 0, which
    // the watchdog owns). The long-frames tile below needed no change: already relative (p50×factor).
    h+=tile('Render FPS', r?fmt(r.fps):'&mdash;','fps',hist.rfps);
    h+=tile('Frame p99', r?fmt(r.frameP99):'&mdash;','ms',hist.fp99, r&&r.fps>0&&r.frameP99>2000/r.fps?'var(--warn)':'var(--fg)');
    h+=tile('Work p99', r?fmt(r.workP99):'&mdash;','ms',hist.wp99);
    h+=tile('Long frames', r?r.longFrames:'&mdash;','',null, r&&r.longFrames>3?'var(--bad)':'var(--fg)');
    h+='</div><h3>System</h3><div class="grid">';
    h+=tile('CPU', sy?fmt(sy.cpuPct):'&mdash;','%',hist.cpuPct, sy&&sy.cpuPct>85?'var(--warn)':'var(--fg)');
    h+=tile('RSS', sy?sy.rssMB:'&mdash;','MB');
    h+=tile('Heap', sy?sy.heapMB:'&mdash;','MB',hist.heapMB);
    h+=tile('Loop lag p99', sy?fmt(sy.eventLoopLagP99Ms):'&mdash;','ms',hist.lagP99, sy&&sy.eventLoopLagP99Ms>50?'var(--warn)':'var(--fg)');
    h+='</div>';
    // Unattended self-heal audit: why (and when) the show auto-restarted. Empty in a stable run.
    var wd=m&&m.watchdog;
    if(wd&&wd.length){
      h+='<h3>Watchdog</h3><div>';
      for(var wi=0;wi<Math.min(wd.length,12);wi++){ var ev=wd[wi];
        var col=(ev.action==='relaunch')?'var(--warn)':(ev.action==='tripped'?'var(--bad)':'var(--fg)');
        var when=new Date(ev.ts).toLocaleTimeString();
        h+='<div class="list-item" style="padding:8px 12px"><div class="grow"><div style="color:'+col+'">'+esc(ev.trigger)+' &middot; '+esc(ev.action)+'</div><div class="meta" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(ev.detail||'')+'</div></div><div class="meta" style="flex:none">'+esc(when)+'</div></div>';
      }
      h+='</div>';
    }
    h+='<div class="hint" style="margin-top:12px">'+(m?('mode '+esc(m.mode)+' &middot; v'+esc(m.version)):'Waiting for metrics&hellip;')+'</div>';
    shell(h);
  }
  function sparkSvg(a){ if(!a||a.length<2) return ''; var max=1; for(var i=0;i<a.length;i++){ if(a[i]>max) max=a[i]; }
    var n=a.length, pts=''; for(var j=0;j<n;j++){ var x=(j/(n-1))*100; var y=34-(a[j]/max)*32-1; pts+=x.toFixed(1)+','+y.toFixed(1)+' '; }
    return '<svg class="spark" viewBox="0 0 100 34" preserveAspectRatio="none"><polyline fill="none" stroke="var(--accent)" stroke-width="1.5" points="'+pts+'"/></svg>'; }
  function fmt(x){ x=Number(x)||0; return (Math.round(x*10)/10).toString(); }

  // ---- shared helpers ----
  function baseName(p){ if(!p) return ''; p=String(p).replace(/[\\\\/]+$/,''); var i=Math.max(p.lastIndexOf('/'),p.lastIndexOf('\\\\')); return i>=0?p.slice(i+1):p; }
  // Windows hands us both separators and a stray trailing one, so a raw string compare silently
  // failed and the NOW / NEXT badges never appeared. Same normalisation as scheduler.ts's 'norm'.
  function normPath(p){ return String(p||'').replace(/\\\\/g,'/').toLowerCase().replace(/\\/+$/,''); }
  function samePath(a,b){ return !!a && !!b && normPath(a)===normPath(b); }
  var DNAMES=['S','M','T','W','T','F','S'];
  var DFULL=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  // Pre-selected from the entry being edited. It used to take no argument, which is another way of
  // saying the chips could only ever describe a NEW entry — you could not see, let alone change,
  // the days an existing one already had.
  function dayChips(sel){
    sel=sel||[]; var o='';
    for(var i=0;i<7;i++){ o+='<button type="button" data-day="'+i+'" class="'+(sel.indexOf(i)>=0?'on':'')+'">'+DNAMES[i]+'</button>'; }
    return o;
  }
  function readDays(id){ var el=document.getElementById(id); if(!el) return []; var out=[]; var b=el.querySelectorAll('button'); for(var i=0;i<b.length;i++){ if(b[i].classList.contains('on')) out.push(parseInt(b[i].getAttribute('data-day'),10)); } return out; }

  // ---- render dispatch ----
  function render(){
    if(!token){ pairView(); return; }
    // Outranks every tab: the app is on its way out, and a transport screen wired to a server that
    // is closing is not something to offer.
    if(stopping){ stoppingView(); return; }
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
    if(t.hasAttribute('data-day')){
      t.classList.toggle('on');
      if(editor) editor.draft.days=readDays('ed-days'); // the chips ARE the model while a sheet is open
      return;
    }
    var a=t.getAttribute('data-act');
    if(a==='pair') doPair();
    else if(a==='tab'){ tab=t.getAttribute('data-tab'); render(); }
    else if(a==='tp') cmd({kind:'transport',action:t.getAttribute('data-a')});
    else if(a==='scene') cmd({kind:'recallScene',ref:t.getAttribute('data-ref')});
    else if(a==='cue') cmd({kind:'fireCue',ref:t.getAttribute('data-ref')});
    else if(a==='fsm') cmd({kind:'setFsmEnabled',on:t.getAttribute('data-on')==='1'});
    else if(a==='trans') cmd({kind:'triggerTransition',id:t.getAttribute('data-id')});
    else if(a==='enter') cmd({kind:'enterState',id:t.getAttribute('data-id')});
    else if(a==='sched-new') newSchedule();
    else if(a==='sched-edit') editSchedule(t.getAttribute('data-id'));
    else if(a==='sched-toggle') toggleSchedule(t.getAttribute('data-id'));
    else if(a==='pl-enable') enablePl(t.getAttribute('data-on')==='1');
    else if(a==='pl-scan') scanFolder();
    else if(a==='pl-add') newPlaylistEntry(t.getAttribute('data-path'),t.getAttribute('data-name'));
    else if(a==='pl-edit') editPlaylistEntry(t.getAttribute('data-id'));
    else if(a==='pl-load') loadNow(t.getAttribute('data-path'),t.getAttribute('data-name'));
    else if(a==='pl-start') api('/playlist/start',{});
    else if(a==='pl-toggle') togglePl(t.getAttribute('data-id'));
    // ── the editor sheet ──
    // Every one of these re-reads the form FIRST: the sheet re-renders when the scheme changes, and
    // an unread field is a field the operator has to type twice.
    else if(a==='ed-rep'){ readEditor(); editor.draft.repeat=t.getAttribute('data-rep'); render(); }
    else if(a==='ed-enable'){ readEditor(); editor.draft.enabled=!editor.draft.enabled; render(); }
    else if(a==='ed-save') saveEditor();
    else if(a==='ed-del') deleteEditor();
    else if(a==='ed-cancel'){ editor=null; render(); }
    else if(a==='pw-restart') askRestart();
    else if(a==='pw-shutdown') askShutdown();
    else if(a==='pw-back'){ stopping=null; render(); }
    else if(a==='ask-no'){ ask=null; render(); }
    else if(a==='ask-yes'){ var q=ask; ask=null; render(); try{ q.run(); }catch(e){ console.error(e); } }
  });

  // The project filter repaints ONLY the list it filters, so the caret stays where it is.
  document.addEventListener('input', function(ev){
    var t=ev.target;
    if(!t||t.id!=='pl-filter') return;
    projFilter=t.value||'';
    var box=document.getElementById('pl-projects');
    if(box) box.innerHTML=projectRows();
  });

  render();
  if(token) connect();
  else { var qp=queryPin(); if(qp) doPair(qp); } // one-scan onboarding: auto-pair from the QR's ?pin=
})();
</script>
</body>
</html>`;
