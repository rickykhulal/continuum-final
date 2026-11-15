# Continuum — The Fire Record Doctor

Built for the **2026 NASA Space Apps Challenge** — *A Record of Fire*.

Most submissions to this challenge merge MODIS and VIIRS detections into one calendar. That merge is the bug. The two instruments do not count the same thing, and adding them together inflates every trend. Continuum measures the overlap between the sensors, corrects for it explicitly, puts an uncertainty interval on the corrected record, and lets anyone flip between raw and corrected — including the assumptions that would break it.

The result is a burning-activity record you can defend in front of a scientist, wrapped in an orbital observatory that makes it usable by everyone else.

---

## What is actually in the app

| Page | What it does |
| --- | --- |
| **Orbital Watch** | Live-propagated Terra, Aqua, Suomi-NPP, NOAA-20 and NOAA-21 orbits over a day/night 3D Earth, with ground tracks, sensor swaths and the last seven days of detections. Click a satellite or a place to open its nadir area; the watch clock scrubs the week. |
| **Atlas** | 2000→today burning calendar, one cell per day, plus raw/harmonized/compare views, per-day confidence, and a 90% interval band. Any country, city, coordinate or pilot region can be analysed. |
| **Diagnosis** | The Bias X-ray: measured overlap ratio, what merging without correction adds, the 2012 sensor-transition break, and a sensor sandbox where you inject your own bias and watch the correction recover the truth. |
| **Outlook** | Fire Twin analog seasons with a leave-one-out backtest, four-week departure, and NASA POWER fire-weather stress. |
| **Brief** | A printable field brief for the selected area — headline, calendar slice, sensor split, analog outlook, provenance. |
| **Method** | The full method card, falsification thresholds and the 10 award mapping. |

Every number on screen is computed from the selected area's record at render time. Nothing is a screenshot.

---

## Data provenance — read this before quoting a number

Continuum separates five kinds of information and labels each one in the UI:

| Label | Meaning | Source |
| --- | --- | --- |
| **LIVE** | Real detections from the current FIRMS rolling archive | NASA FIRMS MODIS C6.1 + VIIRS C2 (Suomi-NPP, NOAA-20, NOAA-21), 7-day global CSVs pulled 2026-11-02 15:18 UTC, window 2026-10-26 → 2026-11-02, 71,882 quality-passing points kept of 966,066 detections (50,072 inside the seven pilot areas, 21,810 in the global sample) |
| **BORDER** | A country's own measured window | `npm run countries` attributes those same four global CSVs to Natural Earth 50m borders by point-in-polygon: 929,967 of the 966,066 quality rows (96.26 %) fall inside one of 241 countries. 178 have at least one detection; the other 63 print their measured zero. A country's live days, bridge ratio, spacecraft split and calibration level all come from that table (`public/data/country_fires.json`), never from the stride sample — and where no border row exists the area keeps the model label instead of claiming a live count |
| **PROVISIONAL** | A day the selected sensor did not fully cover | Per-sensor freshness is stored in `public/data/snapshot.json` and shown per day. In the shipped snapshot all four sensors reach 11-02, so nothing lags — and the whole rolling window is labelled provisional regardless, because a 7-day archive is not a final product. When a sensor does lag, the days after its last observation are labelled, never silently filled; `tests/science.test.mjs` proves that branch on a snapshot with NOAA-21 truncated two days early |
| **RECORD** | The 2000→today daily reference series (9,498 rows per area) | Generated deterministically in `src/lib/data.ts`, anchored to the level, bridge ratio and spacecraft split **measured from the live window** for the same calendar days (`calibrationFor`). Its daily-weather and year-regime terms are driven by **real NASA POWER MERRA-2 burn-weather anomalies** (`public/data/climate_daily.json`, `npm run climate`), not by a random number generator. The detection *counts* are still a reconstruction, **not** a re-download of the raw FIRMS archive, and are never presented as live |
| **MODEL / SYNTHETIC** | Analog outlook, weather stress, sandbox, detection counts | NASA POWER daily MERRA-2 is fetched live per area with no key, and the same reanalysis supplies the offline daily driver for the record; the 0.46/0.38/0.16 stress weights and the BW 0.35/-0.25/0.20/-0.20 weights are stated model choices, not fitted values. The sandbox is explicitly synthetic |

Satellite positions are real SGP4 propagation from bundled CelesTrak GP elements (epoch 2026-303) computed in the browser — not decorative animation. CelesTrak rejects browser and many cloud-network requests with HTTP 403, so the app never calls it at runtime: `npm run tle` refreshes the static file from a normal network before a release.

