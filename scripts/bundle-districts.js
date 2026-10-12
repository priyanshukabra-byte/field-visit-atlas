#!/usr/bin/env node
/* Decide which districts get their village list bundled inside index.html.
   Takes one or more CRM exports, finds every district that appears, adds all neighbouring districts,
   and writes data/bundle_districts.json. Other districts load on demand from data/gazetteer/<state>.json
   when the app is served from a web host (GitHub Pages, Vercel, Netlify).
   Usage: node scripts/bundle-districts.js export1.xlsx [export2.xlsx ...]   (needs: npm i xlsx topojson-client) */
const fs = require('fs'), path = require('path');
const XLSX = require('xlsx'), topojson = require('topojson-client');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'src/geo.js')); require(path.join(ROOT, 'src/ingest.js'));
const D = p => path.join(ROOT, 'data', p);
const topo = JSON.parse(fs.readFileSync(D('india_admin.topo.json')));
const gi = new Geo.GeoIndex();
gi.init(JSON.parse(fs.readFileSync(D('geo_meta.json'))), topo, JSON.parse(fs.readFileSync(D('towns.json'))), null);
const active = new Set();
const prev = fs.existsSync(D('bundle_districts.json')) ? JSON.parse(fs.readFileSync(D('bundle_districts.json'))).active || [] : [];
prev.forEach(d => active.add(d));
for (const f of process.argv.slice(2)) {
  const buf = fs.readFileSync(f);
  const p = Ingest.readWorkbook(XLSX, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const m = Ingest.detectMapping(p.headers);
  for (const r of Ingest.toRecords(p, m.map, 'x')) {
    const g = gi.resolve({ state: r.st, district: r.di, taluka: r.ta, village: r.vi });
    if (g.did) active.add(g.did);
  }
}
const geoms = topo.objects.districts.geometries;
const nb = topojson.neighbors(geoms);
const out = new Set(active);
geoms.forEach((g, i) => { if (active.has(g.properties.d)) nb[i].forEach(j => out.add(geoms[j].properties.d)); });
fs.writeFileSync(D('bundle_districts.json'), JSON.stringify({ active: [...active].sort((a, b) => a - b), bundle: [...out].sort((a, b) => a - b) }));
console.log(`active districts: ${active.size}, bundled with neighbours: ${out.size}`);
