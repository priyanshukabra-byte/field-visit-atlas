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
    return s;
  }
  function key(s) { const n = norm(s); const toks = n ? n.split(' ') : []; return { c: toks.join(''), k: skel(s), t: toks[0] || '', n: toks.length }; }

  // ---------- known aliases (renamed or alternate district names) ----------
  const DISTRICT_ALIASES = {
    kawardha: 'kabirdham', ahilyanagar: 'ahmednagar', ahmadnagar: 'ahmednagar', dharashiv: 'osmanabad',
    chhatrapatisambhajinagar: 'aurangabad', sambhajinagar: 'aurangabad', subarnapur: 'sonepur', sonpur: 'sonepur',
    santravidasnagar: 'bhadohi', bhadoi: 'bhadohi', raebareli: 'raebareli', raebareilly: 'raebareli', raibareli: 'raebareli',
    gorakpur: 'gorakhpur', kalhandi: 'kalahandi', allahabad: 'prayagraj', faizabad: 'ayodhya',
    gurgaon: 'gurugram', balasore: 'baleshwar', baleswar: 'baleshwar', bolangir: 'balangir', keonjhar: 'kendujhar', hoshangabad: 'narmadapuram', santkabirnagar: 'santkabeernagar'
  };
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
      const k = key(raw); if (!k.c) return null;
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
      const vk = key(r.village);
      if (!vk.c) { res.note = res.note || 'Village missing'; return res; }
      const vils = this.villages(gd.id), towns = this.towns(gd.id);
      const inSub = sm ? vils.filter(v => v.sid === sm.s.id) : [];
      const tryList = [];
      // 1. village inside the recorded taluka (small pool, moderate threshold)
      if (inSub.length) { const b = this.bestPlace(vk, inSub); if (b && b.score >= 0.875) tryList.push({ b, prec: 'village', w: 0 }); }
      // 2. town (urban local body) in the district
      if (towns.length) { const b = this.bestPlace(vk, towns, sm ? sm.s.id : undefined); if (b && b.score >= 0.9) tryList.push({ b, prec: 'town', w: 0.02 }); }
      // 3. village anywhere in the district: large pool, so strict and never on a tie
      if (vils.length) { const b = this.bestPlace(vk, vils, sm ? sm.s.id : undefined); if (b && b.ties === 1 && b.score >= 0.95) tryList.push({ b, prec: 'village', w: -0.02 }); }
      if (tryList.length) {
        tryList.sort((x, y) => (y.b.score + y.w) - (x.b.score + x.w));
        const t = tryList[0], v = t.b.v;
        res.lon = v.lon; res.lat = v.lat; res.prec = t.prec; res.place = v.n; res.score = +t.b.score.toFixed(3);
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
    suggest(r, limit) {
      limit = limit || 6;
      const vk = key(r.village || r.taluka || '');
      if (!vk.c) return [];
      const st = this.matchState(r.state);
      const dm = st ? this.matchDistrict(r.district, st.id) : (r.district ? this.matchDistrict(r.district, null) : null);
      // districts to prefer: the recorded one, and the rep's headquarter district when it names one
      const pref = new Set(); if (dm) pref.add(dm.d.id);
      const hq = r.hq ? this.matchDistrict(r.hq, st ? st.id : null) || this.matchDistrict(r.hq, null) : null; if (hq) pref.add(hq.d.id);
      const anchors = [...pref].map(id => this.districts[id]);
      const stId = st ? st.id : (dm ? dm.d.st : (hq ? hq.d.st : null));
      let dids;
      if (pref.size) dids = [...pref];
      else if (stId) dids = (this.distByState[stId] || []).map(d => d.id);
      else dids = Object.keys(this.gazRaw).map(Number);
      const out = [], seen = new Set();
      const rank = (s, did, lat, lon) => {
        let x = s + (pref.has(did) ? 0.06 : 0);
        if (anchors.length) { const km = Math.min(...anchors.map(a => Math.hypot((a.lat - lat) * 111, (a.lon - lon) * 104))); x -= Math.min(0.08, km / 4000); }
        return x;
      };
      const scan = (list, min) => {
        for (const did of list) {
          for (const [pl, prec] of [[this.villages(did), 'village'], [this.towns(did), 'town'], [(this.subByDist[did] || []).map(s => ({ n: s.name, lon: s.lon, lat: s.lat, sid: s.id, pop: 5, key: s.key })), 'taluka']]) {
            for (const v of pl) {
              const s = sim(vk, v.key); const id = did + '|' + v.n + '|' + v.sid + '|' + prec;
              if (s >= min && !seen.has(id)) { seen.add(id); out.push({ s, r: rank(s, did, v.lat, v.lon), v, did, prec }); }
            }
          }
        }
      };
      scan(dids, 0.8);
      // the place may sit in a neighbouring district (wrong district recorded, or a nearby town): widen to the state
      if (stId && out.filter(o => o.s >= 0.9).length < 3) scan((this.distByState[stId] || []).map(d => d.id).filter(d => !dids.includes(d)), 0.9);
      if (hq && hq.d.st !== stId) scan((this.distByState[hq.d.st] || []).map(d => d.id).filter(d => !dids.includes(d)), 0.9);
      out.sort((a, b) => b.r - a.r || b.v.pop - a.v.pop);
      return out.slice(0, limit).map(o => ({
        label: (o.prec === 'taluka' ? 'Taluka centre: ' : '') + o.v.n + (o.prec !== 'taluka' && this.subs[o.v.sid] ? ', ' + this.subs[o.v.sid].name : '') + ', ' + this.districts[o.did].name + (o.prec === 'town' ? ' (town)' : ''),
        st: this.districts[o.did].st, did: o.did, sid: o.v.sid, lon: o.v.lon, lat: o.v.lat, prec: o.prec, place: o.v.n, score: +o.s.toFixed(3)
      }));
    }
  }

  G.Geo = { norm, compact, skel, jaroWinkler, sim, key, GeoIndex, DISTRICT_ALIASES, STATE_ALIASES };
})(typeof window !== 'undefined' ? window : globalThis);