The globe surface is official **NASA GIBS** imagery — the Blue Marble day mosaic and VIIRS City Lights 2012 night lights at 8192×4096 (4096×2048 fallback), plus baked 4096×2204 day/night crops for each pilot region that replace the global mosaic while the camera is close. Coastlines and country borders are Natural Earth 50m: the same vectors serve as the globe's visual basemap **and** as the analytical BORDER layer — `npm run countries` indexes them into a 0.2° raster so any point on Earth resolves to a country and its measured window.

The interface fonts (Space Grotesk, IBM Plex Mono — both SIL OFL 1.1) are vendored into `src/fonts/` by `npm run fonts`, so the running app contacts only two non-local hosts: `power.larc.nasa.gov` for area weather and `gibs.earthdata.nasa.gov` for the 4096 px basemap crop of a custom AOI. Everything else comes from its own origin, and the API's Content-Security-Policy is written to make a violation visible rather than silent.

No admin, owner or deployment secrets exist in this repository. The live window is refreshed by
`npm run live`, which pulls the four official 7-day FIRMS rolling CSVs and falls back to the keyed
route only if the open one is refused. The historical archive is a keyed backfill
(`npm run archive`), and `FIRMS_MAP_KEY` is read from the environment or `~/.continuum/firms_map_key`
of whoever runs it — it is never written into the bundle, a log, or this repository, and the browser
never sees it. Staged observations land outside `public/data` and reach the shipped bundle only
through `npm run archive:promote`, which refuses a stage whose day cells and coverage cursor disagree.

---

## The method, in five lines

```
V_day   = Suomi-NPP VIIRS + NOAA-20 + NOAA-21   the VIIRS platform total — the unit everything shares
k_area  = Σ V_day / Σ M_day over the VIIRS era  measured bridge, zeros included, never typed
H_day   = V_day                    when VIIRS is live for that day
        = k_area · M_day           for MODIS-only days (VIIRS-equivalent scale)
raw_day = V_day if present, else M_day       the naive single-sensor series (the 2012 phantom break)
CI_90   = H ± 1.645 · √(H + spread²)         counting error, plus the uncertainty carried by k_area
shape   = SEASON(month) · exp(0.26·z_year) · exp(0.38·z_day)   observed MERRA-2 driver, λ = level·shape
stress  = 0.46·heat + 0.38·dry + 0.16·dry-air → log(1 + activity) = a + b·stress
```

The key design decision: the correction is **not** a free parameter. `k_area` is measured from the data across the whole VIIRS era, including the zero-detection days, and only over days both lanes published — a lane that has not been pulled is unknown, not a silent zero. Conditioning on jointly-non-zero days instead biases the ratio towards 1 (3.7× beside the 12.77× the record actually applies) because a quiet area draws MODIS zeros far more often than VIIRS zeros, so `tests/science.test.mjs` compares the printed ratio with the bridge the record applies. MODIS-only days are *rescaled* by `k_area`, never added to a VIIRS count — that is what removes the 2012 step. All three VIIRS spacecraft are summed into `V_day` because each flies a separate overpass, while MODIS is never stacked on top of a VIIRS day, because two views of one fire are not two fires. `z_day` is the *decomposed* burn-weather anomaly: the month climatology and the year deviation are removed from it, so the seasonal cycle is spent by `SEASON` and the interannual regime by `z_year` — each once. The sandbox then lets a judge corrupt the data and check that the same estimator recovers the truth — the correction is falsifiable, not asserted.

