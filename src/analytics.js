/* analytics.js — every number on screen comes from here, computed from uploaded records only. */
(function (G) {
  'use strict';
  const DAY = 86400000;
  const toDate = s => new Date(s + 'T00:00:00Z');
  const iso = d => d.toISOString().slice(0, 10);
  const addDays = (s, n) => iso(new Date(toDate(s).getTime() + n * DAY));
  const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY) + 1;
  function hav(a, b) {
    const R = 6371, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  const precise = r => r.g && (r.g.prec === 'village' || r.g.prec === 'town' || r.g.prec === 'gps' || r.g.prec === 'manual');
  const lk = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function villageKey(r) { return r.g && r.g.did ? r.g.did + '|' + (precise(r) ? lk(r.g.place) : lk(r.vi)) : 'x|' + lk(r.vi); }
  function countBy(arr, fn) { const m = new Map(); for (const x of arr) { const k = fn(x); if (k === null || k === undefined || k === '') continue; m.set(k, (m.get(k) || 0) + 1); } return m; }
  function uniq(arr, fn) { const s = new Set(); for (const x of arr) { const k = fn(x); if (k !== null && k !== undefined && k !== '') s.add(k); } return s; }

  function workingDays(from, to) { let n = 0; for (let d = toDate(from); d <= toDate(to); d = new Date(d.getTime() + DAY)) if (d.getUTCDay() !== 0) n++; return n; }

  /* F: {from,to,users:[],managers:[],designations:[],hqs:[],st,did,sid,village,classes:[],vt,customerOnly,q} */
  function applyFilters(recs, F, opts) {
    opts = opts || {};
    const users = F.users && F.users.length ? new Set(F.users) : null;
    const mgrs = F.managers && F.managers.length ? new Set(F.managers) : null;
    const dgs = F.designations && F.designations.length ? new Set(F.designations) : null;
    const hqs = F.hqs && F.hqs.length ? new Set(F.hqs) : null;
    const cls = F.classes && F.classes.length ? new Set(F.classes) : null;
    const q = F.q ? lk(F.q) : '';
    return recs.filter(r => {
      if (!opts.ignoreDate) { if (F.from && r.d < F.from) return false; if (F.to && r.d > F.to) return false; }
      if (F.customerOnly && !r.cust) return false;
      if (users && !users.has(r.u)) return false;
      if (mgrs && !mgrs.has(r.m) && !mgrs.has(r.u)) return false;
      if (dgs && !dgs.has(r.dg)) return false;
      if (hqs && !hqs.has(r.hq)) return false;
      if (cls && !cls.has(r.ac)) return false;
      if (F.vt && r.vt !== F.vt && !(F.vt === '(blank)' && !r.vt)) return false;
      if (!opts.ignoreGeo) {
        if (F.st && (!r.g || r.g.st !== F.st)) return false;
        if (F.did && (!r.g || r.g.did !== F.did)) return false;
        if (F.sid !== null && F.sid !== undefined && F.sid !== '' && (!r.g || r.g.sid !== F.sid)) return false;
        if (F.village && villageKey(r) !== F.village) return false;
      }
      if (q && !(lk(r.c).includes(q) || lk(r.vi).includes(q) || lk(r.u).includes(q) || (r.p || '').includes(q))) return false;
      return true;
    });
  }

  function kpis(recs) {
    const staffDays = uniq(recs, r => r.u + '|' + r.d).size;
    const cust = recs.filter(r => r.cust);
    const custVisits = countBy(cust, r => r.custKey);
    const joint = jointGroups(cust);
    return {
      entries: recs.length, visits: cust.length, staff: uniq(recs, r => r.u).size, staffDays,
      customers: custVisits.size, repeatCustomers: [...custVisits.values()].filter(n => n > 1).length,
      newCustomers: uniq(cust.filter(r => r.vt === 'New'), r => r.custKey).size,
      states: uniq(recs, r => r.g && r.g.st).size, districts: uniq(recs, r => r.g && r.g.did).size,
      talukas: uniq(recs, r => r.g && r.g.sid !== null ? r.g.sid : null).size, villages: uniq(recs, villageKey).size,
      days: uniq(recs, r => r.d).size, perStaffDay: staffDays ? cust.length / staffDays : 0,
      precisePct: recs.length ? recs.filter(precise).length / recs.length : 0,
      unresolved: recs.filter(r => !r.g || r.g.prec === 'none').length,
      jointGroups: joint.length, jointEntries: joint.reduce((s, g) => s + g.recs.length, 0)
    };
  }

  function jointGroups(recs) {
    const m = new Map();
    for (const r of recs) { if (!r.p) continue; const k = r.p + '|' + r.d; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    const out = [];
    for (const [k, arr] of m) { const users = uniq(arr, r => r.u); if (users.size > 1) out.push({ key: k, phone: arr[0].p, date: arr[0].d, users: [...users], recs: arr }); }
    return out;
  }

  function byUser(recs, period) {
    const m = new Map();
    for (const r of recs) { if (!m.has(r.u)) m.set(r.u, []); m.get(r.u).push(r); }
    const wd = period && period.from && period.to ? workingDays(period.from, period.to) : 0;
    const out = [];
    for (const [u, arr] of m) {
      const cust = arr.filter(r => r.cust);
      const cv = countBy(cust, r => r.custKey);
      const days = uniq(arr, r => r.d);
      const pts = arr.filter(precise).map(r => r.g);
      let spread = null;
      if (pts.length >= 3) {
        const c = { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length };
        spread = Math.sqrt(pts.reduce((s, p) => s + hav(c, p) ** 2, 0) / pts.length);
      }
      const last = arr.reduce((a, r) => r.d > a ? r.d : a, '');
      const latest = arr.find(r => r.d === last) || arr[0];
      out.push({
        user: u, dg: latest.dg, hq: latest.hq, m: latest.m, entries: arr.length, visits: cust.length,
        farmer: arr.filter(r => r.ac === 'farmer').length, dealer: arr.filter(r => r.ac === 'dealer').length,
        trial: arr.filter(r => r.ac === 'trial').length, event: arr.filter(r => r.ac === 'event').length,
        nonCustomer: arr.filter(r => !r.cust).length,
        activeDays: days.size, perActiveDay: days.size ? cust.length / days.size : 0, perWorkingDay: wd ? cust.length / wd : null, workingDays: wd,
        customers: cv.size, repeat: [...cv.values()].filter(n => n > 1).length, newCust: uniq(cust.filter(r => r.vt === 'New'), r => r.custKey).size,
        states: uniq(arr, r => r.g && r.g.st).size, districts: uniq(arr, r => r.g && r.g.did).size,
        talukas: uniq(arr, r => r.g && r.g.sid !== null ? r.g.sid : null).size, villages: uniq(arr, villageKey).size,
        precisePct: arr.length ? pts.length / arr.length : 0, spreadKm: spread, lastDate: last
      });
    }
    return out.sort((a, b) => b.visits - a.visits || a.user.localeCompare(b.user));
  }

  function anomalies(recs, opts) {
    opts = Object.assign({ farKm: 150, highVolume: 12 }, opts || {});
    const out = { joint: jointGroups(recs.filter(r => r.cust)), phoneNames: [], highVolume: [], farApart: [], nonCustomer: [], selfLogged: [] };
    const byPhone = new Map();
    for (const r of recs) { if (!r.p) continue; if (!byPhone.has(r.p)) byPhone.set(r.p, new Map()); const n = lk(r.c); byPhone.get(r.p).set(n, (byPhone.get(r.p).get(n) || 0) + 1); }
    for (const [p, names] of byPhone) if (names.size > 1) out.phoneNames.push({ phone: p, names: [...names.keys()] });
    const ud = new Map();
    for (const r of recs) { const k = r.u + '|' + r.d; if (!ud.has(k)) ud.set(k, []); ud.get(k).push(r); }
    for (const [k, arr] of ud) {
      const c = arr.filter(r => r.cust).length;
      if (c >= opts.highVolume) out.highVolume.push({ user: arr[0].u, date: arr[0].d, visits: c });
      const pts = arr.filter(precise);
      let best = null;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
        const dkm = hav(pts[i].g, pts[j].g);
        if (!best || dkm > best.km) best = { km: dkm, a: pts[i], b: pts[j] };
      }
      if (best && best.km >= opts.farKm) out.farApart.push({ user: arr[0].u, date: arr[0].d, km: best.km, a: best.a.g.place, b: best.b.g.place });
    }
    const NC = /\b(hotel|lodge|guest house|rest house|office|meeting|metting|campni|company work|godown)\b/i;
    for (const r of recs) {
      if (r.cust && NC.test(r.c)) out.nonCustomer.push(r);
      const ct = lk(r.c).split(' ').filter(x => x.length > 2), ut = lk(r.u).split(' ');
      if (ct.length >= 2 && ct.every(t => ut.includes(t))) out.selfLogged.push(r);
    }
    out.highVolume.sort((a, b) => b.visits - a.visits);
    out.farApart.sort((a, b) => b.km - a.km);
    return out;
  }

  // talukas with no recorded visit inside the districts in scope
  function coverageGaps(recs, geo, scope) {
    const visitedSid = countBy(recs.filter(r => r.cust), r => r.g && r.g.sid !== null ? r.g.sid : null);
    let dids;
    if (scope && scope.did) dids = [scope.did];
    else { dids = [...uniq(recs, r => r.g && r.g.did)]; if (scope && scope.st) dids = dids.filter(d => geo.districts[d] && geo.districts[d].st === scope.st); }
    const out = [];
    for (const did of dids) {
      const subs = geo.subByDist[did] || [];
      const zero = subs.filter(s => !visitedSid.has(s.id));
      out.push({ did, name: geo.districts[did] ? geo.districts[did].name : '?', total: subs.length, visited: subs.length - zero.length, zero: zero.map(s => s.name).sort(), visits: subs.reduce((s, x) => s + (visitedSid.get(x.id) || 0), 0) });
    }
    return out.sort((a, b) => (a.visited / a.total) - (b.visited / b.total));
  }

  /* territory plan rows: {rep, state, district, taluka, village}; resolved against the gazetteer */
  function territoryCoverage(recs, plan, geo) {
    if (!plan || !plan.length) return [];
    const byRep = new Map();
    for (const p of plan) { if (!byRep.has(p.rep)) byRep.set(p.rep, []); byRep.get(p.rep).push(p); }
    const out = [];
    for (const [rep, rows] of byRep) {
      const mine = recs.filter(r => lk(r.u) === lk(rep) && r.cust);
      const sidHits = countBy(mine, r => r.g && r.g.sid);
      const vilHits = new Set(mine.map(villageKey));
      const units = rows.map(p => {
        const g = geo.resolve({ state: p.state, district: p.district, taluka: p.taluka, village: p.village || '' });
        let visits = 0, level = p.village ? 'village' : (p.taluka ? 'taluka' : 'district');
        if (level === 'village') visits = mine.filter(r => villageKey(r) === villageKey({ g, vi: p.village })).length;
        else if (level === 'taluka') visits = g.sid !== null ? (sidHits.get(g.sid) || 0) : 0;
        else visits = mine.filter(r => r.g && r.g.did === g.did).length;
        return { label: [p.village, p.taluka, p.district].filter(Boolean).join(', '), level, visits, resolved: g.prec !== 'none' };
      });
      const covered = units.filter(u => u.visits > 0).length;
      out.push({ rep, assigned: units.length, covered, pct: units.length ? covered / units.length : 0, units, outside: mine.length - units.reduce((s, u) => s + u.visits, 0) });
    }
    return out.sort((a, b) => a.pct - b.pct);
  }

  function fmtPct(x) { return Math.round(x * 100) + '%'; }

  function insights(ctx) {
    const { recs, all, F, geo, maxDate, k, prev } = ctx;
    const out = [];
    if (!recs.length) return ['No records match the current filters.'];
    const cust = recs.filter(r => r.cust);
    const latest = recs.reduce((a, r) => r.d > a ? r.d : a, '');
    const onLatest = cust.filter(r => r.d === latest);
    out.push(`${uniq(onLatest, r => r.u).size} staff logged ${onLatest.length} customer visits on ${fmtDate(latest)}, the latest day in this selection.`);
    if (prev && prev.visits > 0) {
      const ch = (k.visits - prev.visits) / prev.visits;
      out.push(`Customer visits ${ch >= 0 ? 'rose' : 'fell'} ${Math.abs(Math.round(ch * 100))}% versus the previous ${prev.days}-day period (${prev.visits} → ${k.visits}).`);
    } else if (prev) out.push(`No earlier data covers the previous ${prev.days} days, so there is nothing to compare against yet.`);
    // top area at the next level down
    const lvl = F.did ? 'sid' : F.st ? 'did' : 'st';
    const name = id => lvl === 'sid' ? (geo.subs[id] || {}).name : lvl === 'did' ? (geo.districts[id] || {}).name : geo.states[id] && geo.states[id].name;
    const cnt = [...countBy(cust, r => r.g && r.g[lvl] !== null ? r.g[lvl] : null)].sort((a, b) => b[1] - a[1]);
    if (cnt.length) out.push(`${name(cnt[0][0])} has the most customer visits (${cnt[0][1]}, ${fmtPct(cnt[0][1] / cust.length)} of the total).`);
    if (cnt.length >= 4) { const low = cnt[cnt.length - 1]; out.push(`${name(low[0])} has the fewest among areas with any visits (${low[1]}).`); }
    const gaps = coverageGaps(recs, geo, { st: F.st, did: F.did });
    const zeroT = gaps.reduce((s, g) => s + g.zero.length, 0), totT = gaps.reduce((s, g) => s + g.total, 0);
    if (totT) out.push(`${zeroT} of ${totT} talukas in the ${gaps.length} district${gaps.length > 1 ? 's' : ''} with activity have no recorded customer visit.`);
    if (k.repeatCustomers) out.push(`${k.repeatCustomers} customers were visited more than once in this period.`);
    if (k.jointGroups) out.push(`${k.jointGroups} customer visits were logged by two or more staff on the same day (${k.jointEntries} entries) — count them once when judging reach.`);
    const nonC = recs.length - cust.length;
    if (nonC) out.push(`${nonC} entries are night halts or "other" activities and are ${F.customerOnly ? 'excluded from' : 'included in'} the figures above.`);
    out.push(`${fmtPct(k.precisePct)} of entries are mapped to a named village or town; the rest sit at a taluka or district centre.`);
    if (maxDate && ctx.today && maxDate < ctx.today) out.push(`Latest data is from ${fmtDate(maxDate)}; nothing has been uploaded for ${daysBetween(maxDate, ctx.today) - 1} day(s) since.`);
    return out;
  }

  function fmtDate(s) {
    if (!s) return '';
    const d = toDate(s);
    return d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  G.Analytics = { applyFilters, kpis, byUser, anomalies, jointGroups, coverageGaps, territoryCoverage, insights, countBy, uniq, villageKey, precise, hav,
    workingDays, addDays, daysBetween, fmtDate, iso, toDate };
})(typeof window !== 'undefined' ? window : globalThis);
