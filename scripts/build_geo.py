"""
Build the geographic reference data used by the Field Visit Atlas.

Inputs (download from https://github.com/ramSeraph/indian_admin_boundaries/releases):
  subdistricts/LGD_Subdistricts.parquet   - LGD/Bharatmaps sub-district boundaries
  districts/LGD_Districts.parquet         - LGD/Bharatmaps district boundaries (names, LGD codes)
  census-2011/Census_Villages.parquet     - Census 2011 village points (name, lon/lat, population)
  urban/SBM_ULBs.parquet                  - Swachh Bharat Mission urban local body polygons (towns)
All are republished under CC0 1.0 by ramSeraph (attribute DataMeet and the original government source).
Optional, recommended: GeoNames cities1000 (CC BY 4.0), https://download.geonames.org/export/dump/cities1000.zip
  (unzip to cities1000.txt in the same folder). It fills cities missing from the SBM list (e.g. Varanasi, Pune, Basti).
  The rg_cities1000.csv file shipped with the reverse_geocoder Python package is also accepted.

Outputs (in ../data):
  india_admin.topo.json   - TopoJSON with subdistricts / districts / states sharing arcs
  geo_meta.json           - names, codes and label points for states and districts
  towns.json              - {districtId: "name|x|y|subdistrictId;..."} for every urban local body
  gazetteer/<state>.json  - {districtId: "<sid36>:<name>,<x36>,<y36>,<popClass>|...;<sid36>:..."} Census 2011 villages
                            (x36 / y36 are the x / y offsets below in base 36; popClass = min(9, 2*log10(population+1)))
x / y are integer offsets: x = round((lon-68)*1e4), y = round((lat-6)*1e4)  (~11 m resolution)

Requires: geopandas, pyarrow, numpy, and mapshaper (npm i -g mapshaper)
Usage: python build_geo.py /path/to/parquet/dir
"""
import sys, os, json, re, subprocess
import numpy as np, pandas as pd, geopandas as gpd

SRC = sys.argv[1] if len(sys.argv) > 1 else '.'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data')
os.makedirs(os.path.join(OUT, 'gazetteer'), exist_ok=True)
P = lambda f: os.path.join(SRC, f)

sd = gpd.read_parquet(P('LGD_Subdistricts.parquet'), columns=['sdtname', 'subdt_lgd', 'geometry']).reset_index(drop=True)
sd['sid'] = np.arange(len(sd))
d = gpd.read_parquet(P('LGD_Districts.parquet'), columns=['dist_lgd', 'dtname', 'state_lgd', 'stname', 'geometry']).reset_index(drop=True)
# two districts (PoK) carry LGD code 0 -> give them unique negative ids
d['did'] = np.where(d.dist_lgd > 0, d.dist_lgd, -(np.arange(len(d)) + 1))

# assign every sub-district to the current district layer spatially (LGD sub-district codes lag new districts)
rp = sd.copy(); rp['geometry'] = sd.geometry.representative_point()
j = gpd.sjoin(rp[['sid', 'geometry']], d[['did', 'state_lgd', 'geometry']], how='left', predicate='within')
j = j[~j.index.duplicated()].set_index('sid')
sd['did'] = j.did.reindex(sd.sid).fillna(-999).astype(int).values
sd['st'] = j.state_lgd.reindex(sd.sid).fillna(0).astype(int).values
c = sd.geometry.representative_point(); sd['cx'] = c.x.round(4); sd['cy'] = c.y.round(4)
c = d.geometry.representative_point(); d['cx'] = c.x.round(4); d['cy'] = c.y.round(4)
clean = lambda s: ' '.join(str(s).split())
sd['n'] = sd.sdtname.map(clean); d['n'] = d.dtname.map(clean)
STN = {'DADRA,NAGAR HAVELI,DAMAN & DIU': 'Dadra & Nagar Haveli and Daman & Diu', 'JAMMU & KASHMIR': 'Jammu & Kashmir',
       'ANDAMAN & NICOBAR': 'Andaman & Nicobar Islands'}
d['sn'] = d.stname.map(lambda s: STN.get(s, s.title()))

tmp = os.path.join(SRC, '_sub.geojson')
sd[['sid', 'n', 'did', 'st', 'cx', 'cy', 'geometry']].rename(columns={'sid': 'id', 'did': 'd', 'st': 's'}).to_file(tmp, driver='GeoJSON')
subprocess.run(['mapshaper', '-i', tmp, 'name=subdistricts', '-simplify', '0.5%', 'weighted', 'keep-shapes', '-clean',
                '-dissolve', 'fields=d', 'copy-fields=s', '+', 'name=districts', '-target', 'subdistricts',
                '-dissolve', 'fields=s', '+', 'name=states', '-target', 'subdistricts,districts,states',
                '-o', 'format=topojson', 'quantization=150000', 'target=*', os.path.join(OUT, 'india_admin.topo.json')], check=True)

meta = {'states': {}, 'districts': {}}
for s, g in d.groupby('state_lgd'):
    meta['states'][int(s)] = g.sn.iloc[0]
for r in d.itertuples():
    meta['districts'][int(r.did)] = [r.n, int(r.state_lgd), float(r.cx), float(r.cy)]
json.dump(meta, open(os.path.join(OUT, 'geo_meta.json'), 'w'), separators=(',', ':'))

