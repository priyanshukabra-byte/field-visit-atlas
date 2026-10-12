/* geo.js — place-name normalisation and hierarchical resolution
   State -> District -> Sub-district (taluka/tehsil/block) -> Village / Town.
   Never guesses silently: every result carries a precision level and a score. */
(function (G) {
  'use strict';

  // ---------- text normalisation ----------
  function norm(s) {
    if (s === null || s === undefined) return '';
    return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[()]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }
  function compact(s) { return norm(s).replace(/ /g, ''); }
  // consonant skeleton tuned for Latin transliteration of Indian place names
  function skel(s) {
    let t = compact(s);
    if (!t) return '';
    t = t.replace(/ph/g, 'f').replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k').replace(/x/g, 'ks')
      .replace(/([bcdgjkpt])h/g, '$1').replace(/sh/g, 's');
    const first = t[0];
    let rest = t.slice(1).replace(/[aeiouyh]/g, '');
    let out = first + rest;
    return out.replace(/(.)\1+/g, '$1');
  }
  function jaroWinkler(a, b) {
    if (a === b) return 1;
    const la = a.length, lb = b.length;
    if (!la || !lb) return 0;
    const md = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
    const am = new Array(la).fill(false), bm = new Array(lb).fill(false);
    let m = 0;
    for (let i = 0; i < la; i++) {
      const lo = Math.max(0, i - md), hi = Math.min(i + md + 1, lb);
      for (let j = lo; j < hi; j++) { if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; m++; break; } }
    }
    if (!m) return 0;
    let t = 0, k = 0;
    for (let i = 0; i < la; i++) { if (am[i]) { while (!bm[k]) k++; if (a[i] !== b[k]) t++; k++; } }
    const j = (m / la + m / lb + (m - t / 2) / m) / 3;
    let p = 0; while (p < 4 && a[p] === b[p]) p++;
    return j + p * 0.1 * (1 - j);
  }
  function lev(a, b) {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }
  // similarity between two prepared keys {c: compact, k: skeleton, t: first token}
  // average of Jaro-Winkler and edit-distance ratio; transliteration skeleton and leading-word rules lift true variants
  function sim(A, B) {
    if (!A.c || !B.c) return 0;
    if (A.c === B.c) return 1;
    const la = A.c.length, lb = B.c.length, ratio = Math.min(la, lb) / Math.max(la, lb);
    let s = (jaroWinkler(A.c, B.c) + (1 - lev(A.c, B.c) / Math.max(la, lb))) / 2;
    if (A.k && A.k === B.k && A.k.length >= 3 && ratio >= 0.8) s = Math.max(s, 0.93);
    // "Pachnaur" vs "Pachnaur Murahi", "Manegaon Bajar" vs "Manegaon"
    const short = la <= lb ? A : B, long = la <= lb ? B : A;
    if (short.c.length >= 5 && short.n === 1 && long.n > 1 && long.t === short.c) s = Math.max(s, 0.9);
    // compare without qualifier words ("Shegaon Bk." vs "shegaoan", "Lar road" vs "Lar")
    const ab = A.b || A.c, bb = B.b || B.c;
    if ((A.b || B.b) && ab.length >= 3 && bb.length >= 3) {
      if (ab === bb) s = Math.max(s, 0.95);
      else { const m = Math.max(ab.length, bb.length); s = Math.max(s, 0.97 * (jaroWinkler(ab, bb) + (1 - lev(ab, bb) / m)) / 2); }
    }
    // abbreviated words: "Nandgaon kh" vs "Nandgaon Khandeshwar", "Chandur rly" vs "Chandur Railway"
    if (A.n > 1 && A.n === B.n && A.toks[0] === B.toks[0] && A.toks[0].length >= 4) {
      let ok = true;
      for (let i = 1; i < A.n; i++) { const x = A.toks[i], y = B.toks[i]; if (!(x === y || abbrevOf(x, y) || abbrevOf(y, x))) { ok = false; break; } }
      if (ok) s = Math.max(s, 0.92);
    }
    return s;
  }
  // words that qualify a place rather than name it: Budruk/Khurd parts of a village, market, crossing, road, station...
  const QUALIFIERS = new Set(['bk', 'bu', 'budruk', 'bujruk', 'kh', 'khurd', 'kalan', 'buzurg', 'bujurg', 'part', 'chauraha', 'chowk', 'chouk', 'chok', 'tiraha',
    'fata', 'phata', 'naka', 'bazar', 'bazaar', 'market', 'mandi', 'road', 'rd', 'station', 'stn', 'rly', 'railway', 'camp', 'colony', 'more', 'mod', 'stand', 'gate']);
  function key(s) {
    const n = norm(s); const toks = n ? n.split(' ') : [];
    let core = toks.filter(t => !QUALIFIERS.has(t));
    if (core.length === 1 && /^(.{4,})(haat|hat)$/.test(core[0])) core = [core[0].replace(/(haat|hat)$/, '')]; // "kurmahat" = Kurma haat (market)
    const b = core.join('');
    return { c: toks.join(''), k: skel(s), t: toks[0] || '', n: toks.length, toks, b: b && b !== toks.join('') && b.length >= 3 ? b : '' };
  }
  // "kh" -> "khandeshwar", "rly" -> "railway": prefix or in-order letters with the same first letter
  function abbrevOf(a, w) {
    if (a.length < 2 || a.length >= w.length || a[0] !== w[0]) return false;
    let i = 0; for (const ch of w) { if (ch === a[i]) i++; if (i === a.length) return true; }
    return false;
  }

  // ---------- known aliases (renamed or alternate district names) ----------
  const DISTRICT_ALIASES = {
    kawardha: 'kabirdham', ahilyanagar: 'ahmednagar', ahmadnagar: 'ahmednagar', dharashiv: 'osmanabad',
    chhatrapatisambhajinagar: 'aurangabad', sambhajinagar: 'aurangabad', subarnapur: 'sonepur', sonpur: 'sonepur',
    santravidasnagar: 'bhadohi', bhadoi: 'bhadohi', raebareli: 'raebareli', raebareilly: 'raebareli', raibareli: 'raebareli',
    gorakpur: 'gorakhpur', kalhandi: 'kalahandi', allahabad: 'prayagraj', faizabad: 'ayodhya',
    gurgaon: 'gurugram', balasore: 'baleshwar', baleswar: 'baleshwar', bolangir: 'balangir', keonjhar: 'kendujhar', hoshangabad: 'narmadapuram', santkabirnagar: 'santkabeernagar'
  };
  // renamed towns and towns absorbed into a bigger municipality (village name as recorded -> town name in the reference list)
  const TOWN_ALIASES = {
    dharashiv: 'osmanabad', badnera: 'amravati', paratwada: 'achalpur', chhatrapatisambhajinagar: 'aurangabad', sambhajinagar: 'aurangabad',
    ahilyanagar: 'ahmednagar', prayagraj: 'allahabad', ayodhya: 'faizabad', gurugram: 'gurgaon', narmadapuram: 'hoshangabad', kashi: 'varanasi', banaras: 'varanasi', benaras: 'varanasi'
  };
  // sub-district names that differ between CRM and LGD
  const SUB_ALIASES = { beed: 'bid', ahilyanagar: 'ahmednagar', dharashiv: 'osmanabad' };
  const STATE_ALIASES = {
    orissa: 'odisha', uttaranchal: 'uttarakhand', pondicherry: 'puducherry', chattisgarh: 'chhattisgarh', chhatisgarh: 'chhattisgarh',
    up: 'uttarpradesh', mp: 'madhyapradesh', mh: 'maharashtra', cg: 'chhattisgarh', od: 'odisha', br: 'bihar', ts: 'telangana', tg: 'telangana',
    rj: 'rajasthan', jammukashmir: 'jammukashmir', jammuandkashmir: 'jammukashmir', andamanandnicobarislands: 'andamannicobarislands'
  };

  // towns: "name|x|y|sid;..."   villages: "<sid36>:<name>,<x36>,<y36>,<pop>|...;<sid36>:..."
  function decodeTowns(str) {
    if (!str) return [];
    return str.split(';').map(p => {
      const a = p.split('|');
      const o = { n: a[0], lon: 68 + (+a[1]) / 1e4, lat: 6 + (+a[2]) / 1e4, sid: +a[3], pop: 9 };
      o.key = key(o.n); return o;
    });
  }
  function decodeVillages(str) {
    if (!str) return [];
    const out = [];
    for (const grp of str.split(';')) {
      const c = grp.indexOf(':'); const sid = parseInt(grp.slice(0, c), 36);
      for (const e of grp.slice(c + 1).split('|')) {
        const a = e.split(',');
        const o = { n: a[0], lon: 68 + parseInt(a[1], 36) / 1e4, lat: 6 + parseInt(a[2], 36) / 1e4, sid, pop: +a[3] };
        o.key = key(o.n); out.push(o);
        // Census names carry aliases: "Ramgarh Urf Rajahi", "Dabha(Dava)", "Nawagaon-2 (Nawagaon)"
        const alts = [];
        if (/\burf\b/i.test(o.n)) o.n.split(/\burf\b/i).forEach(x => alts.push(x));
        const par = o.n.match(/^(.*?)\s*\((.+)\)\s*$/); if (par) { alts.push(par[1]); alts.push(par[2]); }
        for (const x of alts) { const t = x.replace(/[-\d]+$/, '').trim(); if (t.length >= 3 && norm(t) !== norm(o.n)) out.push(Object.assign({}, o, { key: key(t), alias: t })); }
      }
    }
    return out;
  }

  class GeoIndex {
    constructor() {
      this.states = {}; this.districts = {}; this.subs = {};
      this.byStateKey = {}; this.distByState = {}; this.subByDist = {};
      this.townRaw = {}; this.gazRaw = {}; this.gazParsed = {}; this.townParsed = {};
      this.loadedStates = new Set(); this.gazLoader = null; this.cache = new Map();
    }
    init(meta, topo, towns, gazBundle) {
      for (const [id, name] of Object.entries(meta.states)) {
        const s = { id: +id, name, key: key(name) };
        this.states[id] = s; this.byStateKey[s.key.c] = s;
      }
      for (const [id, v] of Object.entries(meta.districts)) {
        const d = { id: +id, name: v[0], st: v[1], lon: v[2], lat: v[3], key: key(v[0]) };
        this.districts[id] = d; (this.distByState[d.st] = this.distByState[d.st] || []).push(d);
      }
      for (const g of topo.objects.subdistricts.geometries) {
        const p = g.properties; const s = { id: p.id, name: p.n, did: p.d, st: p.s, lon: p.cx, lat: p.cy, key: key(p.n) };
        this.subs[s.id] = s; (this.subByDist[s.did] = this.subByDist[s.did] || []).push(s);
      }
      this.townRaw = towns || {};
      if (gazBundle) Object.assign(this.gazRaw, gazBundle);
    }
    addGazetteer(obj) { Object.assign(this.gazRaw, obj); for (const k in obj) delete this.gazParsed[k]; this.cache.clear(); }
    hasDistrictGaz(did) { return Object.prototype.hasOwnProperty.call(this.gazRaw, did); }
    villages(did) {
      if (!this.gazParsed[did]) this.gazParsed[did] = decodeVillages(this.gazRaw[did]);
      return this.gazParsed[did];
    }
    towns(did) {
      if (!this.townParsed[did]) this.townParsed[did] = decodeTowns(this.townRaw[did]);
      return this.townParsed[did];
    }
    // optional lazy loading of per-state gazetteer files (GitHub/Vercel deployment)
    async ensureState(st) {
      if (!this.gazLoader || this.loadedStates.has(st)) return;
      this.loadedStates.add(st);
      const missing = (this.distByState[st] || []).some(d => !this.hasDistrictGaz(d.id));
      if (!missing) return;
      try { const obj = await this.gazLoader(st); if (obj) { for (const k in obj) if (!this.hasDistrictGaz(k)) this.gazRaw[k] = obj[k]; this.cache.clear(); } }
      catch (e) { /* offline or blocked: fall back to bundled districts */ }
    }

    matchState(raw) {
      const k = key(raw); if (!k.c) return null;
      const alias = STATE_ALIASES[k.c]; const c = alias || k.c;
      if (this.byStateKey[c]) return this.byStateKey[c];
      let best = null, bs = 0;
      for (const s of Object.values(this.states)) { const v = sim(k, s.key); if (v > bs) { bs = v; best = s; } }
      return bs >= 0.9 ? best : null;
    }
    matchDistrict(raw, st) {
      const k = key(raw); if (!k.c) return null;
      const target = DISTRICT_ALIASES[k.c] ? key(DISTRICT_ALIASES[k.c]) : k;
      const pool = st ? (this.distByState[st] || []) : Object.values(this.districts);
      let best = null, bs = 0, second = 0;
      for (const d of pool) {
        const v = d.key.c === target.c ? 1 : sim(target, d.key);
        if (v > bs) { second = bs; bs = v; best = d; } else if (v > second) second = v;
      }
      if (!best) return null;
      if (bs === 1) return { d: best, score: 1 };
      if (bs >= 0.9 && bs - second >= 0.03) return { d: best, score: bs };
      return null;
    }
    matchSub(raw, did) {
      let k = key(raw); if (!k.c) return null;
      if (SUB_ALIASES[k.c]) k = key(SUB_ALIASES[k.c]);
      const subs0 = this.subByDist[did] || [];
      // HQ taluka recorded under the district's name, LGD calls it "Sadar" (common in UP, Bihar, Odisha)
      const dist = this.districts[did];
      if (dist && sim(k, dist.key) >= 0.95 && !subs0.some(x => x.key.c === k.c)) {
        const sadar = subs0.find(x => /^sadar$|sadar$/.test(x.key.c));
        if (sadar) return { s: sadar, score: 0.95 };
      }
      let best = null, bs = 0, second = 0;
      for (const s of (this.subByDist[did] || [])) {
        let v = sim(k, s.key);
        // "Nagpur Urban" vs "Nagpur (Urban)" etc. are equal after compaction; also accept prefix like "Basavakalyana" ~ "Basavakalyan"
        if (v > bs) { second = bs; bs = v; best = s; } else if (v > second) second = v;
      }
      if (best && (bs === 1 || (bs >= 0.88 && bs - second >= 0.02))) return { s: best, score: bs };
      return null;
    }
    bestPlace(k, list, sidPref) {
      let best = null, bs = 0, ties = [];
      for (const v of list) {
        let s = sim(k, v.key);
        if (sidPref !== undefined && v.sid === sidPref) s += 0.015; // prefer the stated taluka on near-ties
        if (s > bs + 1e-9) { bs = s; best = v; ties = [v]; } else if (Math.abs(s - bs) < 1e-9) ties.push(v);
      }
      if (ties.length > 1) ties.sort((a, b) => b.pop - a.pop), best = ties[0];
      return best ? { v: best, score: Math.min(1, bs), ties: ties.length } : null;
    }

    /* resolve one location. Returns
       {st, did, sid, lon, lat, prec: 'gps'|'manual'|'village'|'town'|'taluka'|'district'|'none', place, score, note} */
    resolve(r, fixes) {
      const ck = [norm(r.state), norm(r.district), norm(r.taluka), norm(r.village)].join('|');
      if (fixes && fixes[ck]) return Object.assign({ prec: 'manual', score: 1, note: 'Corrected by user' }, fixes[ck]);
      if (this.cache.has(ck)) return this.cache.get(ck);
      const out = this._resolve(r);
      this.cache.set(ck, out);
      return out;
    }
    _resolve(r) {
      const res = { st: null, did: null, sid: null, lon: null, lat: null, prec: 'none', place: '', score: 0, note: '' };
      let st = this.matchState(r.state);
      let dm = null;
      if (st) dm = this.matchDistrict(r.district, st.id);
      if (!dm && r.district) { // state missing or wrong: try all-India, accept only an unambiguous exact/alias hit
        const any = this.matchDistrict(r.district, null);
        if (any && any.score === 1) { dm = any; st = this.states[any.d.st]; res.note = st && r.state ? 'District found in a different state than recorded' : ''; }
      }
      if (st) res.st = st.id;
      if (!dm) { res.note = !r.state && !r.district ? 'State and district missing' : (st ? 'District not recognised' : 'State not recognised'); return res; }
      const d = dm.d; res.did = d.id; res.st = d.st;
      res.lon = d.lon; res.lat = d.lat; res.prec = 'district'; res.place = d.name; res.score = dm.score;
      let sm = r.taluka ? this.matchSub(r.taluka, d.id) : null;
      if (!sm && r.taluka) {
        // districts get split (e.g. Adilabad -> Nirmal): look for an unambiguous taluka elsewhere in the same state
        const tk = key(r.taluka); let hit = null, n = 0;
        for (const dd of (this.distByState[d.st] || [])) {
          if (dd.id === d.id) continue;
          for (const s of (this.subByDist[dd.id] || [])) { const v = sim(tk, s.key); if (v >= 0.97) { n++; if (!hit || v > hit.score) hit = { s, score: v }; } }
        }
        if (hit && n === 1) {
          const nd = this.districts[hit.s.did];
          sm = hit; res.did = nd.id; res.note = 'Taluka belongs to ' + nd.name + ' district (recorded district may be outdated)';
        }
      }
      const gd = this.districts[res.did];
      if (sm) { res.sid = sm.s.id; res.lon = sm.s.lon; res.lat = sm.s.lat; res.prec = 'taluka'; res.place = sm.s.name; }
      let vk = key(r.village);
      if (!vk.c) { res.note = res.note || 'Village missing'; return res; }
      const townAlias = TOWN_ALIASES[vk.c] || TOWN_ALIASES[vk.b];
      const tk = townAlias ? key(townAlias) : vk;
      const vils = this.villages(gd.id), towns = this.towns(gd.id);
      const inSub = sm ? vils.filter(v => v.sid === sm.s.id) : [];
      const tryList = [];
      // 1. village inside the recorded taluka (small pool, moderate threshold)
      if (inSub.length) { const b = this.bestPlace(vk, inSub); if (b && b.score >= 0.88) tryList.push({ b, prec: 'village', w: 0 }); }
      // 2. town in the district (renamed/merged towns via TOWN_ALIASES; "Nawapara" inside "Gobranawapara")
      if (towns.length) {
        let b = this.bestPlace(tk, towns, sm ? sm.s.id : undefined);
        if ((!b || b.score < 0.9) && tk.c.length >= 6) { const hit = towns.find(t => t.key.c.endsWith(tk.c) || t.key.c.startsWith(tk.c)); if (hit) b = { v: hit, score: 0.9, ties: 1 }; }
        if (b && b.score >= 0.9) tryList.push({ b, prec: 'town', w: townAlias ? 0.1 : 0.02 });
      }
      // 3. village anywhere in the district: large pool, so strict and never on a tie
      if (vils.length) { const b = this.bestPlace(vk, vils, sm ? sm.s.id : undefined); if (b && b.ties === 1 && b.score >= 0.95) tryList.push({ b, prec: 'village', w: -0.02 }); }
      if (tryList.length) {
        tryList.sort((x, y) => (y.b.score + y.w) - (x.b.score + x.w));
        const t = tryList[0], v = t.b.v;
        res.lon = v.lon; res.lat = v.lat; res.prec = t.prec; res.place = v.n; res.score = +t.b.score.toFixed(3);
        if (townAlias && t.prec === 'town') res.note = 'Recorded as "' + r.village + '", which is part of / renamed to ' + v.n;
        if (v.alias) res.note = (res.note ? res.note + '; ' : '') + 'Matched the alternative name "' + v.alias + '"';
        if (v.sid !== undefined && this.subs[v.sid]) {
          if (sm && v.sid !== sm.s.id) res.note = 'Matched in ' + this.subs[v.sid].name + ', not the recorded taluka';
          res.sid = v.sid;
        }
        if (t.b.ties > 1) res.note = (res.note ? res.note + '; ' : '') + t.b.ties + ' places share this name; the most populous was chosen';
        return res;
      }
      if (!this.hasDistrictGaz(gd.id)) res.note = 'Village list for this district not loaded — placed at ' + (sm ? 'taluka' : 'district') + ' centre';
      else res.note = (res.note ? res.note + '; ' : '') + 'Village not found — placed at ' + (sm ? 'taluka' : 'district') + ' centre';
      if (!sm && r.taluka) res.note += '; taluka "' + r.taluka + '" not recognised';
      return res;
    }
    // ranked suggestions for the manual fixer
    /* Suggestions for the manual fixer. Places in the recorded district (or the rep's HQ district) come first.
       Places elsewhere are only offered for near-exact names and are flagged, because the same village name repeats across India. */
    suggest(r, limit) {
      limit = limit || 6;
      const vk0 = key(r.village || r.taluka || '');
      if (!vk0.c) return [];
      const alias = TOWN_ALIASES[vk0.c] || TOWN_ALIASES[vk0.b];
      const vk = vk0;
      const st = this.matchState(r.state);
      const dm = st ? this.matchDistrict(r.district, st.id) : (r.district ? this.matchDistrict(r.district, null) : null);
      const pref = new Set(); if (dm) pref.add(dm.d.id);
      const hq = r.hq ? this.matchDistrict(r.hq, st ? st.id : null) : null; if (hq) pref.add(hq.d.id);
      const stId = st ? st.id : (dm ? dm.d.st : (hq ? hq.d.st : null));
      const current = r.current || null; // the record's present placement, to avoid offering it again
      const out = [], seen = new Set();
      const add = (s, v, did, prec, group) => {
        const id = did + '|' + v.n + '|' + v.sid + '|' + prec; if (seen.has(id)) return; seen.add(id);
        if (current && prec === 'taluka' && current.prec === 'taluka' && current.sid === v.sid) return;
        out.push({ s, v, did, prec, group });
      };
      const scan = (dids, min, group) => {
        for (const did of dids) {
          for (const v of this.villages(did)) { const s = sim(vk, v.key); if (s >= min) add(s, v, did, 'village', group); }
          for (const v of this.towns(did)) { const s = Math.max(sim(vk, v.key), alias ? sim(key(alias), v.key) : 0); if (s >= min) add(s, v, did, 'town', group); }
          for (const sb of (this.subByDist[did] || [])) { const s = sim(vk, sb.key); if (s >= Math.max(min, 0.9)) add(s, { n: sb.name, lon: sb.lon, lat: sb.lat, sid: sb.id, pop: 5 }, did, 'taluka', group); }
        }
      };
      if (pref.size) scan([...pref], 0.78, 0);
      // the district's headquarters town, for localities inside a city ("Akharaghat" in Muzaffarpur)
      if (dm) {
        const d = dm.d; const hqTown = this.towns(d.id).find(t => sim(d.key, t.key) >= 0.92);
        if (hqTown) add(0.5, hqTown, d.id, 'town', 1);
      }
      if (stId) scan((this.distByState[stId] || []).map(d => d.id).filter(d => !pref.has(d)), 0.95, 2);
      if (!pref.size && !stId) scan(Object.keys(this.gazRaw).map(Number), 0.95, 2);
      out.sort((a, b) => a.group - b.group || b.s - a.s || b.v.pop - a.v.pop);
      const recDist = dm ? dm.d.name : null;
      return out.slice(0, limit).map(o => {
        const dn = this.districts[o.did].name, sub = this.subs[o.v.sid] ? this.subs[o.v.sid].name : '';
        let label;
        if (o.prec === 'taluka') label = 'Taluka centre: ' + o.v.n + ', ' + dn;
        else if (o.group === 1) label = 'Town: ' + o.v.n + ' (district headquarters; use for a locality inside the city)';
        else label = o.v.n + (sub ? ', ' + sub : '') + ', ' + dn + (o.prec === 'town' ? ' (town)' : '');
        if (o.group === 2 && recDist) label = '⚠ ' + label + ' — different district from ' + recDist;
        return { label, st: this.districts[o.did].st, did: o.did, sid: o.v.sid, lon: o.v.lon, lat: o.v.lat, prec: o.prec, place: o.v.n, score: +o.s.toFixed(3), group: o.group };
      });
    }
  }

  G.Geo = { norm, compact, skel, jaroWinkler, sim, key, GeoIndex, DISTRICT_ALIASES, STATE_ALIASES };
})(typeof window !== 'undefined' ? window : globalThis);
