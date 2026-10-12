/* app.js — Field Visit Atlas UI. Depends on: Leaflet (+markercluster, heat), topojson-client, Chart.js, SheetJS,
   and the local modules Geo, Ingest, Store, Analytics. Geographic data arrives as window.GEO_META / GEO_TOPO / GEO_TOWNS / GEO_GAZ. */
(function () {
  'use strict';
  const A = window.Analytics, I = window.Ingest;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => (n === null || n === undefined || isNaN(n)) ? '–' : Number(n).toLocaleString('en-IN');
  const fmt1 = n => (n === null || n === undefined || isNaN(n)) ? '–' : (Math.round(n * 10) / 10).toLocaleString('en-IN');
  const pct = n => (n === null || n === undefined || isNaN(n)) ? '–' : Math.round(n * 100) + '%';
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const localISO = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const PREC_LABEL = { gps: 'GPS from file', manual: 'Corrected by user', village: 'Village', town: 'Town', taluka: 'Taluka centre (approx.)', district: 'District centre (approx.)', none: 'Not resolved' };
  const CLASS_ORDER = ['farmer', 'dealer', 'trial', 'event', 'other', 'halt'];

  const S = {
    records: [], batches: [], fixes: {}, plan: [], keys: new Set(), cur: [], curAll: [],
    F: { period: '7', from: '', to: '', users: [], managers: [], st: null, did: null, sid: null, village: null, classes: [], vt: '', customerOnly: true, q: '' },
    view: 'dashboard', mode: 'points', colorBy: 'activity', areaLevel: 'auto', basemap: 'none',
    sort: { visits: { k: 'd', dir: -1 }, staff: { k: 'visits', dir: -1 } }, page: 0, selected: null, charts: {}, layers: {}, up: { step: 1 }, staffSel: null
  };
  window.FVA = S; // handy for debugging in the console

  function toast(msg, ms) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), ms || 3500);
  }

  // ---------- downloads (claude.ai capability, else a normal browser download) ----------
  async function saveFile(name, blob) {
    try {
      if (window.claude && typeof window.claude.use === 'function') {
        const dl = await Promise.race([window.claude.use('downloads'), new Promise(r => setTimeout(() => r(null), 3000))]);
        if (dl) { await dl.save({ filename: name, data: blob }); toast('Saved ' + name); return; }
      }
    } catch (e) { if (e && e.code === 'declined') return; if (e && e.code && e.code !== 'unavailable' && e.code !== 'not_granted') { toast('Download failed: ' + (e.message || e.code)); return; } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function xlsxBlob(sheets) {
    const wb = XLSX.utils.book_new();
    for (const s of sheets) {
      const ws = s.aoa ? XLSX.utils.aoa_to_sheet(s.aoa) : XLSX.utils.json_to_sheet(s.rows.length ? s.rows : [{ Note: 'No rows for the current filters' }]);
      const keys = s.aoa ? (s.aoa[0] || []) : Object.keys(s.rows[0] || { Note: '' });
      ws['!cols'] = keys.map(k => ({ wch: Math.min(40, Math.max(10, String(k).length + 2)) }));
      XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
    }
    return new Blob([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  const stamp = () => S.F.from === S.F.to ? S.F.to : S.F.from + '_to_' + S.F.to;

  // ---------- boot ----------
  async function gunzipJSON(b64) {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  async function boot() {
    S.today = localISO(new Date());
    if (!window.GEO_TOPO && window.GEO_TOPO_GZ) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser is too old to unpack the map data. Use a current Chrome, Edge, Firefox or Safari.');
      window.GEO_TOPO = await gunzipJSON(window.GEO_TOPO_GZ);
    }
    S.geo = new Geo.GeoIndex();
    S.geo.init(window.GEO_META, window.GEO_TOPO, window.GEO_TOWNS, window.GEO_GAZ || {});
    S.bundledStates = [];
    for (const [st, b64] of Object.entries(window.GEO_GAZ_GZ || {})) { S.geo.addGazetteer(await gunzipJSON(b64)); S.geo.loadedStates.add(+st); S.bundledStates.push(+st); }
    S.geo.gazLoader = async st => { const r = await fetch('data/gazetteer/' + st + '.json'); if (!r.ok) throw new Error('no file'); return r.json(); };
    const T = window.GEO_TOPO;
    S.feat = { states: topojson.feature(T, T.objects.states), districts: topojson.feature(T, T.objects.districts), subs: topojson.feature(T, T.objects.subdistricts) };
    S.store = await connectStore();
    await loadAll();
    setStoreChip();
    $('#loading').remove();
    $('#v-dashboard').classList.add('on');
    initFilterBar(); initMap(); initCharts(); bindStatic();
    if (S.records.length) setPeriod('7'); else { setPeriod('all'); }
    showView(S.records.length ? 'dashboard' : 'upload');
    S.unsub = S.store.onChange(async () => { if (Date.now() - (S.selfWrite || 0) < 15000) return; await loadAll(); populateFilters(); refresh(); toast('Another person changed the uploads — data refreshed.'); });
  }

  // storage: shows the access-key screen when the shared Google Drive database needs it
  function askKey(err) {
    return new Promise(resolve => {
      const box = $('#loading');
      box.className = '';
      box.innerHTML = `<div class="panel" style="max-width:480px;margin:56px auto"><div class="body">
        <h2 style="margin:0 0 6px;font-size:18px">Team access key</h2>
        <p class="muted" style="margin-top:0">Uploads on this dashboard are shared with your team. Enter the access key you were given. It is remembered in this browser.</p>
        ${err ? `<div class="note" style="margin-bottom:10px">${esc(err.code === 'auth' ? 'That key is not right. Check it and try again.' : err.message)}</div>` : ''}
        <form id="keyForm" style="display:flex;gap:8px"><input type="password" id="keyIn" autocomplete="current-password" placeholder="Access key" style="flex:1;height:34px;border:1px solid var(--line);border-radius:6px;padding:0 10px;background:var(--surface)" required>
        <button class="btn primary" type="submit">Open</button></form></div></div>`;
      $('#keyIn').focus();
      $('#keyForm').addEventListener('submit', e => { e.preventDefault(); const k = $('#keyIn').value.trim(); if (k) resolve(k); });
    });
  }
  function showStoreError(err) {
    return new Promise(resolve => {
      const box = $('#loading'); box.className = '';
      box.innerHTML = `<div class="panel" style="max-width:520px;margin:56px auto"><div class="body"><h2 style="margin:0 0 6px;font-size:18px">Shared database not reachable</h2>
        <p>${esc(err.message)}</p><button class="btn primary" id="retryBtn">Try again</button></div></div>`;
      $('#retryBtn').onclick = () => resolve();
    });
  }
  async function connectStore() {
    let res = await Store.openStore();
    while (!res.store) {
      if (res.needsKey) { const key = await askKey(res.error); $('#loading').textContent = 'Opening the shared database…'; res = await Store.openStore({ key }); }
      else { await showStoreError(res.error); $('#loading').textContent = 'Opening the shared database…'; res = await Store.openStore(); }
    }
    $('#loading').className = 'loading'; $('#loading').textContent = 'Loading data…';
    return res.store;
  }

  async function loadAll() {
    S.batches = await S.store.listBatches();
    const chunks = await S.store.loadRecords();
    S.fixes = (await S.store.getKV('geoFixes')) || {};
    S.plan = (await S.store.getKV('territoryPlan')) || [];
    const valid = new Set(S.batches.map(b => b.id));
    const seen = new Set(), recs = [];
    for (const c of chunks) {
      if (!valid.has(c.b)) continue; // half-written or deleted batch
      const f = c.f || I.FIELDS;
      for (const row of c.rows) {
        const r = {}; f.forEach((k, i) => { r[k] = row[i]; }); I.enrich(r);
        if (seen.has(r.k)) continue; seen.add(r.k); recs.push(r);
      }
    }
    S.records = recs; S.keys = seen;
    await resolveAll();
    S.minDate = recs.reduce((a, r) => (!a || (r.d && r.d < a)) ? r.d : a, '');
    S.maxDate = recs.reduce((a, r) => r.d > a ? r.d : a, '');
    $('#dataThrough').textContent = S.maxDate ? 'Data through ' + A.fmtDate(S.maxDate) : 'No data yet';
  }
  async function ensureStatesFor(recs) {
    const sts = new Set();
    for (const r of recs) { const st = S.geo.matchState(r.st); if (st) sts.add(st.id); else if (r.di) { const d = S.geo.matchDistrict(r.di, null); if (d) sts.add(d.d.st); } }
    await Promise.all([...sts].map(s => S.geo.ensureState(s)));
  }
  function resolveOne(r) {
    const q = { state: r.st, district: r.di, taluka: r.ta, village: r.vi };
    const hasGps = r.lat !== '' && r.lon !== '' && r.lat !== undefined && +r.lat >= 6 && +r.lat <= 37.5 && +r.lon >= 68 && +r.lon <= 97.5;
    const g = Object.assign({}, S.geo.resolve(q, S.fixes));
    if (hasGps) { g.lat = +r.lat; g.lon = +r.lon; g.prec = 'gps'; g.note = 'Coordinates from file'; }
    return g;
  }
  async function resolveAll() { await ensureStatesFor(S.records); S.geo.cache.clear(); for (const r of S.records) r.g = resolveOne(r); }

  function setStoreChip() {
    const c = $('#storeChip'); const m = S.store.mode;
    c.classList.toggle('warn', m === 'memory');
    c.querySelector('span').textContent = m === 'shared' ? 'Shared database' : m === 'drive' ? 'Shared (Google Drive)' : m === 'browser' ? 'Saved in this browser' : 'Not saved (memory only)';
    c.title = m === 'shared' ? 'Uploads are stored with this artifact and visible to everyone it is shared with.' : m === 'drive' ? 'Uploads are stored in the team Google Drive and visible to everyone with the access key.' : m === 'browser' ? 'Uploads are stored in this browser only (IndexedDB). Other people do not see them.' : 'Storage is unavailable; data disappears when the page closes.';
  }

  // ---------- filters ----------
  function setPeriod(p) {
    S.F.period = p;
    $$('#periodSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.p === p ? 'true' : 'false'));
    $('#customDates').classList.toggle('hidden', p !== 'custom');
    const max = S.maxDate || S.today, min = S.minDate || max;
    if (p === 'day') { S.F.from = max; S.F.to = max; }
    else if (p === '7') { S.F.from = A.addDays(max, -6); S.F.to = max; }
    else if (p === 'month') { S.F.from = max.slice(0, 8) + '01'; S.F.to = max; }
    else if (p === 'all') { S.F.from = min; S.F.to = max; }
    else { S.F.from = $('#fFrom').value || min; S.F.to = $('#fTo').value || max; }
    $('#fFrom').value = S.F.from; $('#fTo').value = S.F.to;
    refresh();
  }
  function opt(v, label, sel) { return `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`; }
  function populateFilters() {
    const recs = S.records;
    const users = [...A.countBy(recs, r => r.u)].sort((a, b) => a[0].localeCompare(b[0]));
    $('#fUser').innerHTML = opt('', 'All staff (' + users.length + ')') + users.map(([u, n]) => opt(u, u, S.F.users[0] === u)).join('');
    const mgrs = [...A.uniq(recs, r => r.m)].sort();
    $('#fMgr').innerHTML = opt('', 'All managers') + mgrs.map(m => opt(m, m, S.F.managers[0] === m)).join('');
    const sts = [...A.countBy(recs, r => r.g && r.g.st)].map(([id, n]) => [id, S.geo.states[id] ? S.geo.states[id].name : '?', n]).sort((a, b) => a[1].localeCompare(b[1]));
    $('#fState').innerHTML = opt('', 'All India') + sts.map(([id, name, n]) => opt(id, `${name} (${n})`, S.F.st === id)).join('');
    const dists = [...A.countBy(recs.filter(r => !S.F.st || (r.g && r.g.st === S.F.st)), r => r.g && r.g.did)].map(([id, n]) => [id, S.geo.districts[id] ? S.geo.districts[id].name : '?', n]).sort((a, b) => a[1].localeCompare(b[1]));
    $('#fDist').innerHTML = opt('', S.F.st ? 'All districts' : 'All districts (' + dists.length + ')') + dists.map(([id, name, n]) => opt(id, `${name} (${n})`, S.F.did === id)).join('');
    if (S.F.did) {
      const cnt = A.countBy(recs.filter(r => r.g && r.g.did === S.F.did), r => r.g.sid);
      const subs = (S.geo.subByDist[S.F.did] || []).slice().sort((a, b) => a.name.localeCompare(b.name));
      $('#fSub').innerHTML = opt('', 'All talukas') + subs.map(s => opt(s.id, `${s.name} (${cnt.get(s.id) || 0})`, S.F.sid === s.id)).join('');
      $('#fSub').disabled = false;
    } else { $('#fSub').innerHTML = opt('', 'Choose a district first'); $('#fSub').disabled = true; }
    $('#fAct').innerHTML = opt('', 'All activities') + CLASS_ORDER.map(c => opt(c, I.ACTIVITY_CLASSES[c].label, S.F.classes[0] === c)).join('');
  }
  function initFilterBar() {
    populateFilters();
    $$('#periodSeg button').forEach(b => b.addEventListener('click', () => setPeriod(b.dataset.p)));
    $('#fFrom').addEventListener('change', () => setPeriod('custom'));
    $('#fTo').addEventListener('change', () => setPeriod('custom'));
    $('#fUser').addEventListener('change', e => { S.F.users = e.target.value ? [e.target.value] : []; refresh(); });
    $('#fMgr').addEventListener('change', e => { S.F.managers = e.target.value ? [e.target.value] : []; refresh(); });
    $('#fState').addEventListener('change', e => selectGeo(e.target.value ? +e.target.value : null, null, null));
    $('#fDist').addEventListener('change', e => { const d = e.target.value ? +e.target.value : null; selectGeo(d ? S.geo.districts[d].st : S.F.st, d, null); });
    $('#fSub').addEventListener('change', e => selectGeo(S.F.st, S.F.did, e.target.value === '' ? null : +e.target.value));
    $('#fAct').addEventListener('change', e => { S.F.classes = e.target.value ? [e.target.value] : []; if (e.target.value && !I.ACTIVITY_CLASSES[e.target.value].customer) { S.F.customerOnly = false; $('#fCust').checked = false; } refresh(); });
    $('#fVt').addEventListener('change', e => { S.F.vt = e.target.value; refresh(); });
    let qt; $('#fQ').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { S.F.q = e.target.value.trim(); refresh(); }, 250); });
    $('#fCust').addEventListener('change', e => { S.F.customerOnly = e.target.checked; refresh(); });
    $('#filterToggle').addEventListener('click', () => { const o = $('#filterbar').classList.toggle('open'); $('#filterToggle').setAttribute('aria-expanded', o); });
    $('#fReset').addEventListener('click', () => {
      Object.assign(S.F, { users: [], managers: [], st: null, did: null, sid: null, village: null, classes: [], vt: '', customerOnly: true, q: '' });
      $('#fQ').value = ''; $('#fVt').value = ''; $('#fCust').checked = true; populateFilters(); setPeriod('7'); fitSelection();
    });
  }
  function selectGeo(st, did, sid, opts) {
    S.F.st = st || null; S.F.did = did || null; S.F.sid = (sid === null || sid === undefined || sid === '') ? null : sid; S.F.village = null;
    S.selected = null; populateFilters(); refresh(); if (!(opts && opts.noFit)) fitSelection();
  }

  function refresh() {
    if (!S.geo) return;
    S.cur = A.applyFilters(S.records, S.F);
    S.curAll = A.applyFilters(S.records, Object.assign({}, S.F, { customerOnly: false }));
    updateQualityBadge();
    const nAct = [S.F.users.length, S.F.managers.length, S.F.st, S.F.did, S.F.sid !== null, S.F.classes.length, S.F.vt, S.F.q, !S.F.customerOnly].filter(Boolean).length;
    $('#filterToggle').textContent = 'Filters' + (nAct ? ' (' + nAct + ' active)' : '') + ', ' + (S.F.from === S.F.to ? A.fmtDate(S.F.to) : A.fmtDate(S.F.from).replace(/ \d{4}$/, '') + ' – ' + A.fmtDate(S.F.to));
    if (S.view === 'dashboard') renderDashboard();
    else if (S.view === 'staff') renderStaff();
    else if (S.view === 'coverage') renderCoverage();
    else if (S.view === 'quality') renderQuality();
    else if (S.view === 'reports') renderReports();
    else if (S.view === 'settings') renderSettings();
  }

  function showView(v) {
    S.view = v;
    $$('#tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.view === v ? 'page' : 'false'));
    $$('section.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
    $('#filterbar').classList.toggle('hidden', v === 'upload' || v === 'settings');
    if (v === 'upload') renderUpload();
    else refresh();
    if (v === 'dashboard' && S.map) setTimeout(() => S.map.invalidateSize(), 50);
    window.scrollTo(0, 0);
  }

  // ---------- dashboard ----------
  function prevPeriod() {
    if (!S.F.from || !S.F.to) return null;
    const n = A.daysBetween(S.F.from, S.F.to);
    const F2 = Object.assign({}, S.F, { from: A.addDays(S.F.from, -n), to: A.addDays(S.F.from, -1) });
    if (S.minDate && F2.to < S.minDate) return { days: n, visits: 0 };
    const recs = A.applyFilters(S.records, F2);
    return { days: n, visits: recs.filter(r => r.cust).length, staff: A.uniq(recs, r => r.u).size };
  }
  function renderDashboard() {
    const k = A.kpis(S.cur); S.k = k;
    const prev = prevPeriod();
    let delta = '';
    if (prev && prev.visits) { const ch = (k.visits - prev.visits) / prev.visits; delta = `<div class="s ${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '+' : '−'}${Math.abs(Math.round(ch * 100))}% vs previous ${prev.days} days</div>`; }
    else { const sh = d => A.fmtDate(d).replace(/ \d{4}$/, ''); delta = `<div class="s">${S.F.from === S.F.to ? A.fmtDate(S.F.to) : sh(S.F.from) + ' – ' + sh(S.F.to)}</div>`; }
    const cells = [
      [fmt(k.visits), S.F.customerOnly ? 'Customer visits' : 'Entries (all activities)', delta],
      [fmt(k.customers), 'Customers reached', `<div class="s">${fmt(k.repeatCustomers)} repeat</div>`],
      [fmt(k.staff), 'Staff active', `<div class="s">${fmt1(k.perStaffDay)} per staff-day</div>`],
      [fmt(k.states), 'States', '<div class="s">&nbsp;</div>'],
      [fmt(k.districts), 'Districts', '<div class="s">&nbsp;</div>'],
      [fmt(k.talukas), 'Talukas', '<div class="s">&nbsp;</div>'],
      [fmt(k.villages), 'Villages and towns', `<div class="s">${fmt(k.newCustomers)} new customers</div>`],
      [pct(k.precisePct), 'Mapped to a village', `<div class="s">${fmt(k.jointEntries)} joint entries</div>`]
    ];
    $('#ledger').innerHTML = cells.map(c => `<div class="kpi"><div class="v">${c[0]}</div><div class="l">${c[1]}</div>${c[2]}</div>`).join('');
    $('#insights').innerHTML = A.insights({ recs: S.cur, all: S.records, F: S.F, geo: S.geo, maxDate: S.maxDate, today: S.today, k, prev }).map(s => `<li>${esc(s)}</li>`).join('');
    renderMap(); renderCrumbs(); renderDetail(); renderCharts(); renderVisitTable();
  }

  // ---------- map ----------
  function initMap() {
    S.map = L.map('map', { preferCanvas: true, zoomSnap: 0.25, minZoom: 3.5, maxZoom: 17, worldCopyJump: false });
    S.map.attributionControl.setPrefix(false);
    S.map.attributionControl.addAttribution('Boundaries: LGD/Bharatmaps (Govt. of India) via DataMeet and ramSeraph; villages: Census 2011; towns: SBM, © GeoNames (CC BY 4.0)');
    S.map.createPane('areas').style.zIndex = 350;
    S.renderer = L.canvas({ padding: 0.4, pane: 'areas' });
    const tip = (layer, fn) => layer.bindTooltip(fn, { sticky: true, direction: 'top', opacity: 1 });
    S.layers.states = L.geoJSON(S.feat.states, {
      renderer: S.renderer, pane: 'areas', style: () => ({}),
      onEachFeature: (f, l) => { tip(l, () => areaTip('st', f.properties.s)); l.on('click', () => { if (S.F.st !== f.properties.s) selectGeo(f.properties.s, null, null); }); }
    }).addTo(S.map);
    S.layers.districts = L.geoJSON(S.feat.districts, {
      renderer: S.renderer, pane: 'areas', style: () => ({}),
      onEachFeature: (f, l) => { tip(l, () => areaTip('did', f.properties.d)); l.on('click', () => { const p = f.properties; if (S.F.st !== p.s) selectGeo(p.s, null, null); else if (S.F.did !== p.d) selectGeo(p.s, p.d, null); }); }
    }).addTo(S.map);
    S.layers.subs = L.geoJSON(null, {
      renderer: S.renderer, pane: 'areas', style: () => ({}),
      onEachFeature: (f, l) => { tip(l, () => areaTip('sid', f.properties.id)); l.on('click', () => { const p = f.properties; if (S.F.did !== p.d) selectGeo(p.s, p.d, null); else if (S.F.sid !== p.id) selectGeo(p.s, p.d, p.id); }); }
    }).addTo(S.map);
    S.subState = null;
    S.layers.cluster = L.markerClusterGroup({
      chunkedLoading: true, showCoverageOnHover: false, maxClusterRadius: 40, spiderfyOnMaxZoom: true, disableClusteringAtZoom: 15,
      iconCreateFunction: c => { const n = c.getChildCount(); const s = n < 10 ? 26 : n < 100 ? 32 : n < 1000 ? 40 : 48; return L.divIcon({ html: `<div class="clu" style="width:${s}px;height:${s}px">${n}</div>`, className: '', iconSize: [s, s] }); }
    });
    S.layers.heat = L.heatLayer([], { radius: 20, blur: 18, maxZoom: 11, minOpacity: 0.3, gradient: { 0.25: '#fde68a', 0.5: '#f59e0b', 0.75: '#dc2626', 1: '#7f1d1d' } });
    S.tiles = {
      osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }),
      sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' })
    };
    Object.values(S.tiles).forEach(t => t.on('tileerror', () => { if (!S.tileWarned) { S.tileWarned = true; mapNote('Base map tiles could not load here (blocked or offline). Official boundaries are still shown.'); } }));
    S.map.fitBounds([[6.5, 68.1], [37.1, 97.4]]);
    $$('#modeSeg button').forEach(b => b.addEventListener('click', () => { S.mode = b.dataset.m; renderMap(); }));
    $('#colorBy').addEventListener('change', e => { S.colorBy = e.target.value; renderMap(); });
    $('#areaLevel').addEventListener('change', e => { S.areaLevel = e.target.value; renderMap(); });
    $('#basemap').addEventListener('change', e => setBasemap(e.target.value));
    $('#fitBtn').addEventListener('click', fitSelection);
    $('#fullBtn').addEventListener('click', () => { const w = $('#mapwrap'); w.classList.toggle('full'); $('#fullBtn').textContent = w.classList.contains('full') ? 'Exit full screen' : 'Full screen'; setTimeout(() => S.map.invalidateSize(), 60); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#mapwrap').classList.contains('full')) $('#fullBtn').click(); });
  }
  function mapNote(msg) { const n = document.createElement('div'); n.className = 'maptoast'; n.textContent = msg; $('#mapwrap').appendChild(n); setTimeout(() => n.remove(), 7000); }
  function setBasemap(v) {
    S.basemap = v; Object.values(S.tiles).forEach(t => S.map.removeLayer(t)); S.tileWarned = false;
    if (S.tiles[v]) S.tiles[v].addTo(S.map).bringToBack();
    if (v === 'osm') mapNote('OpenStreetMap draws some international borders differently from the official Survey of India depiction. The overlay keeps the official boundaries.');
    renderMap();
  }
  function areaTip(level, id) {
    const recs = S.cur.filter(r => r.g && r.g[level] === id);
    const name = level === 'st' ? (S.geo.states[id] || {}).name : level === 'did' ? (S.geo.districts[id] || {}).name : (S.geo.subs[id] || {}).name;
    const v = recs.filter(r => r.cust).length;
    return `<b>${esc(name)}</b><br>${fmt(v)} customer visit${v === 1 ? '' : 's'}${recs.length ? `, ${A.uniq(recs, r => r.u).size} staff` : ''}`;
  }
  function binColor(n) {
    if (!n) return null;
    const i = n === 1 ? 1 : n <= 3 ? 2 : n <= 7 ? 3 : n <= 15 ? 4 : 5;
    return css('--ch' + i);
  }
  const BINS = [['1', 1], ['2–3', 2], ['4–7', 3], ['8–15', 4], ['16+', 5]];
  function areaLevelNow() { if (S.areaLevel !== 'auto') return S.areaLevel; return S.F.did ? 'taluka' : 'district'; }
  function ensureSubsLayer(st) {
    const want = st || null;
    if (S.subState === want) return;
    S.layers.subs.clearLayers(); S.subState = want;
    if (want === null) return;
    const feats = want === 'all' ? S.feat.subs.features : S.feat.subs.features.filter(f => f.properties.s === want);
    S.layers.subs.addData({ type: 'FeatureCollection', features: feats });
  }
  function renderMap() {
    if (!S.map) return;
    $$('#modeSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.m === S.mode ? 'true' : 'false'));
    $('#colorBy').classList.toggle('hidden', S.mode !== 'points');
    $('#areaLevel').classList.toggle('hidden', S.mode !== 'areas');
    const tiles = S.basemap !== 'none';
    const land = css('--land'), lineC = css('--land-line'), stateC = css('--state-line'), sel = css('--sel'), bad = css('--bad'), badSoft = css('--bad-soft');
    const cust = S.cur.filter(r => r.cust);
    const areas = S.mode === 'areas', lvl = areaLevelNow();
    const cDist = A.countBy(cust, r => r.g && r.g.did), cSub = A.countBy(cust, r => r.g && r.g.sid !== null ? r.g.sid : null);
    const activeDist = new Set(A.uniq(S.curAll, r => r.g && r.g.did)), activeState = new Set(A.uniq(S.curAll, r => r.g && r.g.st));
    // talukas: draw for the selected state, or all India when the taluka choropleth is on
    ensureSubsLayer(areas && lvl === 'taluka' && !S.F.st ? 'all' : S.F.st);
    S.layers.states.setStyle(f => {
      const s = f.properties.s, on = !S.F.st || S.F.st === s;
      return { color: stateC, weight: S.F.st === s ? 2 : 1.1, fill: !tiles, fillColor: land, fillOpacity: tiles ? 0 : (on ? 1 : 0.55), opacity: 1 };
    });
    S.layers.districts.setStyle(f => {
      const d = f.properties.d, s = f.properties.s, isSel = S.F.did === d, inState = !S.F.st || S.F.st === s;
      let fillColor = land, fillOpacity = 0;
      if (areas && lvl === 'district') {
        const n = cDist.get(d) || 0;
        if (n) { fillColor = binColor(n); fillOpacity = inState ? 0.9 : 0.35; }
        else if (activeState.has(s) && inState) { fillColor = badSoft; fillOpacity = 0.85; }
      }
      return { color: isSel ? sel : lineC, weight: isSel ? 2.6 : 0.6, opacity: inState ? 0.9 : 0.35, fill: true, fillColor, fillOpacity };
    });
    S.layers.districts.eachLayer(l => { if (l.feature.properties.d === S.F.did) l.bringToFront(); });
    S.layers.subs.setStyle(f => {
      const id = f.properties.id, d = f.properties.d, isSel = S.F.sid === id, inDist = !S.F.did || S.F.did === d;
      let fillColor = land, fillOpacity = 0;
      if (areas && lvl === 'taluka') {
        const n = cSub.get(id) || 0;
        if (n) { fillColor = binColor(n); fillOpacity = inDist ? 0.9 : 0.3; }
        else if (activeDist.has(d) && inDist) { fillColor = badSoft; fillOpacity = 0.85; }
      }
      return { color: isSel ? sel : (areas && lvl === 'taluka' && activeDist.has(d) && !(cSub.get(id)) ? bad : lineC), weight: isSel ? 2.4 : 0.45, opacity: inDist ? 0.8 : 0.3, dashArray: null, fill: true, fillColor, fillOpacity };
    });
    if (S.F.did) S.layers.districts.eachLayer(l => { if (l.feature.properties.d === S.F.did) l.bringToFront(); });
    S.layers.subs.eachLayer(l => { if (l.feature.properties.id === S.F.sid) l.bringToFront(); });
    // points / heat
    S.layers.cluster.clearLayers();
    if (S.map.hasLayer(S.layers.cluster)) S.map.removeLayer(S.layers.cluster);
    if (S.map.hasLayer(S.layers.heat)) S.map.removeLayer(S.layers.heat);
    const pts = S.cur.filter(r => r.g && r.g.lat !== null && r.g.prec !== 'none');
    if (S.mode === 'points') {
      const markers = pts.map(r => {
        const ll = placed(r), approx = r.g.prec === 'taluka' || r.g.prec === 'district';
        const col = pointColor(r);
        const m = L.marker(ll, { icon: L.divIcon({ className: '', html: `<i class="pt${approx ? ' approx' : ''}" style="${approx ? 'border-color' : 'background'}:${col}"></i>`, iconSize: [12, 12], iconAnchor: [6, 6] }), keyboard: false, title: r.c });
        m.on('click', () => { S.selected = { type: 'visit', r }; renderDetail(); });
        return m;
      });
      S.layers.cluster.addLayers(markers); S.map.addLayer(S.layers.cluster);
    } else if (S.mode === 'heat') {
      S.layers.heat.setLatLngs(pts.map(r => { const ll = placed(r); return [ll[0], ll[1], r.g.prec === 'district' ? 0.4 : 0.8]; }));
      S.map.addLayer(S.layers.heat);
    }
    renderLegend();
  }
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }
  // approximate points get a stable jitter so they don't stack on one pixel; they are drawn as rings to show they are not exact
  function placed(r) {
    const g = r.g;
    if (g.prec !== 'taluka' && g.prec !== 'district') return [g.lat, g.lon];
    const rad = (g.prec === 'taluka' ? 0.035 : 0.08) * Math.sqrt(hash(r.k + 'r')), ang = hash(r.k + 'a') * Math.PI * 2;
    return [g.lat + rad * Math.sin(ang), g.lon + rad * Math.cos(ang) / Math.cos(g.lat * Math.PI / 180)];
  }
  function pointColor(r) {
    if (S.colorBy === 'vt') return css(r.vt === 'New' ? '--c-new' : r.vt === 'Old' ? '--c-old' : '--c-blank');
    if (S.colorBy === 'prec') { const p = r.g.prec; return css(p === 'village' || p === 'gps' || p === 'manual' ? '--c-village' : p === 'town' ? '--c-town' : '--c-approx'); }
    return css('--c-' + r.ac);
  }
  function renderLegend() {
    const L2 = $('#legend'); let h = '';
    if (S.mode === 'points') {
      if (S.colorBy === 'activity') { const present = new Set(S.cur.map(r => r.ac)); h = CLASS_ORDER.filter(c => present.has(c)).map(c => `<div class="row"><span class="sw" style="background:${css('--c-' + c)}"></span>${I.ACTIVITY_CLASSES[c].label}</div>`).join(''); }
      else if (S.colorBy === 'vt') h = [['--c-new', 'New customer'], ['--c-old', 'Existing customer'], ['--c-blank', 'Not recorded']].map(([v, l]) => `<div class="row"><span class="sw" style="background:${css(v)}"></span>${l}</div>`).join('');
      else h = [['--c-village', 'Village matched'], ['--c-town', 'Town matched']].map(([v, l]) => `<div class="row"><span class="sw" style="background:${css(v)}"></span>${l}</div>`).join('');
      h += `<div class="row"><span class="sw ring" style="border-color:${css('--muted')}"></span>Ring = approximate (taluka/district centre)</div>`;
    } else if (S.mode === 'heat') h = '<div class="row">Density of visit points; approximate points count less.</div>';
    else {
      const lvl = areaLevelNow();
      h = `<div class="row" style="font-weight:600">Customer visits per ${lvl}</div>` + BINS.map(([l, i]) => `<div class="row"><span class="sq" style="background:${css('--ch' + i)}"></span>${l}</div>`).join('') +
        `<div class="row"><span class="sq" style="background:${css('--bad-soft')};border-color:${css('--bad')}"></span>No recorded visit (in an active ${lvl === 'taluka' ? 'district' : 'state'})</div>`;
    }
    L2.innerHTML = h;
  }
  function fitSelection() {
    let b = null;
    const grab = (layer, pred) => layer.eachLayer(l => { if (pred(l.feature.properties)) b = b ? b.extend(l.getBounds()) : L.latLngBounds(l.getBounds().getSouthWest(), l.getBounds().getNorthEast()); });
    if (S.F.sid !== null) grab(S.layers.subs, p => p.id === S.F.sid);
    else if (S.F.did) grab(S.layers.districts, p => p.d === S.F.did);
    else if (S.F.st) grab(S.layers.states, p => p.s === S.F.st);
    if (!b) b = L.latLngBounds([[6.5, 68.1], [37.1, 97.4]]);
    S.map.fitBounds(b, { padding: [30, 30], maxZoom: 12 });
  }
  function renderCrumbs() {
    const parts = [`<button data-c="india">India</button>`];
    if (S.F.st) parts.push(`<span class="sep">›</span><button data-c="st">${esc(S.geo.states[S.F.st].name)}</button>`);
    if (S.F.did) parts.push(`<span class="sep">›</span><button data-c="did">${esc(S.geo.districts[S.F.did].name)}</button>`);
    if (S.F.sid !== null) parts.push(`<span class="sep">›</span><span>${esc(S.geo.subs[S.F.sid].name)}</span>`);
    $('#crumbs').innerHTML = parts.join(' ');
    $$('#crumbs button').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.c === 'india') selectGeo(null, null, null); else if (b.dataset.c === 'st') selectGeo(S.F.st, null, null); else selectGeo(S.F.st, S.F.did, null);
    }));
  }

  // ---------- side panel ----------
  function renderDetail() {
    const body = $('#detailBody'); const sel = S.selected;
    $('#detailClose').classList.toggle('hidden', !sel);
    if (sel && sel.type === 'visit') {
      const r = sel.r, g = r.g;
      $('#detailTitle').textContent = 'Visit';
      const same = S.records.filter(x => x.custKey === r.custKey && x.cust);
      body.innerHTML = `<h3>${esc(r.c || 'Unnamed customer')}</h3>
        <dl>
          <dt>Date</dt><dd>${A.fmtDate(r.d)}${r.t ? ' ' + esc(r.t) : ' <span class="muted">(no time in file)</span>'}</dd>
          <dt>Activity</dt><dd>${esc(r.a)}${r.vt ? ` <span class="tag">${esc(r.vt)} customer</span>` : ''}</dd>
          <dt>Staff</dt><dd><button class="btn ghost" style="height:auto;padding:0" data-user="${esc(r.u)}">${esc(r.u)}</button><br><span class="muted">${esc(r.dg)}${r.hq ? ', HQ ' + esc(r.hq) : ''}</span></dd>
          <dt>Manager</dt><dd>${esc(r.m) || '<span class="muted">Not recorded</span>'}</dd>
          <dt>Phone</dt><dd>${esc(r.p) || '–'}</dd>
          <dt>As recorded</dt><dd>${esc([r.vi, r.ta, r.di, r.st].filter(Boolean).join(', ')) || '–'}</dd>
          <dt>Mapped to</dt><dd>${esc(g.place || '–')}${g.sid !== null && S.geo.subs[g.sid] && g.prec !== 'taluka' ? ', ' + esc(S.geo.subs[g.sid].name) : ''}${g.did ? ', ' + esc(S.geo.districts[g.did].name) : ''}<br><span class="prec ${g.prec}">${PREC_LABEL[g.prec]}</span>${g.score && g.score < 1 && g.prec !== 'manual' ? ` <span class="muted">match ${Math.round(g.score * 100)}%</span>` : ''}</dd>
          ${g.note ? `<dt>Note</dt><dd>${esc(g.note)}</dd>` : ''}
          <dt>Coordinates</dt><dd class="num">${g.lat !== null ? g.lat.toFixed(4) + ', ' + g.lon.toFixed(4) : '–'}</dd>
          ${r.prod ? `<dt>Product</dt><dd>${esc(r.prod)}</dd>` : ''}${r.rem ? `<dt>Remarks</dt><dd>${esc(r.rem)}</dd>` : ''}${r.status ? `<dt>Status</dt><dd>${esc(r.status)}</dd>` : ''}
          <dt>Visits to this customer</dt><dd>${same.length} in all data${same.length > 1 ? ' (' + A.uniq(same, x => x.u).size + ' staff)' : ''}</dd>
        </dl>`;
      body.querySelector('[data-user]').addEventListener('click', e => { S.F.users = [e.target.dataset.user]; S.selected = null; populateFilters(); refresh(); });
      return;
    }
    // area summary
    const lvlName = S.F.sid !== null ? S.geo.subs[S.F.sid].name : S.F.did ? S.geo.districts[S.F.did].name : S.F.st ? S.geo.states[S.F.st].name : 'All India';
    $('#detailTitle').textContent = lvlName;
    const cust = S.cur.filter(r => r.cust);
    const topStaff = [...A.countBy(cust, r => r.u)].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const topVil = [...A.countBy(cust, r => r.g && r.g.prec !== 'none' ? (A.precise(r) ? r.g.place : r.vi) : null)].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const gaps = A.coverageGaps(S.cur, S.geo, { st: S.F.st, did: S.F.did });
    const zero = gaps.reduce((s, g) => s + g.zero.length, 0), tot = gaps.reduce((s, g) => s + g.total, 0);
    body.innerHTML = cust.length ? `
      <dl><dt>Customer visits</dt><dd class="num">${fmt(cust.length)}</dd><dt>Staff</dt><dd class="num">${fmt(A.uniq(cust, r => r.u).size)}</dd>
      <dt>Talukas covered</dt><dd class="num">${fmt(tot - zero)} of ${fmt(tot)} ${S.F.did ? 'in this district' : 'in districts with activity'}</dd></dl>
      <div style="margin-top:12px;font-weight:600;font-size:13px">Most active staff</div>
      <ul class="minilist">${topStaff.map(([u, n]) => `<li><button data-user="${esc(u)}">${esc(u)}</button><span class="num">${n}</span></li>`).join('')}</ul>
      <div style="margin-top:12px;font-weight:600;font-size:13px">Most visited places</div>
      <ul class="minilist">${topVil.map(([v, n]) => `<li><span>${esc(v)}</span><span class="num">${n}</span></li>`).join('')}</ul>
      <p style="margin:12px 0 0"><button class="btn" id="toGaps">See ${fmt(zero)} talukas with no recorded visit</button></p>`
      : `<div class="empty"><strong>No visits here</strong><span class="muted">Nothing matches the current filters${S.records.length ? '' : ' — upload a file to begin'}.</span></div>`;
    body.querySelectorAll('[data-user]').forEach(b => b.addEventListener('click', () => { S.F.users = [b.dataset.user]; populateFilters(); refresh(); }));
    const tg = body.querySelector('#toGaps'); if (tg) tg.addEventListener('click', () => showView('coverage'));
  }

  // ---------- charts ----------
  function initCharts() {
    Chart.defaults.font.family = css('--font') || 'Archivo, system-ui, sans-serif';
    Chart.defaults.font.size = 12;
    Chart.defaults.animation = false;
    Chart.defaults.maintainAspectRatio = false;
    const base = { responsive: true, plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } } };
    S.charts.trend = new Chart($('#chTrend'), { type: 'bar', data: { labels: [], datasets: [] }, options: Object.assign({}, base, { scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } }, tooltip: { mode: 'index', intersect: false } } }) });
    const hbar = (onPick) => ({ type: 'bar', data: { labels: [], datasets: [{ data: [] }] }, options: Object.assign({}, base, { indexAxis: 'y', scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { grid: { display: false }, ticks: { autoSkip: false } } }, onClick: (e, els) => { if (els.length) onPick(els[0].index); }, onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; } }) });
    S.charts.geo = new Chart($('#chGeo'), hbar(i => { const id = S.geoIds[i]; if (id === undefined) return; if (S.geoLvl === 'st') selectGeo(id, null, null); else if (S.geoLvl === 'did') selectGeo(S.geo.districts[id].st, id, null); else if (S.geoLvl === 'sid') selectGeo(S.F.st, S.F.did, id); }));
    S.charts.staff = new Chart($('#chStaff'), hbar(i => { const u = S.staffIds[i]; if (u) { S.F.users = [u]; populateFilters(); refresh(); } }));
  }
  function themeChartColors() {
    const ink = css('--ink-2'), grid = css('--line-2');
    for (const c of Object.values(S.charts)) {
      for (const k of ['x', 'y']) { const ax = c.options.scales && c.options.scales[k]; if (ax) { ax.ticks.color = ink; ax.grid.color = grid; } }
      c.options.plugins.legend.labels.color = ink;
    }
  }
  function renderCharts() {
    themeChartColors();
    // trend
    const recs = S.cur;
    if (S.F.from && S.F.to) {
      const n = A.daysBetween(S.F.from, S.F.to); const weekly = n > 62;
      const bucket = d => { if (!weekly) return d; const dt = A.toDate(d); const dow = (dt.getUTCDay() + 6) % 7; return A.addDays(d, -dow); };
      const labels = []; for (let d = S.F.from; d <= S.F.to; d = A.addDays(d, weekly ? 7 : 1)) labels.push(bucket(d));
      const uniqLabels = [...new Set(labels)];
      const present = CLASS_ORDER.filter(c => recs.some(r => r.ac === c));
      S.charts.trend.data.labels = uniqLabels.map(d => { const dt = A.toDate(d); return (weekly ? 'Wk ' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()] + ' ') + dt.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getUTCMonth()]; });
      S.charts.trend.data.datasets = present.map(c => {
        const cnt = A.countBy(recs.filter(r => r.ac === c), r => bucket(r.d));
        return { label: I.ACTIVITY_CLASSES[c].label, data: uniqLabels.map(d => cnt.get(d) || 0), backgroundColor: css('--c-' + c), borderWidth: 0, maxBarThickness: 46 };
      });
      $('#trendNote').textContent = weekly ? 'weekly totals' : (recs.some(r => r.t) ? '' : 'dates only — the file has no visit times');
      S.charts.trend.update('none');
    }
    // geo: next level down
    const cust = recs.filter(r => r.cust);
    let lvl, title, nameOf;
    if (S.F.sid !== null) { lvl = 'village'; title = 'Visits by village / town'; }
    else if (S.F.did) { lvl = 'sid'; title = 'Visits by taluka'; nameOf = id => S.geo.subs[id].name; }
    else if (S.F.st) { lvl = 'did'; title = 'Visits by district'; nameOf = id => S.geo.districts[id].name; }
    else { lvl = 'st'; title = 'Visits by state'; nameOf = id => S.geo.states[id].name; }
    let rows;
    if (lvl === 'village') rows = [...A.countBy(cust, r => A.precise(r) ? r.g.place : r.vi + ' (unmatched)')].map(([k, n]) => [k, n, k]);
    else rows = [...A.countBy(cust, r => r.g && r.g[lvl] !== null ? r.g[lvl] : null)].map(([id, n]) => [nameOf(id), n, id]);
    rows.sort((a, b) => b[1] - a[1]); rows = rows.slice(0, 15);
    S.geoLvl = lvl; S.geoIds = lvl === 'village' ? [] : rows.map(r => r[2]);
    $('#geoChartTitle').textContent = title + (rows.length === 15 ? ' (top 15)' : '');
    S.charts.geo.data.labels = rows.map(r => r[0]); S.charts.geo.data.datasets[0].data = rows.map(r => r[1]);
    S.charts.geo.data.datasets[0].backgroundColor = css('--ch4'); S.charts.geo.data.datasets[0].maxBarThickness = 18;
    S.charts.geo.update('none');
    const st = [...A.countBy(cust, r => r.u)].sort((a, b) => b[1] - a[1]).slice(0, 15);
    S.staffIds = st.map(r => r[0]);
    S.charts.staff.data.labels = st.map(r => r[0].length > 22 ? r[0].slice(0, 21) + '…' : r[0]); S.charts.staff.data.datasets[0].data = st.map(r => r[1]);
    S.charts.staff.data.datasets[0].backgroundColor = css('--accent'); S.charts.staff.data.datasets[0].maxBarThickness = 18;
    S.charts.staff.update('none');
  }

  // ---------- generic sortable table ----------
  function table(el, cols, rows, opts) {
    opts = opts || {};
    const sort = opts.sort;
    if (sort) rows = rows.slice().sort((a, b) => { const x = a[sort.k], y = b[sort.k]; return (x === y ? 0 : (x === null || x === undefined || x === '') ? 1 : (y === null || y === undefined || y === '') ? -1 : x > y ? 1 : -1) * sort.dir; });
    const page = opts.pageSize ? rows.slice(opts.page * opts.pageSize, (opts.page + 1) * opts.pageSize) : rows;
    el.innerHTML = `<thead><tr>${cols.map(c => `<th data-k="${c.k}" class="${c.r ? 'r' : ''}${c.nosort ? ' nosort' : ''}"${sort && sort.k === c.k ? ` aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${esc(c.t)}</th>`).join('')}</tr></thead>
      <tbody>${page.map((r, i) => `<tr data-i="${i}"${opts.onRow ? ' class="click"' : ''}>${cols.map(c => `<td class="${c.r ? 'r' : ''}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="muted" style="padding:20px">Nothing to show for the current filters.</td></tr>`}</tbody>`;
    if (sort && opts.onSort) el.querySelectorAll('th').forEach(th => { if (!th.classList.contains('nosort')) th.addEventListener('click', () => opts.onSort(th.dataset.k)); });
    if (opts.onRow) el.querySelectorAll('tbody tr[data-i]').forEach(tr => tr.addEventListener('click', () => opts.onRow(page[+tr.dataset.i])));
    return rows.length;
  }

  function visitRows(recs) {
    return recs.map(r => ({ _r: r, d: r.d, u: r.u, c: r.c, p: r.p, a: r.a, vt: r.vt, vi: r.vi, place: r.g.place, prec: r.g.prec,
      sub: r.g.sid !== null && S.geo.subs[r.g.sid] ? S.geo.subs[r.g.sid].name : r.ta, dist: r.g.did ? S.geo.districts[r.g.did].name : r.di }));
  }
  function renderVisitTable() {
    const PS = 50;
    const rows = visitRows(S.cur);
    const total = table($('#visitTable'), [
      { k: 'd', t: 'Date', f: r => A.fmtDate(r.d) }, { k: 'u', t: 'Staff' }, { k: 'c', t: 'Customer' }, { k: 'p', t: 'Phone' }, { k: 'a', t: 'Activity' }, { k: 'vt', t: 'New/old' },
      { k: 'vi', t: 'Village (as recorded)' }, { k: 'place', t: 'Mapped to', f: r => `${esc(r.place)} <span class="prec ${r.prec}">${r.prec === 'village' ? 'village' : r.prec === 'town' ? 'town' : PREC_LABEL[r.prec].replace(' (approx.)', '')}</span>` },
      { k: 'sub', t: 'Taluka' }, { k: 'dist', t: 'District' }
    ], rows, {
      sort: S.sort.visits, page: S.page, pageSize: PS,
      onSort: k => { const s = S.sort.visits; s.dir = s.k === k ? -s.dir : 1; s.k = k; renderVisitTable(); },
      onRow: row => { const r = row._r; S.selected = { type: 'visit', r }; renderDetail(); if (r.g.lat !== null) S.map.setView(placed(r), Math.max(S.map.getZoom(), 11)); $('#mapwrap').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    });
    $('#visitCount').textContent = `(${fmt(total)})`;
    const pages = Math.max(1, Math.ceil(total / PS)); if (S.page >= pages) S.page = 0;
    $('#visitPager').innerHTML = `<span>Showing ${total ? S.page * PS + 1 : 0}–${Math.min(total, (S.page + 1) * PS)} of ${fmt(total)}</span><span><button class="btn" id="pgPrev" ${S.page === 0 ? 'disabled' : ''}>Previous</button> <button class="btn" id="pgNext" ${S.page >= pages - 1 ? 'disabled' : ''}>Next</button></span>`;
    $('#pgPrev').onclick = () => { S.page--; renderVisitTable(); }; $('#pgNext').onclick = () => { S.page++; renderVisitTable(); };
  }

  // ---------- staff ----------
  function renderStaff() {
    const rows = A.byUser(S.curAll, { from: S.F.from, to: S.F.to });
    const flags = A.anomalies(S.curAll);
    const fl = new Map(); const add = (u, s) => { if (!fl.has(u)) fl.set(u, []); fl.get(u).push(s); };
    flags.highVolume.forEach(x => add(x.user, `${x.visits} visits on ${A.fmtDate(x.date)}`));
    flags.farApart.forEach(x => add(x.user, `${Math.round(x.km)} km apart on ${A.fmtDate(x.date)}`));
    flags.selfLogged.forEach(r => add(r.u, `own name as customer (${A.fmtDate(r.d)})`));
    flags.nonCustomer.forEach(r => add(r.u, `"${r.c}" logged as ${r.a}`));
    rows.forEach(r => { r.flags = (fl.get(r.user) || []).length; });
    S.staffRows = rows; S.staffFlags = fl;
    table($('#staffTable'), [
      { k: 'user', t: 'Staff member', f: r => `${esc(r.user)}<br><span class="muted" style="font-size:12px">${esc(r.dg)}${r.hq ? ', ' + esc(r.hq) : ''}</span>` },
      { k: 'visits', t: 'Customer visits', r: 1 }, { k: 'activeDays', t: 'Active days', r: 1 },
      { k: 'perActiveDay', t: 'Per active day', r: 1, f: r => fmt1(r.perActiveDay) }, { k: 'perWorkingDay', t: 'Per working day', r: 1, f: r => fmt1(r.perWorkingDay) },
      { k: 'customers', t: 'Customers', r: 1 }, { k: 'repeat', t: 'Repeat', r: 1 }, { k: 'villages', t: 'Villages', r: 1 }, { k: 'talukas', t: 'Talukas', r: 1 }, { k: 'districts', t: 'Districts', r: 1 },
      { k: 'nonCustomer', t: 'Halts / other', r: 1 }, { k: 'flags', t: 'Flags', r: 1, f: r => r.flags ? `<span class="tag warn">${r.flags}</span>` : '' }
    ], rows, { sort: S.sort.staff, onSort: k => { const s = S.sort.staff; s.dir = s.k === k ? -s.dir : -1; s.k = k; renderStaff(); }, onRow: r => { S.staffSel = r.user; renderStaffDetail(); } });
    renderStaffDetail();
  }
  function renderStaffDetail() {
    const u = S.staffSel; const r = (S.staffRows || []).find(x => x.user === u);
    $('#staffMap').classList.toggle('hidden', !r);
    if (!r) { $('#staffTitle').textContent = 'Select a staff member'; return; }
    $('#staffTitle').textContent = r.user;
    const recs = S.curAll.filter(x => x.u === u);
    const byDay = [...A.countBy(recs.filter(x => x.cust), x => x.d)].sort();
    const maxN = Math.max(1, ...byDay.map(x => x[1]));
    const dists = [...A.countBy(recs.filter(x => x.cust), x => x.g.did ? S.geo.districts[x.g.did].name : null)].sort((a, b) => b[1] - a[1]);
    const subs = [...A.countBy(recs.filter(x => x.cust), x => x.g.sid !== null && S.geo.subs[x.g.sid] ? S.geo.subs[x.g.sid].name : null)].sort((a, b) => b[1] - a[1]);
    const flags = S.staffFlags.get(u) || [];
    $('#staffBody').innerHTML = `
      <dl><dt>Role</dt><dd>${esc(r.dg)}${r.hq ? ', HQ ' + esc(r.hq) : ''}</dd><dt>Manager</dt><dd>${esc(r.m) || '<span class="muted">Not recorded</span>'}</dd>
      <dt>Customer visits</dt><dd class="num">${fmt(r.visits)} (farmer ${r.farmer}, dealer ${r.dealer}, trial ${r.trial}, events ${r.event})</dd>
      <dt>Other entries</dt><dd class="num">${fmt(r.nonCustomer)} night halts / other</dd>
      <dt>Customers</dt><dd class="num">${fmt(r.customers)} (${fmt(r.newCust)} new, ${fmt(r.repeat)} visited more than once)</dd>
      <dt>Average</dt><dd class="num">${fmt1(r.perActiveDay)} per active day; ${fmt1(r.perWorkingDay)} per working day (${r.workingDays} Mon–Sat days)</dd>
      <dt>Spread</dt><dd>${r.spreadKm === null ? '<span class="muted">Too few village-level points</span>' : Math.round(r.spreadKm) + ' km typical distance from centre of activity'}</dd>
      <dt>Mapped precisely</dt><dd>${pct(r.precisePct)} of entries</dd><dt>Last entry</dt><dd>${A.fmtDate(r.lastDate)}</dd></dl>
      <div style="margin-top:14px;font-weight:600;font-size:13px">Customer visits per day</div>
      <ul class="minilist">${byDay.map(([d, n]) => `<li><span style="width:96px">${A.fmtDate(d)}</span><span class="bar" style="flex:1"><i style="width:${n / maxN * 100}%"></i></span><span class="num" style="width:26px;text-align:right">${n}</span></li>`).join('')}</ul>
      <div style="margin-top:14px;font-weight:600;font-size:13px">Areas</div>
      <p style="margin:4px 0">${dists.map(([d, n]) => `<span class="tag">${esc(d)} ${n}</span>`).join('')}</p>
      <p style="margin:4px 0">${subs.slice(0, 20).map(([d, n]) => `<span class="tag">${esc(d)} ${n}</span>`).join('')}</p>
      <div style="margin-top:14px;font-weight:600;font-size:13px">Review flags</div>
      ${flags.length ? `<ul class="minilist">${flags.map(f => `<li><span>${esc(f)}</span></li>`).join('')}</ul>` : '<p class="muted" style="margin:4px 0">None in this period.</p>'}`;
    $('#staffMap').onclick = () => { S.F.users = [u]; populateFilters(); showView('dashboard'); setTimeout(() => { const pts = S.cur.filter(x => x.g.lat !== null).map(placed); if (pts.length) S.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 11 }); }, 100); };
  }

  // ---------- coverage ----------
  function renderCoverage() {
    const gaps = A.coverageGaps(S.cur, S.geo, { st: S.F.st, did: S.F.did });
    $('#gapScope').textContent = S.F.did ? S.geo.districts[S.F.did].name : S.F.st ? S.geo.states[S.F.st].name + ', districts with activity' : 'districts with activity';
    table($('#gapTable'), [
      { k: 'name', t: 'District', f: r => `<button class="btn ghost" style="height:auto;padding:0" data-did="${r.did}">${esc(r.name)}</button>` },
      { k: 'visits', t: 'Visits', r: 1 }, { k: 'cov', t: 'Talukas with visits', r: 1, f: r => `${r.visited} / ${r.total}` },
      { k: 'pct', t: '', nosort: 1, f: r => `<div class="bar"><i style="width:${r.total ? r.visited / r.total * 100 : 0}%"></i></div>` },
      { k: 'zero', t: 'No recorded visit', nosort: 1, f: r => r.zero.map(z => `<span class="tag bad">${esc(z)}</span>`).join('') || '<span class="muted">All covered</span>' }
    ], gaps.map(g => Object.assign(g, { cov: g.total ? g.visited / g.total : 0 })), {});
    $$('#gapTable [data-did]').forEach(b => b.addEventListener('click', () => { const d = +b.dataset.did; S.mode = 'areas'; S.areaLevel = 'taluka'; $('#areaLevel').value = 'taluka'; selectGeo(S.geo.districts[d].st, d, null); showView('dashboard'); }));
    renderPlan();
  }
  function renderPlan() {
    const body = $('#planBody');
    if (!S.plan.length) {
      body.innerHTML = `<div class="note info">No territory plan uploaded. With one, this panel shows each person's assigned talukas or villages, which ones got a visit, and which did not — a confirmed gap rather than just an empty area.</div>
        <p class="muted" style="margin-top:10px">Template columns: Representative, State, District, Taluka, Village (village optional). One row per assigned area. Names must match the "Submitted User" names in the CRM export.</p>`;
      return;
    }
    const res = A.territoryCoverage(S.cur, S.plan, S.geo);
    const known = new Set(S.records.map(r => r.u.toLowerCase()));
    const unknown = [...new Set(S.plan.map(p => p.rep))].filter(r => !known.has(String(r).toLowerCase()));
    body.innerHTML = `<p class="muted" style="margin-top:0">${S.plan.length} assigned areas for ${res.length} people. <button class="btn ghost" id="planClear" style="height:auto;padding:0">Remove plan</button></p>
      ${unknown.length ? `<div class="note">These names in the plan do not match any staff in the uploads: ${unknown.map(esc).join(', ')}</div>` : ''}
      <div class="tablewrap"><table class="t" id="planTable"></table></div><div id="planUnits" style="margin-top:12px"></div>`;
    table($('#planTable'), [
      { k: 'rep', t: 'Representative' }, { k: 'assigned', t: 'Assigned', r: 1 }, { k: 'covered', t: 'Visited', r: 1 },
      { k: 'pct', t: 'Coverage', r: 1, f: r => pct(r.pct) }, { k: 'b', t: '', nosort: 1, f: r => `<div class="bar"><i style="width:${r.pct * 100}%"></i></div>` },
      { k: 'outside', t: 'Visits outside plan', r: 1 }
    ], res, { onRow: r => { $('#planUnits').innerHTML = `<div style="font-weight:600;margin-bottom:6px">${esc(r.rep)}</div>` + r.units.map(u => `<span class="tag ${u.visits ? '' : 'bad'}">${esc(u.label)}${u.visits ? ' ' + u.visits : ' — no visit'}${u.resolved ? '' : ' (place not recognised)'}</span>`).join(''); } });
    $('#planClear').onclick = async () => { S.plan = []; await S.store.setKV('territoryPlan', []); renderPlan(); toast('Territory plan removed'); };
  }
  async function loadPlanFile(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    const hi = rows.findIndex(r => r.some(c => /rep|staff|employee|user/i.test(c)) && r.some(c => /district/i.test(c)));
    if (hi < 0) { toast('Could not find the header row (needs Representative and District columns).'); return; }
    const h = rows[hi].map(x => String(x).toLowerCase());
    const col = re => h.findIndex(x => re.test(x));
    const c = { rep: col(/rep|staff|employee|user/), state: col(/state/), district: col(/district/), taluka: col(/taluka|tehsil|block|mandal/), village: col(/village|town/) };
    const plan = rows.slice(hi + 1).filter(r => r[c.rep] && r[c.district]).map(r => ({ rep: String(r[c.rep]).trim(), state: c.state >= 0 ? r[c.state] : '', district: r[c.district], taluka: c.taluka >= 0 ? r[c.taluka] : '', village: c.village >= 0 ? r[c.village] : '' }));
    if (!plan.length) { toast('No rows found under the header.'); return; }
    S.plan = plan; await S.store.setKV('territoryPlan', plan); renderPlan(); toast(`Territory plan loaded: ${plan.length} rows`);
  }

  // ---------- data quality ----------
  function fixGroups(recs, includeApprox) {
    const m = new Map();
    for (const r of recs) {
      if (!r.g) continue;
      const p = r.g.prec;
      if (!(p === 'none' || (includeApprox && (p === 'taluka' || p === 'district')))) continue;
      const key = [r.st, r.di, r.ta, r.vi].map(Geo.norm).join('|');
      if (!m.has(key)) m.set(key, { key, r, n: 0 }); m.get(key).n++;
    }
    return [...m.values()].sort((a, b) => (a.r.g.prec === 'none' ? -1 : 0) - (b.r.g.prec === 'none' ? -1 : 0) || b.n - a.n);
  }
  /* The fixer. By default it lists only places that are NOT on the map. Places already shown at a taluka or district
     centre are optional improvements, shown when "includeApprox" is ticked. */
  function renderFixList(container, recs, onDone, opts) {
    opts = opts || {};
    const limit = opts.limit || 40, inc = !!S.fixApprox;
    const nNone = fixGroups(recs, false).length, nAll = fixGroups(recs, true).length;
    const groups = fixGroups(recs, inc);
    const toggle = `<label class="check" style="height:auto;margin:0 0 10px"><input type="checkbox" class="fixApproxToggle" ${inc ? 'checked' : ''}> Also show the ${fmt(nAll - nNone)} place names placed at a taluka or district centre (optional; they are already on the map)</label>`;
    if (!groups.length) {
      container.innerHTML = (nAll - nNone ? toggle : '') + `<p class="muted" style="margin:0">${nNone ? '' : 'Every row in this selection is on the map. '}${inc ? 'Nothing left to improve.' : 'Nothing needs fixing.'}</p>`;
      bindToggle(); return 0;
    }
    function bindToggle() { const t = container.querySelector('.fixApproxToggle'); if (t) t.onchange = e => { S.fixApprox = e.target.checked; renderFixList(container, recs, onDone, opts); }; }
    const sugFor = g => S.geo.suggest({ state: g.r.st, district: g.r.di, taluka: g.r.ta, village: g.r.vi, hq: g.r.hq, current: g.r.g }, 6);
    container.innerHTML = toggle + `<p class="muted" style="margin-top:0">Choose the right place, or "Enter coordinates…" and type "lat, lon" (right-click the spot in Google Maps to copy them). Options marked ⚠ are in a different district from the one recorded; pick them only if you know the record is wrong. Fixes are reused for every later upload with the same spelling.</p>` +
      groups.slice(0, limit).map((g, i) => {
        const sug = sugFor(g);
        return `<div class="fixrow" data-i="${i}">
          <div><b>${esc(g.r.vi || '(no village)')}</b><br><span class="muted" style="font-size:12px">${esc([g.r.ta, g.r.di, g.r.st].filter(Boolean).join(', ') || 'no state/district/taluka')}${g.r.hq ? ' (HQ ' + esc(g.r.hq) + ')' : ''}</span><br><span class="prec ${g.r.g.prec}">${PREC_LABEL[g.r.g.prec]}</span></div>
          <div class="num muted">${g.n} row${g.n > 1 ? 's' : ''}</div>
          <div><select><option value="">${sug.length ? '— choose a place —' : 'No close matches; enter coordinates or leave it'}</option>${sug.map((s, j) => `<option value="${j}">${esc(s.label)}${s.group === 1 ? '' : ' (' + Math.round(s.score * 100) + '%)'}</option>`).join('')}<option value="ll">Enter coordinates…</option></select><input class="hidden" placeholder="21.1458, 79.0882" style="margin-top:4px"></div>
          <button class="btn">Apply</button></div>`;
      }).join('') + (groups.length > limit ? `<p class="muted">${groups.length - limit} more not shown; they appear here as you fix these.</p>` : '');
    bindToggle();
    container.querySelectorAll('.fixrow').forEach(row => {
      const g = groups[+row.dataset.i];
      const sug = sugFor(g);
      const sel = row.querySelector('select'), inp = row.querySelector('input');
      sel.addEventListener('change', () => inp.classList.toggle('hidden', sel.value !== 'll'));
      row.querySelector('button').addEventListener('click', async () => {
        let fix;
        if (sel.value === 'll') {
          const m = inp.value.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
          if (!m || +m[1] < 6 || +m[1] > 37.5 || +m[2] < 68 || +m[2] > 97.5) { toast('Enter coordinates inside India as "lat, lon"'); return; }
          const lat = +m[1], lon = +m[2];
          fix = Object.assign({ lat, lon, place: g.r.vi || 'Manual point' }, locate(lon, lat));
        } else if (sel.value !== '') { const s = sug[+sel.value]; fix = { st: s.st, did: s.did, sid: s.sid, lat: s.lat, lon: s.lon, place: s.place }; }
        else { toast('Choose a place from the list first'); return; }
        S.fixes[g.key] = Object.assign(fix, { prec: 'manual', score: 1, note: 'Corrected by user', fixedAt: new Date().toISOString() });
        await S.store.setKV('geoFixes', S.fixes);
        S.geo.cache.clear();
        for (const r of S.records) r.g = resolveOne(r);
        toast('Location saved for ' + (g.r.vi || 'this entry'));
        onDone && onDone();
      });
    });
    return groups.length;
  }
  function exportFixes() {
    const n = Object.keys(S.fixes).length;
    if (!n) { toast('No location fixes saved yet'); return; }
    saveFile('location_fixes.json', new Blob([JSON.stringify({ app: 'field-visit-atlas', version: 1, fixes: S.fixes }, null, 1)], { type: 'application/json' }));
  }
  async function importFixes(file) {
    try {
      const obj = JSON.parse(await file.text());
      const fx = obj && obj.fixes ? obj.fixes : obj;
      let n = 0; for (const [k, v] of Object.entries(fx)) { if (v && typeof v.lat === 'number' && typeof v.lon === 'number') { S.fixes[k] = v; n++; } }
      await S.store.setKV('geoFixes', S.fixes); S.geo.cache.clear(); for (const r of S.records) r.g = resolveOne(r);
      toast(`Imported ${n} location fixes`); refresh();
    } catch (e) { toast('That file is not a location-fixes file'); }
  }
  // point-in-polygon against the sub-district layer for manual coordinates
  function locate(lon, lat) {
    const inRing = (pt, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) c = !c; } return c; };
    for (const f of S.feat.subs.features) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const p of polys) if (inRing([lon, lat], p[0])) return { st: f.properties.s, did: f.properties.d, sid: f.properties.id };
    }
    return { st: null, did: null, sid: null };
  }
  function updateQualityBadge() {
    const n = S.records.filter(r => r.g && r.g.prec === 'none').length;
    const b = $('#qbadge'); b.textContent = n; b.classList.toggle('hidden', !n); b.title = n + ' rows with unresolved location';
  }
  function renderQuality() {
    renderFixList($('#fixBody'), S.curAll, () => { refresh(); });
    const nNone = fixGroups(S.curAll, false).length;
    $('#fixCount').textContent = nNone ? nNone + ' place names not on the map' : 'all rows are on the map';
    // batches
    const bt = $('#batchTable');
    table(bt, [
      { k: 'uploadedAt', t: 'Uploaded', f: b => new Date(b.uploadedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) },
      { k: 'fileName', t: 'File' }, { k: 'from', t: 'Covers', f: b => b.from === b.to ? A.fmtDate(b.from) : A.fmtDate(b.from) + ' – ' + A.fmtDate(b.to) },
      { k: 'rows', t: 'Rows saved', r: 1 }, { k: 'sk', t: 'Skipped', r: 1, f: b => b.summary ? fmt((b.summary.dupInFile || 0) + (b.summary.existing || 0) + (b.summary.rejected || 0)) : '' },
      { k: 'x', t: '', nosort: 1, f: b => `<button class="btn danger" data-del="${esc(b.id)}" style="height:26px">Delete</button>` }
    ], S.batches.slice().reverse(), {});
    bt.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
      if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = 'Click again to delete'; setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Delete'; }, 4000); return; }
      btn.disabled = true; btn.textContent = 'Deleting…'; S.selfWrite = Date.now();
      await S.store.deleteBatch(btn.dataset.del); await loadAll(); populateFilters(); refresh(); toast('Upload deleted');
    }));
    // flags
    const f = A.anomalies(S.curAll);
    S.flags = f;
    const sec = (title, n, html, hint) => `<details class="flag"${n ? '' : ''}><summary><span>${esc(title)}</span><span class="n">${n}</span></summary><div class="inner">${hint ? `<p class="muted" style="margin-top:0">${esc(hint)}</p>` : ''}${html}</div></details>`;
    const mini = (cols, rows) => `<table class="t"><thead><tr>${cols.map(c => `<th class="nosort">${esc(c[0])}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${c[1](r)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    $('#flagBody').innerHTML =
      sec('Joint visits: same customer, same day, several staff', f.joint.length, mini([['Date', g => A.fmtDate(g.date)], ['Customer', g => esc(g.recs[0].c)], ['Staff', g => g.users.map(esc).join('<br>')]], f.joint), 'Usually a manager accompanying a rep. Fine in itself, but it inflates visit counts if each entry is treated as separate reach.') +
      sec('Same phone, different customer names', f.phoneNames.length, mini([['Phone', x => esc(x.phone)], ['Names used', x => x.names.map(esc).join('<br>')]], f.phoneNames), 'Mostly spelling variants of one shop or farmer; a hotel or office number reused as a customer is worth questioning.') +
      sec('Non-customer names logged as customer visits', f.nonCustomer.length, mini([['Date', r => A.fmtDate(r.d)], ['Staff', r => esc(r.u)], ['Logged as', r => esc(r.a)], ['Customer', r => esc(r.c)]], f.nonCustomer)) +
      sec('Staff member logged as their own customer', f.selfLogged.length, mini([['Date', r => A.fmtDate(r.d)], ['Staff', r => esc(r.u)], ['Activity', r => esc(r.a)], ['Customer', r => esc(r.c)]], f.selfLogged)) +
      sec('High-volume days (12+ customer visits)', f.highVolume.length, mini([['Date', x => A.fmtDate(x.date)], ['Staff', x => esc(x.user)], ['Visits', x => x.visits]], f.highVolume), 'Possible, but worth a call-back check, especially with joint visits on the same day.') +
      sec('Same-day places 150 km or more apart', f.farApart.length, mini([['Date', x => A.fmtDate(x.date)], ['Staff', x => esc(x.user)], ['Distance', x => Math.round(x.km) + ' km'], ['Between', x => esc(x.a) + ' and ' + esc(x.b)]], f.farApart), 'Straight-line distance between village-level matches. With no visit times in the file, the order of visits is unknown.');
  }

  // ---------- upload ----------
  function setStep(n) {
    S.up.step = n;
    $$('#steps li').forEach(li => { const s = +li.dataset.s; li.classList.toggle('on', s === n); li.classList.toggle('done', s < n); });
  }
  function renderUpload() {
    const b = $('#uploadBody'); const up = S.up;
    setStep(up.step);
    if (up.step === 1 && !up.parsed) {
      b.innerHTML = `<label class="drop" id="drop" for="fileInput"><strong>Drop today's Excel file here</strong><span class="muted">or click to choose a file. Nothing is saved until the last step.</span></label>
        ${S.records.length ? `<p class="muted">Currently stored: ${fmt(S.records.length)} rows from ${S.batches.length} upload${S.batches.length > 1 ? 's' : ''}, ${A.fmtDate(S.minDate)} to ${A.fmtDate(S.maxDate)}.</p>` : ''}`;
      const drop = $('#drop');
      ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) readFile(f); });
      return;
    }
    if (up.step === 1) {
      const p = up.parsed, map = up.map;
      const missing = I.FIELD_DEFS.filter(d => d.req && map[d.f] === undefined);
      const noLoc = map.vi === undefined && map.lat === undefined && map.di === undefined;
      b.innerHTML = `<div class="grid2">
        <div class="panel"><h2>${esc(up.file.name)}</h2><div class="body">
          <dl class="detail" style="display:grid;grid-template-columns:140px 1fr;gap:5px 10px;margin:0"><dt class="muted">Sheet</dt><dd style="margin:0">${esc(p.sheet)}</dd><dt class="muted">Header row</dt><dd style="margin:0">Row ${p.headerRow + 1}</dd>
          <dt class="muted">Data rows</dt><dd style="margin:0">${fmt(p.body.length)}</dd><dt class="muted">Report period</dt><dd style="margin:0">${p.period ? A.fmtDate(p.period.from) + ' – ' + A.fmtDate(p.period.to) : 'Not stated in file'}</dd>
          ${p.title.length ? `<dt class="muted">Title lines</dt><dd style="margin:0">${p.title.map(esc).join('<br>')}</dd>` : ''}</dl>
          ${missing.length ? `<div class="note" style="margin-top:12px">Required columns not found: ${missing.map(d => esc(d.label)).join(', ')}. Choose them on the right.</div>` : ''}
          ${noLoc ? '<div class="note" style="margin-top:12px">No location columns found. Visits cannot be mapped without a village, district or coordinates.</div>' : ''}
          ${up.unmapped.length ? `<p class="muted">Columns not used: ${up.unmapped.map(esc).join(', ')}</p>` : ''}
          <p style="margin-top:16px"><button class="btn" id="upCancel">Choose another file</button> <button class="btn primary" id="upCheck" ${missing.length ? 'disabled' : ''}>Check data</button></p>
        </div></div>
        <div class="panel"><h2>Column mapping</h2><div class="tablewrap"><table class="t maptable"><thead><tr><th class="nosort">Field</th><th class="nosort">Column in file</th><th class="nosort">First value</th></tr></thead><tbody>
          ${I.FIELD_DEFS.map(d => `<tr><td>${esc(d.label)}${d.req ? ' *' : ''}</td><td><select data-f="${d.f}"><option value="">— not in file —</option>${p.headers.map((h, i) => `<option value="${i}"${map[d.f] === i ? ' selected' : ''}>${esc(h || 'Column ' + (i + 1))}</option>`).join('')}</select></td><td class="muted">${map[d.f] !== undefined ? esc((() => { const v = p.body[0] ? p.body[0][map[d.f]] : ''; if (d.f === 'date') { const x = I.parseDate(v); return x ? A.fmtDate(x.d) : String(v) + ' (unreadable)'; } return String(v); })().slice(0, 40)) : ''}</td></tr>`).join('')}
        </tbody></table></div></div></div>`;
      $$('.maptable select').forEach(s => s.addEventListener('change', () => { if (s.value === '') delete up.map[s.dataset.f]; else up.map[s.dataset.f] = +s.value; renderUpload(); }));
      $('#upCancel').onclick = () => { S.up = { step: 1 }; renderUpload(); };
      $('#upCheck').onclick = runValidation;
      return;
    }
    if (up.step === 2 || up.step === 3) {
      const v = up.val, s = v.summary;
      const tiles = [
        ['Rows read', s.read, ''], ['New and valid', s.newValid, 'good'], ['Duplicates within file', s.dupInFile, s.dupInFile ? 'warn' : ''], ['Already uploaded', s.existing, s.existing ? 'warn' : ''],
        ['Rejected (no date/staff)', s.rejected, s.rejected ? 'bad' : ''], ['Location not resolved', s.unresolved, s.unresolved ? 'bad' : ''], ['Approximate location', s.approx, s.approx ? 'warn' : ''],
        ['Non-customer names', s.nonCustomer, s.nonCustomer ? 'warn' : ''], ['Own name as customer', s.selfLogged, s.selfLogged ? 'warn' : ''], ['Invalid coordinates', s.invalidGps, s.invalidGps ? 'bad' : ''],
        ['Phone not 10 digits', s.badPhone, s.badPhone ? 'warn' : ''], ['Future dates', s.futureDate, s.futureDate ? 'bad' : '']
      ];
      const sev = r => (r.status === 'rejected' ? 0 : r.issues.includes('unresolved') ? 1 : r.status !== 'new' ? 2 : r.issues.some(i => i !== 'approximate' && i !== 'partial_location') ? 3 : 4);
      const issueRows = v.rows.filter(r => r.issues.length || r.status !== 'new').sort((a, b) => sev(a) - sev(b) || a.rec._row - b.rec._row);
      const codes = [...new Set(issueRows.flatMap(r => r.issues.concat(r.status !== 'new' ? ['status_' + r.status] : [])))];
      const label = c => c.startsWith('status_') ? ({ status_duplicate: 'Duplicate within file', status_existing: 'Already uploaded', status_rejected: 'Rejected' })[c] : I.ISSUE_LABELS[c] || c;
      const saveN = s.newValid + (up.keepDup ? s.dupInFile : 0);
      const dates = Object.keys(s.dates).sort();
      b.innerHTML = `<div class="tiles">${tiles.map(t => `<div class="tile ${t[2]}"><div class="v">${fmt(t[1])}</div><div class="l">${t[0]}</div></div>`).join('')}</div>
        <div class="panel" style="margin-top:14px"><div class="body" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between">
          <span>${saveN ? `Ready to save <b>${fmt(saveN)}</b> rows from ${fmt(s.users)} staff covering ${dates.length ? A.fmtDate(dates[0]) + ' – ' + A.fmtDate(dates[dates.length - 1]) : '–'}.` : 'Nothing new to save — every row is already stored or rejected.'}
          Location precision: ${['village', 'town', 'gps', 'manual', 'taluka', 'district', 'none'].filter(k => s.precision[k]).map(k => `${PREC_LABEL[k]} ${fmt(s.precision[k])}`).join(', ')}.</span>
          <span style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            ${s.dupInFile ? `<label class="check"><input type="checkbox" id="keepDup" ${up.keepDup ? 'checked' : ''}> Keep in-file duplicates</label>` : ''}
            <button class="btn" id="upBack">Back</button>
            ${(s.unresolved + s.approx) ? `<button class="btn" id="upFix">${s.unresolved ? 'Fix places not on the map (' + fmt(fixGroups(v.rows.filter(r => r.status === 'new').map(r => r.rec), false).length) + ')' : 'Improve approximate places (optional)'}</button>` : ''}
            <button class="btn primary" id="upSave" ${saveN ? '' : 'disabled'}>Save ${fmt(saveN)} rows</button></span></div></div>
        <div class="panel ${up.step === 3 ? '' : 'hidden'}" style="margin-top:14px"><h2>Fix locations in this file</h2><div class="body" id="upFixBody"></div></div>
        ${s.approx ? `<div class="note info" style="margin-top:14px">${fmt(s.approx)} rows are placed at a taluka or district centre because the village name was not found in the Census list (hamlets, localities, markets, spelling variants). They are on the map and counted; fixing them is optional and only improves pin precision.</div>` : ''}
        <div class="panel" style="margin-top:14px"><header><span>Rows needing attention (${fmt(issueRows.length)})</span><select id="issueFilter" style="height:30px;border:1px solid var(--line);border-radius:6px;background:var(--surface)"><option value="">All issues</option>${codes.map(c => `<option value="${c}">${esc(label(c))}</option>`).join('')}</select></header>
          <div class="tablewrap" style="max-height:480px;overflow:auto"><table class="t" id="issueTable"></table></div></div>`;
      const drawIssues = () => {
        const fsel = $('#issueFilter').value;
        const rows = issueRows.filter(r => !fsel || r.issues.includes(fsel) || ('status_' + r.status) === fsel).slice(0, 500);
        table($('#issueTable'), [
          { k: 'row', t: 'Excel row', r: 1, f: r => r.rec._row }, { k: 'issues', t: 'Issues', nosort: 1, f: r => (r.status !== 'new' ? [`<span class="tag ${r.status === 'rejected' ? 'bad' : 'warn'}">${esc(label('status_' + r.status))}</span>`] : []).concat(r.issues.map(i => `<span class="tag ${i === 'unresolved' || i === 'missing_location' ? 'bad' : 'warn'}">${esc(I.ISSUE_LABELS[i] || i)}</span>`)).join('') },
          { k: 'd', t: 'Date', f: r => esc(A.fmtDate(r.rec.d)) }, { k: 'u', t: 'Staff', f: r => esc(r.rec.u) }, { k: 'c', t: 'Customer', f: r => esc(r.rec.c) },
          { k: 'loc', t: 'Location as recorded', f: r => esc([r.rec.vi, r.rec.ta, r.rec.di, r.rec.st].filter(Boolean).join(', ')) },
          { k: 'g', t: 'Mapped to', f: r => `${esc(r.rec.g.place || '')} <span class="prec ${r.rec.g.prec}">${PREC_LABEL[r.rec.g.prec]}</span>${r.rec.g.note ? `<br><span class="muted" style="font-size:12px">${esc(r.rec.g.note)}</span>` : ''}` }
        ], rows, {});
      };
      $('#issueFilter').addEventListener('change', drawIssues); drawIssues();
      if ($('#keepDup')) $('#keepDup').onchange = e => { up.keepDup = e.target.checked; renderUpload(); };
      $('#upBack').onclick = () => { up.step = 1; renderUpload(); };
      if ($('#upFix')) $('#upFix').onclick = () => { up.step = 3; renderUpload(); setTimeout(() => $('#upFixBody').scrollIntoView({ behavior: 'smooth' }), 50); };
      if (up.step === 3) { if (!s.unresolved) S.fixApprox = true; renderFixList($('#upFixBody'), v.rows.filter(r => r.status === 'new').map(r => r.rec), () => runValidation(true)); }
      $('#upSave').onclick = saveUpload;
      return;
    }
    if (up.step === 4) {
      b.innerHTML = `<div class="panel"><div class="body empty"><strong>Saved ${fmt(up.saved)} rows</strong><span class="muted">${esc(up.file.name)} is now part of the history${S.store.shared ? ' and visible to everyone this dashboard is shared with' : ' in this browser'}.</span>
        <p style="margin-top:16px"><button class="btn primary" id="upGo">Open the map</button> <button class="btn" id="upAnother">Upload another file</button></p></div></div>`;
      $('#upGo').onclick = () => { S.up = { step: 1 }; setPeriod('7'); showView('dashboard'); fitSelection(); };
      $('#upAnother').onclick = () => { S.up = { step: 1 }; renderUpload(); };
    }
  }
  async function readFile(file) {
    try {
      const buf = await file.arrayBuffer();
      const parsed = I.readWorkbook(XLSX, buf);
      const dm = I.detectMapping(parsed.headers);
      S.up = { step: 1, file: { name: file.name, size: file.size }, parsed, map: dm.map, unmapped: dm.unmapped };
      renderUpload();
    } catch (e) { toast(e.message || 'Could not read that file', 6000); console.error(e); }
  }
  async function runValidation(keepStep) {
    const up = S.up;
    $('#uploadBody').insertAdjacentHTML('afterbegin', '<p class="muted" id="valMsg">Checking rows and matching places…</p>');
    await new Promise(r => setTimeout(r, 30));
    up.batchId = up.batchId || ('b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    up.recs = I.toRecords(up.parsed, up.map, up.batchId);
    await ensureStatesFor(up.recs);
    up.val = I.validate(up.recs, { geo: S.geo, fixes: S.fixes, existingKeys: S.keys, today: S.today });
    for (const row of up.val.rows) row.rec.g = resolveOne(row.rec);
    up.step = keepStep === true ? 3 : 2;
    renderUpload();
  }
  async function saveUpload() {
    const up = S.up, btn = $('#upSave');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const keep = up.val.rows.filter(r => r.status === 'new' || (up.keepDup && r.status === 'duplicate')).map(r => r.rec);
      const packed = keep.map(I.packRecord);
      const chunks = Store.chunkRecords(up.batchId, packed, I.FIELDS);
      const dates = keep.map(r => r.d).sort();
      const s = up.val.summary;
      const meta = { id: up.batchId, fileName: up.file.name, uploadedAt: new Date().toISOString(), from: dates[0], to: dates[dates.length - 1], rows: keep.length, chunks: chunks.length,
        period: up.parsed.period, sheet: up.parsed.sheet, summary: { read: s.read, saved: keep.length, dupInFile: up.keepDup ? 0 : s.dupInFile, existing: s.existing, rejected: s.rejected, unresolved: s.unresolved, approx: s.approx } };
      S.selfWrite = Date.now();
      await S.store.saveBatch(meta, chunks);
      up.saved = keep.length;
      await loadAll(); populateFilters();
      up.step = 4; renderUpload();
    } catch (e) {
      console.error(e); btn.disabled = false; btn.textContent = 'Save';
      toast(e && e.code === 'quota_exceeded' ? 'Storage is full. Delete old uploads under Data quality, then try again.' : 'Save failed: ' + (e.message || e.code || e), 7000);
    }
  }

  // ---------- reports ----------
  function exportVisits() {
    const rows = visitRows(S.cur).map(r => {
      const x = r._r;
      return { Date: x.d, Time: x.t, Staff: x.u, Designation: x.dg, Headquarter: x.hq, Manager: x.m, Customer: x.c, Phone: x.p, Activity: x.a, 'Activity group': I.ACTIVITY_CLASSES[x.ac].label, 'New/old': x.vt,
        'State (recorded)': x.st, 'District (recorded)': x.di, 'Taluka (recorded)': x.ta, 'Village (recorded)': x.vi, 'Mapped place': x.g.place, 'Mapped taluka': r.sub, 'Mapped district': r.dist,
        'Location precision': PREC_LABEL[x.g.prec], Latitude: x.g.lat, Longitude: x.g.lon, 'Mapping note': x.g.note };
    });
    saveFile(`visits_${stamp()}.xlsx`, xlsxBlob([{ name: 'Visits', rows }]));
  }
  function exportStaff() {
    const rows = A.byUser(S.curAll, { from: S.F.from, to: S.F.to }).map(r => ({ Staff: r.user, Designation: r.dg, Headquarter: r.hq, Manager: r.m, 'Customer visits': r.visits, 'Farmer visits': r.farmer, 'Dealer visits': r.dealer, Trials: r.trial, 'Field days / meetings': r.event,
      'Night halts / other': r.nonCustomer, 'Active days': r.activeDays, 'Visits per active day': +r.perActiveDay.toFixed(2), 'Working days (Mon-Sat)': r.workingDays, 'Visits per working day': r.perWorkingDay === null ? '' : +r.perWorkingDay.toFixed(2),
      Customers: r.customers, 'New customers': r.newCust, 'Repeat customers': r.repeat, Villages: r.villages, Talukas: r.talukas, Districts: r.districts, States: r.states, '% mapped to village': Math.round(r.precisePct * 100), 'Spread (km)': r.spreadKm === null ? '' : Math.round(r.spreadKm), 'Last entry': r.lastDate }));
    saveFile(`staff_performance_${stamp()}.xlsx`, xlsxBlob([{ name: 'Staff', rows }]));
  }
  function exportCoverage() {
    const cust = S.cur.filter(r => r.cust);
    const byD = [...A.countBy(cust, r => r.g.did)].map(([d, n]) => ({ State: S.geo.states[S.geo.districts[d].st].name, District: S.geo.districts[d].name, 'Customer visits': n, Staff: A.uniq(cust.filter(r => r.g.did === d), r => r.u).size, Villages: A.uniq(cust.filter(r => r.g.did === d), A.villageKey).size }));
    const byT = [...A.countBy(cust, r => r.g.sid)].filter(([s]) => s !== null && s !== undefined).map(([s, n]) => ({ District: S.geo.districts[S.geo.subs[s].did].name, Taluka: S.geo.subs[s].name, 'Customer visits': n, Staff: A.uniq(cust.filter(r => r.g.sid === s), r => r.u).size }));
    const gaps = A.coverageGaps(S.cur, S.geo, { st: S.F.st, did: S.F.did }).flatMap(g => g.zero.map(z => ({ District: g.name, Taluka: z, 'Recorded customer visits': 0 })));
    saveFile(`coverage_${stamp()}.xlsx`, xlsxBlob([{ name: 'Districts', rows: byD }, { name: 'Talukas', rows: byT }, { name: 'Talukas with no visit', rows: gaps }]));
  }
  function exportFlags() {
    const f = A.anomalies(S.curAll);
    saveFile(`review_flags_${stamp()}.xlsx`, xlsxBlob([
      { name: 'Joint visits', rows: f.joint.map(g => ({ Date: g.date, Phone: g.phone, Customer: g.recs[0].c, Staff: g.users.join('; ') })) },
      { name: 'Phone-name conflicts', rows: f.phoneNames.map(x => ({ Phone: x.phone, Names: x.names.join('; ') })) },
      { name: 'Non-customer entries', rows: f.nonCustomer.map(r => ({ Date: r.d, Staff: r.u, Activity: r.a, Customer: r.c })) },
      { name: 'Own name as customer', rows: f.selfLogged.map(r => ({ Date: r.d, Staff: r.u, Activity: r.a, Customer: r.c })) },
      { name: 'High-volume days', rows: f.highVolume.map(x => ({ Date: x.date, Staff: x.user, 'Customer visits': x.visits })) },
      { name: 'Far-apart same day', rows: f.farApart.map(x => ({ Date: x.date, Staff: x.user, 'Distance km': Math.round(x.km), From: x.a, To: x.b })) },
      { name: 'Unresolved locations', rows: S.curAll.filter(r => r.g.prec === 'none').map(r => ({ Date: r.d, Staff: r.u, Village: r.vi, Taluka: r.ta, District: r.di, State: r.st, Headquarter: r.hq })) }
    ]));
  }
  function exportCSV() {
    const rows = visitRows(S.cur).map(r => [r.d, r.u, r._r.dg, r._r.hq, r._r.m, r.c, r.p, r.a, r.vt, r._r.st, r._r.di, r._r.ta, r.vi, r.place, r.sub, r.dist, PREC_LABEL[r.prec], r._r.g.lat, r._r.g.lon]);
    const head = ['Date', 'Staff', 'Designation', 'Headquarter', 'Manager', 'Customer', 'Phone', 'Activity', 'New/old', 'State', 'District', 'Taluka', 'Village', 'Mapped place', 'Mapped taluka', 'Mapped district', 'Precision', 'Latitude', 'Longitude'];
    const q = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    saveFile(`visits_${stamp()}.csv`, new Blob(['\ufeff' + [head, ...rows].map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' }));
  }
  function summaryText() {
    const k = A.kpis(S.cur), prev = prevPeriod();
    const scope = S.F.sid !== null ? S.geo.subs[S.F.sid].name : S.F.did ? S.geo.districts[S.F.did].name : S.F.st ? S.geo.states[S.F.st].name : 'All India';
    const lines = A.insights({ recs: S.cur, all: S.records, F: S.F, geo: S.geo, maxDate: S.maxDate, today: S.today, k, prev });
    return { title: `Field visit summary: ${scope}, ${A.fmtDate(S.F.from)} – ${A.fmtDate(S.F.to)}${S.F.users.length ? ', ' + S.F.users[0] : ''}`, k, lines };
  }
  function exportSummaryHtml() {
    const s = summaryText();
    const staff = A.byUser(S.curAll, { from: S.F.from, to: S.F.to });
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(s.title)}</title><style>body{font-family:Arial,sans-serif;max-width:900px;margin:30px auto;color:#15211C;font-size:13px}h1{font-size:20px}table{border-collapse:collapse;width:100%;margin-top:10px}td,th{border-bottom:1px solid #ccc;padding:5px 8px;text-align:left}th{background:#f3f5f4}.r{text-align:right}.k{display:inline-block;margin:0 18px 10px 0}.k b{display:block;font-size:22px}</style></head><body>
      <h1>${esc(s.title)}</h1><p style="color:#666">Generated ${new Date().toLocaleString('en-IN')} from CRM uploads. ${S.F.customerOnly ? 'Customer visits only (night halts and other entries excluded).' : 'All entries included.'}</p>
      <div>${[['Customer visits', s.k.visits], ['Customers', s.k.customers], ['Staff active', s.k.staff], ['Districts', s.k.districts], ['Talukas', s.k.talukas], ['Villages/towns', s.k.villages]].map(([l, v]) => `<span class="k"><b>${fmt(v)}</b>${l}</span>`).join('')}</div>
      <h2 style="font-size:15px">Findings</h2><ul>${s.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      <h2 style="font-size:15px">Staff</h2><table><tr><th>Staff</th><th>Designation</th><th class="r">Customer visits</th><th class="r">Active days</th><th class="r">Per active day</th><th class="r">Customers</th><th class="r">Villages</th><th class="r">Talukas</th></tr>
      ${staff.map(r => `<tr><td>${esc(r.user)}</td><td>${esc(r.dg)}</td><td class="r">${r.visits}</td><td class="r">${r.activeDays}</td><td class="r">${fmt1(r.perActiveDay)}</td><td class="r">${r.customers}</td><td class="r">${r.villages}</td><td class="r">${r.talukas}</td></tr>`).join('')}</table>
      <p style="color:#666;margin-top:20px">Locations are self-reported in the CRM; the export has no GPS or visit times, so this report shows where visits were logged, not proof they happened. Boundaries: LGD/Bharatmaps (Govt. of India).</p></body></html>`;
    saveFile(`field_visit_summary_${stamp()}.html`, new Blob([html], { type: 'text/html' }));
  }
  function templateXlsx() {
    saveFile('territory_plan_template.xlsx', xlsxBlob([
      { name: 'Territory plan', aoa: [['Representative', 'State', 'District', 'Taluka', 'Village'], ['Omkar Nath Sheshdhar Tiwari', 'Uttar Pradesh', 'Mirzapur', 'Lalganj', ''], ['Omkar Nath Sheshdhar Tiwari', 'Uttar Pradesh', 'Mirzapur', 'Marihan', 'Danti']] },
      { name: 'How to fill', aoa: [['One row per assigned area.'], ['Representative must match the "Submitted User" name in the CRM export.'], ['Leave Village empty to assign a whole taluka; leave Taluka empty to assign a whole district.'], ['The two rows on the first sheet are examples; replace them.']] }
    ]));
  }
  function renderReports() {
    const items = [
      ['Visit list (filtered)', 'Every row with recorded and mapped location, precision and coordinates', 'Excel', exportVisits],
      ['Visit list (filtered)', 'Same as above for other tools', 'CSV', exportCSV],
      ['Staff performance', 'Visits, days, customers, villages, talukas and spread per person', 'Excel', exportStaff],
      ['Geographic coverage', 'Visits by district and taluka, plus talukas with no recorded visit', 'Excel', exportCoverage],
      ['Review flags', 'Joint visits, name conflicts, non-customer entries, outliers, unresolved places', 'Excel', exportFlags],
      ['Management summary', 'Print-ready page; open it and print to PDF', 'HTML', exportSummaryHtml],
      ['Territory plan template', 'Fill in and upload under Coverage gaps', 'Excel', templateXlsx]
    ];
    const t = $('#reportTable');
    t.innerHTML = `<tbody>${items.map((it, i) => `<tr><td><b>${esc(it[0])}</b><br><span class="muted">${esc(it[1])}</span></td><td class="r"><button class="btn" data-i="${i}">Download ${it[2]}</button></td></tr>`).join('')}</tbody>`;
    t.querySelectorAll('button').forEach(b => b.addEventListener('click', () => items[+b.dataset.i][3]()));
    const s = summaryText();
    $('#summaryBody').innerHTML = `<p style="margin-top:0"><b>${esc(s.title)}</b></p><ul class="insights">${s.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul><p><button class="btn" id="printBtn">Print this page</button></p>`;
    $('#printBtn').onclick = () => { try { window.print(); } catch (e) { toast('Printing is blocked here; download the HTML summary instead.'); } };
  }

  // ---------- settings / sources ----------
  function renderSettings() {
    const precCounts = A.countBy(S.records, r => r.g.prec);
    const active = A.uniq(S.records, r => r.g.did);
    const missingGaz = [...active].filter(d => !S.geo.hasDistrictGaz(d)).map(d => S.geo.districts[d].name);
    $('#settingsLeft').innerHTML = `
      <div class="panel"><h2>Where uploads are stored</h2><div class="body">
        <p style="margin-top:0"><span class="chip"><i></i>${esc($('#storeChip span').textContent)}</span></p>
        <p>${S.store.mode === 'drive' ? 'Uploads, location fixes and the territory plan are saved in the team Google Drive (folder "Field Visit Atlas data" of the account that deployed the Apps Script). Everyone who opens this page with the access key sees the same data and can upload or delete. Customer names and phone numbers are included, so give the key only to people who should see them, and change it in the Apps Script settings when someone leaves.'
          : S.store.mode === 'shared' ? 'Uploads, location fixes and the territory plan are saved with this artifact on claude.ai. Everyone you share it with sees the same data; people with Contributor access or above can upload and delete. Customer names and phone numbers are included, so share accordingly.'
          : S.store.mode === 'browser' ? 'Uploads are saved in this browser (IndexedDB). Other people and other browsers do not see them. Clearing site data deletes them. For a shared team version, connect a database (see README: Supabase adapter).'
          : 'Storage is not available, so uploads last only until the page closes.'}</p>
        <p class="muted">${fmt(S.records.length)} rows from ${S.batches.length} upload(s). Location fixes saved: ${Object.keys(S.fixes).length}.</p>
        <div id="migrateBox"></div>
        <p>${S.store.mode === 'drive' ? '<button class="btn" id="forgetKey">Forget the access key on this browser</button> ' : ''}<button class="btn danger" id="clearAll">Delete all uploaded data</button></p></div></div>
      <div class="panel"><h2>What this data cannot tell you</h2><div class="body"><ul class="insights">
        <li>Whether a visit happened. The CRM export has no GPS coordinates, check-in times or photos; every location is what the person typed or picked.</li>
        <li>Visit order, travel distance or time spent. Only dates are present, so routes and time-of-day patterns cannot be computed.</li>
        <li>Missed visits. Without a territory plan or visit schedule, empty areas are "no recorded visit", not confirmed misses.</li>
        <li>Visit outcome. There is no status, product or remarks column, so nothing here measures what a visit achieved.</li>
        <li>"Updated date" is treated as the visit date. If the CRM changes that date when a record is edited, trends shift.</li></ul>
        <p class="muted">Adding GPS and timestamp capture at check-in in the CRM app would close the first two gaps; the app already reads Latitude, Longitude and Visit time columns if they appear.</p></div></div>`;
    $('#settingsRight').innerHTML = `
      <div class="panel"><h2>Map data and licences</h2><div class="body" style="font-size:13.5px">
        <p style="margin-top:0"><b>State, district and taluka boundaries:</b> Local Government Directory / Bharatmaps (National Informatics Centre, Government of India), republished by ramSeraph/indian_admin_boundaries under CC0 1.0 with attribution to DataMeet and the original government source. The national outline follows the official depiction of India. Simplified for web display, so borders are approximate at street level.</p>
        <p><b>Village locations:</b> Census of India 2011 village points, from the same repository (CC0 1.0). Village names and boundaries change; newer villages may be missing.</p>
        <p><b>Town locations:</b> Swachh Bharat Mission urban local body boundaries, from the same repository (CC0 1.0), plus cities missing from that list from GeoNames (© GeoNames, CC BY 4.0).</p>
        <p><b>Optional base maps:</b> OpenStreetMap tiles (© OpenStreetMap contributors, ODbL; light use only under the OSMF tile policy) and Esri World Imagery (check Esri terms before commercial use). OpenStreetMap shows some borders differently from the official map; the official boundary overlay stays on top. In the claude.ai version these tiles are blocked, so the official boundaries are the only base map.</p>
        <p class="muted">Village lists are bundled for ${S.bundledStates.map(s => esc(S.geo.states[s].name)).join(', ') || 'no states'}${location.protocol.startsWith('http') ? '; other states load on demand when the page is served from a web host' : ''}. ${missingGaz.length ? 'Districts in your data without a bundled list (placed at taluka centre unless the full list can load): ' + missingGaz.map(esc).join(', ') + '.' : 'All districts in your data have a village list.'}</p></div></div>
      <div class="panel"><h2>Location precision across all data</h2><div class="body"><ul class="minilist">${['gps', 'manual', 'village', 'town', 'taluka', 'district', 'none'].filter(k => precCounts.get(k)).map(k => `<li><span><span class="prec ${k}">${PREC_LABEL[k]}</span></span><span class="num">${fmt(precCounts.get(k))} (${pct(precCounts.get(k) / S.records.length)})</span></li>`).join('')}</ul>
        <p class="muted">Village matching tolerates common spelling variants (w/v, sh/s, aa/a) but rejects ambiguous matches rather than guessing. Rings on the map mark entries placed at a taluka or district centre.</p></div></div>`;
    if ($('#forgetKey')) $('#forgetKey').onclick = () => { Store.rememberKey(''); location.reload(); };
    if (S.store.mode === 'drive') renderMigrate();
    const btn = $('#clearAll');
    btn.onclick = async () => {
      if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = 'Click again to delete everything'; setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Delete all uploaded data'; }, 5000); return; }
      btn.disabled = true; btn.textContent = 'Deleting…'; S.selfWrite = Date.now();
      for (const b of S.batches) await S.store.deleteBatch(b.id);
      await loadAll(); populateFilters(); setPeriod('all'); renderSettings(); toast('All uploads deleted');
    };
  }

  // one-time copy of uploads that were saved in this browser before shared storage was switched on
  async function localLeftovers() {
    try {
      const l = new Store.IdbStore(); await l.init();
      const have = new Set(S.batches.map(b => b.id));
      const todo = (await l.listBatches()).filter(b => !have.has(b.id));
      const fixes = (await l.getKV('geoFixes')) || {};
      const newFixes = Object.keys(fixes).filter(k => !S.fixes[k]).length;
      return { l, todo, fixes, newFixes };
    } catch (e) { return { todo: [], newFixes: 0 }; }
  }
  async function renderMigrate() {
    const box = $('#migrateBox'); if (!box) return;
    const x = await localLeftovers();
    if (!x.todo.length && !x.newFixes) { box.innerHTML = ''; return; }
    const rows = x.todo.reduce((a, b) => a + (b.rows || 0), 0);
    box.innerHTML = `<div class="note info" style="margin:10px 0">This browser still holds ${x.todo.length ? `${x.todo.length} upload(s) with ${fmt(rows)} rows` : ''}${x.todo.length && x.newFixes ? ' and ' : ''}${x.newFixes ? `${x.newFixes} location fix(es)` : ''} saved before shared storage was switched on. Copy them so the team sees them. Rows already in the shared data are not counted twice.</div>
      <p><button class="btn primary" id="migrateBtn">Copy to shared storage</button></p>`;
    $('#migrateBtn').onclick = async () => {
      const btn = $('#migrateBtn'); btn.disabled = true; btn.textContent = 'Copying…'; S.selfWrite = Date.now();
      try {
        const recs = await x.l.loadRecords();
        for (const b of x.todo) { const chunks = recs.filter(c => c.b === b.id).sort((p, q) => p.n - q.n); if (chunks.length) await S.store.saveBatch(b, chunks); }
        if (x.newFixes) { for (const [k, v] of Object.entries(x.fixes)) if (!S.fixes[k]) S.fixes[k] = v; await S.store.setKV('geoFixes', S.fixes); }
        const plan = await x.l.getKV('territoryPlan'); if (plan && plan.length && !S.plan.length) await S.store.setKV('territoryPlan', plan);
        await loadAll(); populateFilters(); refresh(); toast('Copied to shared storage');
      } catch (e) { toast('Copy failed: ' + (e.message || e), 7000); btn.disabled = false; btn.textContent = 'Copy to shared storage'; }
    };
  }

  function bindStatic() {
    $$('#tabs button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
    $('#fileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) readFile(f); e.target.value = ''; });
    $('#detailClose').addEventListener('click', () => { S.selected = null; renderDetail(); });
    $('#expVisits').addEventListener('click', exportVisits);
    $('#expStaff').addEventListener('click', exportStaff);
    $('#expFlags').addEventListener('click', exportFlags);
    $('#fixExport').addEventListener('click', exportFixes);
    $('#fixImportFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) importFixes(f); e.target.value = ''; });
    $('#tplBtn').addEventListener('click', templateXlsx);
    $('#planFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadPlanFile(f); e.target.value = ''; });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', () => refresh());
  }

  function start() {
    if (!window.L || !window.Chart || !window.XLSX || !window.topojson) {
      $('#loading').innerHTML = '<b>Some libraries did not load.</b><br>Check the internet connection (the page loads Leaflet, Chart.js and SheetJS from cdn.jsdelivr.net) and reload.';
      return;
    }
    boot().catch(e => { console.error(e); $('#loading').textContent = 'Could not start: ' + (e.message || e); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
