/**
 * Field Visit Atlas — shared storage on Google Drive (Google Apps Script web app).
 *
 * SETUP (once, with a company Google account):
 *  1. script.google.com → New project → paste this whole file into Code.gs → Save.
 *  2. Project Settings (gear icon) → Script properties → Add script property:
 *       Property: ACCESS_KEY    Value: a long team passphrase (e.g. 4–5 random words)
 *  3. Deploy → New deployment → Select type: Web app
 *       Execute as: Me      Who has access: Anyone
 *     → Deploy → Authorize access (Advanced → Go to project → Allow) → copy the Web app URL (ends in /exec).
 *  4. Put that URL in src/config.js of the GitHub repository.
 *
 * Data lives in a Drive folder named "Field Visit Atlas data" in the deploying account:
 *   month_YYYY-MM.json.gz  — uploads (batch details + rows), gzipped, one file per upload month
 *   kv.json                — location fixes and territory plan
 * Every request must carry the ACCESS_KEY. Without it, the URL returns nothing.
 *
 * After editing this code later: Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy.
 * (The URL stays the same.)
 */
var FOLDER_NAME = 'Field Visit Atlas data';

function doGet(e) {
  try {
    var p = e.parameter || {};
    checkKey_(p.key);
    if (p.action === 'stamp') return out_({ ok: true, stamp: stamp_() });
    if (p.action === 'load') return out_(load_());
    return out_({ ok: false, error: 'Unknown action' });
  } catch (err) { return out_({ ok: false, error: String(err.message || err) }); }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    checkKey_(body.key);
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      if (body.action === 'saveBatch') return out_(saveBatch_(body.meta, body.chunks));
      if (body.action === 'deleteBatch') return out_(deleteBatch_(body.id));
      if (body.action === 'setKV') return out_(setKV_(body.name, body.value));
      return out_({ ok: false, error: 'Unknown action' });
    } finally { lock.releaseLock(); }
  } catch (err) { return out_({ ok: false, error: String(err.message || err) }); }
}

// ---------- helpers ----------
function out_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

function checkKey_(k) {
  var want = PropertiesService.getScriptProperties().getProperty('ACCESS_KEY');
  if (!want) throw new Error('ACCESS_KEY is not set in Script properties');
  if (String(k || '') !== want) throw new Error('Wrong access key');
}

function folder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreated below */ } }
  var it = DriveApp.getFoldersByName(FOLDER_NAME);
  var f = it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
  props.setProperty('FOLDER_ID', f.getId());
  return f;
}

function stamp_() { return PropertiesService.getScriptProperties().getProperty('STAMP') || '0'; }
function touch_() { var s = String(Date.now()); PropertiesService.getScriptProperties().setProperty('STAMP', s); return s; }

function fileByName_(name) { var it = folder_().getFilesByName(name); return it.hasNext() ? it.next() : null; }

function readMonth_(file) {
  var blob = file.getBlob().setContentType('application/x-gzip');
  return JSON.parse(Utilities.ungzip(blob).getDataAsString('UTF-8'));
}

function writeFile_(name, blob) {
  var old = fileByName_(name);
  folder_().createFile(blob.setName(name));
  if (old) old.setTrashed(true);
}

function writeMonth_(name, obj) {
  var json = Utilities.newBlob(JSON.stringify(obj), 'application/json', name + '.json');
  writeFile_(name, Utilities.gzip(json));
}

function monthFiles_() {
  var out = [], it = folder_().getFiles();
  while (it.hasNext()) { var f = it.next(); if (/^month_\d{4}-\d{2}\.json\.gz$/.test(f.getName())) out.push(f); }
  out.sort(function (a, b) { return a.getName() < b.getName() ? -1 : 1; });
  return out;
}

function readKV_() { var f = fileByName_('kv.json'); return f ? JSON.parse(f.getBlob().getDataAsString('UTF-8')) : {}; }

// ---------- actions ----------
function load_() {
  var months = monthFiles_().map(function (f) { return Utilities.base64Encode(f.getBlob().getBytes()); });
  return { ok: true, months: months, kv: readKV_(), stamp: stamp_() };
}

function saveBatch_(meta, chunks) {
  if (!meta || !meta.id || !chunks) throw new Error('Missing batch');
  var name = 'month_' + String(meta.uploadedAt || new Date().toISOString()).slice(0, 7) + '.json.gz';
  var f = fileByName_(name);
  var m = f ? readMonth_(f) : { batches: {}, chunks: {} };
  m.batches[meta.id] = meta;
  chunks.forEach(function (c) { m.chunks[c.b + '_' + c.n] = c; });
  writeMonth_(name, m);
  return { ok: true, stamp: touch_() };
}

function deleteBatch_(id) {
  monthFiles_().forEach(function (f) {
    var m = readMonth_(f);
    if (!m.batches[id]) return;
    delete m.batches[id];
    Object.keys(m.chunks).forEach(function (k) { if (m.chunks[k].b === id) delete m.chunks[k]; });
    if (Object.keys(m.batches).length) writeMonth_(f.getName(), m); else f.setTrashed(true);
  });
  return { ok: true, stamp: touch_() };
}

function setKV_(name, value) {
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(String(name))) throw new Error('Bad name');
  var kv = readKV_();
  kv[name] = value;
  writeFile_('kv.json', Utilities.newBlob(JSON.stringify(kv), 'application/json'));
  return { ok: true, stamp: touch_() };
}
