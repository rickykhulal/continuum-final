# Validation and integrity gates

Six gates and one drill, all runnable offline on this machine. None of them requires a network service
except the optional NASA POWER call, which is allowed to fail with a documented `503`, and except
`npm run data`, which is an ingest rather than a gate.

```
npm run validate      # 23 data + bundle integrity checks   → docs/validation-report.json
npm test              # 59 unit/contract tests (node:test)
npm run secret-scan   # pattern scan of source, dist, and .env presence
npm run smoke         # 44 live API checks against server/api.mjs → docs/api-smoke-report.json
npm run audit         # validate → test → secret-scan → smoke, in that order
npm run build         # tsc -b && vite build (typecheck + production bundle)
npm run e2e           # 92 headless-Chrome checks against the built app (E2E_ORIGIN, default :4174)
npm run perf          # latency + web vitals against the same-origin server → docs/perf-report.json
npm run rehearse      # backup/restore drill: corrupts a temp bundle, never the repo one → docs/rehearsal-report.json
```

`npm run e2e` expects the built app to be served first:
`npm run build && npx vite preview --port 4174 --strictPort`, then `npm run e2e`. It drives a real
Chrome via CDP, asserts on the DOM, waits for real downloads (`.txt`, `.csv`, `.geojson`, `.png`,
`.pdf`) and fails on any console error, failed network load, or HTTP 4xx/5xx inside the page.

## Gate 1 — data integrity (`scripts/validate.mjs`)

Implements the deployment PRD §7.5 checks over the shipped bundle. Exit `0` pass, `1` a failed
check, `2` the gate itself could not run. Each check records the evidence, not just a boolean.

Current result on this machine: **23/23 PASS**, `bundle_version`
`continuum-2026-10-31-3d36468a8dc0`.

Groups:

- **Reconciliation** — row count equals the declared kept count (83,116); region points (61,229)
  plus the global sample (21,887) equal the kept total; per-sensor quality sum (1,046,139) equals
  the declared total.
- **Field sanity** — coordinates in range, FRP non-negative and finite, sensor id in 0..3,
  confidence code in 0..2, acquisition time inside the declared window, timestamps monotonic,
  window ordered and matching the data.
- **Duplicates** — no exact duplicate row on the full tuple (lat, lon, acquisition time, FRP,
  confidence, sensor). Three rows share a rounded footprint with different FRP, which is normal
  scan-line coincidence and is reported informationally rather than failed.
- **Freshness** — per-sensor first/last inside the window and ordered; the sensors that lag the
  window (NOAA-21 in this bundle) are exactly the ones `provisional_from` names.
- **Record** — one row per day per region, `lower ≤ value ≤ upper` on every row (66,472 rows
  checked), no negative counts, provisional flags cover the stale tail and touch no model day.
- **Manifest** — `schema_version`, `bundle_version`, `data_through` present; every listed file's
  SHA-256 and byte size recomputed and compared (11 files); manifest window agrees with
  `snapshot.json`.

Two properties of that last group are worth knowing before running the gate somewhere new:

- **It certifies the directory it is told about.** `DATA_BUNDLE_PATH` relocates the bundle and the gate
  follows it (ADR-20); when it is set, nothing falls back to `public/data`, so a partially mounted
  bundle reports `missing` instead of borrowing the repo copy's bytes and passing.
- **It checksums the build inputs, not only the shipped files.** The manifest lists the four
  `data_raw/*.csv` sources, and those are gitignored. On a fresh clone the gate therefore reports
  20/21 with the four CSVs named missing until `npm run data` fetches them (measured by moving
  `data_raw/` aside and putting it back). `npm run serve` and `/ready` do not need them — the API
  skips `data_raw/` because it never serves it.

## Gate 2 — unit and contract tests (`npm test`, `scripts/test.mjs`)

48 tests in `tests/geometry.test.mjs`, `tests/science.test.mjs`, `tests/api.test.mjs`,
`tests/bundle.test.mjs`, `tests/analog-index.test.mjs`. `scripts/test.mjs` discovers the files and
spawns `node --test` with relative paths, because `node --test tests/` does not resolve correctly on
Windows.

The tests that matter most for a project that shows numbers to people:

- API responses equal the in-app computed values for the same area and window — the single-source
  claim is enforced, not assumed.
- `k_area` is the measured overlap ratio with a real 90% interval; NOAA-20/NOAA-21 never enter H.
- The raw 2012 step is compared in the same peak month across the sensor eras and must exceed 1.5×,
  while the harmonized step must be smaller — the phantom break claim is falsifiable.
- Provisional flags cover exactly the live window tail and never a model day.
- Geometry: ring closure, centroid, equal-area circle resolution, `pointInRing`, and simplification
  keep the area within 2% at 0.02° tolerance.
- Sandbox recovery is deterministic per seed.
- `bundle_version` is stable across re-runs of `npm run bundle` (content-derived, not a timestamp).
- The ingest path is keyless: no request in the shipped pipeline can carry a FIRMS API key.

Interval ordering, one-row-per-day, and negative-count checks are enforced on the full record by
Gate 1 (66,472 daily rows across the pilot regions), not by the unit tests.

- The Fire Twin's numbers are frozen against the pre-optimization implementation for all seven pilots
  (`tests/analog-index.test.mjs`), because the window sums behind the analog ranking were moved into a
  cached prefix-sum index (ADR-18). The fixture tolerates 1e-6 relative against a measured 2.1e-12 of
  float re-association, so a real change in the statistic fails the suite instead of shipping.

## Gate 3 — secret scan (`scripts/secret-scan.mjs`)

Patterns: AWS access keys, Google API keys, Slack tokens, GitHub tokens, PEM private keys, JWTs,
generic `secret = "…"` assignments, and credentials embedded in URLs. Scans source, config, and the
built `dist/assets`. A documented allowlist permits labelled placeholders. A real `.env` file is
flagged by presence. Current result: **clean**.

## Gate 4 — API smoke (`scripts/smoke.mjs`)

Boots the API on port 4181 and asserts 44 behaviours, including a genuine `429 RATE_LIMITED` with
`Retry-After` on class C, path traversal refusal, security headers, the static origin, the PDF brief
(`%PDF-1.4` header, non-trivial size), and 11 checks on the Prometheus `/metrics` scrape. The metrics
block is not a boot-only test: it runs *after* the smoke traffic, so the counters it reads must have
been moved by the requests the harness itself made — per-route totals, the class-C tally, and the
exact number of `RATE_LIMITED` responses observed in this run. It also proves `401` with no or wrong
token, `404` on a second instance started without `METRICS_TOKEN`, a well-formed exposition (every
sample family declared, no duplicate `# TYPE`, known types only), that the token value never appears
in the body, that 40 random paths add no new route label, and that the scrape itself is class A — a
check that failed on first run and exposed a real defect: unprefixed paths (`/health`, `/metrics`,
`/openapi.json`) were classified as class B because the leading slash survived into the class name, so
a page-traffic burst could have starved the monitor and the liveness probe. Current result:
**44/44 PASS**.

## Gate 5 — browser sweep (`scripts/e2e.mjs`)

Drives a real Chrome over the DevTools protocol against the built app: asserts on the DOM, waits for
genuine downloads in a temp folder, and dispatches **trusted** input (real mouse events for the draw
editor, real key events for the FR-32 block) so browser default actions — button activation,
`<summary>` toggling, anchor focus jumps — actually fire. Current result: **92/92 PASS** with zero
console errors.

| Group | Checks | What it proves |
| --- | --- | --- |
| Globe / Watch | 8 | SGP4 propagation runs on `requestAnimationFrame`, satellite selection updates the detail panel, speed selector reaches 600×, the time-offset slider seeks a real UTC day back |
| Alerts / dispatch | 4 | Alert center ranks the 7 pilot regions, preview text carries live + calibration content, clipboard write and `.txt` download both succeed |
| Atlas calendar | 12 | Every day of the record renders, 3 metrics × 2 modes, raw/harmonized split, month recompute, four-sensor day inspector, LIVE badge on the latest day, and the hover readout carries value + 90% interval + per-sensor mix + trust. The reading frame exposes five resolutions and span/focus/compare, re-reads the same record at each resolution, writes non-default frame settings into the share hash, restores them when the hash is pasted back, and drops them again at defaults |
| Exports | 3 | CSV (>20 kB), GeoJSON (>50 kB) and PNG all download for real |
| Draw area (FR-01/FR-05) | 3 | A dragged rectangle validates, reports km²/vertices/data-volume with its measured basis, and becomes the analysed AOI |
| Keyboard drawing (FR-01/FR-05/FR-32) | 12 | The canvas focuses and announces its contract; nothing is on the canvas before the first keystroke; Enter sets a corner, shifted arrows drag it into a valid area, Enter on the focused Analyze button resolves it to an AOI, the shape survives the region change it causes, and the data-volume estimate is measured on the drawn area so it does not move when Analyze is pressed. Polygon: Enter places vertices at the pen, Backspace undoes one, C closes the ring, and the keyboard-drawn polygon resolves to an AOI exactly like a pointer-drawn one |
| Table alternatives (FR-33) | 2 | Five tables on Atlas; every `svg.chart` on the page has a sibling `.table-alt` |
| Sandbox / Outlook | 4 | Overpass and resample controls change the output; analogs list and live NASA POWER weather render |
| Brief (FR-27) | 5 | Copy, `.txt` download, sensor + calibration text in the file, and a PDF that starts `%PDF-1.4`, ends `%%EOF`, and is >900 B |
| Method / provenance | 4 | Bundled TLE epoch stated honestly, no false runtime CelesTrak claim, all four sensors named, reconstruction boundary disclosed |
| Tour + share | 3 | Nine-step judge tour advances; the share link restores region and view |
| Keyboard (FR-32) | 8 | Calendar focus + announced contract, cursor clamped at today, arrows move between days, Enter opens the day under the cursor, Space activates a toggle, Enter expands a table alternative, skip link focuses `#main` **without** resetting the hash-routed view |
| Structural accessibility (all six views) | 9 | Every focusable control carries an accessible name, every form control is labelled, no positive `tabindex` anywhere, heading ranks never skip, every `img` names itself or is marked decorative, every `role="img"` graphic carries a name, exactly one `main` plus a `nav` per view, `<html lang>` is declared, and the views that update without being asked (Watch, Atlas, Outlook) expose a polite live region |
| Mobile ergonomics (390×844) | 7 | The document does not scroll sideways on Watch or Atlas; every visible top-nav target is ≥44 px tall and icon-only ones ≥44 px wide; the four simulation speed chips are ≥36 px; hero copy is not collapsed; the five calendar-frame resolutions stay inside their panel |
| Network / console audit | 5 | No 4xx/5xx, no failed loads, no console errors, no runtime CelesTrak traffic, NASA POWER returns 200 |

Five defects were found by writing these browser blocks — none of them visible to the earlier gates:

- *Interval is not shown in units it does not describe* fails if the 90% CI — which is an interval on
  the harmonized hotspot count — is displayed next to a fire-day or FRP value. The readout now shows
  the interval only in Hotspot-equivalents + Harmonized mode, and the day inspector labels it
  `90% CI (harmonized)` (ADR-13).
- The skip link reset the app. Letting the default anchor jump fire rewrote `location.hash` to `#main`,
  which `parseHash()` reads as an unknown view, silently discarding the selected region, metric and
  range. The click is now intercepted and focus is moved directly (checked by *"Skip link moves focus
  to main without resetting the hash-routed view"*).
- Free polygons could never be analysed. The close action only set a flag; the ring was left open, and
  `inspectGeometry` requires the first vertex to be repeated, so every drawn polygon came back
  `RING_NOT_CLOSED` with Analyze disabled. Closing now appends the closing vertex
  (*"C closes the polygon so it becomes analysable"*).
- The editor showed a phantom shape. When the canvas window became fixed for keyboard use, the
  circle/rectangle no longer had a corner to hang on, and the old code still drew a default-radius
  circle at its stored centre. A shape now requires an explicit anchor
  (*"No shape exists before the first keystroke"*).
- The estimate described the wrong area. The data-volume read-out took its detections/km²/day density
  from whichever region was selected *before* the draw, so pressing Analyze could change the number by
  two orders of magnitude without the shape moving. Density is now measured on the drawn area itself and
  `estimateDataVolume` is called on that same region
  (*"Data-volume estimate is measured on the drawn area and is unchanged by Analyze"*).

## Gate 6 — performance probe (`scripts/perf-probe.mjs`)

`npm run perf` starts the shipped same-origin topology (`server/api.mjs` serving `dist/` and `/api/v1`
on one loopback port), samples every declared route, then drives headless Chrome over three views by
CDP and writes `docs/perf-report.json`. It judges each number against the deployment PRD's §2 objective
table and §9.2 budgets, copied verbatim into `OBJECTIVES` at the top of the script, and exits 1 if any
breaches. Last run: 186 requests, 0 server errors, every §2 objective met, `verdict.breaches: []`.

What it records per view is deliberately narrow and self-disclosing:

- **API latency** — p50/p95/p99/max per route with its objective and sample count, uncached, with rate
  limits raised so the limiter does not answer 429 inside the samples it is measured around.
- **Web vitals** — LCP before the first input, CLS excluding shifts after input, TBT, and INP as the
  *processing component* (`processingEnd - processingStart`) with `durationThreshold: 0`, which is a
  lower bound on true INP and a maximum rather than the PRD's p75.
- **Attribution** — every dispatched click gets a row (`web_vitals[].interactions`) with the handler's
  own processing cost and `view_swap_ms`, the wall time from click to the committed view. The two are
  reported side by side because ADR-19 defers the mount out of the click task: a short handler and a
  long swap are one trade-off, not a win.
- **A control view** — the static Method page, which has no canvas, so the recurring ~250 ms frame tasks
  produced by software WebGL under `--disable-gpu` can be separated from application work instead of
  being averaged into a single TBT number.

## Rehearsal — backup and restore (`scripts/rehearse-restore.mjs`)

Not a gate — a drill that deliberately breaks bytes. `npm run rehearse` copies `public/data` to a fresh
temp directory, serves *that* directory with `DATA_BUNDLE_PATH`, and then: appends one byte to
`snapshot.json` (still valid JSON, so only a checksum can see it) → `/ready` 503 naming the file and
`npm run validate` exits 1 on the same bytes; deletes `land-110m.json` → `/ready` 503 with `missing`;
re-copies the files → `/ready` 200 in the same process, with the summary response byte-identical to the
one taken before the corruption. Last run: **12/12 steps**, `docs/rehearsal-report.json`.

`public/data` is opened read-only and its checksums are re-verified as the final step, so a failed drill
cannot leave the repo bundle damaged; the temp copy is deleted either way. What the drill does *not*
cover: restoring a host volume from a provider snapshot, or a re-deploy — see
`docs/production-readiness.md` §2 Reliability.

## What these gates do not prove

- The structural accessibility sweep proves *structure*, not *perception*: contrast ratios, focus
  order as a screen reader presents it, and announcement quality are not machine-checkable here and
  need an axe/pa11y run plus one manual read-along pass (`docs/production-readiness.md` §6).
- They do not prove historical accuracy of the 2000→today series. That record is a deterministic
  reconstruction calibrated to the live FIRMS window and is labelled as such in the UI, the brief,
  the CSV header, the GeoJSON metadata, and `GET /method-card`.
- They do not test any cloud deployment. No deployment, credential, or paid service was used; see
  `docs/production-readiness.md` for the explicit not-verified list.
- The performance probe measures a machine, not users. One client on loopback with the rate limits
  raised, no concurrency, no TLS or CDN, one navigation per view rather than a p75 over field data, INP
  reported as a processing-only maximum, and TBT inflated by software WebGL. 99 % monthly availability
  cannot be observed this way at all. The report's own `caveats[]` array is the authoritative list, and
  §14.3 load testing remains open until there is a target to aim at.
- The probe measures the §9.2 initial-JS budget per view instead of assuming one bundle. Since 2026-11-03
  all six routes are lazy and SGP4 propagation sits behind the globe, so the payload a view waits for is
  220.05 KiB (225.34 kB decimal) on Orbital Watch, 98.34 KiB (100.70 kB) on Atlas and 81.18 KiB
  (83.13 kB) on the static Method view — inside "250 kB" on either unit reading. `js_budget[]` carries
  both the initial payload and the whole-session download per view, so the 257.60 KiB session total of a
  sweep that visits every route is printed as a near-miss and not quoted as the budget figure.

## 2026-11-02 — the reconstruction's weather term is now real NASA data

**Verified** (command run, output recorded)
- `npm run climate` — seven keyless NASA POWER daily requests (MERRA-2 reanalysis), 2000-01-01 → 2026-11-01, ~0.95 MB each, 9,802 days per region, written to `public/data/climate_daily.json` (442,572 bytes). BW mean 0.000–0.007, s.d. 0.491–0.764, annual mean −0.75…+1.48 per region.
- Driver coverage: 9,496 of 9,496 record days (100.0 %) carry an observed anomaly in all seven pilot regions (`weatherCoverage()` in `src/lib/data.ts`).
- Physical sanity: California BW on 2020-09-01 is +0.744 and its 2020 annual mean +0.347 (the megafire season). Under the real driver the top Fire Twin for California is 2020 and for southeast Australia 2020; the simulated AR(1) term had picked 2013 and 2005.
- Gates after the swap: `npm run build` clean; `npm run validate` 21/21; `npm test` 49/49 (48 carried over plus a new invariant asserting the driver is attached and >95 % of days are observed); `npm run smoke` 44/44; `npm run secret-scan` clean; `npm run bundle` → `continuum-2026-10-31-e6471a074f1e`; `E2E_ORIGIN=http://localhost:8787 npm run e2e` 79/79.
- In-browser: the page resource log shows `/data/climate_daily.json` 200 (432 kB) alongside `/data/live_fires.json` 200 — the UI fetches the driver, it is not only a Node-side file.
- API/UI parity: `tests/api.test.mjs` "the API and the browser compute from one implementation" passes because `server/analytics.ts` attaches the driver for every Node consumer. Before that attach the same window computed 855.85 with the real driver against 830.65 with the fallback, and the test failed — it is what caught the divergence.

**Partial**
- The BW weights (0.35 / −0.25 / +0.20 / −0.20) state the contribution of four observed quantities; they are not fitted to fire counts, because nothing in this bundle is independent enough to fit against.
- BW is the pilot-region centre from POWER, not an area-weighted mean of the box.
- MERRA-2 publishes with a ~2-month lag, so the last weeks persist the final valid anomaly forward — the same labelled-persistence convention already used for provisional days.
- The analog goldens in `tests/analog-index.test.mjs` were recaptured at this bundle. With `attachClimate(null)` the 2026-11-01 fixture still reproduces to six decimals, which proves the shift came from the driver and not from the prefix-sum index; a recaptured golden no longer pins a future change on its own.

**Not verified**
- BW skill against actual fire weather: the shipped live window is eight days, too short to correlate. Needs the FIRMS archive or a CONAE validation set.

**Blocked** (needs a credential or a host the pack names; nothing was stored or printed)
- FIRMS archive request and `/api/area/csv`: require a `FIRMS_MAP_KEY`. This remains the only route to real 2000→2026 detection *counts*.
- MCD64A1 burned area and the MOD14 / MYD14 / VNP14IMG / VJ114IMG swath fire masks: require an Earthdata Login.
- CONAE catalog hotspots and monthly burned area: require `registro.conae.gov.ar` registration.
- GFWED: `data.giss.nasa.gov` did not resolve from this network (`curl` exit 6, HTTP 000), so pack §11 step 7 is unproven here.

**Resource pack §11 step 6 (GOES-R fire) — resolved by direct anonymous S3 listing**
- `noaa-goes16` serves `ABI-L2-FDCC` for 2017–2025 at ~467 kB per 10-minute granule (~11 MB a day) — cheap, but the CONUS domain does not cover the Argentina pilot box.
- `ABI-L2-FDCD` is absent from both `noaa-goes16` and `noaa-goes19`; the full-disk equivalent `ABI-L2-MCMIPF` is 276,916,657 bytes per granule, ~40 GB per day. The pack's instruction to check FDC file sizes before choosing a sampling plan was the decisive one: an anonymous geostationary backfill for a Southern-Hemisphere box is not viable, and Pilot B's geostationary route stays open.

## 2026-11-02 — every typed constant in the reconstruction and the bias estimator is gone

What changed, and what caught it:

1. **The bridge ratio is measured, not typed.** `calibrationFor()` derives the daily level, `k_area`, the
   per-spacecraft split and the per-sensor FRP distributions from the live FIRMS window; `biasXray()`
   re-estimates the ratio from the selected record itself. The fallback chain is labelled: `kSource` is
   `area` when the area has enough shared days, otherwise `pilot-regions` (pooled); `levelSource` is
   `area` or `pilot-density`.
   *Defect found by the new test:* conditioning ΣV/ΣM on days where both sensors were non-zero gave
   k = 3.99 in-record against a measured 10.71 — a classic selection-on-the-dependent-variable bias.
   Summing over every VIIRS-era day, zeros included, fixed it; `tests/science.test.mjs` now pins the
   per-day identity `H = V + NOAA-20 + NOAA-21` (or `M·k` on MODIS-only days).
2. **`H` is the VIIRS platform total.** All three operational spacecraft, because FIRMS reports
   per-satellite detections and the live window measures the total directly. MODIS is rescaled onto that
   unit and never added on top of a VIIRS day.
3. **The daily weather term is decomposed.** `burnWeatherAnomaly()` subtracts the month climatology and
   the year deviation from the raw BW index before the `exp(0.38·z)` term, so the seasonal cycle is spent
   by SEASON and the interannual regime by `exp(0.26·z_year)` — once each.
   *Defect found by the new test:* the raw annual BW mean entered both terms, so the record spent the
   regime signal twice (effective sensitivity ≈2.2 per BW unit). California's corrected 2012 break fell
   from 225% to 116% once the double-count was removed, and 2011 vs 2013 annual totals went from a
   173k/78k ratio driven partly by double-spent weather to the regime term's own exp(0.26·3.0) ≈ 2.2.
4. **Nothing is typed as fire history any more.** `base`, `trend`, `peakMonths`, `seasonLabel` and
   `events` no longer exist on a region; the season is derived from observed MERRA-2 monthly means and
   the notable seasons are ranked by computed activity. `tests/science.test.mjs` asserts all seven
   regions carry none of those fields.
5. **A custom AOI gets a real driver.** `climateSourceFor()` resolves weather/season/regime to the
   nearest observed POWER point (distance reported, badge in the UI) instead of the AR(1) simulator, and
   its level comes from the pilot-density measurement with `levelSource = pilot-density`.

**Verified** (commands run against this build, 2026-11-02)
- `npm run api:build` → `dist-server/analytics.mjs` rebuilt; `npx tsc -b` clean.
- `npm test` → **53/53** pass, including the new invariant "the daily weather term spends only what
  SEASON and the regime term have not" (2001–2025 sample: |mean daily term| < 0.02 overall, per-month
  < 0.05, and the strongest raw-anomaly year keeps < 0.05 in the daily term while its raw mean exceeds
  0.15).