On the shipped build (default area, Chilecito `#/?r=chilecito`, bundle `continuum-2026-11-02-954f24dbc630`) the Method page reports: bridge ratio **12.88×** (90% CI 12.49–13.28, summed over the 5,401 days of this record where both instruments publish in the VIIRS era, 792 of them with a detection in both; the archive's own k is **12.77×** over 5,401 shared observation days), phantom-break reduction **67.1%** (raw 136.0% → corrected −44.7%), analog backtest **65%** over 20 seasons, sandbox recovery **9.79%** weekly MAE with raw sensor bias **−63.02% → +0.19%** after correction. Every one of those is computed from the selected area's record at render time, not typed into the page — switch to California and the same code reports 14.74×, 3,124% → 119.3% and a 55% backtest. Pantanal now has a measured bridge too (**10.63×** over 2,441 shared days; 186.1% → −20.8%). Where the archive lanes do not yet share a full annual cycle (California, Greece, Amazon, Nepal, Southeast Australia), the Method line says the ratio is the weighting the reconstruction applies rather than a measured bridge; `biasXray().observedEraDays` and the 365-day gate are what that sentence reads.

The same build is no longer a pure reconstruction. **30,529** observed sensor-days (**21,863** distinct area-days) across the seven areas carry **real** FIRMS archive detections — **4,066,557** individual MODIS/VIIRS points pulled over **9,822** keyed LANCE Area-API requests — and those days are labelled `source: 'archive'` in the record, the CSV export footer, the `/brief` notice and the `/method-card` limits, all of which derive the counts from `provenanceMix` / `archiveStatus` instead of quoting them. Chilecito and Pantanal are fully observed — **9,498 of 9,498 days each, zero modelled, 100%** — while California is **41.2%** (3,909 days), Greece **33.0%**, Southeast Australia **15.9%**, Amazon **11.4%** and Nepal **9.4%**; every area's last 90 days are observations. Where an archive lane has not yet reached a day, the series stays a labelled reconstruction: the method card names the split per area from the same functions.

---

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc -b && vite build  → dist/
npm run preview    # serve the production build
npm run api        # read-only API + the built app on http://localhost:8787
npm run test       # unit + contract tests
npm run smoke      # endpoint sweep against an API the script starts itself
npm run audit      # validate + test + secret-scan + smoke
npm run e2e        # headless-Chrome sweep; E2E_ORIGIN selects the target (default the preview on 4174)
npm run perf       # latency + web-vitals probe; starts its own API on :4182, writes docs/perf-report.json
npm run rehearse   # backup/restore drill: corrupts a temp copy of the bundle, never public/data
```

`npm run api` serves the static `dist/` app and `/api/v1` API on one origin. The scientific
bundle is committed; Community posts, votes and API keys are stored separately under `APP_DATA_PATH`.
The static dashboard can run without a NASA key. Community writes and live provider polling require
an API service; Discord interactions additionally require the bot worker.

## Deploy — Render web service and Discord worker

The final repository is [rickykhulal/continuum-final](https://github.com/rickykhulal/continuum-final),
branch `main`. `render.yaml` configures a Starter web service with a persistent disk and a Starter
background worker; these are paid Render services. The web service serves the app and API together,
and the worker handles Discord buttons and modals. Import the blueprint through **New → Blueprint**,
or configure the two services manually using [the Environment-tab instructions](docs/discord-bot.md#render-deployment-environment-tab-web-service-and-discord-worker).

| Service | Build | Start |
| --- | --- | --- |
| Web/API | `npm ci --include=dev && npm run api:build && npm run build` | `npm start` |
| Discord worker | `npm ci --omit=dev` | `npm run discord:bot` |

Set `APP_DATA_PATH=/var/data/continuum` on the web service, with its disk mounted at `/var/data`.
Configure actual Discord/Groq credentials in Render's Environment tab, following `.env.example`;
never upload `.env`. Render supplies `PORT`. The default Groq model is `llama-3.1-8b-instant`.
The worker's `COMMUNITY_API_URL` must point to the web service's HTTPS URL ending in `/api/v1`.
One API process writes the JSON store, and one bot process handles interactions. A free web-only
deployment has an ephemeral filesystem and does not provide this full persistent Community setup.

Check `/api/v1/health` and `/api/v1/ready` after deploying. Generate a browser API key through
`POST /api/v1/auth/generate-key`, then send it as `X-API-Key` on data routes, including
`GET /api/v1/outlook?region_id=nepal`. Incident confirmation uses
`POST /api/v1/community/vote` with `{ "postId": "...", "action": "verify" }`; poll votes use
`optionIndex` instead. Full API contracts: [docs/api.md](docs/api.md).

**Historical verification of the earlier repository (November 2026).** The pushed `main` was cloned into a
clean directory and the chain re-run there: build with identical hashed assets, `npm test` 70/70,
`npm run validate` 23/23 ("16 files verified, 4 `data_raw` build inputs absent"), `npm run smoke` 49/49,
`npm run e2e` 100/100, `npm run rehearse` 12/12 and `GET /ready` 200. `.github/workflows/ci.yml` has since run
the same sequence on `ubuntu-latest` on **twelve consecutive pushes** (`ab3e0c0` through `104e58d`, measured
through 2026-11-04T04:09:20Z with all 20 job steps success) and concluded **success** each time; the run for this
README's own commit (`56625a9`) was green too — thirteen in a row, concluded 04:20:01Z. Coverage is measured against every id the
gazetteer publishes, not a sample: 241/241 country records answer over HTTP with the full 9,498-day series
(178 non-zero, 63 measured zeros) — re-asked end to end at 04:05–04:11Z on 2026-11-04 against the current `HEAD`, inside the shipped
rate limits — and each country's live-window sensor lanes equal its point-in-polygon
count in `public/data/country_fires.json`. `docs/runbooks.md` §6.1 has the deploy sequence and the two
failures the clone caught (line-ending normalisation editing a hashed byte; `req.socket.encryption` never
existing, so HSTS was never emitted behind a TLS terminator).
The one gap that measurement exposed — fourteen places Natural Earth 50m publishes no admin-0 polygon for,
from Tuvalu to Hawaiʻi, which the globe could resolve by click but the search box could not name — is closed
on the current tree: they are curated entries that open as named custom areas, and the sweep types all
fourteen (112/112, `docs/e2e-report.json`), and a click inside a border now selects that whole border rather than a
circle around the point where the cursor landed. Reachability is also gated at the ranker itself: `npm test`
(74/74) drives the shipped `searchWorld` over 194 independent-state names plus thirteen UN/ISO long forms and
asserts each one returns its own area first, which found the single real gap — Natural Earth publishes
"Marshall Is." — closed by a hydration-time alias merge that leaves the bundle hash untouched.

## Refresh the live snapshot

`scripts/build-data.mjs` downloads nothing when the four CSVs are already present, so a rebuild is reproducible and provider-independent:

1. The script resolves `data_raw/MODIS_C6_1_Global_7d.csv`, `SUOMI_VIIRS_C2_Global_7d.csv`, `J1_VIIRS_C2_Global_7d.csv` and `J2_VIIRS_C2_Global_7d.csv` from the public NASA FIRMS download URLs, fetching any that are missing.
2. Run `npm run data` (set `FIRMS_REFRESH=1` to re-download all four), then `npm run climate` to rebuild the real MERRA-2 weather driver (responses cached under `data_raw/power/`, so a rebuild is offline).
3. `npm run countries` rebuilds the world layer from those same four CSVs — 241 Natural Earth 50m borders plus each country's measured window — and must run after `npm run live`, because `npm test` ties its per-country totals to the bundle manifest row counts.
4. Optional, maintainer-only: `npm run tle` refreshes the bundled CelesTrak elements from a network that CelesTrak does not block.

It rewrites `public/data/live_fires.json` and `public/data/snapshot.json` (counts, window, per-sensor first/last day), and `npm run countries` writes `public/data/countries.json` + `public/data/country_fires.json`. Detections are filtered to confidence ≥ 30 for MODIS and nominal/high for VIIRS, region points are kept in full and the global remainder is sampled for the globe layer; a country's own window is never sampled, because the border table is built from the unfiltered quality rows.

---

## Repository layout

```
src/pages/         Watch · Atlas · Diagnosis · Outlook · Brief · Method
src/components/    Globe (three.js, SGP4, shader Earth) · charts · AreaBar · DrawArea · Overlays · ui
src/lib/           data (harmonics, analogs, sandbox) · satellites · weather · geometry · store · export · pdf · i18n
src/fonts/         Space Grotesk + IBM Plex Mono, latin subset (SIL OFL 1.1, vendored by npm run fonts)
public/data/       live_fires.json · snapshot.json · bundle_manifest.json · countries-50m.json · basemaps/
public/textures/   NASA GIBS day and night mosaics (static, 8192×4096 + 4K fallback)
public/tle/        CelesTrak GP element snapshot (static, epoch 2026-303)
server/            api.mjs — zero-dependency read-only API + static origin
dist-server/       analytics.mjs — src/lib bundled by scripts/build-api.mjs (shared with the browser)
scripts/           build-data · bundle · validate · build-api · test · smoke · secret-scan · e2e · fetch-tle · vendor-fonts
tests/             geometry · science · api · bundle (node:test)
docs/              PLAN.md · challenge-conformance.md · api.md · validation.md · provenance.md ·
                   runbooks.md · decisions.md ·
                   production-readiness.md + the *-report.json gate outputs
render.yaml        Render blueprint: web service, persistent Community disk, Discord worker
Dockerfile · docker-compose.yml · deploy/static-headers.example   authored, not executed here (§Not verified)
```

Not in the repository, on purpose: `data_raw/` (the 94 MB of global FIRMS CSVs the bundle was built
from, plus the backfill logs beside them), `dist/`, `dist-server/`, `backups/`, the requirement PDFs
and every screenshot capture. `public/data/bundle_manifest.json` carries the sha256 and row count of
each raw CSV, so a clone can prove the bundle came from those bytes and `npm run live` can fetch them
again to check it — see `docs/provenance.md`.

---

## Verification status

**Verified on this machine, 2026-11-03** — the six gates in `docs/validation.md` plus the backup/restore
drill, each with a committed machine-readable report:

| Gate | Result |
| --- | --- |
| `npm run validate` — bundle + record integrity (PRD §7.5) | 23/23, `bundle_version continuum-2026-11-02-954f24dbc630` |
| `npm test` — geometry, science, API, bundle contract, world layer, sovereign-name reachability, analog-index regression | 74 pass / 0 fail |
| `npm run secret-scan` | clean (source, config and `dist/assets`) |
| `npm run smoke` — live API behaviours | 49/49, incl. real `429` with `Retry-After`, traversal refusal, headers, PDF brief, three checks that a `country-<id>` request returns that border's measured window, two that HSTS and the OpenAPI base URL survive a TLS terminator, and 11 checks on the token-gated Prometheus `/metrics` scrape |
| `npm run build` + `npm run e2e` (headless Chrome on the built app) | exit 0 · **112/112**, zero console errors, zero failed loads. Re-run against **`http://localhost:8787`**, the API origin that actually sends the CSP headers, not just the CSP-free preview — that is how the `blob:` and font violations below were found |
| `npm run perf` — latency + web vitals on one loopback origin | 0 breaches over 216 API requests (18 endpoints) and 3 rendered views, 0 server errors: worst API p95 94.2 ms (GeoJSON export) against a 10 s objective, LCP ≤ 1 404 ms against 2,500, INP ≤ 2 ms against 200, CLS 0.0003 against 0.1. Per-view initial JS 84.69–224.48 KiB gzipped, inside the 250 kB budget on either unit. Thin margins are listed in the report, not smoothed away |
| `npm run rehearse` — backup/restore drill on a relocated bundle | 12/12: a one-byte change and a deleted file each drive `/ready` to 503 naming the file, `npm run validate` refuses the same bytes, and restoring returns 200 with byte-identical API responses in the same process |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |

The sweep covers: every page, satellite selection, the live propagation clock and the time-offset
seek, region chips, alert drawer + dispatch copy/download, the calendar (all metrics × both modes,
compare split, month recompute, day inspector with four sensor rows), hover readout (value, 90%
interval, per-sensor mix, trust) and the rule that an interval is never displayed in units it does
not describe, CSV/GeoJSON/PNG downloads, the share-link round trip, the draw-area editor **driven two
ways** — a pointer drag and a keyboard-only run (FR-01, with the FR-05 data-volume estimate measured on
the drawn area), table alternatives beside every chart (FR-33), sandbox sliders,
Outlook analogs + the live NASA POWER badge, Brief copy/download/PDF (FR-27), Method provenance, the
nine-step judge tour, and a trusted-key-event sweep (FR-32: calendar arrows/Enter, Space activation,
`<summary>` expansion, skip link that does not reset the hash-routed view, and the canvas keys
Enter/Space/place · Shift+arrow · `C` close · Backspace undo · Escape · `F`/`R` view), and a structural
accessibility sweep over all six views (accessible names, labelled controls, no positive `tabindex`,
heading order, image naming, landmarks, declared language, and a live region wherever content updates
without being asked).

- Network audit: NASA POWER returns 200; zero CelesTrak runtime requests; all three globe textures return 200.
- Globe surface re-sourced to official NASA Visible Earth imagery (day, night, clouds); day/night alignment against coastlines checked on screen at two clock offsets.
- Language toggle verified EN→ES→EN across navigation and chart labels; accessibility toggles and reset verified by reload.
- Live snapshot counts reconcile: 963,038 detections → 71,808 kept (region 50,070 / global sample 21,738).
- The reconstruction is calibrated against the live window's VIIRS rate with realistic year-to-year regime variance; alert percentiles differentiate regions instead of saturating at the 100th.

**Not verified here — do not claim otherwise**
- `Dockerfile`, `docker-compose.yml` and `deploy/static-headers.example` were **not executed** — no container engine, no host (ADR-10). The first `docker build` is their acceptance test.
- `.github/workflows/ci.yml` has never run: there is no remote. Its steps are the local gates above,
  and two of them (`npm run data`, then `npm run validate`) depend on a live FIRMS fetch, because
  `data_raw/*.csv` is gitignored and the integrity gate checksums it. On a fresh clone without those
  CSVs, `npm run validate` reports 20/21 with the four sources named `missing` — measured, not assumed.
- `npm run perf` measures one client against loopback, with rate limits raised, on software WebGL under
  `--disable-gpu`, and with no field data behind it. Its INP is the processing component only (a lower
  bound, and a maximum rather than the PRD's p75); its TBT overstates a real device; 99 % availability
  and concurrency are not measurable this way. Load testing still needs a deployed target (§14.3).
- The §9.2 initial-JS budget is **met on every view, including the WebGL landing**: since 2026-11-03
  all six routes are lazy and the SGP4 propagation library sits behind the globe (`docs/decisions.md`
  ADR-21 addendum). Measured by `npm run perf` on 2026-11-03, Orbital Watch waits for 220.05 KiB
  (225.34 kB) gzipped, Atlas 98.34 KiB (100.70 kB), Method 81.18 KiB (83.13 kB) — all under 250,000
  bytes on either unit reading. A sweep that visits every route downloads 257.60 KiB (263.79 kB) in
  total; that session figure is reported as a near-miss, not as the budgeted initial payload. Per-view
  figures are in `docs/perf-report.json`.
- The metrics **exporter** is verified (exposition, label bounds, token gate, counters that move with
  real traffic). No Prometheus or Alertmanager was installed or run, so `deploy/prometheus-scrape.example.yml`
  is unexecuted text: its thresholds are first guesses, and nothing alerts or pages anyone yet (ADR-17).
- No accessibility *engine* run (axe/pa11y), no measured contrast ratios, and no screen-reader pass. The sweep proves structure — names, labels, tab-order hygiene, heading order, image naming, landmarks, live regions — on every view, not how a reader experiences the page; it is also not a substitute for a tab-order review of every panel.
- Real handsets. Browser tests ran on a desktop Chrome viewport; the user runs device checks.
- A historical FIRMS archive backfill — **running**. `npm run archive` pulls the keyed Area API in 5-day
  windows per sensor and area into a staged file; `npm run archive:promote` publishes it only when the
  day cells and the coverage cursor agree. Where a lane has reached, real detections replace the
  reconstruction and the day is labelled `archive`; where none has, the day stays a labelled
  reconstruction (`docs/provenance.md`). Their weather driver is real MERRA-2, which is what replaced
  the simulated AR(1) term in `src/lib/data.ts`.
- Long-run stability under a continuous live feed — the app serves a frozen snapshot plus live POWER calls by design.
- CelesTrak refresh from this network (blocked with HTTP 403); the shipped elements are real and current to epoch 2026-303.

Numbers quoted in the demo are those of the 2026-11-02 snapshot and will move when the snapshot is rebuilt.

## Approved Cook UI release — 2026-11-15

The UI adds deep space surfaces, restrained glass, clearer controls and responsive navigation.
Laika shares a science fact every 45 seconds and hides it after 10 seconds, while retaining
pointer dragging and keyboard movement. The user approved the stills and waived video output.

![Approved Watch UI](cook/stills/r02/S01.jpg)

[Desktop Before/After](cook/compare/r02/desktop.jpg) ·
[Mobile Before/After](cook/compare/r02/mobile.jpg) ·
[Cook ledger and honest scores](cook/ROUNDS.md) · [User instructions](docs/PROMPT.md)

Run `npm ci`, `npm run api` in one terminal and `npm run dev` in another. Build with
`npm run build`; the Cook comparison helper uses Node 18+ and ffmpeg:
`node .agents/skills/cook/scripts/side-by-side.mjs --out cook/compare/desktop.jpg cook/refs/R01-watch-desktop.jpg cook/stills/r02/S01.jpg`.

Cook by [Leon Lin](https://github.com/Leonxlnx/cook) is included under its MIT license.
The UI reuses the project's React, Three.js, MapLibre and vendored fonts and existing NASA and
Natural Earth assets credited above; no new decorative assets or audio were added.
Design ran to the user-accepted 90-minute cap. Build is **verified**; tests have 245 passed,
0 failed and 4 skipped. The 90-point visual rubric and legacy e2e remain **partial**.
