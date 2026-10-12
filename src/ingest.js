/* ingest.js — read the daily CRM Excel export, detect columns, normalise and validate rows.
   Works with SheetJS (window.XLSX in the browser, require('xlsx') in Node). */
(function (G) {
  'use strict';
  const N = s => (s === null || s === undefined) ? '' : String(s).replace(/\s+/g, ' ').trim();
  const lowerKey = s => N(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // canonical field -> header synonyms (normalised, compared as whole strings)
  const FIELD_DEFS = [
    { f: 'date', label: 'Visit date', req: true, syn: ['updated date', 'visit date', 'date', 'activity date', 'created date', 'created on', 'visit on', 'submitted date', 'date of visit'] },
    { f: 'time', label: 'Visit time', syn: ['visit time', 'time', 'check in time', 'checkin time', 'created time', 'submitted time'] },
    { f: 'user', label: 'Sales representative', req: true, syn: ['submitted user', 'sales representative', 'sales rep', 'employee name', 'emp name', 'user', 'user name', 'rep name', 'submitted by', 'field staff', 'staff name', 'executive name'] },
    { f: 'eid', label: 'Employee ID', syn: ['employee id', 'emp id', 'emp code', 'employee code', 'user id', 'staff id'] },
    { f: 'dg', label: 'Designation', syn: ['designation', 'role', 'position'] },
    { f: 'hq', label: 'Headquarter', syn: ['headquarter', 'headquarters', 'hq', 'head quarter', 'base location'] },
    { f: 'm', label: 'Manager', syn: ['manager name', 'manager', 'reporting manager', 'reporting to', 'reports to'] },
    { f: 'p', label: 'Customer phone', syn: ['crm phone no', 'phone', 'phone no', 'mobile', 'mobile no', 'mobile number', 'contact', 'contact no', 'customer mobile', 'farmer mobile'] },
    { f: 'cid', label: 'Customer ID', syn: ['customer id', 'farmer id', 'crm id', 'customer code', 'dealer code'] },
    { f: 'c', label: 'Customer / farmer', syn: ['crm customer name', 'customer name', 'farmer name', 'dealer name', 'retailer name', 'customer', 'party name'] },
    { f: 'a', label: 'Activity', syn: ['activity name', 'activity', 'activity type', 'purpose', 'visit purpose'] },
    { f: 'vt', label: 'New / old customer', syn: ['visit type', 'new old', 'customer type', 'new/old'] },
    { f: 'st', label: 'State', syn: ['state name', 'state'] },
    { f: 'di', label: 'District', syn: ['district name', 'district'] },
    { f: 'ta', label: 'Taluka / tehsil', syn: ['taluka name', 'taluka', 'tehsil', 'tahsil', 'block', 'mandal', 'sub district', 'subdistrict'] },
    { f: 'vi', label: 'Village / town', syn: ['village name', 'village', 'location', 'town', 'city', 'place', 'locality'] },
    { f: 'lat', label: 'Latitude', syn: ['latitude', 'lat', 'gps lat', 'geo lat'] },
    { f: 'lon', label: 'Longitude', syn: ['longitude', 'long', 'lng', 'lon', 'gps long', 'geo long'] },
    { f: 'status', label: 'Visit status', syn: ['status', 'visit status'] },
    { f: 'prod', label: 'Product / crop', syn: ['product', 'products', 'crop', 'variety', 'product name'] },
    { f: 'rem', label: 'Remarks', syn: ['remarks', 'remark', 'comments', 'comment', 'notes', 'feedback'] },
    { f: 'terr', label: 'Territory', syn: ['territory', 'assigned territory', 'beat', 'route'] }
  ];
  // stored record layout (arrays in storage, objects in memory)
  const FIELDS = ['k', 'd', 't', 'u', 'eid', 'dg', 'hq', 'm', 'p', 'cid', 'c', 'a', 'vt', 'st', 'di', 'ta', 'vi', 'lat', 'lon', 'status', 'prod', 'rem', 'terr', 'b'];

  const ACTIVITY_RULES = [
    [/farmer/, 'farmer'],
    [/retailer|dealer|distributor|counter sale|shop/, 'dealer'],
    [/trial|demo|mlt|plot/, 'trial'],
    [/field day|group meeting|kisan|mela|campaign|jeep|meeting/, 'event'],
    [/night halt|halt|stay/, 'halt'],
    [/other/, 'other']
  ];
  const ACTIVITY_CLASSES = {
    farmer: { label: 'Farmer visit', customer: true },
    dealer: { label: 'Dealer / retailer visit', customer: true },
    trial: { label: 'Trial (MLT)', customer: true },
    event: { label: 'Field day / group meeting', customer: true },
    other: { label: 'Other visit', customer: false },
    halt: { label: 'Night halt', customer: false }
  };
  function activityClass(a) {
    const s = lowerKey(a);
    for (const [re, c] of ACTIVITY_RULES) if (re.test(s)) return c;
    return 'other';
  }
  const NON_CUSTOMER_RE = /\b(hotel|lodge|guest house|rest house|office|meeting|metting|campni|company work|head office|godown|warehouse|self)\b/i;

  function excelSerialToISO(v) {
    const ms = Math.round((v - 25569) * 86400000); // 25569 = 1970-01-01
    const dt = new Date(ms);
    const d = dt.toISOString();
    const frac = v - Math.floor(v);
    return { d: d.slice(0, 10), t: frac > 1e-6 ? d.slice(11, 16) : '' };
  }
  function parseDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' && isFinite(v) && v > 20000 && v < 80000) return excelSerialToISO(v);
    if (v instanceof Date && !isNaN(v)) return { d: v.toISOString().slice(0, 10), t: '' };
    const s = N(v);
    let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:[ T](\d{1,2}):(\d{2}))?/); // Indian dd/mm/yyyy
    if (m) {
      let y = +m[3]; if (y < 100) y += 2000;
      const dd = +m[1], mm = +m[2];
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return { d: `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, t: m[4] ? `${m[4].padStart(2, '0')}:${m[5]}` : '' };
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    if (m) return { d: `${m[1]}-${m[2]}-${m[3]}`, t: m[4] ? `${m[4]}:${m[5]}` : '' };
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    m = s.match(/^(\d{1,2})[ \-]([a-z]{3})[a-z]*[ \-,]+(\d{4})/i);
    if (m && months[m[2].toLowerCase()]) return { d: `${m[3]}-${String(months[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`, t: '' };
    return null;
  }
  function parseTime(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' && v >= 0 && v < 1) { const mins = Math.round(v * 1440); return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`; }
    if (typeof v === 'number' && v > 20000) return excelSerialToISO(v).t;
    const m = N(v).match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!m) return '';
    let h = +m[1]; if (m[3]) { const pm = m[3].toLowerCase() === 'pm'; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  }
  function normPhone(v) {
    let s = N(v).replace(/\.0+$/, '').replace(/\D/g, '');
    if (s.length === 12 && s.startsWith('91')) s = s.slice(2);
    if (s.length === 11 && s.startsWith('0')) s = s.slice(1);
    return s;
  }
  function titleCase(s) { return N(s).toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()); }

  // ---------- workbook ----------
  function scoreHeaderRow(row) {
    let hits = 0;
    for (const cell of row) {
      const k = lowerKey(cell); if (!k) continue;
      if (FIELD_DEFS.some(d => d.syn.includes(k))) hits++;
    }
    return hits;
  }
  function readWorkbook(XLSX, data) {
    const wb = XLSX.read(data, { type: data instanceof ArrayBuffer ? 'array' : 'buffer', cellDates: false, raw: true });
    let best = null;
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true, blankrows: false });
      for (let i = 0; i < Math.min(25, rows.length); i++) {
        const sc = scoreHeaderRow(rows[i]);
        if (sc >= 3 && (!best || sc > best.score || (sc === best.score && rows.length > best.rows.length))) best = { sheet: name, headerRow: i, score: sc, rows };
      }
    }
    if (!best) throw new Error('No header row found. The sheet needs columns such as "Submitted User", "Updated date" and "Village Name".');
    const pre = best.rows.slice(0, best.headerRow).map(r => r.filter(x => x !== '').join(' ')).filter(Boolean);
    let period = null;
    for (const line of pre) {
      const m = line.match(/from\s*:?\s*([0-9\/\-.]+)\s*to\s*:?\s*([0-9\/\-.]+)/i);
      if (m) { const a = parseDate(m[1]), b = parseDate(m[2]); if (a && b) period = { from: a.d, to: b.d }; }
    }
    const headers = best.rows[best.headerRow].map(h => N(h));
    const body = best.rows.slice(best.headerRow + 1).filter(r => r.some(c => N(c) !== ''));
    return { sheet: best.sheet, headerRow: best.headerRow, headers, body, title: pre, period };
  }
  function detectMapping(headers) {
    const map = {}, used = new Set();
    // exact synonym passes, in synonym priority order
    for (const def of FIELD_DEFS) {
      for (const syn of def.syn) {
        const idx = headers.findIndex((h, i) => !used.has(i) && lowerKey(h) === syn);
        if (idx >= 0) { map[def.f] = idx; used.add(idx); break; }
      }
    }
    // looser containment pass for anything left
    for (const def of FIELD_DEFS) {
      if (map[def.f] !== undefined) continue;
      const idx = headers.findIndex((h, i) => !used.has(i) && def.syn.some(s => s.length > 3 && lowerKey(h).includes(s)));
      if (idx >= 0) { map[def.f] = idx; used.add(idx); }
    }
    const unmapped = headers.map((h, i) => used.has(i) || !h || /^sr\.? ?no/i.test(h) ? null : h).filter(Boolean);
    return { map, unmapped };
  }

  // ---------- records ----------
  function toRecords(parsed, map, batchId) {
    const g = (row, f) => map[f] === undefined ? '' : row[map[f]];
    const out = [];
    for (let i = 0; i < parsed.body.length; i++) {
      const row = parsed.body[i];
      const dt = parseDate(g(row, 'date'));
      const r = {
        _row: parsed.headerRow + i + 2, // Excel row number for the user
        d: dt ? dt.d : '', t: parseTime(g(row, 'time')) || (dt ? dt.t : ''),
        u: titleCase(g(row, 'user')), eid: N(g(row, 'eid')), dg: N(g(row, 'dg')), hq: titleCase(g(row, 'hq')), m: titleCase(g(row, 'm')),
        p: normPhone(g(row, 'p')), cid: N(g(row, 'cid')), c: N(g(row, 'c')), a: N(g(row, 'a')), vt: titleCase(g(row, 'vt')),
        st: N(g(row, 'st')), di: N(g(row, 'di')), ta: N(g(row, 'ta')), vi: N(g(row, 'vi')),
        lat: g(row, 'lat') === '' ? '' : +g(row, 'lat'), lon: g(row, 'lon') === '' ? '' : +g(row, 'lon'),
        status: N(g(row, 'status')), prod: N(g(row, 'prod')), rem: N(g(row, 'rem')), terr: N(g(row, 'terr')), b: batchId
      };
      if (!dt && N(g(row, 'date'))) r._badDate = N(g(row, 'date'));
      out.push(r);
    }
    // idempotent keys: identical rows get an occurrence index, so re-uploading the same export adds nothing
    const occ = new Map();
    for (const r of out) {
      const base = [r.d, lowerKey(r.u), r.p || lowerKey(r.c), lowerKey(r.a), lowerKey(r.vi)].join('|');
      const n = occ.get(base) || 0; occ.set(base, n + 1);
      r.k = base + '#' + n; r._occ = n;
    }
    return out;
  }
  function enrich(r) {
    r.ac = activityClass(r.a);
    r.cust = ACTIVITY_CLASSES[r.ac].customer;
    r.custKey = r.p || ('n:' + lowerKey(r.c));
    return r;
  }
  function packRecord(r) { return FIELDS.map(f => (r[f] === undefined || r[f] === null) ? '' : r[f]); }
  function unpackRecord(a) { const r = {}; FIELDS.forEach((f, i) => { r[f] = a[i]; }); return enrich(r); }

  /* validate: returns {rows: [{rec, issues:[codes], status:'new'|'duplicate'|'existing'|'rejected'}], summary} */
  function validate(recs, ctx) {
    const { geo, fixes, existingKeys, today } = ctx;
    const rows = [];
    const sum = { read: recs.length, newValid: 0, dupInFile: 0, existing: 0, rejected: 0, missingLocation: 0, unresolved: 0, approx: 0,
      invalidGps: 0, missingDate: 0, missingUser: 0, nonCustomer: 0, selfLogged: 0, unknownActivity: 0, badPhone: 0, futureDate: 0,
      precision: {}, dates: {}, users: new Set(), unknownActivities: new Set() };
    for (const rec of recs) {
      enrich(rec);
      const issues = [];
      if (!rec.d) { issues.push(rec._badDate ? 'bad_date' : 'missing_date'); sum.missingDate++; }
      if (!rec.u) { issues.push('missing_user'); sum.missingUser++; }
      const hasGps = rec.lat !== '' && rec.lon !== '';
      if (hasGps && !(rec.lat >= 6 && rec.lat <= 37.5 && rec.lon >= 68 && rec.lon <= 97.5)) { issues.push('invalid_gps'); sum.invalidGps++; }
      if (!rec.vi && !rec.di && !rec.st && !hasGps) { issues.push('missing_location'); sum.missingLocation++; }
      else if (!rec.st || !rec.di || !rec.ta) issues.push('partial_location');
      if (rec.p && !/^[6-9]\d{9}$/.test(rec.p)) { issues.push('bad_phone'); sum.badPhone++; }
      if (rec.d && today && rec.d > today) { issues.push('future_date'); sum.futureDate++; }
      const ak = lowerKey(rec.a);
      if (rec.a && !ACTIVITY_RULES.some(([re]) => re.test(ak))) { issues.push('unknown_activity'); sum.unknownActivity++; sum.unknownActivities.add(rec.a); }
      if (rec.ac !== 'halt' && NON_CUSTOMER_RE.test(rec.c)) { issues.push('non_customer'); sum.nonCustomer++; }
      if (rec.c && rec.u) {
        const ct = lowerKey(rec.c).split(' ').filter(x => x.length > 2), ut = lowerKey(rec.u).split(' ');
        if (ct.length >= 2 && ct.every(t => ut.includes(t))) { issues.push('self_logged'); sum.selfLogged++; }
      }
      // geography
      let g;
      if (hasGps && !issues.includes('invalid_gps')) g = Object.assign(geo.resolve({ state: rec.st, district: rec.di, taluka: rec.ta, village: rec.vi }, fixes), { lon: rec.lon, lat: rec.lat, prec: 'gps', note: 'Coordinates from file' });
      else g = geo.resolve({ state: rec.st, district: rec.di, taluka: rec.ta, village: rec.vi }, fixes);
      rec.g = g;
      sum.precision[g.prec] = (sum.precision[g.prec] || 0) + 1;
      if (g.prec === 'none') { issues.push('unresolved'); sum.unresolved++; }
      else if (g.prec === 'taluka' || g.prec === 'district') { issues.push('approximate'); sum.approx++; }
      let status = 'new';
      if (issues.includes('missing_date') || issues.includes('bad_date') || issues.includes('missing_user')) { status = 'rejected'; sum.rejected++; }
      else if (existingKeys && existingKeys.has(rec.k)) { status = 'existing'; sum.existing++; }
      else if (rec._occ > 0) { status = 'duplicate'; sum.dupInFile++; }
      else { sum.newValid++; sum.dates[rec.d] = (sum.dates[rec.d] || 0) + 1; sum.users.add(rec.u); }
      rows.push({ rec, issues, status });
    }
    sum.users = sum.users.size; sum.unknownActivities = [...sum.unknownActivities];
    return { rows, summary: sum };
  }

  const ISSUE_LABELS = {
    missing_date: 'Missing date', bad_date: 'Unreadable date', missing_user: 'Missing representative', missing_location: 'Missing location',
    partial_location: 'Incomplete location fields', invalid_gps: 'Coordinates outside India', bad_phone: 'Phone not a 10-digit mobile',
    future_date: 'Date in the future', unknown_activity: 'Unrecognised activity type', non_customer: 'Looks like a non-customer entry (hotel, office, meeting)',
    self_logged: 'Customer name matches the rep', unresolved: 'Location not resolved', approximate: 'Placed at taluka/district centre'
  };

  G.Ingest = { FIELD_DEFS, FIELDS, ACTIVITY_CLASSES, ISSUE_LABELS, activityClass, parseDate, normPhone, readWorkbook, detectMapping, toRecords, validate, enrich, packRecord, unpackRecord, lowerKey };
})(typeof window !== 'undefined' ? window : globalThis);