- `npm run validate` → **21/21**, 66,472 record rows, one row per day, provisional tail flagged.
- `npm run bundle` → `continuum-2026-10-31-c573ab38dc69`, 12 files.
- `npm run build` → clean, 330.04 kB app + 486.97 kB three, no type errors.
- `npm run secret-scan` → clean, 109 source files (9.6 MB) and 5 bundle assets checked.
- `npm run smoke` against a restarted :8787 → **44/44**; `/api/v1/health` reports the current bundle.
- `E2E_ORIGIN=http://localhost:8787 npm run e2e` → **79/79**, no failed checks.
- Per-area measurement at bundle continuum-2026-10-31-c573ab38dc69 (bridge ratio with its 90% CI, raw →
  corrected 2012 break, analog backtest, weather coverage — superseded later the same day by the live
  re-pull recorded in the next section):

  | area | k in record | 90% CI | shared days | raw break | corrected | break removed | analog hit rate | weather coverage |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | chilecito | 10.63 | 10.18–11.08 | 1,262 | 1348.8% | 37.8% | 97.2% | 70% | 1.0000 |
  | pantanal | 10.85 | 10.58–11.12 | 2,475 | 725.0% | −21.8% | 97.0% | 65% | 1.0000 |
  | california | 16.57 | 16.50–16.65 | 5,377 | 3494.5% | 116.0% | 96.7% | 35% | 1.0000 |
  | greece | 10.73 | 10.66–10.81 | 5,290 | 1419.3% | 41.9% | 97.0% | 65% | 1.0000 |
  | amazon | 10.31 | 10.30–10.32 | 5,399 | 699.1% | −22.5% | 96.8% | 45% | 1.0000 |
  | nepal | 10.73 | 10.66–10.80 | 5,386 | 906.2% | −6.0% | 99.3% | 55% | 1.0000 |
  | southeast-australia | 24.52 | 24.25–24.79 | 4,748 | 3695.9% | 55.0% | 98.5% | 55% | 1.0000 |

  `break removed` is the product's own definition — `(|raw| − |corrected|) / |raw|`, i.e. the reduction in
  the size of the step, not its signed change. A negative `corrected` means the harmonized series
  slightly over-corrects the transition and lands on the other side of the baseline.

- `tests/analog-index.test.mjs` goldens recaptured at this bundle for all seven areas (9/9 pass), so the
  prefix-sum index is still exact against the row-by-row sums after the model change.
- Simulated paths in the reconstruction are unreachable with the shipped bundle. `buildRecord()` still
  carries three fallbacks — flat monthly weights instead of SEASON (`monthlyWeights`), a drawn year
  regime when `annualZ` is missing, and an AR(1) daily term when no observed anomaly exists — and each is
  now provably not taken: `weatherCoverage()` = 1.0000 for all seven areas (9,496 of 9,496 days), and
  `climate_daily.json` carries an `annual` value for every year 2000–2026 for all seven, so no year
  falls to the drawn regime. The remaining draw inside the record is the FRP per-detection lognormal,
  whose mean and log-spread are measured from the live detections (`calibrationFor`), and the sandbox,
  which is labelled synthetic by design. Reproduce with `node scripts/capture-analogs.mjs` (per-area
  measurements and goldens) and `node scripts/probe-analog-spread.mjs` (similarity spread).

**Partial**
- A corrected break that is not zero is correct behaviour, not a bug: the residual is the part of the
  measured step that the harmonization does not explain. Four of seven areas now show a small negative
  corrected break (the harmonized series slightly over-corrects the step); the Method page states the
  numbers dynamically instead of promising a clean removal.
- Analog backtest hit rates moved in both directions when the daily term was decomposed (california
  60 → 35, nepal 80 → 55, chilecito 60 → 70). With 20 trials each, no individual rate is significantly
  different from a coin flip. The Fire Twin card is therefore presented as a comparison of seasons, and
  `Method`/`Known limits` keep the "conditional, not a forecast" wording.

**Not verified**
- Analog skill against real-world outcomes: the backtest scores the rule against Continuum's own
  reconstruction, so it measures internal consistency, not forecast skill. Scoring it against an
  independent archive needs the same credentials listed below.
- Sandbox recovery generality: 26.8% weekly MAE with −63.1% raw bias → +0.2% residual is one seed (42)
  on the default area at the default dials.

**Blocked** — unchanged from the entry above: FIRMS historical counts need `FIRMS_MAP_KEY`; MCD64A1 and
the swath fire masks need Earthdata Login; CONAE `catalogofocos` needs registration. No credential was
read, stored or printed in this session, and none is in the repository, the bundle, the logs or the
manifest.

## 2026-11-02 (later) — the live window was re-pulled from NASA and the product re-verified on it

`FIRMS_REFRESH=1 npm run data` pulled all four keyless 7-day global CSVs from
`firms.modaps.eosdis.nasa.gov` at 09:46–09:50 UTC (MODIS 4.9 MB, S-NPP 28.0 MB, NOAA-20 29.3 MB,
NOAA-21 29.0 MB). Exit code 0.

**Verified**
- Window moved 2026-10-24→10-31 to **2026-10-26 → 2026-11-02**. Per-sensor quality detections
  MODIS 60,474 · S-NPP 298,427 · NOAA-20 306,547 · NOAA-21 297,590 = 963,038, of which **71,808 kept**
  (50,070 inside the seven pilot areas, 21,738 in the global sample). All four sensors now report
  through the window end, so nothing lags and `provisional_from` is 2026-11-03.
- `npm run bundle` → `continuum-2026-11-02-84eefe748d50`; `npm run validate` **21/21** (66,486 record
  rows across the seven areas, one row per day); `npm test` **53/53**; `npm run build` clean;
  `npm run secret-scan` clean (109 source files, 8.7 MB); API restarted on :8787 and `/api/v1/health`
  reports `data_through 2026-11-02`; `npm run smoke` **44/44**;
  `E2E_ORIGIN=http://localhost:8787 npm run e2e` **79/79**.
- The measured calibration moved with the window, exactly as it should: default-area bridge ratio
  10.63 → **10.32×** (90% CI 9.91–10.73, 1,374 shared days), phantom break 1348.8→37.8% becomes
  **1345.7 → 42.6%** (96.8% of the step removed), sandbox recovery 26.8 → **21.8%** weekly MAE with
  raw bias −62.3% → **+2.2%** residual. Per area: california 14.70× (3119.1 → 119.3%),
  southeast-australia 19.53× (3090.6 → 62.6%), amazon 9.94×, nepal 10.31×, greece 10.36×,
  pantanal 10.33×. `kSource` is `area` for california/amazon/southeast-australia and `pilot-regions`
  (pooled) for the other four; weather coverage stays 1.0000 everywhere.
- Analog goldens recaptured for the new window (`scripts/capture-analogs.mjs`), 9/9 pass. Hit rates
  re-scattered (amazon 45 → 20, california 35 → 80, nepal 55 → 85), which is the honest behaviour of a
  20-trial test on a moving anchor week and is stated as such in the test header and on the Method page.
- A test assumption was replaced, not softened: `provisional flags cover the live window…` had asserted
  that the shipped snapshot contains a lagging sensor, which stopped being true the moment NASA caught
  up. It now asserts the product rule (every day inside the rolling window is provisional, nothing
  before it is) **and** proves the lag branch on a synthetic snapshot with NOAA-21 truncated two days
  early — 0 detections for that spacecraft after its last report, both days labelled. The branch is
  covered whether or not the real archive is late today.

**Partial**
- The refresh is a deliberate operator step, not a scheduler. The app ships a frozen snapshot plus live
  NASA POWER calls by design; making the FIRMS pull automatic needs a host, a schedule and a credential
  story that this environment does not have.

**Blocked**
- Independent validation of the reconstruction's daily counts still needs the historical FIRMS archive
  (`FIRMS_MAP_KEY`) or MCD64A1 (Earthdata Login). The re-pull proves the live path is real and current;
  it does not make the 2000→2026 daily counts an archive product, and the UI never calls them one.

## 2026-11-02 (later still) — the chance-level wording was added to the UI and the chain re-run

Three UI-copy edits went in after the re-pull, all of them telling the user what the analog backtest
number means: the Stat sub-line on the Method page now reads `20 leave-one-out seasons, coin flip =
50%`, the Method validation row now says a coin flip scores 50% and that at n=20 no single area's rate
is separable from chance, and the Outlook panel note now ends "against 50% for a coin flip". The whole
chain was re-run against the edited bundle, not just the tests that read the source:

**Verified**
- `npm run build` clean (tsc -b + vite, `dist/assets/index-BAg6Fecs.js`, 64 modules).
- `npm test` → **53/53**, 0 fail. `npm run validate` → **21/21** against
  `continuum-2026-11-02-84eefe748d50`. `npm run secret-scan` → clean, 109 source files, 5 bundle assets.
- `npm run smoke` → **44/44** against the running API; `GET /api/v1/health` returns the current
  bundle with `data_through 2026-11-02`, `provisional_from 2026-11-03`.
- The API serves the rebuilt `dist` straight off disk: the live index at `:8787` references the same
  asset hash as the build just produced, so no restart was needed and no stale bundle was tested.
- `E2E_ORIGIN=http://localhost:8787 npm run e2e` → **79/79**, no failed checks.
- The new copy is in the shipped artefact, not only in source: `coin flip` appears twice in
  `dist/assets/index-BAg6Fecs.js`.
- Rendered without clipping. The sweep asserts text presence but not layout, so both pages were opened
  in the browser and every element carrying the new sentences measured `scrollHeight == clientHeight`
  with `webkitLineClamp: none`. The Outlook note reads in full: "…Hit rate 60% over 20 seasons, against
  50% for a coin flip. Analogues are evidence, not prophecy."
- Provenance audit of the shipped record, all seven areas: 9,498 rows each, of which 9,490 are
  `source: model` (the labelled reconstruction behind the live window) and 8 are `source: live`
  (observed FIRMS detections, and the only days carrying the LIVE label). No model row is provisional
  and no live row is unlabelled — the split the AGENTS.md non-negotiable requires.

**Not verified**
- A keyless historical fire-count source, searched for again so the archive route would not be assumed
  closed. `data.giss.nasa.gov` still fails from this network (curl exit 35 / exit 6, HTTP 000), so GFWED
  stays unproven here. `gibs.earthdata.nasa.gov` is reachable but publishes no fire layer in either
  current WMTSCapabilities document (`epsg4326` 5.32 MB, `epsg3857` 5.85 MB — zero Titles or Identifiers
  matching "fire"), and direct requests to three plausible legacy layer names all return HTTP 400
  `InvalidParameter`. `firms.modaps.eosdis.nasa.gov` and `power.larc.nasa.gov` both answer 200. The
  conclusion is unchanged: the keyed FIRMS archive request is the only official NASA route to real
  2000→2026 daily detection counts.

## 2026-11-02 (keyed archive online) — real observations entered the record, then a writer race forced a rebuild

The `FIRMS_MAP_KEY` arrived, so the historical archive stopped being a blocked gate and became a data
pipeline. `scripts/backfill-archive.mjs` pulls the keyed Area API in 5-day windows for every
sensor × area lane and writes `public/data/archive_daily.json` (schema `continuum-archive-1`);
`buildRecord` overlays those days on top of the reconstruction, and the overlay keeps the
reconstruction's own values in `DailyRecord.modelled` so a diagnostic can read one provenance end to
end instead of comparing an observed year against a modelled one.

**Verified**
- The keyed request path itself: real MODIS/VIIRS detection rows reach the aggregate — the first clean
  pass logged `120 requests / 11,869 rows` across four lanes with `failed: []`.
- Throttle answers are survivable and non-destructive. FIRMS returns HTTP 400
  `Exceeding allowed transaction limit` and, when the key is over-queried, `Invalid MAP_KEY`. Both now
  cool every lane and retry the *same* window with the cursor unchanged
  (`[auth] FIRMS closed the key … retrying the same window (3/8, cursor unchanged)`); nine rejections
  in the new run cost no coverage. Before this, a 400 was recorded as a permanently failed window,
  which froze six rate-limit answers into the coverage ranges as fake "no observation" holes.
- Single-provenance diagnostics are exact. `biasXray` reports `breakBasis` and measures the
  reconstruction→observation seam on the *same* days: `breakBasis 'reconstruction'`, raw 2012 break
  **+1345.7%**, trend-corrected **+42.6%**, seam **+23.8%** over 2,825 days from 2012-01-20, area k
  **10.305** vs in-record ratio **10.33**, overlap 1,373 days. All 22 science assertions green at that
  state, including the new one that refuses a `reconstruction` fallback while the archive actually
  reaches 2011 (`observedIn(2011) < 180`).
