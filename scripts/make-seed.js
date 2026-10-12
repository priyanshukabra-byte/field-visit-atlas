#!/usr/bin/env node
/* Turn a CRM export into the stored batch format (same code path as the browser upload), for pre-loading a database.
   Usage: node scripts/make-seed.js export.xlsx out_dir
   Writes out_dir/batch.json (batches/<id>) and out_dir/records_<n>.json (records/<id>_<n>). */
const fs = require('fs'), path = require('path'); const XLSX = require('xlsx');
const ROOT = path.join(__dirname, '..');
['geo', 'ingest', 'store'].forEach(m => require(path.join(ROOT, 'src', m + '.js')));
const D = p => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', p)));
const gi = new Geo.GeoIndex(); gi.init(D('geo_meta.json'), D('india_admin.topo.json'), D('towns.json'), null);
for (const f of fs.readdirSync(path.join(ROOT, 'data/gazetteer'))) gi.addGazetteer(D('gazetteer/' + f));
const [file, out] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
const buf = fs.readFileSync(file);
const parsed = Ingest.readWorkbook(XLSX, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const map = Ingest.detectMapping(parsed.headers).map;
const id = 'b' + Date.now().toString(36) + 'seed';
const recs = Ingest.toRecords(parsed, map, id);
const val = Ingest.validate(recs, { geo: gi, fixes: {}, existingKeys: new Set(), today: new Date().toISOString().slice(0, 10) });
const keep = val.rows.filter(r => r.status === 'new').map(r => r.rec);
const chunks = Store.chunkRecords(id, keep.map(Ingest.packRecord), Ingest.FIELDS);
const dates = keep.map(r => r.d).sort(); const s = val.summary;
const meta = { id, fileName: path.basename(file), uploadedAt: new Date().toISOString(), from: dates[0], to: dates[dates.length - 1], rows: keep.length, chunks: chunks.length,
  period: parsed.period, sheet: parsed.sheet, summary: { read: s.read, saved: keep.length, dupInFile: s.dupInFile, existing: 0, rejected: s.rejected, unresolved: s.unresolved, approx: s.approx } };
fs.writeFileSync(path.join(out, 'batch.json'), JSON.stringify(meta));
chunks.forEach(c => fs.writeFileSync(path.join(out, `records_${c.n}.json`), JSON.stringify(c)));
console.log(id, keep.length, 'rows in', chunks.length, 'chunks', chunks.map(c => JSON.stringify(c).length));
