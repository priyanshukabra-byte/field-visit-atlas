# Data sources and licences

All geographic reference data comes from Government of India sources. It was obtained through the community republication at <https://github.com/ramSeraph/indian_admin_boundaries>, which releases it under **CC0 1.0** and asks users to credit DataMeet and the original government source where possible. The app credits both on the map and on its *Sources* page.

| File in `data/` | Content | Original source | Notes |
|---|---|---|---|
| `india_admin.topo.json` | 6,470 sub-districts (taluka / tehsil / block / mandal), dissolved into 785 districts and 36 states/UTs | Local Government Directory boundaries served by Bharatmaps (National Informatics Centre, MeitY) | Simplified with mapshaper for web display (about 0.5% of original vertices). Districts and states are built from the sub-districts, so all three levels share exactly the same borders. |
| `geo_meta.json` | District names, LGD district codes, state codes, label points | LGD district layer (Bharatmaps) | Some LGD names lag official renamings, e.g. Osmanabad (Dharashiv), Ahmednagar (Ahilyanagar), Aurangabad (Chhatrapati Sambhajinagar). `src/geo.js` maps both names. |
| `towns.json` | About 3,368 urban local bodies with a point inside each, plus about 1,800 further towns and cities | Swachh Bharat Mission (Urban) ULB boundaries (CC0 via ramSeraph); missing towns from **GeoNames** cities1000 (CC BY 4.0, © GeoNames, geonames.org) | The SBM list lacks many large cities (Varanasi, Pune, Basti and over 300 district headquarters), so GeoNames fills them. Suffixes such as "Municipal Council" and "Nagar Panchayat" are stripped so that "Washim" matches "Municipal Council Washim". |
| `gazetteer/<state>.json` | About 645,000 village points with name and population class | Census of India 2011 village locations, served by Bharatmaps (NIC) and republished by ramSeraph (CC0 1.0) | Villages are re-assigned to *current* sub-districts by location. Villages created after 2011 are missing, and so are hamlets, city localities and market names. |

**Not used:** SHRUG village and town polygons are excluded. They carry a non-commercial licence (CC BY-NC-SA 4.0), which does not fit a company tool.

## National boundary

The national outline is the one in the Government of India's LGD/Bharatmaps data, which follows the official depiction of India. The Geospatial Data Guidelines (DST, 2021) make Survey of India boundary data the standard for political maps of India.

The optional base maps follow different rules:

- **OpenStreetMap tiles:** follow OSM's own on-the-ground boundary policy and show some international borders differently. The app keeps the official boundary overlay on top and warns when this layer is switched on. Light use only, under the OSM Foundation tile usage policy. Switch to a commercial tile provider for heavy use.
- **Esri World Imagery:** satellite imagery with no political lines. Check Esri's terms before commercial use.

## Accuracy limits

- **Boundaries:** simplified, so they are reliable at district and taluka level but not for parcel-level work.
- **Village points:** Census 2011 locations. Village names in CRM exports are typed by field staff in Latin script with varying spellings. Matching tolerates common transliteration differences but rejects ambiguous matches. On the first export (1–6 Oct 2026), 80% of rows matched a named village or town and 19% fell back to a taluka centre. 2 rows had no state or district at all.
- **Sub-district layer age:** the LGD sub-district layer predates some new districts, mostly the 2023 districts of Rajasthan, so their sub-districts are approximate.
