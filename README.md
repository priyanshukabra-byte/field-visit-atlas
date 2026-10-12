# Field Visit Atlas

A field-visit map and analytics dashboard for Basant Agro Tech. You upload the CRM "Summary Export Report" (Excel) each day. The app validates the rows, places every visit on official Indian administrative boundaries down to village level where it can, and shows coverage, gaps, staff activity and data-quality flags.

It is a static web app: one HTML page and some data files. There is no server to run.

## What it does

- **Daily upload.** Finds the header row automatically (title rows above it are fine) and maps the columns. You can change the mapping before saving. It then runs the validation report, offers a place-name fixer, and saves.
- **Safe re-uploads.** Each row gets a stable key: date, staff, phone, activity, village and an occurrence number. Uploading an overlapping or identical export adds only the rows that are new.
- **Map.** Shows official State, District and Taluka boundaries, drilled down by click or by the dropdowns. It has three views: grouped visit points, a heat map, and areas shaded by visit count. Talukas with no recorded visit are marked red inside districts that have activity.
- **Location matching.**
  - **Order of use:** GPS columns are used first if the file ever has them. Otherwise the app matches the recorded village to a Census 2011 village in the recorded taluka, then to an urban local body (town) in the district, then district-wide with a stricter threshold. If none of those match, the visit goes to the taluka or district centre.
  - **Precision label:** every visit carries one, and approximate points are drawn as rings.
  - **No guessing on ambiguity:** when two places share a name, the match is rejected rather than guessed.
- **Staff view.** Visits, active days, visits per active day and per working day, customers, repeat customers, villages, talukas, districts, geographic spread, and review flags for each person.
- **Coverage.** Lists talukas with no recorded visit. If you upload a territory plan (rep → district/taluka/village), it shows assigned versus visited areas per rep.
- **Data quality.**
  - **Upload checks:** missing fields, duplicates, unresolved places, non-customer entries such as hotels or office meetings, and the rep's own name used as the customer.
  - **Cross-checks across rows:** joint visits (same customer, same day, several staff), one phone number used with different names, high-volume days, and same-day places 150 km or more apart.
- **Exports.** Visit list (Excel/CSV), staff performance, geographic coverage, review flags, a print-ready management summary (HTML, print to PDF), and the territory-plan template.
- **Generated insights.** Short findings in plain sentences. Every number comes from the uploaded data, and a statement is skipped when the data cannot support it.

## What the CRM export cannot tell you

The current export has no GPS coordinates, visit times, visit status, product, remarks or assigned territory. As a result:

- **Visits are not verified.** The map shows where staff *recorded* visits, not proof they happened. The fix belongs in the CRM app: capture GPS and a timestamp (ideally a photo) at check-in. The importer already recognises `Latitude`, `Longitude` and `Visit time` columns and will use them automatically.
- **No routes or time analysis.** There is no visit order, travel distance or time-of-day analysis.
- **No confirmed misses.** "Missed visits" can only be confirmed against a territory plan. Without one, empty areas are reported as *no recorded visit*.
- **Date assumption.** `Updated date` is treated as the visit date. Confirm with the CRM vendor that editing a record does not change it.

## Daily workflow

1. Export the Summary Export Report from the CRM.
2. Open the app, then **Upload**. Drop the file in.
3. Check the column mapping and press **Check data**.
4. Read the validation report and fix any place names you want to fix. Fixes are remembered for future uploads with the same spelling.
5. Press **Save**, then use the dashboard filters (period, staff, manager, geography, activity) to review.

## Run locally

```bash
npm install          # libraries used by the build (Leaflet CSS, SheetJS for scripts)
npm run build        # writes dist/index.html and dist/data/gazetteer/*
npm run serve        # http://localhost:8080
```

Opening `dist/index.html` directly from disk also works. In that mode only the bundled states have village lists, because browsers block `fetch` from `file://`.

## Deploy

Everything deployable is in `dist/`.

- **GitHub Pages:**
  1. Push the repository to GitHub.
  2. Go to Settings → Pages → Source: *GitHub Actions*.
  3. The included workflow `.github/workflows/pages.yml` builds and publishes on every push to `main`.
- **Vercel:** Import the repository. `vercel.json` sets the build command and output directory.
- **Netlify:** Import the repository. `netlify.toml` sets the build and publish directory.
- **Any static host:** Upload the contents of `dist/`.

When the page is served from a web host, village lists for states that aren't bundled load automatically from `data/gazetteer/<state-code>.json`.

## Storage

All storage goes through `src/store.js`, which has one small interface: `listBatches`, `loadRecords`, `saveBatch`, `deleteBatch`, `getKV`, `setKV`, `onChange`.

| Where the page runs | Backend used | Who sees the data |
|---|---|---|
| Published as a claude.ai artifact | the artifact's shared database | everyone the artifact is shared with |
| Your own web host, with `sharedStoreUrl` set in `src/config.js` | Google Drive via `apps-script/Code.gs` | everyone with the team access key |
| Your own web host or local file, without it | browser IndexedDB | only that browser |
| Neither available | memory | nobody (lost on reload) |

**Shared storage for the team (Google Drive, free).** Out of the box, the GitHub/Vercel/Netlify version keeps uploads in each person's browser, so a shared link shows an empty dashboard to everyone else. To give the team one shared history:

