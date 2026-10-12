#!/usr/bin/env node
/* Build dist/index.html: one self-contained page (app code, styles, boundaries, towns, bundled village lists)
   plus dist/data/gazetteer/*.json for on-demand loading of other districts.
   Usage: node scripts/build.js   (needs: npm i leaflet@1.9.4 leaflet.markercluster@1.5.3 for their CSS) */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const R = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const js = s => s.replace(/<\/(script)/gi, '<\\/$1');
const meta = R('data/geo_meta.json'), topo = R('data/india_admin.topo.json'), towns = R('data/towns.json');
const zlib = require('zlib');
const gz64 = str => zlib.gzipSync(Buffer.from(str, 'utf8'), { level: 9 }).toString('base64');
// bundle the full village list for every state that has activity (from data/bundle_districts.json)
let active = [];
try { active = JSON.parse(R('data/bundle_districts.json')).active; } catch (e) { console.warn('No data/bundle_districts.json — no village lists bundled'); }
const metaObj = JSON.parse(meta);
const states = [...new Set(active.map(d => metaObj.districts[d] && metaObj.districts[d][1]).filter(Boolean))].sort((a, b) => a - b);
const gazGz = {};
for (const st of states) { const f = 'data/gazetteer/' + st + '.json'; if (fs.existsSync(path.join(ROOT, f))) gazGz[st] = gz64(R(f)); }
const libCss = ['node_modules/leaflet/dist/leaflet.css', 'node_modules/leaflet.markercluster/dist/MarkerCluster.css']
  .map(p => { const full = path.join(ROOT, p); if (!fs.existsSync(full)) throw new Error('Missing ' + p + ' — run npm install'); return fs.readFileSync(full, 'utf8'); })
  .join('\n').replace(/url\([^)]*images\/[^)]*\)/g, 'none');
let html = R('src/index.html');
html = html.replace('/*INLINE_LIB_CSS*/', () => libCss);
html = html.replace('<!--INLINE_DATA-->', () => `<script>window.GEO_META=${js(meta)};window.GEO_TOWNS=${js(towns)};window.GEO_TOPO_GZ="${gz64(topo)}";window.GEO_GAZ_GZ=${JSON.stringify(gazGz)};</script>`);
const app = ['src/geo.js', 'src/ingest.js', 'src/store.js', 'src/analytics.js', 'src/app.js'].map(p => `<script>/* ${p} */\n${js(R(p))}\n</script>`).join('\n');
html = html.replace('<!--INLINE_APP-->', () => app);
fs.mkdirSync(path.join(ROOT, 'dist/data/gazetteer'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist/index.html'), html);
for (const f of fs.readdirSync(path.join(ROOT, 'data/gazetteer'))) fs.copyFileSync(path.join(ROOT, 'data/gazetteer', f), path.join(ROOT, 'dist/data/gazetteer', f));
console.log(`dist/index.html ${(html.length / 1e6).toFixed(2)} MB, village lists bundled for states ${states.join(', ')}`);