- Determinism, proven the hard way. Resetting `archive_daily.json` to zero coverage and rebuilding made
  the seven pre-archive `twinAnalogs` fixtures pass again to the last decimal at
  `continuum-2026-11-02-107911de714d`. The archive overlay, not the code, is what moved them.
- Chain at `continuum-2026-11-02-107911de714d` (reconstruction-only bundle):
  `npm run build` clean; `npm test` **55/59**; `npm run validate` **21/22**; `npm run smoke` **44/44**;
  `npm run secret-scan` clean (115 files, 5 bundle assets); `E2E_ORIGIN=http://localhost:8787 npm run e2e`
  **79/79**.

**Blocked — the 5 reds are all the same gate, and it is data, not code**
- `the archive is attached…`, `archive detections reach the record unchanged`,
  `a sensor the archive has not pulled yet is unknown…`, `provenance is counted from the rows…` and
  validate's `archive observations reach the record unchanged — 0 of 0 archive days` fail because the
  published archive is deliberately empty right now. They go green when a rebuilt archive is promoted.
  They are not softened, skipped, or conditioned on coverage.

**The race, and what it cost**
- Two `backfill-archive.mjs` processes ran against the same output at once (one launch I believed I had
  stopped was still alive). `aggregate()` increments day cells that `rehydrate()` has already loaded
  from the file, so the pair both double-counted each other's windows and lost each other's newer rows;
  whichever process flushed last decided the file, while the cursor kept the other's `done` counts.
- Measured on the quarantined file: day cells sum **798,822** detections against a cursor declaring
  **1,106,566** rows — a 307,744-row deficit — and `southeast-australia` had lost every observation.
  A lost window is invisible per day, because `covered[]` derives from the cursor, so the record would
  have rendered unknown days as observed zeros. That is exactly the failure AGENTS.md forbids.
- Recovery: the raced archive and its cursor are unrepairable and were moved to
  `C:\Users\Ricky\continuum-data-backup\race-2026-11-02\` (kept, not deleted); the published archive was
  reset to zero coverage; one clean backfill was relaunched from scratch.
- Two fixes so the class of failure cannot return: `--out=` stages observations outside the published
  bundle (a mid-flight rewrite also drifts the manifest hash under any verification run), and a PID lock
  next to the output refuses a second writer — `backfill: PID 27912 already writes
  data_raw\firms_archive\archive_staging.json — refusing to race it.` A stale lock from a dead PID is
  taken over, so a crash cannot wedge the pipeline.

## 2026-11-02 (archive attached) — the shipped bundle carries real FIRMS detections, and the chain order was the next bug

`npm run archive -- --out=data_raw/firms_archive/archive_staging.json` pulled enough of the keyed
archive to promote a real record. At bundle **`continuum-2026-11-02-84cea7615e37`** the published
`public/data/archive_daily.json` contributes **281,799** detections across **1,020** keyed Area-API
requests, which is **5,100** pilot-area record days with `source: 'archive'` — for Chilecito,
VIIRS-SNPP SP real observations replace the reconstruction from 2012-01-20 to 2016-11-08.

**Verified**
- The five previously blocked gates went green on data, not on edits: `npm run validate` now reports
  *archive observations reach the record unchanged — 3662 of 3662 archive days carried into the record
  as observed*. **23/23** (22 checks plus the new dist-drift gate below).
- Full frozen chain at that bundle: `npm run build` clean, `npm test` **59/59**, `npm run validate`
  **23/23**, `npm run smoke` **44/44**, `npm run secret-scan` clean,
  `E2E_ORIGIN=http://localhost:8787 npm run e2e` **79/79**. `/data/archive_daily.json` serves 200
  (56,462 B) beside `live_fires.json` and the snapshot.
- `npm run live` survived a real transport failure. `J2` died mid-stream with
  `Error: read ECONNRESET` and took the other three files down with it (exit 1). `getWithRetry()` now
  retries 3× with 5/10 s backoff, surfaces response-body errors, and caps the read at 300 s; a
  still-failing lane logs `FAIL … — network: <msg>; previous file kept` instead of an uncaught
  rejection. Re-run: **4/4**.