1. With a company Google account, open <https://script.google.com> and click **New project**.
2. Replace the sample code with the whole of `apps-script/Code.gs` and save.
3. Go to **Project Settings → Script properties → Add script property**. Name it `ACCESS_KEY` and set it to a long passphrase.
4. Go to **Deploy → New deployment → Web app**. Set *Execute as: Me* and *Who has access: Anyone*, then click **Deploy**. Authorize it (Advanced → Go to project → Allow) and copy the Web app URL, which ends in `/exec`.
5. In the repository, edit `src/config.js` and paste the URL between the quotes of `sharedStoreUrl`. Commit; the site rebuilds in about 2 minutes.
6. Open the site and enter the access key; each person does this once per browser. On the **Sources** page, use **Copy to shared storage** to move anything uploaded earlier in that browser.

Notes:
- **Where the data lives:** a Drive folder called "Field Visit Atlas data", owned by the account that deployed the script, with one gzipped file per month.
- **Size:** about 5 KB per day of uploads, so a year loads in a few MB.
- **Access:** anyone with the key can read, upload and delete. Change the key in Script properties when someone leaves; everyone then re-enters it.
- **Keep the key out of GitHub:** never put it in `config.js`, because the repository is public.
- **Editing the script later:** go to Deploy → Manage deployments → edit → *New version*. The URL stays the same.

**Shared team storage on a database.** To give a team one shared history outside claude.ai, implement the same interface on a database and return it from `openStore()`. A Supabase sketch:

```js
class SupabaseStore {
  constructor(client) { this.mode = 'shared'; this.shared = true; this.sb = client; }
  async init() { return true; }
  async listBatches() { return (await this.sb.from('batches').select('meta')).data.map(r => r.meta); }
  async loadRecords() { return (await this.sb.from('record_chunks').select('chunk')).data.map(r => r.chunk); }
  async saveBatch(meta, chunks) {
    await this.sb.from('record_chunks').insert(chunks.map(c => ({ id: c.b + '_' + c.n, batch_id: c.b, chunk: c })));
    await this.sb.from('batches').insert({ id: meta.id, meta });
  }
  async deleteBatch(id) { await this.sb.from('batches').delete().eq('id', id); await this.sb.from('record_chunks').delete().eq('batch_id', id); }
  async getKV(k) { const r = await this.sb.from('kv').select('value').eq('key', k).maybeSingle(); return r.data ? r.data.value : null; }
  async setKV(k, v) { await this.sb.from('kv').upsert({ key: k, value: v }); }
  onChange(cb) { const ch = this.sb.channel('batches').on('postgres_changes', { event: '*', schema: 'public', table: 'batches' }, cb).subscribe(); return () => ch.unsubscribe(); }
}
```

Use Supabase Auth and row-level security. The data contains customer names and phone numbers.

**Data model.** Each upload is one *batch*. Rows are stored as compact arrays in chunks of 400. Field order is `Ingest.FIELDS` in `src/ingest.js`: key, date, time, user, employee ID, designation, HQ, manager, phone, customer ID, customer, activity, new/old, state, district, taluka, village, latitude, longitude, status, product, remarks, territory, batch.

Geography is re-resolved every time the app loads. Improving the gazetteer or adding location fixes therefore updates old records too. Location fixes and the territory plan live in key–value storage under `geoFixes` and `territoryPlan`.

## Project layout

```
src/config.js         settings: the shared-storage URL (empty = each browser keeps its own data)
src/index.html        page shell and styles (Archivo; light and dark themes)
src/geo.js            name normalisation, fuzzy matching, State→District→Taluka→Village resolution
src/ingest.js         Excel reading, header and column detection, validation, duplicate keys
src/store.js          storage adapters
src/analytics.js      filters, KPIs, staff metrics, review flags, coverage gaps, insights
src/app.js            UI: map (Leaflet), charts (Chart.js), tables, upload flow, exports
data/                 boundaries, district metadata, towns, per-state village lists (see DATA_SOURCES.md)
scripts/build_geo.py  rebuilds data/ from the government source files
scripts/bundle-districts.js  decides which states' village lists are embedded in the page
scripts/build.js      produces dist/
scripts/make-seed.js  converts an export into stored batch format (for pre-loading a database)
apps-script/Code.gs   Google Apps Script backend for shared storage on Google Drive
```

## Rebuilding the map data

`data/` is already built. To refresh it, for example when new districts are notified:

1. Download from <https://github.com/ramSeraph/indian_admin_boundaries/releases>:
   - `LGD_Subdistricts.parquet`
   - `LGD_Districts.parquet`
   - `Census_Villages.parquet`
   - `SBM_ULBs.parquet`
2. Install the tools: `pip install geopandas pyarrow` and `npm i -g mapshaper`.
3. Run `python scripts/build_geo.py /path/to/parquet/folder`.
4. Run `node scripts/bundle-districts.js your_exports/*.xlsx`. This picks the states to embed.
5. Run `npm run build`.

## Library versions and security

Libraries load from jsDelivr at pinned versions with Subresource Integrity hashes: Leaflet 1.9.4, Leaflet.markercluster 1.5.3, Leaflet.heat 0.2.0, topojson-client 3.1.0, Chart.js 4.4.1 and SheetJS 0.18.5.

SheetJS 0.18.5 is the last version published to npm. It has known issues with maliciously crafted spreadsheets: a prototype-pollution bug (CVE-2023-30533) and a ReDoS bug (CVE-2024-22363). The risk is low when you only upload your own CRM exports.

For your own deployment, replace the SheetJS `<script>` in `src/index.html` with the current release from `https://cdn.sheetjs.com/`, then rebuild. The claude.ai version has to stay on 0.18.5, because claude.ai only lets the page load scripts from a short list of hosts that does not include SheetJS's own CDN.

## Customer data

The app stores customer names and phone numbers. Do not commit CRM exports to the repository; `.gitignore` excludes `.xlsx` files. If you make a deployment public, add authentication in front of it.