def xy(lon, lat):
    return int(round((lon - 68) * 1e4)), int(round((lat - 6) * 1e4))

# towns: urban local bodies, label point inside polygon
u = gpd.read_parquet(P('SBM_ULBs.parquet'), columns=['ulbnm', 'geometry'])
u['geometry'] = u.geometry.representative_point()
u = gpd.sjoin(u, sd[['sid', 'did', 'geometry']], how='inner', predicate='within'); u = u[~u.index.duplicated()]
TOWN_WORDS = r'\b(municipal|municipality|council|councli|corporation|corp|nagar panchayat|nagar palika parishad|nagar palika|nagar nigam|' \
             r'npp|np|nps|nn|nagarpanchayat|city|cantonment board|cantonment|town panchayat|notified area|mc|m cl|m corp|cb|ct|og|ulb)\b'
def clean_town(n):
    n = re.sub(r'\(.*?\)', ' ', str(n))
    n = re.sub(r'[|;.]', ' ', n)
    n = re.sub(r'^(Npp?|Mc)(?!leod)(?=[a-z]{4,})', '', n.strip().title())   # glued prefixes e.g. "Nprudrapur", "Mcdaryapur"
    n = re.sub(TOWN_WORDS, ' ', n, flags=re.I)
    return ' '.join(n.split()).title()

towns = {}
for did, g in u.groupby('did'):
    parts = []
    for n, p, s in zip(g.ulbnm, g.geometry, g.sid):
        n = clean_town(n)
        if not n: continue
        x, y = xy(p.x, p.y); parts.append(f'{n}|{x}|{y}|{s}')
    towns[int(did)] = ';'.join(parts)
# add GeoNames places that the SBM list lacks (same district, no similar name already present)
def load_geonames():
    import csv
    pts = []
    f1, f2 = P('cities1000.txt'), P('rg_cities1000.csv')
    if os.path.exists(f1):
        for r in csv.reader(open(f1, encoding='utf-8'), delimiter='\t'):
            if len(r) > 8 and r[8] == 'IN' and r[6] == 'P': pts.append((r[2] or r[1], float(r[5]), float(r[4])))
    elif os.path.exists(f2):
        for r in csv.DictReader(open(f2, encoding='utf-8')):
            if r['cc'] == 'IN': pts.append((r['name'], float(r['lon']), float(r['lat'])))
    return pts
gn = load_geonames()
if gn:
    g = gpd.GeoDataFrame({'n': [x[0] for x in gn]}, geometry=gpd.points_from_xy([x[1] for x in gn], [x[2] for x in gn]), crs='OGC:CRS84')
    g = gpd.sjoin(g, sd[['sid', 'did', 'geometry']], how='inner', predicate='within'); g = g[~g.index.duplicated()]
    norm = lambda t: re.sub(r'[^a-z]', '', t.lower())
    added = 0
    for did, gg in g.groupby('did'):
        have = set(norm(p.split('|')[0]) for p in towns.get(int(did), '').split(';') if p)
        parts = [towns[int(did)]] if towns.get(int(did)) else []
        for n, p, s_ in zip(gg.n, gg.geometry, gg.sid):
            n = clean_town(n)
            if not n or norm(n) in have: continue
            have.add(norm(n)); x, y = xy(p.x, p.y); parts.append(f'{n}|{x}|{y}|{s_}'); added += 1
        towns[int(did)] = ';'.join(parts)
    print('GeoNames towns added:', added)
json.dump(towns, open(os.path.join(OUT, 'towns.json'), 'w'), separators=(',', ':'))

# villages: Census 2011 points, re-assigned to current sub-districts spatially
cv = pd.read_parquet(P('Census_Villages.parquet'), columns=['vilname', 't_pop2011', 'Long', 'Lat'])
cv = cv.dropna(subset=['Long', 'Lat']); cv = cv[(cv.Long > 60) & (cv.Lat > 5)]
cv = gpd.GeoDataFrame(cv, geometry=gpd.points_from_xy(cv.Long, cv.Lat), crs='OGC:CRS84')
cv = gpd.sjoin(cv, sd[['sid', 'did', 'st', 'geometry']], how='inner', predicate='within'); cv = cv[~cv.index.duplicated()]
def b36(n):
    n = int(n); d = '0123456789abcdefghijklmnopqrstuvwxyz'; o = ''
    while True:
        n, r = divmod(n, 36); o = d[r] + o
        if n == 0: return o

# compact encoding per district: "<sid36>:<name>,<x36>,<y36>,<pop>|<name>,...;<sid36>:..."
for st, gs in cv.groupby('st'):
    out = {}
    for did, g in gs.groupby('did'):
        groups = []
        for sid, gg in g.groupby('sid'):
            ents = []
            for n, x0, y0, p in zip(gg.vilname.fillna('').astype(object).map(str), gg.Long, gg.Lat, gg.t_pop2011.fillna(0)):
                n = ' '.join(re.sub(r'[|;:,]', ' ', n).split())
                if not n: continue
                x, y = xy(x0, y0)
                ents.append(f'{n},{b36(x)},{b36(y)},{min(9, int(np.log10(p + 1) * 2))}')
            if ents: groups.append(b36(sid) + ':' + '|'.join(ents))
        out[int(did)] = ';'.join(groups)
    json.dump(out, open(os.path.join(OUT, 'gazetteer', f'{int(st)}.json'), 'w'), separators=(',', ':'))
print('done')