- Three `twinAnalogs` goldens failed and were **recaptured, not loosened** — the archive overlay
  legitimately replaced modelled days under three areas. `scripts/capture-analogs.mjs --write` rewrote
  the fixture at the new bundle (Chilecito hitRate 60→65%, California's top analogs now 2021/2008/2020)
  and the test header records why, so the next reader sees the provenance rather than a mystery diff.
- `dist/` can no longer silently serve a stale record. `vite build` copies `public/data` → `dist/data`,
  and a `bundle` run *after* `build` shipped `…-107911de714d` while disk said `…-84cea7615e37`. The API
  was answering with the previous record. Validate now byte-compares every `dist/data/*.json` against
  `public/data/` and fails with *run npm run build after npm run bundle*. Chain order recorded in
  AGENTS.md: `live → data → api:build → bundle → build → test → validate → smoke → secret-scan → e2e`.
- No static provenance claim survives in the API. `/method-card` limits[0] and the `/brief` notice are
  derived from `archiveStatus()` and `provenanceMix()` at request time; both were hard-coded sentences
  about "a labelled reconstruction" that the attached archive made false. Live answer:
  *labelled blend: 5,100 pilot-area days carry real FIRMS archive detections (281,799 detections over
  1,020 keyed Area-API requests)*, and the Chilecito brief says *1755 of 9498 record days (2012-01-20
  to 2016-11-08) are real FIRMS archive detections*. If the archive is removed, the same code falls
  back to the reconstruction sentence — verified by reading the branch, and the fall-through is what
  the zero-coverage state printed earlier the same day.
- Method-page figures re-measured at this bundle and written into README: Chilecito bridge
  **10.33×** (90% CI 9.91–10.74, 1,373 shared days), phantom-break **1345.7% → 42.6%** (96.8%
  reduction), analog backtest **65%**, sandbox recovery 21.8% weekly MAE, raw bias
  **−62.3% → +2.2%**; California **14.72×** (CI 14.66–14.78, 5,383 days), 3124% → 119.3%, 80%.

**Partial — the backfill is still running**
- One staged writer continues at `--rate=60` (55 lanes, 4 concurrent, 3,280 windows / 579,370 rows at
  the time of writing). **46** `Invalid MAP_KEY` answers so far, every one survived by a cool-down that
  retries the *same* window with the cursor unchanged — no coverage lost, and `archive:promote` refuses
  a file whose cell sum disagrees with its cursor.
- Rate measured, not assumed: 45/min clean; **120/min trips the key** (auth streak 7/8 with 180–210 s
  cool-downs); 60/min is the operating point.
- The MODIS lane has to reach the 2012 overlap days (Chilecito `MODIS_SP` was at 400/1887 windows)
  before `breakBasis` can be re-measured from the archive instead of the reconstruction. Until then the
  Method page says PENDING / not-archive-measured, which is correct, and is left saying it.

**Not verified**
- Burned area: `BA_MODIS` / `BA_VIIRS` are reachable with the key but unimplemented; the Method page
  still shows PENDING for that row.

## 2026-11-02 (MODIS lane reaches 2022) — the 2012 break is now measured on observations, and the printed bridge was wrong

The staged writer reached Chilecito's MODIS lane past the VIIRS start. Promoted at
**`continuum-2026-11-02-c26b349d3f33`**: `archive:promote` reports **17,464** sensor-days carrying a
detection / **1,671,595** detections over **6,400** keyed requests — Chilecito 5,304 such days on 4 lanes
(MODIS SP 2000-11-01→2022-07-13 beside VIIRS-SNPP 2012-01-20→2026-07-31), Pantanal 9,015 days on 4 lanes,
California 1,422 and Greece 1,723 on the VIIRS lane alone. On the record those are **20,504** pilot-area
days with `source: 'archive'` (a record day counts once however many lanes report it; promote's tally
counts each lane separately). Two intermediate promotions
(`…-4ebb7b7f7935`, `…-7a18b6059c30`) were superseded within the hour by this one.

A second provenance overclaim was found while checking the API against the record: `/method-card`
summed `archiveCoverage(id).days` across areas and called the result *"N pilot-area days carry real
FIRMS archive detections"*. That field is the span from the first to the last covered day, so Pantanal's
2010→2026 hole counted as observed and the sentence read **22,003**. The route and the Method page now
count record days through `provenanceMix()` and print **20,504** beside the modelled remainder, and the
page names each lane's covered-day count instead of one span figure.

**Verified**
- `bridgeFor('chilecito')` now returns `{source: 'firms-archive', k: 12.9679…, days: 3928}` instead of
  `calibrationFor`'s pilot-region prior, and `biasXray().breakBasis` flipped from `reconstruction` to
  `observations`: raw 2012 break **136.5% → corrected −45.6%** (66.6% reduction) measured on archive
  days, seam +83.7% from 2000-11-01 over 9,404 days.
- Two defects in the printed bridge ratio were found by comparing it with the bridge the record
  applies, and both were fixed in `biasXray()` rather than by widening the test tolerance:
  1. An unpublished lane was summed as a silent zero. Chilecito's MODIS lane stops in 2022 while its
     VIIRS lane reaches 2026, so the whole post-2022 era counted as "no MODIS fires" and the printed
     k read **79.7×** beside the **10.8×** applied. The sum is now restricted to days both lanes
     published (`bothPublished`), the same rule `sensorCount()` uses before printing an em dash.
  2. VIIRS totals were raw lane sums while the record applies completion-weighted `harmonized`, which
     put **3.74×** on the page. Where the archive really observed VIIRS, the sum now uses the record's
     own scaled value. Final: **13.13×** (90% CI 12.64–13.63) over 3,936 published era days against
     **12.97×** applied — agreement asserted in `tests/science.test.mjs`, not assumed.
- "Published" is not "observed", and the Method sentence now says which. `biasXray()` returns
  `observedEraDays` (3,928 for Chilecito) and the resolution term prints *"9,404 … 3,928 of those days
  observed side by side in the keyed FIRMS archive"*. For Amazon, Nepal and Southeast Australia —
  0% archive coverage — it prints *"the archive has not published a MODIS lane that reaches into the
  VIIRS era here, so this is the weighting the reconstruction applies, not a measured bridge"*. The
  number was previously presented as a measurement in both cases.
- Test premises corrected to what the data now is, never the tolerances: `eraDays`/`overlapDays` replace
  the joint-non-zero count (118 jointly-non-zero days, 3,936 published); the live-window calibration is
  compared to the record only while it is the applied bridge (`applied.source !== 'firms-archive'`);
  the spacecraft test pools modelled NOAA days across all seven areas instead of the default area
  alone; MODIS-only rescale days are asserted against `bridgeFor().k`. `npm test` **59/59**.
- Three `twinAnalogs` goldens moved because real days replaced modelled ones (Chilecito top analog 2019
  similarity 67.27, Pantanal's top analog moved 2023 → 2025 as its VIIRS lane gained 2021-2023) and were
  **recaptured** with `node scripts/capture-analogs.mjs --write`; the test header records the bundle,
  the request/row counts and why each number moved.
- Full frozen chain at `…-c26b349d3f33`: `npm run data` clean, `npm run api:build`, `npm run bundle`,
  `npm run build` clean, `npm test` **59/59**, `npm run validate` **23/23**, `npm run smoke` **44/44**,
  `npm run secret-scan` clean, `E2E_ORIGIN=http://localhost:8787 npm run e2e` **79/79**. `/api/v1/health`
  serves `bundle_version continuum-2026-11-02-c26b349d3f33`; the previously running API was still on
  `…-4ebb7b7f7935` and was restarted.
- Re-ran the frozen chain after the `/method-card` and `Method.tsx` provenance fixes on the same bundle:
  `npm test` **59/59**, `npm run validate` **23/23**, `npm run smoke` **44/44**,
  `E2E_ORIGIN=http://localhost:8787 npm run e2e` **79/79**. The first sweep of that session returned
  **77/79** — "Outlook uses live NASA POWER weather" read `offline estimate` and one fetch showed
  `net::ERR_ABORTED` — while the archive writer was saturating the link; POWER answered a direct request
  in 2.6 s and the immediate rerun was clean. That check depends on an upstream NASA service and can
  flake under network load; it is recorded here rather than loosened.
- `npm run validate` reconciliation at this bundle: *10107 of 11156 archive days carried into the record
  as observed; 1049 days hold NOAA-20/21 detections but no reference lane (SNPP or MODIS) and stay
  modelled — first: pantanal 2023-03-01*. Those 1,049 days are named, not hidden.

**Partial**
- Chilecito is **99.1%** observed (9,404 archive + 8 live of 9,498; 86 modelled). Pantanal **83.3%**,
  California **15.1%**, Greece **18.7%**, Amazon / Nepal / Southeast Australia **0%**.
- Pantanal has MODIS to 2010-04-02 and VIIRS from 2012-01-20 — no shared day, so it still borrows the
  pilot-region prior (k 10.31) and its Method line is labelled as by-construction.
- The writer is still running at `--rate=60` (Chilecito MODIS 1,800/1,887, Pantanal MODIS 1,000/1,887,
  California VIIRS 400/1,062 at the time of writing). `Invalid MAP_KEY` cool-downs continue; each retries
  the *same* window with the cursor unchanged. Re-promote and re-run the chain when it adds coverage.

**Not verified**
- Burned area (`BA_MODIS` / `BA_VIIRS`) is still PENDING on the Method page.
- Either NOAA lane alone never clears the "observed" bar; the archive overlay needs a reference lane.

## 2026-11-02 (MODIS lane reaches 2026) — Pantanal gets its own measured bridge

**Verified**
- `npm run archive:promote` on the staged snapshot: **24,024** sensor-days carrying a detection /
  **2,503,739** detections over **8,200** keyed Area-API requests. Per area: Chilecito 5,569 days /
  29,046 detections on 4 lanes; Pantanal 12,474 / 1,850,043 on 4; California 4,258 / 538,074 on 3;
  Greece 1,723 / 86,576 on the VIIRS lane alone.
- On the record: **24,059** pilot-area days carry archive observations (`provenanceMix` summed across
  the seven areas, printed by `/method-card` beside 2,503,739 detections/8,200 requests).
  Chilecito **99.4%** observed (9,435 archive + 8 live of 9,498, 55 modelled); Pantanal **99.1%**
  (9,404 + 8, 86 modelled); California **36.4%** (3,450); Greece **18.7%** (1,770); Amazon, Nepal and
  Southeast Australia hold the 8-day live window only.
- `bridgeFor('chilecito') = {source:'firms-archive', k:12.7537, days:5307}`; its MODIS SP lane now
  reaches 2026-08-31 beside VIIRS-SNPP 2012-01-20→2026-07-31. `biasXray`: ratio **12.87** (90% CI
  12.47–13.27), eraDays **5,315**, observedEraDays **5,315**, joint-non-zero **778**, raw **136.0%** →
  corrected **−44.8%**, reduction **67.06%**, `breakBasis: 'observations'`.
- `bridgeFor('pantanal') = {source:'firms-archive', k:10.6120, days:2053}` — the first bundle where
  Pantanal is **not** borrowing the pilot-region prior, because its MODIS lane was carried past
  2010-04-02 into the VIIRS era. `biasXray`: ratio **10.61**, era **2,061**, observedEra **2,061**,
  joint-non-zero **1,385**, raw **186.0%** → corrected **−20.8%**, reduction **88.84%**,
  `breakBasis: 'observations'`.
- Sandbox on the default area: recovery **10.08%** weekly MAE, raw sensor bias **−62.93%** →
  **+0.43%** after correction; `weatherCoverage()` 1.0000 on all seven areas.
- `npm run validate` **23/23**, including *16008 of 16,988 archive days carried into the record as
  observed; 980 days hold NOAA-20/21 detections but no reference lane (SNPP or MODIS) and stay
  modelled — first: california 2023-03-01 n=0 n21=16*.
- Full chain at `continuum-2026-11-02-ee72e729cceb`: `npm run data`, `npm run api:build`,
  `npm run bundle`, `npm run build`, `npm test` **59/59**, `npm run validate` **23/23**,
  `npm run smoke` **44/44**, `npm run secret-scan` clean (126 source files, 15.9 MB, 5 bundle
  assets), API restarted and `/api/v1/health` serves the new bundle id,
  `E2E_ORIGIN=http://localhost:8787 npm run e2e` **79/79**.
- Four analog goldens moved because real days replaced modelled ones and were **recaptured** with
  `node scripts/capture-analogs.mjs --write`: Chilecito top similarity 67.2733 → **67.3023**;
  Pantanal hit rate 65 → **60** and top analog 2025 → **2016**; California hit rate 85 → **75**; the
  cached-index identity check follows the same value. The test header records the bundle, counts and
  reason. No tolerance was changed.

**Partial**
- California **36.4%** has no shared MODIS/VIIRS day yet (MODIS 1,055 days sit before VIIRS starts),
  so its bridge remains the live-window `area` calibration (k 14.7) and its break is still marked
  `reconstruction`.
- Greece **18.7%** has the VIIRS lane only; Amazon, Nepal and Southeast Australia have **no archive
  day** yet.
- The writer is still running at `--rate=60` (8,200 requests at promotion; Pantanal/California lanes
  still filling). `Invalid MAP_KEY` and 400 `Exceeding allowed transaction limit` cool-downs continue;
  each retries the same window with the cursor unchanged. Re-promote when coverage moves materially.
- The queue was reordered mid-run: it used to be region-major within every sensor, which handed
  windows to Chilecito/Pantanal/California for hours before Amazon, Nepal or Southeast Australia saw
  one (`--lanes=4`). It now sorts each sensor group by completion fraction, so the emptiest lane is
  next; restarted at 8,412 requests and Amazon/Nepal/Southeast Australia VIIRS and Greece MODIS lanes
  began advancing within two minutes (21/20/22/57 windows). Lane cursors and the lock survived the
  stop via the `STOP` checkpoint file — no window was fetched twice and no cursor moved.
- Burned-area gate probed: requesting `BA_MODIS` and `BA_VIIRS` from the keyed Area API returns HTTP
  200 but the *detection* schema with zero rows, and NASA's own API page lists only nine detection
  sources (LANDSAT_NRT, MODIS_NRT/SP, VIIRS-SNPP/NOAA-20/NOAA-21 NRT+SP). The burned-area products
  (MCD64A1, VNP64A1) are LP DAAC assets behind Earthdata Login, so this gate is **blocked** on a
  token-bearing backfill, not on repo code. The Method card now states that instead of "future work".

**Not verified**
- Burned area (`BA_MODIS` / `BA_VIIRS`) is still PENDING on the Method page.
- Either NOAA lane alone never clears the "observed" bar; the archive overlay needs a reference lane.

## 2026-11-02 (NRT tail and the transaction budget) — every area reaches the present, and the key taught us its meter

**Verified**
- The near-real-time tail ran first. Standard processing ends 2026-07-31 (VIIRS) and 2026-08-31
  (MODIS), and the rolling 7-day CSVs cover only the last week, so ~87 days at the recent end of every
  area stayed modelled. The queue groups were reordered NRT-before-SP (`scripts/backfill-archive.mjs`);
  490 NRT windows answered with **zero failures**, adding **757,166** detections, and every area's last
  90 days became observations.
- `npm run archive:promote` on the staged snapshot: **30,529** observed sensor-days (**21,863** distinct
  area-days) / **4,066,557** detections over **9,822** keyed Area-API requests. Per area: Chilecito
  5,733 / 29,501 on 4 lanes; Pantanal 12,928 / 1,863,513 on 4; California 5,311 / 662,947 on 4; Greece
  2,923 / 119,688 on 4; Amazon 1,230 / 1,065,331 on 4; Nepal 728 / 73,985 on 4; Southeast Australia
  1,676 / 251,592 on 4.
- On the record (`provenanceMix`, 9,498 days per area): Chilecito and Pantanal **100%** observed with
  **zero modelled** days; California **41.2%** (3,909), Greece **33.0%** (3,139), Southeast Australia
  **15.9%** (1,514), Amazon **11.4%** (1,084), Nepal **9.4%** (889). All seven report 90/90 observed
  days in the last 90.
- `bridgeFor('chilecito') = {source:'firms-archive', k:12.77, days:5401}`; `biasXray`: ratio **12.88**
  (90% CI 12.49–13.28), eraDays **5,401**, joint-non-zero **792**, raw **136.0%** → corrected **−44.7%**,
  reduction **67.15%**, `breakBasis: 'observations'`. `bridgeFor('pantanal') = {k:10.63, days:2441}`;
  ratio **10.64** (10.55–10.72), **1,590** joint days, **186.1%** → **−20.8%**, reduction **88.80%**.
- Sandbox on the default area: recovery **9.79%** weekly MAE, raw sensor bias **−63.02%** →
  **+0.19%**; `weatherCoverage()` 1.0000 on all seven areas.
- `npm run validate` **23/23**, including *20451 of 21863 archive days carried into the record as
  observed; 1358 days hold NOAA-20/21 detections but no reference lane (SNPP or MODIS) and stay
  modelled — first: california 2023-03-01 n=0 n21=16*. 66,486 record rows.
- Full chain at `continuum-2026-11-02-50570444baa4`: `npm run data`, `npm run api:build`,
  `npm run bundle`, `npm run build`, `npm test` **59/59**, `npm run validate` **23/23**,
  `npm run smoke` **44/44**, `npm run secret-scan` clean (126 source files, 16.1 MB, 5 bundle assets),
  API restarted and `/api/v1/health` serves the new bundle id,
  `E2E_ORIGIN=http://localhost:8787 npm run e2e` **79/79**.
- Two analog hit rates moved with the observed seasons and the goldens were **recaptured** with
  `node scripts/capture-analogs.mjs --write`: Amazon **10 → 65** (its observed seasons nearly doubled)
  and Southeast Australia **65 → 60**; Chilecito 65, Pantanal 60, California 55, Greece 70, Nepal 80.
  Every row was rewritten because the underlying season sums changed. The test header records the
  bundle, counts and reason. No tolerance was changed.

**Partial**
- Standard-processing depth is still partial for five areas (California, Greece, Amazon, Nepal,
  Southeast Australia): MODIS and SNPP lanes are filling but nowhere near complete, so those areas keep
  the calibrated bridge rather than a measured one.
- The writer is **paused at a clean checkpoint** (`STOP` file, lock released, 9,822 requests). Remaining
  work is roughly 18k SP requests — hours of wall-clock at the key's shared budget, resumable from the
  cursors without refetching.
- **The transaction meter was the real cause of "Invalid MAP_KEY".** The Area API charges about one
  transaction per day of a multi-day window, so 60 requests/min of 5-day windows can exhaust the
  documented 5,000-per-10-minute budget; the CSV endpoint then answers exactly like a revoked key.
  `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=…` reported
  `current_transactions: 5000` of `5000` while WMS still answered 200 with the same key. Fixed by
  polling that status endpoint every 100 requests and, on `Invalid MAP_KEY`, checking the meter before
  counting an auth failure: a spent budget waits 60 s and retries the same window with the cursor
  unchanged (bounded at 20 waits). The log records `[budget] 5000/5000 … waiting 60s` followed by
  resumed fetching — the run survived several full windows without losing coverage.
- `MIN_BRIDGE_DAYS = 365` in `src/lib/archive.ts`: after the NRT fill, areas with only an Aug–Nov
  overlap measured absurd bridges (Nepal **46.69×** on 63 days, raw break 3,090%). A ratio from one fire
  season must not rescale twenty-five years of MODIS-only days, so `archiveRatio()` now returns null
  under a full annual cycle and `bridgeFor()` falls back to the calibration.
- `tests/science.test.mjs` MODIS-rescale sample cap raised 200 → 400 so the pooled non-zero sample
  still clears 1,000 after Chilecito and Pantanal became fully observed (a strengthening, not a
  loosening).
- Burned-area gate remains **blocked** on an Earthdata-Login/LP DAAC token; the keyed Area API serves
  detection products only, as recorded above.

**Not verified**
- Same as the previous section: burned area is PENDING, and neither NOAA lane alone clears the
  "observed" bar — the archive overlay needs a reference lane.

## 2026-11-03 — final gate re-run; two stale contract assertions corrected, calendar frame covered

**Verified** (commands run against `continuum-2026-11-02-50570444baa4`, data through 2026-11-02)
- `npm run validate` → **23/23** (17 manifest files checksummed; 66,486 record rows; 8 data files
  identical between `public/data` and `dist/data`).
- `npm test` → **59/59**, 0 fail. Two assertions that had gone stale against the data were replaced
  with stricter contracts rather than relaxed:
  - *Seam test.* It asserted a seam must exist whenever any `archive` row exists. Chilecito and
    Pantanal are 100% archive (their keyed LANE covers 2000-11-01 onward), so they have no
    model→archive switch and `bias.seam` is correctly `null`. The test now derives the switch days
    from each record and asserts, for all seven pilots: no switch → `seam === null`; one or more
    switches → `seam.from`, `seam.switches` and `seam.days` equal the derived values and `pct` is
    finite. California/Greece/Amazon/Nepal/Southeast Australia now exercise the non-null path
    (2012-01-20, 2 switches, 451 pooled days at this bundle).
  - *Texture test.* It asserted exactly three textures; the globe now selects an 8K or 4K tier of the
    day and night sheets, so seven attributed Visible Earth files ship. The test now pins the exact
    seven-file set and asserts the four tiered sheets are the ones `Globe.tsx` loads.
- `npm run secret-scan` → clean — 133 source files (18.9 MB), 5 bundle assets, no credentials in the
  tracked tree or the built bundle.
- `npm run smoke` → **44/44** against `server/api.mjs`.
- `E2E_ORIGIN=http://localhost:8787 npm run e2e` → **82/82**, `failed []`, zero console errors. The
  month-comparison check was targeting the first `.select` in the Atlas DOM, which is now the
  calendar frame's *Span* control; it now targets `select[aria-label="Month"]`. Three checks were
  added for the frame itself: the five resolutions (`Days,Weeks,Months,3 mo,Years`), the
  `Span`/`Focus year`/`Compare` fields, and that switching to `Years` re-reads the same record
  (`~9,498` day cells → tens of year cells) and restores the day view exactly.

**Gap unchanged**
- Every host-bound item in `docs/production-readiness.md` §2 stays where it was: real-device sweep,
  provider TLS/CDN/volume restore, and a live Prometheus/Alertmanager collector are not exercised
  locally.

## 2026-11-03 (later) — final UI upgrade: branded Watch fallback, 44 px mobile targets, shareable frame

**Verified** (same bundle `continuum-2026-11-02-50570444baa4`, data through 2026-11-02)
- `npm run build` → exit 0, 67 modules, `dist/` emitted.
- `npm run validate` → **23/23**; `npm test` → **59/59**, 0 fail; `npm run smoke` → **44/44**;
  `npm run secret-scan` → clean (144 source files, 18.9 MB, 15 bundle assets).
- `E2E_ORIGIN=http://localhost:8787 npm run e2e` → **92/92**, `failed []`, zero console errors.
  Ten checks were added:
  - *Calendar frame link.* Non-default `res`/`fy`/`gap` appear in `location.hash`, pasting that hash
    restores the same resolution, focus year and comparison gap, and returning to defaults removes
    the parameters again. `res`/`span`/`fy`/`gap` are parsed in `parseHash()` and only emitted when
    non-default, so ordinary links stay short.
  - *Mobile 390×844.* No sideways document scroll on Watch or Atlas; all nine visible top-nav
    targets are ≥44 px tall (brand 44×44, nav 31–51×44, alert 51×44, settings 44×44); icon-only
    targets are ≥44 px wide; speed chips measure 36–44×36; hero copy is present; the five frame
    buttons stay inside the panel.
- The lazy-route fallback was captured deterministically by pausing the `Watch-*.js` request with
  CDP `Fetch` and screenshotting `.watch-boot-card` (`.qoder-shots/resp-d-watch-skeleton.png`): the
  card reads “Assembling the orbital watch”, the wrapper carries `role="status"` +
  `aria-live="polite"`, and continuing the request mounts the canvas and hero. Previously this
  state was a bare `LOADING_` line.
- A responsive sweep of all six routes at 390×844, 768×1024 and 1440×1000 reports
  `scrollWidth − clientWidth = 0` on every route.
- `npm run perf` → **every measurable §2 objective met, zero breaches** (`docs/perf-report.json`,
  2026-11-03T07:03). Initial JS: Watch 220.05 KiB / 225.34 kB, Atlas 98.34 / 100.70, Method 81.18 /
  83.13 — all inside the 250 kB §9.2 budget on either unit reading. Web vitals CLS 0.0003 on all
  three probes; LCP 1 328 / 1 200 / 908 ms; INP 2 / 2 / 1 ms. The 257.60 KiB whole-session download is
  reported as a near-miss because the sweep walks through every lazy route.
- All six routes are now `lazy()` boundaries in `src/App.tsx`, and `satellite.js` moved from
  `src/lib/satellites.ts` into `src/lib/sgp4.ts`, imported only by `Globe.tsx`. That took the entry
  chunk from 120.03 kB to 73.34 kB gzipped and removed the SGP4 chunk from the initial preload list.

**Gap unchanged**
- Real devices, provider TLS/CDN, volume restore from a provider snapshot, and a live metrics
  collector remain unexercised; these need a host, not another local run.

## 2026-11-03 (world layer) — every country on Earth is selectable, and each one carries its own measured window

**Verified** (bundle `continuum-2026-11-02-954f24dbc630`, live window 2026-10-26 → 2026-11-02, 8 days)

The user's report was that only a few places could be picked on the map. That was true: the app knew
seven pilot regions plus a curated gazetteer. The world layer replaces that shortlist with Natural
Earth 50m borders — 241 countries, 1,616 polygons — and attributes the four global FIRMS CSVs to
them by point-in-polygon.

- `npm run countries` → `raster filled 574,242 cells`; **966,066** quality rows read, **929,967
  (96.26 %)** fall inside a country border, **36,099 (3.74 %)** are ocean or unclaimed, **146,008**
  dropped on confidence; **178 of 241** countries have at least one detection in this window;
  `20/20 reverse-lookup spot checks pass`; the per-country totals sum to 929,967, i.e. the table
  accounts for every attributed row.
- Independent geometry checks, all in `npm test`: Σ country area **148,686,163 km²** against the
  published 148.9 M km² of dry land (0.14 % off); Antarctica **14,311,067 km²** against ~14.2 M
  published; Russia **16.88 M km²** by polygon and **16.88 M km²** by the 0.2° raster against 17.10 M
  published, and raster/polygon stays inside 0.9–1.1 so the antimeridian cannot double-count it.
- The top of the window is Brazil 102,684 | China 70,217 | Australia 64,226 | Mozambique 59,471 |
  Tanzania 49,224 | South Sudan 48,316 | Indonesia 40,246 | Sudan 37,467 | Botswana 33,484 |
  Madagascar 29,579 detections — measured inside each border, not modelled.
- `npm run build` → exit 0, `dist/` emitted. `npm test` → **66/66**, 0 fail. `npm run validate` →
  **23/23**. `npm run smoke` → **44/44**. `npm run secret-scan` → clean (152 source files, 19.2 MB,
  15 bundle assets). `npm run perf` → zero breaches (2026-11-03T08:47): initial JS Watch 223.82 KiB /
  Atlas 101.42 KiB / Method 84.03 KiB gzipped, LCP 1 148 / 1 040 / 776 ms, INP ≤ 3 ms, CLS 0.0003.
- `E2E_ORIGIN=http://localhost:8787 npm run e2e` → **100/100**, `failed []`, zero console errors.
  Eight of those checks are new and all target this goal: typing "Antarctica" reaches a country with
  no pilot region; selecting it makes it the analysed area; a genuine pointer click on the South Pole
  names the continent rather than open ocean; `#/atlas?c=kenya` restores Kenya as the area with a
  measured window; and the live figure for a country equals the VIIRS detections its border actually
  recorded (Kenya **233**), while a country with no detections prints **0**.

**Two accuracy defects the audit found and fixed** (both were proven in Node against the shipped
bundle before and after, then locked by `npm test` case *"a country record is its measured border
counts, day by day"*):

1. **A country's live days were built from the stride sample, and the days the sample missed stayed
   modelled.** Kenya's eight window days printed `1, 2, 4, 2, 1` detections — the sampling rate, not
   the fire rate — then `72, 54, 71` with every sensor count zeroed, because the overlay blanks the
   instrument columns but left the modelled Poisson total in place, under `source: 'live'`. That
   breaks two rules at once: a model output wearing the LIVE label, and a series whose days are not
   in the same unit. The record now takes a country's days from `country_fires.json` — the complete
   per-day, per-sensor count for that border — allocated across days by largest remainder so the
   days add back to the measured total exactly. Kenya 245 detections, Brazil 102,684, Russia 23,983,
   Australia 64,226, Iceland 5: each record sums to its border count, each of the eight days is a
   real observation, and the level the model is calibrated to (`levelPerDay × 8`) now equals the
   record's own harmonized sum (Kenya 233, Brazil 91,994) instead of disagreeing with it. The same
   fix removed the Brazil case where the country inherited the *pilot* area's ratio because its
   centroid happens to sit inside an Amazon bbox: a border count outranks an area count wherever both
   exist. For an area that is neither a country nor inside a pilot bbox, the window days keep their
   modelled value and their `'model'` label instead of a `'live'`-labelled observed zero they cannot
   support.
2. **A country with no detections inherited the pooled pilot density.** `countryStatsFor` rejected
   `total: 0`, so Antarctica fell through to `pilot-density` and Atlas reported **26,671**
   VIIRS-equivalent detections over a continent where the satellites measured none. A measured zero is
   a measurement: the gazetteer's 63 countries with no row now calibrate to their own zero, and
   Antarctica prints 0 with `levelSource: country-window`.

**Blocked / not verified**
- **Blocked:** the keyed FIRMS archive stays pilot-only, so a country's record runs 2000-11-01 → the
  window start as a labelled reconstruction calibrated to its own measured window; only the seven
  pilot areas carry archive-observed days. Extending it needs `FIRMS_MAP_KEY`, which is not present in
  this environment.
- **Was Partial, now verified:** the API resolves `country-*` ids. `server/api.mjs` reads
  `data/countries.json` + `data/country_fires.json` and runs the *same* installer the browser
  fetches into — `hydrateWorldLayer()` then `installWorldLayer()` in `src/lib/countries.ts` — so both
  surfaces build one Region object and share one calibration lookup. Measured over HTTP below.

**Verified — same day, later: the world layer over HTTP**
- `POST /api/v1/area/summary {"region_id":"country-kenya"}` → 200 with
  `area_resolution: "country border (Natural Earth 50m)"`, `counts.days = 8`,
  `counts.by_sensor = {modis: 12, viirs: 78, noaa20: 81, noaa21: 74}`, `counts.total = 233` — Kenya's
  measured border counts (245 detections in the window, 233 of them on VIIRS), not the stride sample.
  `country-antarctica` → `total: 0`. `country-russia` → 22,830, which is exactly its measured
  7,568 + 7,714 + 7,548 VIIRS lanes. `country-atlantis` → 422 `OUT_OF_COVERAGE` whose hint teaches
  the `country-<id>` form and the 241 count.
- `GET /meta` publishes the index: 241 borders, 178 with detections, 96.26 % of window rows inside a
  border, per-sensor lanes and active days per country; the per-country rows add back to
  `rows_in_countries`. Proved by `npm run smoke` → **47/47** (three new checks) and `npm test` →
  **70/70**, four of them over HTTP against a server spawned on an isolated port.
- **Pilot invariance is proved, not assumed.** Registering 241 borders must not move an area that has
  its own complete pull, so `countryStatsFor()` now returns null for a sub-country area inside a pilot
  bbox: every pilot region keeps `levelSource: area` and never inherits a country bridge, and a
  hand-picked 60 km AOI inside California keeps `levelSource: area` even though the gazetteer can name
  the country it sits in. California still answers 1,323 harmonized over the window, identical to the
  in-app record computed with the world layer installed (asserted to < 0.05), and
  `npm run validate` stays **23/23** on the existing goldens.
- Latency measured rather than assumed: `country-summary` p50 16.0 / p95 16.5 ms, and the worst case in
  the gazetteer — `country-calendar` for Russia, 2000-01-01 → 2026-11-02, 9,498 rows — p50 34.2 /
  p95 63.1 ms against a 3 s objective (`docs/perf-report.json`, 2026-11-03T09:11Z). Both rows are in
  the probe's own endpoint list now, so a country regression would fail a future run.
- **Gap, documented not smoothed:** 3.74 % of detections land outside any 50m border (open ocean,
  and the few places Natural Earth does not name); Antarctica's 0.2° raster area and its cap integral
  legitimately disagree because a ring around the pole also encloses the Weddell and Ross embayments,
  so the raster cross-check excludes it; and a country's per-detection FRP *spread* still comes from
  the pilot regions — only the border's measured mean FRP is shipped.

## 2026-11-03 (published tree) — the repository was cloned and the whole chain re-run inside the clone

**What ran.** `main` pushed to `https://github.com/rickykhulal/continuum` (b66ae0b → e04bf7a → da204c0),
then `git clone --depth 1` into a clean directory, `npm ci`, and the release chain there:
`npm run api:build && npm run build` → `npm test` → `npm run validate` → `npm run smoke` →
`node server/api.mjs` on an isolated port → `E2E_ORIGIN=… npm run e2e` → direct `GET /ready`, `GET /meta`
and `POST /api/v1/area/summary` for a country.

**Result — verified on the published artifact, not the working copy**
- Build exit 0, emitting the same content-hashed asset filenames as the working tree — the published
  source compiles to the artifact that was tested.
- `npm test` → **70 pass / 0 fail**, `npm run validate` → **23/23** reporting
  "16 files verified, 4 `data_raw` build inputs absent (run npm run live to verify them)",
  `npm run smoke` → **49/49**, `npm run e2e` → **100/100** with `failed []`.
- `GET /ready` → 200 with `integrity {ok: true, bad: [], files: 20}` — the manifest's own row count,
  including the four inputs a clone does not carry.
- The world layer answers from a tree with no CSVs: `/meta` 241 borders / 178 with detections /
  96.26 % attributed, Kenya `counts.by_sensor = {modis 12, viirs 78, noaa20 81, noaa21 74}` → 233,
  an unburnt country 9,498 calendar days summing to 0, Brazil 102,684 as the busiest border.

**Two failures found and fixed here rather than shipped**
- **Line endings broke integrity.** The first clone answered `GET /ready` → **503** with
  `integrity.bad = ["tle/satellites.txt: checksum mismatch", "tle/satellites.txt: size mismatch"]`.
  `.gitattributes` said `* text=auto`, so checkout rewrote the committed CRLF bytes of the TLE file
  (845 → 830 bytes) and the served file no longer matched the hash the manifest recorded. `public/data/**`,
  `public/tle/**` and `public/textures/**` are now declared `-text` and the tree renormalised (`e04bf7a`).
  `npm test` in a clone covers the same hazard from the other side: the bundle tests recognise absent
  inputs and still verify every shipped byte (`da204c0`).
- **HSTS had never been emitted.** `server/api.mjs` read `req.socket.encryption`, which is not a Node
  socket property, and behind Render's TLS terminator the socket is plain HTTP anyway. `isTls(req)` now
  consults `req.socket.encrypted` *or* the first `x-forwarded-proto` token and drives both
  `Strict-Transport-Security` and the `/openapi.json` server URL. Two new smoke checks forge a proxied
  request so the terminator path is asserted, not assumed — the suite moved 47 → **49**.

- **The drill's file list had gone stale, and CI found it.** All three pushes ran `.github/workflows/ci.yml`
  on `ubuntu-latest`; steps 1-11 (install, `tsc -b`, `npm test` 70/70, `npm run build`, `npm run validate`,
  secret-scan, `npm run smoke` 49/49) passed and **`npm run rehearse` failed** — the same failure reproduced
  in the clean clone: 8/12, with `/ready` answering 503 on the relocated bundle because
  `data/climate_daily.json`, `archive_daily.json`, `countries.json`, `country_fires.json` and
  `countries-50m.json` were never copied there. `scripts/rehearse-restore.mjs` carried a four-file bundle
  list written before the world layer existed, so the last recorded 12/12 (2026-11-01,
  `continuum-2026-10-31-3d36468a8dc0`) had been certifying a 4-file bundle while the shipped bundle has 9
  data files. The list is now derived from `bundle_manifest.json` (+ the manifest itself), and the drill
  re-run on 2026-11-03 is **12/12** on `continuum-2026-11-02-954f24dbc630` — `backup … 9 files`, corruption
  and deletion still name their file, restore returns `/ready` 200 in the same process.

**Coverage proved exhaustively, not by sampling (2026-11-03, same day)**
- Every id the gazetteer publishes was asked for over HTTP, not a subset: **241/241** returned 200 with
  `counts.days = 9498` (2000-11-01 → 2026-11-02), 178 of them non-zero and **63 printing a measured 0**
  — the same 178 the builder reports, so "selectable" holds for the quiet borders as well as the busy
  ones. Spot-checked across every continent and size class: Nauru, San Marino, Liechtenstein, Kiribati,
  Singapore, Malta, Antarctica all answer; Iceland 17,399, Finland 69,031, Botswana 91.28 M,
  Timor-Leste 574,842, Vanuatu 120,235 harmonized.
- Each country's live-window block was then compared to the point-in-polygon measurement rather than to
  itself: **241/241 exact agreement** between the API's `counts.by_sensor` VIIRS lanes for
  2026-10-26 → 2026-11-02 and `data/country_fires.json` (`days = 8` for every one). No border inherits
  another's density and none is filled in.
- Latency over that sweep: p50 80 ms, p95 125 ms, max 293 ms — with the default `API_RATE_LIMITS`
  the sweep itself starts receiving 429 after roughly a hundred calls, which is the documented class-B
  behaviour rather than a fault; the full pass needed a throwaway instance on another port with the
  limits raised. The app never makes a call per country: the browser computes from the selected area's
  record, and `/meta` is the only world-layer request it makes.
- **Re-run at the shipped limits, 2026-11-03T13:03Z on `feb2aa0`.** The same 241 ids were asked again of the
  API on :8787 with default `API_RATE_LIMITS`, paced to one request per 1.05 s (57/min, inside class B):
  **241/241 HTTP 200, 0 failures, one distinct `counts.days` value — 9498 — and 63 borders reporting a
  measured 0.** Nothing had to be relaxed to reproduce it; the earlier un-paced pass only needed the raised
  limits because it issued calls faster than the documented rate class allows.
- **Third re-run, 2026-11-04T04:05–04:11Z on `104e58d`.** The same 241 ids were asked again of the API on
  :8787 at the shipped defaults, paced to one request per 1.1 s, with the client honouring `Retry-After`
  rather than the limit being raised: **241/241 HTTP 200, 0 failures, one distinct series length —
  `values.length = 9498` — for every id, 178 borders with detections and 63 with a measured 0**, against
  the window 2026-10-26 → 2026-11-02 and `rows_in_countries` 929,967 of 966,066 read (96.26 %). The
  pushed commit's own CI run (`run_number` 15, `104e58d`) concluded **success** at 04:09:20Z with
  **20/20 steps** green on `ubuntu-latest`.

- **Gazetteer gaps, measured and then closed.** Natural Earth 50m publishes 241 admin-0 units. Tested
  against the shipped `data/countries.json` index, the 14 names below have no polygon — searched as
  substrings of all 241 entries, they return nothing, while Monaco, Norfolk Island and **Vatican City**
  (an earlier draft of this entry wrongly listed the Holy See as absent; the measurement says present,
  `id: vatican-city`, 1 km², a measured 0 detections) are in the list and answer normally:
  Tuvalu, Tokelau, Gibraltar, Wake Island, Réunion, Mayotte, Canary Islands, Svalbard, Christmas
  Island, Cocos (Keeling) Islands, Bonaire, Ceuta, Melilla, Hawaiʻi.
  They are now curated entries in `PLACES`
  ([src/data/places.ts:32](file:///c:/Users/Ricky/Desktop/NASA%20HACKATHON/src/data/places.ts#L32))
  and `WorldSearch` passes that list into `searchWorld`, so each one opens as a named custom AOI at its
  own coordinates — the same thing the app already does for every non-pilot place — instead of being
  invisible to the keyboard. **Verified 2026-11-03** by `npm run e2e` 105/105,
  which types all 14 queries and requires a matching result row for each, then selects Tuvalu and asserts
  the header names it, the hash is an `aoi-*` region and the toast says custom area. The outward probe is
  no longer unasserted either: a click on open water now has to report "Open ocean" with its own
  coordinates and still become a 150 km AOI, and the pole click still resolves to Antarctica rather than
  water. Remaining gap: none known for *reachability*; a territory AOI is still an exploratory area, not a
  border-aggregated country record.
- The same selection pass showed the hero line was ambiguous rather than wrong: `{kept} real detections` sat
  under a header naming the selected area while `live.meta.counts.kept` is the harmonized **global** total for
  the window (71,882 kept of 966,066 quality rows, unchanged by selection — verified by selecting California,
  Nauru and a Svalbard AOI and reading the same figure each time). All four places that print it now say
  `real detections worldwide` / `Live detections worldwide`; per-area numbers were already derived at render
  time from the selected record and are unchanged.
- One more number of the same kind was removed rather than re-labelled: every border's description said
  "the live 7-day window", but `CountryWindow` carries `day`/`night` counts and no window length, so that
  seven was not derivable from the record (and the shipped window is not seven days: all four
  `data_raw/*_Global_7d.csv` files contain 8 distinct acquisition dates, 2026-10-26 → 2026-11-02, measured
  by counting dates in each file). It now reads "the live FIRMS window"
  ([src/lib/countries.ts:431](file:///c:/Users/Ricky/Desktop/NASA%20HACKATHON/src/lib/countries.ts#L431));
  the detection figure beside it is still `w.total` from the same record. `npm run validate` 23/23, `npm run
  smoke` 49/49 and `npm run e2e` 105/105 were re-run on that tree with zero console errors.
- Read back out of the served page rather than out of the source: `http://127.0.0.1:8787/` (chunk
  `index-Cp3BhHdt.js`, same file on disk) was driven from the keyboard for two more Pacific nations —
  Kiribati → header `Kiribati — country wide`, result row "941 km² · 0 detections this window", and
  Fiji → `#/atlas?r=country-fiji…` with 9,506 calendar cells, the description printing the measured
  `(971 detections)`, no `NaN`/`undefined` anywhere in `<main>`, and no surviving "7-day window" string.
  The quiet border renders as a real record, not an empty area.
- **A click on a country now selects that country, not a circle around the cursor.** The globe's land pick
  used to call `selectCustom(lat, lon, 150, …)` for every point, so clicking the middle of Australia gave a
  150 km AOI *labelled* Australia — which is what "only a few places are actually selectable" looked like
  from the outside: the whole-border record was reachable from the search box but never from the map. The
  pick now branches on the hit test ([src/components/Globe.tsx:796](file:///c:/Users/Ricky/Desktop/NASA%20HACKATHON/src/components/Globe.tsx#L796)):
  a point inside a published border calls `selectCountry`, a point in water or within one probe ring of a
  border keeps the point-centred AOI, and the coordinate + radius fields in the Atlas remain the way to
  frame a deliberate small area. Measured in the sweep, clicking the centre of a globe that is looking at
  each place: `Australia selected country-wide — 64,226 detections measured inside its border in this
  window` with `r=country-australia` in the URL; `Antarctica selected country-wide — no detection inside
  its border in this window` (an observed zero, not an empty area); `Open ocean at -8.52°, 179.14° selected
  as a 150 km AOI` with `r=aoi-s8p52-e179p14`. `npm run e2e` is **107/107** on that tree — the two added
  checks require the land click to end on a `country-` region and the water click to end on an `aoi-`
  region, so the two branches cannot silently collapse back into one another — with `npm test` 70/70,
  `npm run validate` 23/23, `npm run smoke` 49/49 and secret-scan clean.
- `npm run perf` re-run on this tree at 12:14Z (the chunk hashes move with the copy change): 216 requests
  across 18 endpoints, 0 server errors, 0 objective breaches. `country-summary` p95 15.9 ms, the gazetteer's
  worst case `country-calendar` (Russia, 9,498 rows) p50 29.3 / p95 37.0 ms, GeoJSON export still the slowest
  data path at 94.2 ms p95 against a 10 s objective, `/ready` 54.5 ms p95 because it re-hashes the bundle.
  Per-view initial JS 84.69 / 102.07 / 224.48 KiB gzipped, all inside the §9.2 budget; full table in
  `docs/api.md`.
- **A pasted border link snapped back to the default area, and the sweep now catches it.** Selecting Japan
  from search worked, but editing the address bar to `#/atlas?r=country-japan…` in the same tab left the
  Atlas header on Chilecito and rewrote the URL to `r=chilecito`. Two causes, both in
  [src/lib/store.tsx](file:///c:/Users/Ricky/Desktop/NASA%20HACKATHON/src/lib/store.tsx): `parseHash()` only
  recognised a border through the `c=` parameter, so a bare `r=country-<id>` failed the pilot-list check and
  became the fallback region; and the `hashchange` handler applied `selectCountry()` for a fresh load but not
  for a link pasted into a running tab. `r=country-<id>` is now parsed as the border it names and the hash
  change path selects it the same way a click does. **Verified** by the new check
  `A border named in a link pasted into an open tab stays the analysed area` (Japan, 9,506 calendar cells
  rendered, URL keeps `country-japan`) — `npm run e2e` **105/105**, `npm test` 70/70, `npm run validate`
  23/23, `npm run smoke` 49/49 on the same tree.

- **Reachability of every state is now gated at the ranker, not only at the map.**
  [tests/sovereign-coverage.test.mjs](file:///c:/Users/Ricky/Desktop/NASA%20HACKATHON/tests/sovereign-coverage.test.mjs)
  hydrates the shipped world layer from `public/data/countries.json` + `country_fires.json` and drives the
  *same* `searchWorld()` the browser runs (exported through `server/analytics.ts` so the test cannot drift
  from the app) over four assertions: all **194** independent-state names (193 UN members + Vatican City)
  resolve to a gazetteer border or a curated place; typing any of them returns that state's own area first;
  **13** UN/ISO long forms resolve to the border they name; and every ranked hit is a real area — an id in
  `worldCountries()`, finite coordinates, a defined `detections` figure. It found one genuine gap: Natural
  Earth publishes **"Marshall Is."**, so the name a user types ("Marshall Islands") did not rank its own
  border. Fixed with `SPELLING_ALIASES` in [src/lib/countries.ts](file:///c:/Users/Ricky/Desktop/NASA%20HACKATHON/src/lib/countries.ts),
  merged into the gazetteer **at hydration time** rather than in `scripts/build-countries.mjs`, because
  rebuilding `countries.json` would move `bundle_version` and invalidate every published latency and
  coverage figure in this file. Measured: `npm test` **74/74**, and the served bundle still reports
  `bundle_version: continuum-2026-11-02-954f24dbc630` — the alias merge is provably bundle-neutral.
- **The sweep's own ordering was a bug, and it was a real one.** Adding the Marshall check before the
  open-water click made `Water outside the probe radius says open ocean…` fail with
  `Marshall Is. selected country-wide`. Not an app defect: selecting an atoll country parks the camera on
  the centroid of its own polygon, so the centre pixel *is* land and the click correctly answers
  country-wide. The check was moved after the water click, with the reason recorded in the script, because a
  camera-state dependency that only shows up as an app failure is worse than the defect it pretends to catch.
- **The challenge's "downloadable CSV File of hot spots" is now literally satisfied, and measured against
  the geometry file.** Atlas gained a fifth export, *Hotspot table*
  ([src/lib/export.ts](file:///c:/Users/Ricky/Desktop/NASA%20HACKATHON/src/lib/export.ts) → `exportHotspotCSV`),
  one row per detected point with `time_utc, date, latitude_east, longitude_east, sensor, frp_mw, confidence`
  and the source + geometry-coverage limit in `#` header comments. Two new checks download it in the browser
  and parse it back: at the Pantanal AOI for the live window the file is **12,299 bytes / 162 point rows**, and
  the GeoJSON produced by the same search carries **exactly 162** `kind: "hotspot"` features — the two files
  cannot now disagree without failing the sweep. Typed latitude/longitude got the same treatment: checks
  `Typed latitude and longitude open the area they name, with the radius typed` (−10.50°, −55.20°, 180 km →
  `r=aoi-…`, full 9,498-day record rendered) and `An out-of-range latitude is refused with the range stated,
  and the area does not move` (123° → the range message, hash unchanged). Before this, "option to enter
  latitude and longitude" was only evidenced by the inputs being *labelled*, which is not the same claim.
  `npm run e2e` **112/112** on this tree, `npm run validate` 23/23, `npm run smoke` 49/49, secret-scan clean.
- **`docs/challenge-conformance.md`** maps every objective and every "you may consider" line of
  `docs/challengestatements.txt` to the shipped surface and the check that proves it, and states what the
  build does *not* claim (reconstruction labelling, live-window-only geometry, observed zeros, nothing deployed).

**Not claimed.** The Render dashboard Blueprint import (no account was driven from here), container
builds (no engine in this environment), and anything that needs a host: availability, cold start on the
free tier, CDN behaviour. `docs/runbooks.md` §6.1 records the deploy sequence and labels the host-bound
parts; `docs/production-readiness.md` §2 keeps Performance, Reliability and Observability open for
exactly that reason.


## 2026-11-13 current-working-tree audit

Full findings: [Project audit](project-audit-2026-11-13.md). Earlier success entries describe earlier trees and do not certify the current working copy. Audit baseline: HEAD `b81a57d` plus existing live-feed edits; further edits to `src/lib/data.ts` and `src/lib/archive.ts` arrived during consolidation and are **not verified** by the earlier runs. No application source edits were made by this audit.

| Command | Current output | Status |
| --- | --- | --- |
| `npm ci` | exit 0; 106 added, 107 audited | **verified** |
| `npm run build` | exit 1; TS1144 at `src/lib/liveClient.ts(136,3)` | **verified** failure |
| `node --check server/live.mjs` | duplicate `resetForTest`, reported at line 344 | **verified** failure |
| `npm test` | exit 1; 108 passed, 15 failed, 9 cancelled, 3 skipped of 135 | **partial**; API startup fails |
| `npm run validate` | exit 0; 23/23, 20 manifest entries, 66,486 pilot rows | **verified** for checked stored-bundle contracts |
| `npm run smoke` | exit 1; 0/1, API startup failure | **verified** failure |
| `npm run secret-scan` | exit 0; clean, 166 files, 15 existing bundle assets | **verified** within scanner scope |
| `npm audit --omit=dev --audit-level=high` | zero vulnerabilities | **verified** |
| `npm audit --audit-level=high` | exit 1; one moderate, one high development advisory | **verified** outstanding findings |
| preview + `npm run e2e` | 80 true / 102 recorded assertions, 22 false, fatal null `.focus()`; erroneous exit 0 | **partial**; pre-existing dist only, current build failed |

Release blockers include shifted acquisition timestamps (`alignLiveToRealtime`, country equivalent), disconnected runtime data/store/API updates, unsafe whole-feed argument spread, geographic/cache errors and incorrect recent-year means. Read-only analytics probe: an Oct 26 acquisition became Nov 6 (+950,400 seconds); latest-five mean returned 60 instead of 42; 20/140 km areas shared an API cache key; polygon hole area was added. See the audit appendix for the command input and findings.

Stored data remains through November 2 on `continuum-2026-11-02-920de0617606`; the later bundle creation date is not fresher data. Measured pilot observation coverage is 30,895/66,486 area-days (46.47%), with remaining days reconstructed. Current API/browser functionality and scientific accuracy are not certified by the passing file-integrity check. Current-source e2e is **not verified**; target deployment/load/rollback/alerts are **not verified**, with host-bound execution **blocked** where a host/engine is required.

Machine reports updated: `validation-report.json`, `api-smoke-report.json`, `e2e-report.json`. Preview was stopped. No new NASA fire download, archive promotion, dependency upgrade or deployment was performed.

## 2026-11-15 pet and wind integration

Base: `cc6a1b8`, following `git pull origin main` (already up to date). The pet is mounted once
in the application shell. Its GLTF loader now runs inside Canvas/Suspense, renders the loaded
scene with Drei Float, and retains a keyboard-operated fact button and a fallback. Model credit
and its CC BY 4.0 license are recorded in NOTICE and linked from the companion.

The map already used acquisition timestamp tuple index `5`; no `Loaded Fires:` overlay remained.
The obsolete debug comment was removed. Browser checks reproduced three separate integration
defects: the production worker URL was missing, CARTO tiles displayed `API KEY REQUIRED`, and
the first source update was skipped while the new GeoJSON worker loaded. The build now emits the
worker, the API serves `.mjs` with JavaScript MIME, and the map uses key-free NASA GIBS tiles with
the corresponding CSP connection permission. Source updates wait for registration instead of
every source being loaded. A fire click opens the wind panel through a body portal, so parent
panel styling cannot place it outside the viewport. Area/date/sensor/window changes clear the
selection. The fixed wind scenario remains explicitly labelled Simulation.

| Command or browser action | Output | Status |
| --- | --- | --- |
| `npm ci` | exit 0; 172 added, 173 audited | **verified** |
| `npm run build` | exit 0; 1,024 modules; module worker emitted; entry `index-B7CDkrgM.js` | **verified** |
| `npm test` | exit 0; 223 tests, 219 passed, 0 failed, 4 skipped | **verified** within executed cases; skipped live-key cases remain **not verified** |
| `npm run smoke` | exit 0; 49/49 | **verified** |
| `npm run validate` | exit 1; 22/23; VIIRS-SNPP freshness is `9999-99-99..0000-00-00`, outside the stored window | **verified** failure; existing data metadata needs repair |
| `npm run secret-scan` in the workspace | exit 1; local `.env` reported by presence only; `git check-ignore .env` confirms it is ignored | **verified** failure for the complete local workspace |
| `SECRET_SCAN_ROOT` set to a scratch copy of tracked working files plus `dist/` and `dist-server/`; `npm run secret-scan` | exit 0; 198 files, 17.5 MB, no credentials found | **verified** for the publishable files and built bundle; the workspace failure above is retained |
| `npm run api`; GET emitted worker asset | 200; `text/javascript; charset=utf-8`; 519,547 bytes | **verified** |
| GET NASA GIBS Blue Marble WMTS tile | 200; `image/jpeg`; 10,170 bytes | **verified** |
| CUA: navigate all eight primary pages and inspect Laika visibility/current navigation | 8/8 `petVisible: true`, 8/8 `aria-current: page`; loaded 3D scene visible | **verified** |
| CUA: fresh Atlas load, click rendered California fire at viewport `(270, 630)` | points visible before toggling controls; wind panel `42.0371, -123.5495`, NE (45°) at 12 m/s; popup time `2026-11-10T20:42:00Z`; panel bounds inside viewport | **verified** |
| CUA: click simulator Close, then Laika fact button | wind panel count 0; `Woof! Satellites track fires from space.` visible | **verified** |
| API on :8787; `E2E_ORIGIN=http://127.0.0.1:8787 npm run e2e` | erroneous exit 0; 73 true / 102 recorded assertions, 29 false; fatal null `.focus()` | **partial**; complete sweep still cannot finish |

The full browser report retains its failures in `docs/e2e-report.json`: Watch/Atlas expectations,
missing live geometry in store-derived exports/metrics, country search/state cases, and network/
console checks. These occurred in the baseline too (72 true / 102, 30 false, same fatal `.focus()`).
Passing integration checks do not certify these paths or repair the malformed sensor metadata.
No freshness tolerance, assertion, or secret-scan rule was relaxed. No raw data was refreshed or
bundle rebuilt. Deployment is checked separately after pushing; these are local results.

### Render runtime packaging

After integration commit `cbf3ecf`, the Render origin served the exact local entry
`index-B7CDkrgM.js` and emitted worker (`200`, JavaScript MIME, GIBS allowed by CSP).
`GET https://continuum-6ofw.onrender.com/api/v1/ready` returned **503**, with eight missing
manifest assets: `tle/satellites.txt` and all seven `textures/earth_*.jpg` entries. These files
are tracked and copied into the built static app, but the Docker runtime stage copied only
`public/data`. The runtime image now also copies `public/tle` and `public/textures`, retaining
the existing integrity checks and manifest hashes. The host readiness failure is **verified**;
the following redeploy is verified separately after pushing this packaging change.

## 2026-11-15 Laika polish and final feature audit

Base `f2a9e58`; `git fetch origin` confirmed HEAD and origin/main identical before publishing.
Laika now uses the requested ambient/directional/spot lights and an alpha canvas with no
background, border or shadow on its fixed wrapper (20 px bottom/right, z-index 9999).
Its model floats with a sine wave; the reduced-motion setting stops this movement. The
uncompressed GLB uses GLTFLoader directly, avoiding an unnecessary WASM decoder under the
strict script policy. GLB textures use blob fetches, now permitted by connect-src. Script
execution remains restricted to self. The model credit and keyboard fact button remain.
The wind panel moves to the upper right to keep its Close button clear of the companion.

The audit reproduced a zero-data defect: the former realtime alignment shifted observations
to today's date and threw on malformed sensor dates. It now preserves the stored pilot and
country acquisition dates, windows, aggregates and generation time. Snapshot loading no
longer discards valid points through that date-shifting path. No data was re-downloaded,
promoted or regenerated; the November 14 bundle and its hashes remain unchanged.

Community's anomaly checkbox and post type now agree, including API normalization and
previously checkbox-flagged posts. Verification opens Alert Center, announcement timestamps
are formatted as dates, the method link works, and form fields have accessible labels.
Community is included in hash restoration. Community verification is explicitly distinct
from official NASA verification. Developer key requests use the configured/local origin;
keys remain in browser memory, and protected browser requests acquire a key after a 401.
Issuance stays public after the first key, while data requests still enforce registered keys.
Configured CORS clients may send x-api-key. Copy awaits the clipboard and reports success
or failure; keys wrap without ellipsis. Every language example now includes its auth header.
APP_DATA_PATH allows the tests and local audit to isolate runtime posts/keys from normal data.
Laika is hidden when printing; Brief's primary actions say Print Brief and Export CSV.

| Command or action | Output | Status |
| --- | --- | --- |
| Baseline `npm ci` | exit 0; 172 added, 173 audited; two known build-tool advisories | **verified** |
| Baseline `npm run build`; `npm test` | exit 0; 1,024 modules; 219 passed, 0 failed, 4 skipped | **verified** within executed cases |
| Preview on :4174; baseline `npm run e2e` | 73 true / 102 recorded, 29 false, fatal null `.focus()`; erroneous exit 0 | **partial** |
| Final `npm run build` | exit 0; entry `index-Dab97m8q.js`; 17.22 s | **verified** |
| Final `npm test` | exit 0; 229 total, 225 passed, 0 failed, 4 skipped; regression coverage for immutable observation dates, key issuance/auth/CORS and anomaly announcements | **verified** within executed cases; skipped live-key cases **not verified** |
| `npm run smoke` | exit 0; 49/49 | **verified** |
| `node --check server/api.mjs`; `node --check server/community-store.mjs`; `git diff --check` | exit 0 | **verified** |
| `npm run validate` | 22/23; existing VIIRS-SNPP envelope remains `9999-99-99..0000-00-00` | **verified** failure; metadata repair remains a gap |
| Post-fix preview `npm run e2e` | 76 true / 102 recorded, 26 false, same fatal null `.focus()` and erroneous exit 0 | **partial**; full legacy suite remains incomplete |
| CUA: Orbital Watch rendering and Laika fact button | textured dog without box; globe, legend, differently scaled FRP points; 55,608 stored detections; data through November 14; fact displayed | **verified** for observed desktop view |
| CUA: Atlas fire dot and Close | selected -28.1810, -67.2978; wind panel shows NE (45 degrees), 12 m/s and Simulation; Close removes it | **verified** |
| CUA: local Community post, anomaly checkbox, Verify | TEST ONLY post created in isolated runtime; type becomes Data anomaly; verified banner and Alert Center open with the report | **verified**; announcement date formatting correction compiled and checked separately |
| CUA: Developers Generate API key, Copy, return to Community | local API base; 36-character key shown; clipboard matches; Key copied status; feed remains available; no credential output recorded | **verified** |
| CUA: Brief Export CSV and Download PDF; local file inspection | CSV 802,187 bytes / 9,510 data rows through 2026-11-14, sensor/CI/provenance columns; PDF 3,107 bytes, percent-PDF-1.4 header and EOF trailer | **verified** |
| CUA: Print Brief | input timed out; no print preview captured; computer control stopped because the active browser URL could not be confirmed | **partial**; actual print preview and physical printing **not verified** |
| Legacy e2e Diagnosis sandbox and Outlook | both sandbox response/resample checks true; analog charts and NASA POWER weather checks true | **verified** for automated cases; separate manual diagnosis/outlook inspection **not verified** after computer control stopped |
| LiveMap cleanup: `rg -n 'console\.log|Loaded Fires|Local Fires' src/components/LiveMap.tsx` | no matches; tuple index 5 retained | **verified** |

The full application audit is **partial**, not a certification that every feature passes.
`docs/e2e-report.json` retains the legacy failures, including Watch controls, complete-calendar
expectations, GeoJSON export, share/keyboard paths and country selection/state. Some selectors
refer to replaced UI, but the whole set has not been reconciled, and no assertion was relaxed.
The original freshness validation failure is still recorded. Community reload and manual
Diagnosis/Outlook/Method checks were not completed after browser control stopped. No production
test post or audit key was created. Local audit artifacts/keys are ignored and excluded from
the publishable-file scan. Release scan and deployment results are recorded below after execution.

Release checks: `npm audit --omit=dev --audit-level=high` reports 0 vulnerabilities (**verified**).
The complete-workspace secret scan reports the ignored local `.env` by presence only; it also
flagged a synthetic invalid-key literal, which was shortened to an obvious test value. No secret
was read or emitted. `SECRET_SCAN_ROOT` set to a scratch copy of all publishable working files
plus dist/dist-server reports **clean**, 201 files / 17.4 MB (**verified** within that scope).
Runtime credentials and the ignored local environment are excluded from the release.

### Large live feed follow-up

Local server shutdown exposed `[live] refresh failed: Maximum call stack size exceeded`.
The provider merged a global CSV with `all.push(...tuples)`, exceeding the engine's argument
limit. `node --test tests/live-volume.test.mjs` reproduced this with 180,000 synthetic points:
exit 1, live response 503 instead of 200 (**verified** failure). The provider now appends
points in a loop. The same command returns exit 0, all 180,000 points with unchanged
acquisition timestamps, sensor count and date bounds (**verified**). The test copies the
exact provider into an isolated temporary root, so its synthetic cache cannot enter data_raw
or the production application. No upstream credentials or network are used by that test.

The deployed polish commit `addf32d` was **verified** at Render: entry `index-Dab97m8q.js`
matches the local asset byte for byte; `/api/v1/health` and `/api/v1/ready` both return 200,
with integrity true for 20 files. The live-feed follow-up is published and checked separately.

After the volume fix, `npm run build` exits 0 (16.29 s, same entry), and `npm test` exits 0:
230 total, **226 passed / 0 failed / 4 skipped** (**verified** for executed cases).

## 2026-11-15 Final wind, Laika and Alert Center changes

Base `8a33e4e`; `git fetch origin main` and `git rev-list --left-right --count
main...origin/main` returned `0 0` before publishing. Laika's model wrapper now supports
pointer capture, touch dragging and keyboard movement; the speech bubble moves with it and
the projected tether stays anchored to the viewport corner. The visible model attribution
and chat text were removed. Model provenance remains in NOTICE.

Wind requests use the clicked detection's coordinates. An explicitly selected past date
uses NASA POWER's WS10M/WD10M daily reanalysis; current selections use Open-Meteo's current
10 m forecast. POWER m/s is converted to km/h, north/360 degrees and calm wind are handled,
and provider failures produce an error/retry state rather than invented readings. Historical
days without individual detection geometry offer wind at the clearly labelled area center.
The production CSP permits both providers. These products are labelled forecast/reanalysis.

Alert Center fetches `/api/v1/community/feed` and `/api/v1/live-firms`. Only explicitly verified
anomaly posts enter the report list. High-FRP alerts are computed from actual detection tuples
for the selected area and seven pilot regions, grouped by observed day, newest first, at a
stated inclusive 50 MW threshold. Point counts are detections, not separate fires. The drawer
labels the bundled snapshot or stale fallback when the latest feed cannot be obtained.
Copy/download actions export the measured report; Atlas navigation selects its observed date.
The prior simulated dispatch and analog forecast surfaces were removed from this drawer.

| Command | Output / scope | Status |
| --- | --- | --- |
| `npm ci` | initial EPERM from the project's running preview holding esbuild.exe; after restarting that preview, 172 packages installed, exit 0; 2 known toolchain advisories | **verified** |
| Baseline `npm run build`; `npm test` | exit 0; 1,028 modules; 237 total / 233 passed / 0 failed / 4 skipped | **verified** for executed cases |
| Baseline `npm run e2e`, preview on :4174 | 76 true / 102 executed; aborted at the legacy null `.focus()` selector | **partial**; known unrelated UI expectations retain failures |
| `npm run api:build` → `npm run bundle` → `npm run build` | exit 0; bundle `continuum-2026-11-14-58d98f95f252`; only manifest created_at moved, so no golden recapture; final build 1,030 modules, 15.15 s, zero TypeScript errors, entry `index-kHhWYiPO.js` | **verified** |
| Final `npm test` | 249 total / 245 passed / 0 failed / 4 skipped; provider selection, units, fill values, cancellation, HTTP errors, measured FRP and verified-post filtering | **verified** for executed cases; keyed live cases **not verified** |
| `node scripts/e2e-final-polish.mjs` against API on :8787 | 10/10; real UI and bundled detection geometry; isolated browser response fixtures for wind/community, no server posts written; pointer drag/tether, keyboard bubble, verified report filtering, clicked-fire loading/current wind, historical date/units, error/retry, CSP | **verified** within this scope; `docs/final-polish-e2e-report.json` |
| Provider GETs using curl, parsed with `parseWind` | Open-Meteo 200: 5 km/h from 314 degrees at 2026-11-15T06:30 UTC; POWER for 2022-01-01 at -29.2/-67.5: 200, WS10M 2.97 m/s → 10.692 km/h, WD10M 198 degrees | **verified**; `docs/wind-provider-report.json` |
| `npm run validate` | exit 1, 22/23; unchanged VIIRS-SNPP freshness sentinel `9999-99-99..0000-00-00`; all 20 manifest files and all 10 dist/data files match | **partial**; existing metadata gap retained, no assertion relaxed |
| `npm run smoke` | exit 0, 49/49 including readiness, API contracts and security headers | **verified** |
| `npm run secret-scan` | exit 1; ignored local .env reported by presence only, no contents read or printed | **partial** for whole workspace |
| `SECRET_SCAN_ROOT=<temporary copy of git publishable files plus dist/dist-server>`; `npm run secret-scan` | exit 0, 210 files / 17.5 MB, clean; ignored runtime credentials excluded | **verified** for release scope |
| `git diff --check` | exit 0 | **verified** |

The repository-wide browser audit remains **partial**. Its old Alert Center assertions were
updated to require observed FRP, date, provenance and report copy/download because that product
behavior was explicitly replaced; other failing legacy assertions were not relaxed. The
freshness metadata failure is an existing release gap and will also affect the CI validation
step. Build/test success does not certify that gate. No live/archive data was regenerated and
no keyed backfill was run. Render results are recorded after publishing below.

### Publication continuation — 2026-11-15

The interrupted final-polish task resumed on the same base. `git fetch origin main` followed
by `git rev-list --left-right --count main...origin/main` returned `0 0` again.

| Command | Output / scope | Status |
| --- | --- | --- |
| `npm run build` | exit 0; zero TypeScript errors; entry `index-kHhWYiPO.js`; Vite 68 s with an older browser sweep still running | **verified** |
| `npm test` | retry exit 0; 249 total / 245 passed / 0 failed / 4 skipped, 13.05 s; first run had one local ECONNRESET while the old sweep was running | **verified** for executed cases |
| `node scripts/e2e-final-polish.mjs`, API on :8787 | retry exit 0; 10/10; first run timed out while the build and old sweep overlapped; rerun after build completion and stopping the stale sweep | **verified** for focused fixture scope |
| `npm run validate` | exit 1; 22/23; existing VIIRS-SNPP sentinel failure; all 10 built data files match | **partial** |
| `npm run smoke` | exit 0; 49/49 | **verified** |
| `SECRET_SCAN_ROOT=<temporary checkout of the staged release plus dist/dist-server>`; `npm run secret-scan` | exit 0; 211 files / 17.5 MB; clean | **verified** for release scope |
| GET Render `/` before push | HTTP 200; old entry `index-BykkYhYB.js` | **verified** for old deployment; new release **not verified** yet |
| `git commit -m "Final Polish: Draggable Laika, clean attribution, real Wind API integration, and Alert Center overhaul"`; `git push origin main` | exit 0; `8a33e4e..254a683` published to main | **verified** |
| GET Render `/`, `/assets/index-kHhWYiPO.js`, `/api/v1/health`, `/api/v1/ready` after push | all HTTP 200 at 2026-11-15T07:06:01Z; asset SHA-256 matches the local build; readiness integrity `{ok:true,bad:[],files:20}` | **verified**; `docs/render-final-polish-report.json` |

## 2026-11-15 Workspace Cook skill installation

Installed `Leonxlnx/cook` at `.agents/skills/cook`, from commit
`b23cac6fd9439dfddcab61b14808e7bf72549b46`, using the skill-installer helper with
`--repo Leonxlnx/cook --path . --name cook --ref b23cac6fd9439dfddcab61b14808e7bf72549b46`.
The helper downloaded into temporary staging before the directory was moved into this workspace.

| Command | Output / scope | Status |
| --- | --- | --- |
| `npm ci` | initial esbuild/Rollup EPERM locks; temporarily stopped and restored the workspace preview on :4174; retry exit 0, 172 packages installed, 2 toolchain advisories | **verified** |
| `npm run build` | exit 0, 1,030 modules, Vite build 15.00 s | **verified** |
| `npm test` | exit 0, 249 total / 245 passed / 0 failed / 4 skipped | **verified** for executed cases |
| `npm run e2e` against preview on :4174 | exit 0 but 76 passed / 26 failed / 102 executed, then aborted at the existing null `.focus()` selector; static preview also returns 404 for `/api/v1/live-firms` | **partial**; matches the previously recorded baseline gaps |
| Python source-integrity comparison against the GitHub tree | all 12 downloaded files have matching Git blob SHA-1 hashes | **verified** |
| `node --check .agents/skills/cook/scripts/side-by-side.mjs` | exit 0 | **verified** |

The pre-existing `docs/e2e-report.json` was restored byte for byte after this baseline run.
The skill's screenshot comparison helper has not been executed; its ffmpeg integration is
**not verified**. Application source and data were not changed for this installation.

## 2026-11-15 Local Cook UI upgrade and autonomous Laika

All edits are local and uncommitted. HEAD remains `705f75282b0f7ae05ce4cec3620dea5ddc4eb572`.
No push, deployment or publishing was performed. Cook's accepted 90-minute cap ended design work;
stills are ready for review and no video render was started. The complete local ledger is
`cook/ROUNDS.md`; the 90-point visual target remains **partial**, with typography/mobile density gaps.

| Command / observation | Output / scope | Status |
| --- | --- | --- |
| `npx skills add Leonxlnx/cook --global --agent codex --yes`; Codex skill-installer helper | exit 0; installed at both home `.agents/skills/cook` and `.codex/skills/cook`; latter SKILL.md existence true | **verified** |
| `node --version`; `ffmpeg -version` | v24.19.0; Gyan FFmpeg Essentials 9.0.1 installed via winget, version command exit 0 | **verified** |
| Baseline `npm ci`; `npm run build`; `npm test` | install exit 0 after releasing preview lock; build exit 0, 1,030 modules; 245 passed / 0 failed / 4 skipped | **verified** for executed cases |
| Baseline `npm run e2e`, preview :4174 | script exit 0 but 76/102 then existing null focus exception; report preserved at `cook/baseline-e2e-report.json`, original docs report restored | **partial** |
| Final `npm run build` | exit 0; 1,030 modules; 17.60-second Vite build; zero TypeScript errors | **verified** |
| Final `npm test` | 249 total; 245 passed / 0 failed / 4 skipped; `.cook-final-tests.log` | **verified** for executed cases |
| Foreground browser observation on local dev :5173, real wall clock | Laika mounted observed 559ms after reload; no click/key input; fact observed at 46,335ms, absent by 55,593ms; source cadence 45,000ms and hide timeout 10,000ms; `cook/laika-timing.json` | **verified** within this foreground cycle |
| Browser area/map/globe observations | Nepal heading and computed metrics updated; MapLibre zoom with real bundled 52-point snapshot; five satellite controls and Terra focus/details; Laika keyboard moved 20px; no desktop/mobile viewport overflow; `cook/ui-verification.json` | **verified** within tested paths |
| Cook `side-by-side.mjs` through Node/ffmpeg | Before/After desktop and mobile images emitted for both rounds in `cook/compare/` | **verified** |
| WCAG luminance calculation on named palette pairs | 17.67:1 body, 8.38:1 supporting text, 6.16:1 dim text, 8.34:1 primary action; `cook/color-check.json` | **verified** within named opaque pairs; overall accessibility **partial** |
| `git diff --check` | exit 0 | **verified** |

Timer interval and pending hide timeout are cleared by effect cleanup; drag pointer capture and
keyboard movement remain implemented. An instrumented unmount/StrictMode test, background-tab
cadence, final full legacy e2e and full light/high-contrast/reduced-motion sweep are **not verified**.
Browser timers may be throttled in background tabs. No data, analytics or scientific labels were
regenerated. The local dev server proxies `/api` to the existing API on :8787.

### Cook release approval — 2026-11-15

The user reviewed and approved the UI, autonomous Laika and responsive navigation, explicitly
authorized `git add .`, the supplied Final Release commit and `git push origin main`, and
requested Render verification. This supersedes the initial local-only restriction. The final
Cook video is waived; stills are the approved visual deliverable. Historical local-only statements
above apply to the review stage. Existing validation and legacy e2e gaps remain **partial**.

`git fetch origin main` and `git rev-list --left-right --count HEAD...origin/main`: exit 0,
`0 0`, **verified** before staging. No application or data changes were made after the approved
build/test/browser evidence; release bookkeeping and privacy cleanup only.

`git diff --cached --check`: exit 0, **verified**. Secret scan against a temporary checkout
of every staged release file plus `dist` and `dist-server`: exit 0, 232 files / 17.7 MB,
0 findings, **verified** for publishable scope. Ignored local runtime credentials were excluded
without changing the scanner rules. Baseline report temporary download paths were redacted;
the untouched original remains in an ignored local log.

### Predictive Risk Dashboard — 2026-11-15 (local review)

The model implementation described in this initial review was superseded by the archive-only
correction below. This section retains the evidence for the first implementation.

Outlook now begins with a 30-day calendar and Historical Pattern Insights. The existing analog
seasons, four-week departure, season clock and NASA POWER panels remain below them. No data bundle
was regenerated and no commit or push was performed for this change.

`src/lib/prediction.ts::predictFutureRisk` uses the selected area's existing harmonized daily
record. That record already incorporates `public/data/archive_daily.json` through `loadLiveBundle`
and the archive coverage/constellation correction layer. Archive gaps remain explicitly labelled
deterministic reconstruction, calibrated to the FIRMS window; the new model does not describe the
whole 26-year series as raw observed archive. An unknown region ID never borrows another region.

The model holds out the current year, groups month/day on a leap-year template, and computes the
mean and interpolated P90 within each day-of-year bin. Calendar colours compare the expected
daily count with the mean and P90 **across the seasonal daily means**. This avoids comparing a
day's expectation to its own upper-tail statistic as though that were an independently forecast
count. The within-day P90 is shown separately in the inspector. High plus daily maximum 10 m wind
strictly above 20 km/h becomes Critical. Wind only joins exact dates within the first seven UTC
days; later dates remain climatology-only. Neither a missing wind value nor an absent history
sample becomes zero. Three samples per non-leap calendar day across a full seasonal cycle are
required to rank risk. Monthly insights exclude incomplete months. Historical activity frequency
is explicitly a property of the training record, not a calibrated probability of ignition.

| Command / evidence | Output | Status |
| --- | --- | --- |
| Baseline `npm ci` | exit 0, 172 packages added; two existing dependency advisories | **verified** |
| Baseline `npm run build` | exit 0, zero TypeScript errors; `.outlook-baseline-build.log` | **verified** |
| Baseline `npm test` | 249 total, 245 passed, 0 failed, 4 skipped; `.outlook-baseline-test.log` | **verified** for executed cases |
| Baseline `npm run e2e` against preview :4174 | 75/102 before `Cannot read properties of null (reading 'focus')`; `.outlook-baseline-e2e-report.log` | **partial** |
| Final `npm run build` | exit 0, zero TypeScript errors; `.outlook-build.log` | **verified** |
| Final `npm test` | 260 total, 256 passed, 0 failed, 4 existing skips; `.outlook-test.log` | **verified** for executed cases |
| `node scripts/e2e-outlook.mjs` against production API :8787 | 18/18; fixed peak-season clock and explicit Open-Meteo fixtures; `docs/outlook-e2e-report.json` | **verified** for tested paths |
| Real `fetchWindForecast(-29.1667, -67.5)` through the built analytics module | 7 Open-Meteo days, 2026-11-15 to 2026-11-21; first 9 km/h from 336°, last 10.7 km/h from 175° | **verified** for this provider request |
| `npm run validate` | 22/23; existing VIIRS-SNPP freshness envelope `9999-99-99..0000-00-00` lies outside stored window `2026-11-07..2026-11-14`; all 20 manifest files and all 10 dist data files match; `.outlook-validate.log` | **partial** |
| `npm run smoke` | 49/49; `.outlook-smoke.log` | **verified** |
| `npm run secret-scan` | exit 1; 517 files scanned, only finding is the existing ignored `.env` file's presence, 0 unscanned; `.outlook-secret-scan.log`. The scanner never reads `.env` contents. | **partial** |
| `E2E_ORIGIN=http://127.0.0.1:8787 npm run e2e` | 77/102 before the same null-focus exception; both legacy Outlook checks passed; `.outlook-e2e-report.json.log` | **partial** |

The focused browser suite covers all 30 dates, the seven-day wind boundary, Critical classification,
explanation contents, preservation/order of existing features, click/keyboard selection, mobile
fit, reduced motion, light theme, HTTP failure, stale dates, retry, rapid region changes, CSP and
absence of runtime exceptions. Desktop/mobile screenshots were inspected at
`.shots/outlook-desktop.png` and `.shots/outlook-mobile.png`; these show **test fixture winds and
a fixed date**, not actual weather. A held-out skill evaluation of this new climatology model,
regional wind representativeness and calibrated ignition probabilities are **not verified**.
The four existing skipped unit cases concern the optional live-feed HTTP service.

The broad e2e failures already occur before these changes, spanning older Watch, Atlas, navigation
and country-metric checks. The script catches its fatal exception and exits 0, so the report's
failure is recorded here rather than treating the process exit as success. The unchanged snapshot
freshness metadata and existing local `.env` were left in place. Original generated broad reports
were restored after retaining this run's output in the named ignored logs. No check was softened.

### Archive-only predictive risk correction — 2026-11-15 (local review)

The calendar now subscribes directly to `useStore().region`. `Outlook.tsx` no longer passes the
general-purpose record into it. Its independent loader fetches only `public/data/archive_daily.json`;
the predictor selects the exact `regions[region.id]` block. It never calls `getRecord`, the
reconstruction, live-window calibration or a country/pilot alias. An unavailable file or unmatched
ID produces **No Data Available**. The user can explicitly select an available archive area from
that state; the UI never silently substitutes it for a country border or custom area.

The decoder uses the file's `start` date and per-sensor coverage ranges. Covered days omitted from
the sparse tuples are observed zeros; uncovered dates are absent. Each published sensor contributes
its raw count once. Overlapping ranges and identical duplicate tuples cannot double counts;
conflicting or invalid counts exclude the affected day. These are **raw sensor detections**, not
unique fires or harmonized counts. The method panel names this unit and the limitation that changing
sensor availability affects comparisons across years. No reconstructed value enters this model.

The prior-year holdout, leap-day separation, DOY means/P90, seasonal colour thresholds and strictly
greater-than-20 km/h Critical gate are retained. Wind is joined to exact dates within seven days;
days 8–30 remain climatology-only. Insights use complete observed months and state the number of
eligible and missing years in the previous 20-year window. Every calendar cell now displays its
expected count, so two areas can have visibly different predictions even when both classify Low.

Current-date browser evidence, from the real archive and the actual **Change area** controls:

| Archive area | 2026-11-15 mean | DOY P90 | Computed peak month | November years with activity, 2006–2025 |
| --- | ---: | ---: | --- | --- |
| Nepal | 85.0 | 243.5 | April | 20 / 20 |
| California | 119.6 | 350.5 | August | 20 / 20 |
| Chilecito | 2.6 | 5.5 | August | 19 / 20 |

All three histories contain 9,192 observed dates before 2026. Nepal and California both classify
Low in the current 30-day window, with different daily counts. Chilecito has a different mixture
of Low/Moderate/High dates before applying forecast wind. `country-nepal` has no exact key in the
archive and is **No Data Available**, rather than borrowing the larger Nepal pilot bounding box.

| Command / evidence | Output | Status |
| --- | --- | --- |
| Baseline `npm ci` | First attempt hit the existing preview's esbuild lock; after stopping that preview/helper, retry exited 0 and preview was restarted | **verified** |
| Baseline `npm run build`; `npm test` | exit 0; 256 passed, 0 failed, 4 existing skips | **verified** for executed cases |
| Baseline `npm run e2e` against preview :4174 | 77/102 before the existing null-focus exception; `.outlook-fix-baseline-e2e-report.log` | **partial** |
| Final `npm run build` | exit 0; zero TypeScript errors; Vite 9.57 s; `.outlook-fix-build.log` | **verified** |
| Final `npm test` | 262 total; 258 passed, 0 failed, 4 existing skips; `.outlook-fix-test.log` | **verified** for executed cases |
| `node scripts/e2e-outlook.mjs` against production API :8787 | 34/34; `docs/outlook-e2e-report.json` | **verified** for tested paths |
| `npm run validate` | 22/23, exit 1; same pre-existing invalid VIIRS-SNPP freshness envelope; all shipped hashes and dist/data parity verified; `.outlook-fix-validate.log` | **partial** |
| `npm run smoke` | 49/49, exit 0; `.outlook-fix-smoke.log` | **verified** |
| `npm run secret-scan` | exit 1; 535 files, one finding for the existing ignored `.env` presence, 0 unscanned; `.outlook-fix-secret-scan.log` | **partial** |
| `E2E_ORIGIN=http://127.0.0.1:8787 npm run e2e` | 77/102 before the same baseline null-focus exception; both legacy Outlook checks passed; `.outlook-fix-final-e2e-report.log` | **partial** |
| `git diff --check` | exit 0 | **verified** |

The focused suite uses the shipped archive for every browser calculation. Its threshold and failure
checks use a peak date derived from the archive and explicit wind fixtures. The final three checks
remove the test clock and provider interception, select Nepal, California and Chilecito through the
top bar, and compare the displayed date, mean, P90 and insights to the archive. Forecast retrieval
may still be pending during those current-date checks; live wind across all three areas is **not
verified** by them. Threshold, horizon, failure, retry and stale-response behavior is **verified**
with fixtures. Archive HTTP failure, retry, exact-key no-data behavior, and independence from a
failed live-record fetch are also covered. Screenshots inspected: `.shots/outlook-nepal-today.png`,
`.shots/outlook-california-today.png`, `.shots/outlook-mobile.png` (the mobile capture uses fixture
wind and a test date).

In-app browser control was **blocked** by helper initialization (`failed to write kernel assets`,
OS error 3) on both attempts, so it could not refresh the user's already open tab. The separate
automated Chrome checks above ran successfully. The archived series and all broader app records
remain unchanged. Nothing was committed or pushed.

### Community Hub, geocoding and Discord — 2026-11-15 (local review)

The Community feed now has a centered 760px column, location search with debounce and stale-response
protection, optional manual coordinates, persisted polls, source badges, and server-derived satellite
status. The companion is hidden on narrow Community screens after screenshots showed it covering
poll content. The Developer Portal's shared `PageHeader` export is preserved with an explicit React
type import.

Reports are checked against the stored `live_fires.json` detection tuples using a 15 km Haversine
radius. A matched report includes distance and acquisition date; the UI explains that nearby stored
evidence does not independently confirm the report or current conditions. Client source, vote totals,
and verification flags cannot set these fields. The old manual Verify action is removed; the existing
API recheck route recomputes evidence and does not duplicate announcements.

The requested `data/community.json` was deleted and regenerated as `[]` (previously 65 posts).
The focused browser run uses an isolated temporary database, and the unit/API fixtures are isolated
as well. After verification the user's database still contains zero posts. Other local data and
existing API credentials were preserved. No archive, live bundle, or scientific record was rebuilt.

Discord outbound delivery uses a server-only webhook, disables mention notifications, times out after
five seconds, and cannot turn a saved report into a failed submission. Inbound sync requires its own
server secret, sets `source: discord`, checks the same satellite evidence, and never echoes a report
back to Discord. Missing configuration returns 503; wrong/missing credentials return 401. The API
contract test explicitly checks that disabled-service response. Live channel delivery is **not
verified** because Discord credentials are not configured. Unit tests intercept outbound requests;
the inbound endpoint and rendered Discord report are **verified** with an isolated local relay request.

| Command / evidence | Output | Status |
| --- | --- | --- |
| Baseline `npm ci` | exit 0; `.community-baseline-install.log` | **verified** |
| Baseline `npm run build`; `npm test` | exit 0; 258 passed, 0 failed, 4 existing skips; baseline build/test logs | **verified** for executed cases |
| Baseline `npm run e2e` against preview :4174 | 77/102, existing null-focus exception; `.community-baseline-e2e-report.log` | **partial** |
| Final `npm run build` | exit 0; zero TypeScript errors; Vite 9.11 s; `.community-build.log` | **verified** |
| Final `npm test` | 275 total; 271 passed, 0 failed, 4 existing skips; `.community-test.log` | **verified** for executed cases |
| `node scripts/e2e-community.mjs` with `npm run dev -- --strictPort` on :5173 | 23/23; `docs/community-e2e-report.json`; no browser runtime exceptions | **verified** |
| `npm run smoke` | 49/49, exit 0; `.community-smoke.log` | **verified** |
| `npm run validate` | 22/23, exit 1; existing VIIRS-SNPP `9999-99-99..0000-00-00` freshness error; 10 dist/data files match; `.community-validate.log` | **partial** |
| `npm run secret-scan` | exit 1; 558 files, one finding for existing ignored `.env` presence, 0 unscanned; `.community-secret-scan.log` | **partial** |
| `E2E_ORIGIN=http://127.0.0.1:8787 npm run e2e` | 77/102, same baseline null-focus exception; `.community-final-e2e-report.log` | **partial** |
| `git diff --check` | exit 0 | **verified** |

The focused browser checks use the real Open-Meteo search: Biratnagar, Nepal resolves to
26.45505, 87.27007 and its saved anomaly is Pending against this stored FIRMS window. Tests create
a poll, vote, repeat a vote, change choice, refresh, and reload to verify backend persistence. They
also check incomplete coordinates, a confirmed report at an actual stored detection, an authenticated
Discord relay report, filters, desktop centering, 390px mobile layout, mobile companion overlap,
provider failure, delayed search races, keyboard selection, and clearing a stale selected location.
Only provider error/race cases use explicit fixtures; no live Discord message was sent. Screenshots
inspected: `.shots/community-desktop.png` and `.shots/community-mobile.png`.

Changed files for this task (earlier Outlook edits remain intact):

- `.env.example`
- `docs/api.md`
- `docs/validation.md`
- `docs/community-e2e-report.json`
- `scripts/e2e-community.mjs`
- `server/api.mjs`
- `server/community-store.mjs`
- `server/community-integrations.mjs`
- `src/lib/geocoding.ts`
- `src/pages/Community.tsx`
- `src/styles.css`
- `tests/api.test.mjs`
- `tests/coder-live.test.mjs`
- `tests/community-auth.test.mjs`
- `tests/community-model.test.mjs`

Ignored local state reset: `data/community.json`. Generated build output and task logs are local.
The dev server is running at `http://127.0.0.1:5173/#/community` with the regular API on :8787.
Nothing was committed or pushed.

### Laika lighting, image attachments and live Gemini/Discord bridge — 2026-11-15

Laika now uses ambient intensity 1.5, directional intensity 3 and spot intensity 2, with local
generated environment reflections. No external HDR request is needed. The inspected desktop
capture `.shots/community-images-and-laika.png` shows a bright suit and visible face texture.

Web composition uses FileReader, an image preview/removal control and validated PNG/JPEG/WebP
attachments up to 4 MiB (24 megapixels in the browser). Image data URLs persist in the JSON store
and render in the feed. The report routes accept the Base64 envelope without increasing scientific
API limits. Discord multipart embeds reference attached image bytes. Web delivery uses an optional
webhook or the configured bot/channel. Incoming `author` and legacy `name` are supported; stable
Discord message IDs deduplicate retries. Existing posts and earlier Outlook changes are preserved.

The bot is runnable with `npm run discord:bot`. It selects one server text channel, ignores bot
and webhook messages, limits queued work, sends original text/image content to Gemini, and resolves
only unique named places or explicitly supplied coordinates. Gemini classifies relevance; the server
alone derives satellite status. Unresolved named places remain visible with no coordinates and a
Pending badge. The page refreshes every 15 seconds while visible and on returning to the tab.
Poll voting, repeat-click idempotency, choice changes and persistence remain **verified**; optional
poll-result announcements are not enabled.

User-supplied credentials and channel configuration were stored only in the ignored local `.env`.
The loader reads an allowlist of integration settings and preserves exported environment values;
it cannot change unrelated data-bundle settings. The initial Gemini 2.5 Flash request returned 404
with a retired-for-new-users response. Model discovery and live requests identified
`gemini-3.1-flash-lite` as available; it is the configured default. The live check subsequently
verified both text and image input. No credential values or raw SDK errors were logged.

| Command / evidence | Output | Status |
| --- | --- | --- |
| Baseline `npm run e2e` against running preview | 77/102, same existing null-focus exception; `.bridge-baseline-e2e-report.log` | **partial** |
| Baseline `npm ci`; `npm run build`; `npm test` | exit 0; baseline build 8.55 s; 271 passed, 0 failed, 4 existing skips; `.bridge-baseline-*.log` | **verified** for executed cases |
| `npm install discord.js @google/generative-ai` | exit 0; 25 packages added; installed 14.28.1 / 0.24.1; `.bridge-install.log` | **verified** |
| Final `npm run build` | exit 0, zero TypeScript errors, Vite 9.50 s; `.bridge-build.log` | **verified** |
| Final `npm test` | 291 total; 287 passed, 0 failed, 4 existing skips; `.bridge-test.log` | **verified** for executed cases |
| `node scripts/e2e-community.mjs` against `npm run dev -- --strictPort` | 30/30, no runtime exceptions; `docs/community-e2e-report.json` | **verified** |
| `npm run discord:check` | Discord login/channel permissions verified; Gemini 3.1 Flash Lite text/image analysis verified; 0 messages sent; `.bridge-connectivity.log` | **verified** |
| `npm run api`; `npm run discord:bot` | API :8787 integrity PASS; bot emitted listening confirmation for the user-specified channel | **verified** for startup |
| `npm run smoke` | 49/49, exit 0; `.bridge-smoke.log` | **verified** |
| `npm audit --omit=dev --json` | 0 production vulnerabilities; `.bridge-audit.log` | **verified** |
| `npm run validate` | 22/23, same existing VIIRS-SNPP freshness range failure; all 10 dist/data files match; `.bridge-validate.log` | **partial** |
| `npm run secret-scan` | 582 files, 1 finding for ignored local `.env` presence, 0 unscanned; `.bridge-secret-scan.log` | **partial** |
| Exact credential scan of Git-visible files plus dist/ and dist-server/ | 329 files, 0 matches for the three supplied credentials; `.bridge-credential-scan.log` | **verified** |
| `git diff --check` | exit 0 | **verified** |

The browser suite exercises image selection, decoding, removal, oversize rejection, persisted web
images, incoming Discord image posts appearing without manual refresh, page reload, polls, geocoding
and mobile layout. Boundary tests verify 4 MiB decoded payloads reach storage and larger ones are
rejected. Bot tests cover schema parsing, model failure, attachments, ambiguous geocoding, retries,
duplicates, other channels, loop prevention and replies based on the server's actual satellite status.
Multipart delivery is **verified** with an intercepted transport. Posting a test message into the
live Discord channel and observing a complete round trip is **not verified**; live checks tested
provider access without posting. The real bot is running for user reports.

Files changed in this extension:

- `package.json`, `package-lock.json`, `.env.example`
- `src/components/PetCompanion.tsx`, `src/pages/Community.tsx`, `src/styles.css`
- `server/api.mjs`, `server/community-store.mjs`, `server/community-integrations.mjs`
- `server/community-env.mjs`, `server/community-image.mjs`
- `scripts/discord-bot.mjs`, `scripts/discord-bridge.mjs`, `scripts/e2e-community.mjs`
- `tests/api.test.mjs`, `tests/coder-live.test.mjs`, `tests/community-auth.test.mjs`
- `tests/community-model.test.mjs`, `tests/discord-bridge.test.mjs`
- `docs/api.md`, `docs/discord-bot.md`, `docs/validation.md`, `docs/community-e2e-report.json`

Local ignored configuration updated: `.env`. The dev server, API and bot are running locally.
Nothing was committed or pushed. Setup and deployment notes: `docs/discord-bot.md`.

### Discord buttons/modals and satellite/weather/community verification — 2026-11-15

The running bot now subscribes only to InteractionCreate with the Guilds intent. Startup upserts
only the guild's admin-only `/setup-report` command. An administrator posts the public panel in
its current text channel; members use the four-field incident modal. Each submission is privately
acknowledged before queued network work. Explicit coordinates bypass Gemini; named places are
parsed into comma-separated components and resolved uniquely with Open-Meteo Geocoding. The
live check originally exposed a missing-comma bug for “Biratnagar Nepal”; the extraction prompt
was corrected and the real check now resolves 26.45505, 87.27007. Optional image links produce
validated bounded raster uploads and retain their source URL. Stable interaction IDs deduplicate
API retries. Ordinary messages are ignored, and errors remain private without raw SDK logging.

The API checks satellite tuples within 15 km first and returns early on a match. Otherwise it
requests current Open-Meteo temperature, humidity and wind, with a six-second timeout, metric
unit validation and timestamp checks. Only temperature >30°C AND humidity <30% AND wind >15 km/h
produces `weather_warning`. Other weather or provider failure yields Pending. Current estimates,
provider time and check time are stored; the UI shows orange weather, yellow Pending, green
satellite and blue community badges. Three distinct registered voting keys confirm an anomaly;
repeat votes are idempotent and private voter identities stay out of responses. Human evidence
never inherits the satellite-only legacy `verified` flag or satellite announcements. Poll votes
remain separate. No production provider fixtures or historical summer conditions were introduced.

| Command / evidence | Output | Status |
| --- | --- | --- |
| Baseline `npm ci`; `npm run build`; `npm test` | exit 0; 287 passed, 0 failed, 4 existing skips; `.modal-baseline-install.log`, `.modal-baseline-build.log`, `.modal-baseline-test.log` | **verified** for executed cases |
| Baseline `npm run e2e` against running preview | 77/102, existing null-focus exception; `.modal-baseline-e2e.log`, `.modal-baseline-e2e-report.log` | **partial** |
| Final `npm run build` | exit 0; zero TypeScript errors; Vite 12.31 s; `.modal-build.log` | **verified** |
| Final `npm test` | 312 total, 308 passed, 0 failed, 4 existing skips; `.modal-test.log` | **verified** for executed cases |
| `node scripts/e2e-community.mjs` against the dev server | 34/34, isolated store; `docs/community-e2e-report.json` | **verified** |
| Real `verifyCommunityReport` calls for California desert and London | both Pending under today's weather; `.modal-live-weather.log` | **verified** |
| `npm run discord:check` | real Discord login/channel permissions and Gemini text/image/modal location verified; 0 messages sent; `.modal-connectivity.log` | **verified** |
| `npm run api`; `npm run discord:bot` | API :8787 integrity PASS; guild setup-report registration and interaction-only readiness; `.modal-api.log`, `.modal-bot.log` | **verified** for startup |
| Read back guild commands with Discord REST | setup-report exists, default_member_permissions=8 (Administrator); `.modal-command-registration.log`; 0 messages sent | **verified** |
| `npm run smoke` | 49/49, exit 0; `.modal-smoke.log` | **verified** |
| `npm run validate` | 22/23; existing VIIRS-SNPP malformed freshness range; 10 dist/data files identical; `.modal-validate.log` | **partial** |
| `npm run secret-scan` | 598 files, one finding for ignored local .env presence, zero unscanned; `.modal-secret-scan.log` | **partial** |
| Exact configured credential scan of Git-visible files plus dist/ and dist-server/ | 333 files, zero matches; `.modal-credential-scan.log` | **verified** |
| `git diff --check` | exit 0 | **verified** |

The focused browser comparison used explicit current-weather fixtures: California 34°C/20% RH/
25 km/h rendered High Risk Weather; London 8°C/80% RH/5 km/h rendered Pending. Three distinct keys
changed the badge to Community Verified, and repeat votes were disabled. Actual stored FIRMS
coordinates exercised satellite precedence, while Biratnagar geocoding used the real service.
Images, polling, poll votes, location selection and layout remain covered. Inspected screenshots:
`.shots/community-weather-comparison.png`, `.shots/community-human-confirmed.png`.

Live weather at the checked 2026-11-15T15:30:00Z observation was 7.6°C/56% RH/3.9 km/h at
34,-116 and 10.2°C/91% RH/9.4 km/h at London. Both correctly stayed Pending; a desert location
does not automatically imply today's weather meets the hot/dry/windy thresholds. No regular
community posts or Discord channel messages were created by these checks. The user's earlier
free-text bridge round trip was reported working; a human click-through of the new live Discord
modal is **not verified**. Automated interaction tests verify builders, permissions, private
acknowledgement ordering, queue overflow, coordinates, images, failures and deduplicated forwarding.
Follow `docs/discord-bot.md` to run `/setup-report` and submit the first modal report.

Exact source, test and evidence files changed for this task:

- `scripts/discord-bot.mjs`, `scripts/discord-bridge.mjs`, `scripts/discord-interactions.mjs`, `scripts/e2e-community.mjs`
- `server/api.mjs`, `server/community-store.mjs`, `server/community-integrations.mjs`, `server/community-image.mjs`
- `src/pages/Community.tsx`, `src/styles.css`
- `tests/community-auth.test.mjs`, `tests/community-weather.test.mjs`, `tests/discord-interactions.test.mjs`, `tests/helpers/community-api.mjs`
- `docs/api.md`, `docs/discord-bot.md`, `docs/validation.md`, `docs/community-e2e-report.json`

Earlier Outlook, Laika and other local changes remain intact. Scientific data was not refreshed.
Existing generated validation and smoke reports were restored byte-for-byte after these checks;
this section and task logs record the current results. API, dev server and interaction bot are
running locally. Nothing was committed or pushed.

### Final repository release — 2026-11-15

The remote is now `https://github.com/rickykhulal/continuum-final.git`, branch `main`.
The release adds 14 Laika facts and makes her tether/float/drag use the same screen coordinates.
Startup, live polling and key acquisition have bounded requests; a cached snapshot preserves its
published dates, and unavailable snapshots show Retry. The Developer Portal and OpenAPI expose
regional `GET /outlook?region_id=...` and `POST /community/vote` with `action: "verify"`, preserving
poll votes and the older upvote alias. Render configuration now describes a persistent web/API
service and a separate Discord worker, with server-side environment instructions and Gemini 3.8.

| Evidence | Result | Status |
| --- | --- | --- |
| Baseline npm ci/build/test | exit 0; build 10.89 s; 308 passed, 4 skips | **verified** |
| Baseline browser sweep | 75/102; existing null-focus exception | **partial** |
| Release npm run build | exit 0; zero TypeScript errors; see `.release-build.log` | **verified** |
| First release npm test | 312 passed, zero failed, four existing skips | **verified** for that run |
| Last repeat npm test | 311 passed, one failed, four skips; `class A must limit at 120/min` assertion failed | **partial** |
| node scripts/e2e-release.mjs | 15/15; `docs/release-e2e-report.json` | **verified** |
| npm run validate | 22/23; existing VIIRS-SNPP sentinel freshness range; all ten dist/data files identical | **partial** |
| Gemini 3.8 model discovery | model listed for this account | **verified** for discovery |
| Gemini 3.8 generation check | upstream HTTP 503; Discord login/channel permissions succeeded | **blocked** on provider availability |
| Render deployment | blueprint and Environment-tab instructions prepared; no deployment performed | **not verified** |

The focused browser run covers the fallback toast, missing-snapshot retry, API documentation,
Laika's tether during drag/resize/keyboard movement, and on-demand facts. The screenshot
`.shots/release-laika-tether.png` was inspected. Earlier Community/Outlook checks and their limits
remain recorded above. At the user's deadline instruction, further test debugging and the repeated
broad E2E run were stopped; no check was weakened. The requested commit title refers to the first
312-pass release run; the later rate-limit assertion failure is retained here explicitly.
Scientific data was not refreshed. The local .env and runtime data remain excluded from Git.
