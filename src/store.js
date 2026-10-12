/* store.js — persistence behind one small interface, so the backend can change without touching the app.
   Layout (same in every adapter):
     batches/<batchId>        {id, fileName, uploadedAt, from, to, rows, chunks, summary}
     records/<batchId>_<n>    {b, n, f: FIELDS, rows: [[...], ...]}   (<= 400 rows per chunk)
     kv/<name>                {value}                                  (location fixes, territory plan, settings)
   To move to Supabase/Postgres/Firebase later, implement the same 8 methods. */
(function (G) {
  'use strict';
  const CHUNK = 400;

  class MemoryStore {
    constructor() { this.mode = 'memory'; this.shared = false; this.b = {}; this.r = {}; this.kv = {}; }
    async init() { return true; }
    async listBatches() { return Object.values(this.b).sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt)); }
    async loadRecords() { return Object.values(this.r); }
    async saveBatch(meta, chunks) { this.b[meta.id] = meta; chunks.forEach(c => { this.r[c.b + '_' + c.n] = c; }); }
    async deleteBatch(id) { delete this.b[id]; for (const k of Object.keys(this.r)) if (this.r[k].b === id) delete this.r[k]; }
    async getKV(name) { return this.kv[name] === undefined ? null : this.kv[name]; }
    async setKV(name, value) { this.kv[name] = value; }
    onChange() { return () => {}; }
  }

  class IdbStore {
    constructor(dbName) { this.mode = 'browser'; this.shared = false; this.name = dbName || 'field-visit-atlas'; }
    init() {
      return new Promise((res, rej) => {
        if (!G.indexedDB) return rej(new Error('IndexedDB unavailable'));
        const req = G.indexedDB.open(this.name, 1);
        req.onupgradeneeded = () => { const db = req.result; ['batches', 'records', 'kv'].forEach(s => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s); }); };
        req.onsuccess = () => { this.db = req.result; res(true); };
        req.onerror = () => rej(req.error);
      });
    }
    _tx(store, mode, fn) {
      return new Promise((res, rej) => {
        const tx = this.db.transaction(store, mode); const os = tx.objectStore(store); let out;
        Promise.resolve(fn(os, v => { out = v; })).catch(rej);
        tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
      });
    }
    _all(store) { return this._tx(store, 'readonly', (os, set) => { const q = os.getAll(); q.onsuccess = () => set(q.result); }); }
    async listBatches() { return (await this._all('batches')).sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt)); }
    async loadRecords() { return this._all('records'); }
    async saveBatch(meta, chunks) {
      await this._tx('records', 'readwrite', os => { chunks.forEach(c => os.put(c, c.b + '_' + c.n)); });
      await this._tx('batches', 'readwrite', os => { os.put(meta, meta.id); });
    }
    async deleteBatch(id) {
      await this._tx('batches', 'readwrite', os => { os.delete(id); });
      await this._tx('records', 'readwrite', os => new Promise(res => {
        const q = os.openCursor();
        q.onsuccess = () => { const c = q.result; if (!c) return res(); if (c.value.b === id) c.delete(); c.continue(); };
      }));
    }
    async getKV(name) { const v = await this._tx('kv', 'readonly', (os, set) => { const q = os.get(name); q.onsuccess = () => set(q.result); }); return v === undefined ? null : v; }
    async setKV(name, value) { await this._tx('kv', 'readwrite', os => { os.put(value, name); }); }
    onChange() { return () => {}; }
  }

  // claude.ai published-artifact database: shared by everyone the artifact is shared with
  class ClaudeDbStore {
    constructor(db) { this.mode = 'shared'; this.shared = true; this.db = db; }
    async init() { return true; }
    async listBatches() {
      const s = await this.db.collection('batches').limit(1000).get();
      return s.docs.map(d => d.data()).filter(Boolean).sort((a, b) => String(a.uploadedAt).localeCompare(String(b.uploadedAt)));
    }
    async loadRecords() {
      const s = await this.db.collection('records').limit(1000).get();
      if (s.size >= 1000) console.warn('Record chunk limit reached; older data may be missing');
      return s.docs.map(d => d.data()).filter(Boolean);
    }
    async saveBatch(meta, chunks) {
      for (const c of chunks) await this.db.doc('records/' + c.b + '_' + c.n).set(c);
      await this.db.doc('batches/' + meta.id).set(meta); // meta last: a batch is visible only once all its rows are written
    }
    async deleteBatch(id) {
      const meta = (await this.db.doc('batches/' + id).get()).data();
      await this.db.doc('batches/' + id).delete();
      const n = meta && meta.chunks ? meta.chunks : 50;
      for (let i = 0; i < n; i++) { try { await this.db.doc('records/' + id + '_' + i).delete(); } catch (e) { /* missing chunk */ } }
    }
    async getKV(name) { const s = await this.db.doc('kv/' + name).get(); return s.exists ? s.data().value : null; }
    async setKV(name, value) { await this.db.doc('kv/' + name).set({ value }); }
    onChange(cb) {
      let first = true;
      return this.db.collection('batches').onSnapshot(() => { if (first) { first = false; return; } cb(); }, () => {});
    }
  }

  async function gunzipB64(b64) {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  // Google Apps Script web app over Google Drive (apps-script/Code.gs): one shared history for everyone with the key
  class AppsScriptStore {
    constructor(url, key) { this.mode = 'drive'; this.shared = true; this.url = url; this.key = key; this.b = {}; this.c = {}; this.kv = {}; this.stamp = '0'; }
    async _call(params, body) {
      let r;
      try {
        if (body) r = await fetch(this.url, { method: 'POST', body: JSON.stringify(Object.assign({ key: this.key }, body)) }); // text/plain: no CORS preflight
        else r = await fetch(this.url + '?' + new URLSearchParams(Object.assign({ key: this.key }, params)));
      } catch (e) { const er = new Error('Cannot reach the shared database. Check the internet connection, or the URL in src/config.js.'); er.code = 'network'; throw er; }
      let j; try { j = await r.json(); } catch (e) { const er = new Error('The shared database URL did not answer as expected. It must be the Web app URL ending in /exec, deployed with access "Anyone".'); er.code = 'server'; throw er; }
      if (!j.ok) { const er = new Error(j.error || 'Shared database error'); er.code = /access key/i.test(j.error || '') ? 'auth' : 'server'; throw er; }
      if (j.stamp) this.stamp = j.stamp;
      return j;
    }
    async init() { await this._load(); return true; }
    async _load() {
      const j = await this._call({ action: 'load' });
      const b = {}, c = {};
      for (const m64 of j.months || []) { const m = await gunzipB64(m64); Object.assign(b, m.batches || {}); Object.assign(c, m.chunks || {}); }
      this.b = b; this.c = c; this.kv = j.kv || {};
    }
    async listBatches() { return Object.values(this.b).sort((a, b) => String(a.uploadedAt).localeCompare(String(b.uploadedAt))); }
    async loadRecords() { return Object.values(this.c); }
    async saveBatch(meta, chunks) {
      await this._call(null, { action: 'saveBatch', meta, chunks });
      this.b[meta.id] = meta; chunks.forEach(ch => { this.c[ch.b + '_' + ch.n] = ch; });
    }
    async deleteBatch(id) {
      await this._call(null, { action: 'deleteBatch', id });
      delete this.b[id]; for (const k of Object.keys(this.c)) if (this.c[k].b === id) delete this.c[k];
    }
    async getKV(name) { return this.kv[name] === undefined ? null : this.kv[name]; }
    async setKV(name, value) { await this._call(null, { action: 'setKV', name, value }); this.kv[name] = value; }
    onChange(cb) {
      const t = setInterval(async () => {
        if (document.hidden) return;
        try { const before = this.stamp; const j = await this._call({ action: 'stamp' }); if (j.stamp !== before) { await this._load(); cb(); } } catch (e) { /* try again next round */ }
      }, 90000);
      return () => clearInterval(t);
    }
  }
  const KEY_STORE = 'fva_access_key';
  function savedKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } }
  function rememberKey(k) { try { if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE); } catch (e) { /* private mode */ } }

  function chunkRecords(batchId, packedRows, fields) {
    const chunks = [];
    for (let i = 0; i < packedRows.length; i += CHUNK) chunks.push({ b: batchId, n: chunks.length, f: fields, rows: packedRows.slice(i, i + CHUNK) });
    return chunks;
  }

  /* pick the backend: claude.ai shared artifact database > Google Drive (if configured) > browser IndexedDB > memory.
     Returns {store} or {needsKey: true, url, error} when the Drive store needs the team access key. */
  async function openStore(opts) {
    opts = opts || {};
    try {
      if (G.claude && typeof G.claude.use === 'function') {
        const db = await Promise.race([G.claude.use('db'), new Promise(r => setTimeout(() => r(null), 6000))]);
        if (db) { const s = new ClaudeDbStore(db); await s.listBatches(); return { store: s }; }
      }
    } catch (e) { console.warn('Shared artifact database unavailable', e); }
    const url = (G.FVA_CONFIG && G.FVA_CONFIG.sharedStoreUrl || '').trim();
    if (url) {
      const key = opts.key || savedKey();
      if (!key) return { needsKey: true, url };
      const s = new AppsScriptStore(url, key);
      try { await s.init(); rememberKey(key); return { store: s }; }
      catch (e) { if (e.code === 'auth') rememberKey(''); return { needsKey: e.code === 'auth', url, error: e }; }
    }
    try { const s = new IdbStore(); await s.init(); return { store: s }; } catch (e) { console.warn('IndexedDB unavailable', e); }
    return { store: new MemoryStore() };
  }

  G.Store = { openStore, chunkRecords, MemoryStore, IdbStore, ClaudeDbStore, AppsScriptStore, rememberKey, savedKey, CHUNK };
})(typeof window !== 'undefined' ? window : globalThis);
