import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { analogDeparture, climateSourceFor, notableSeasons, recordsInRange, seasonClock, seasonLabelFor, twinAnalogs } from '../lib/data';
import { loadWeather, stressBand, type WeatherContext } from '../lib/weather';
import { Badge, ChartTable, Panel, PageHeader, Stat, Empty } from '../components/ui';
import { SeasonDial, TwinChart } from '../components/charts';
import { FutureRiskCalendar } from '../components/FutureRiskCalendar';
import { MONTHS, longDate, nf, pct, riskColor, ordinal } from '../lib/format';

function WeatherStrip({ weather }: { weather: WeatherContext }) {
  const width = 860;
  const height = 230;
  const padL = 40;
  const padB = 26;
  const padT = 36;
  const days = weather.days.slice(-150);
  const maxRain = Math.max(2, ...days.map((d) => d.precip ?? 0));
  const rawMaxStress = Math.max(...days.map((d) => d.stress), 10);
  const maxStress = Math.min(100, Math.ceil(rawMaxStress / 10) * 10 + 5);
  const x = (i: number) => padL + (i / Math.max(1, days.length - 1)) * (width - padL - 18);
  const yStress = (v: number) => padT + (1 - v / maxStress) * (height - padT - padB);
  const bw = Math.max(1, (width - padL - 18) / days.length - 1);
  const stressPath = days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yStress(d.stress).toFixed(1)}`).join(' ');
  const last = days[days.length - 1];
  const gridTicks = [0, Math.round(maxStress / 2), maxStress];

  return (
    <ChartTable
      columns={['Date', 'Stress 0–100', 'Rainfall', '2 m temperature', 'Relative humidity']}
      rows={days.map((d) => [
        d.date,
        d.stress,
        `${nf(d.precip ?? 0, 1)} mm`,
        d.t2m != null ? `${d.t2m.toFixed(1)} °C` : '—',
        d.rh != null ? `${d.rh.toFixed(0)} %` : '—',
      ])}
      summary={`Table of the ${days.length} days plotted`}
      note={`Source: ${weather.source}, fetched ${weather.fetchedAt.slice(0, 16)} UTC. Latest day is ${last ? `${last.stress} (${stressBand(last.stress).label})` : 'unavailable'}.`}
    >
    <div className="chart-wrap">
    <svg viewBox={`0 0 ${width} ${height}`} className="chart" role="img" aria-label="Recent fire-weather stress from NASA POWER, with daily rainfall.">
      <defs>
        <linearGradient id="stressFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ff7a45" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#ff7a45" stopOpacity="0.01" />
        </linearGradient>
      </defs>
      {gridTicks.map((v) => (
        <g key={v}>
          <line x1={padL} x2={width - 18} y1={yStress(v)} y2={yStress(v)} stroke="rgba(140,180,220,.1)" />
          <text x={padL - 8} y={yStress(v) + 3} textAnchor="end" className="axis-label">{v}</text>
        </g>
      ))}
      {days.map((d, i) => (
        <rect
          key={d.date}
          x={x(i) - bw / 2}
          y={height - padB - ((d.precip ?? 0) / maxRain) * 34}
          width={bw}
          height={((d.precip ?? 0) / maxRain) * 34}
          fill="rgba(74,168,255,.45)"
        >
          <title>{longDate(d.date)} · {nf(d.precip ?? 0, 1)} mm</title>
        </rect>
      ))}
      <path d={`${stressPath} L${x(days.length - 1)},${height - padB} L${x(0)},${height - padB} Z`} fill="url(#stressFill)" />
      <path d={stressPath} fill="none" stroke="#ff9a6a" strokeWidth={1.8} />
      {last && (
        <g>
          <circle cx={x(days.length - 1)} cy={yStress(last.stress)} r={4} fill="#ffb020" />
          <text x={x(days.length - 1) - 6} y={yStress(last.stress) - 8} textAnchor="end" className="axis-value" fill="#ffb020">{last.stress}</text>
        </g>
      )}
      <text x={padL} y={16} className="axis-label">fire-weather stress (0–100) · rainfall (mm, lower band) · last 150 days</text>
      <g transform={`translate(${width - 320}, 4)`}>
        <rect x={0} y={0} width={310} height={20} rx={3} fill="rgba(6,12,20,.85)" stroke="rgba(255,255,255,0.08)" />
        <line x1={8} x2={22} y1={10} y2={10} stroke="#ff9a6a" strokeWidth={2} />
        <text x={28} y={13} className="axis-label">stress</text>
        <rect x={80} y={5} width={8} height={10} fill="rgba(74,168,255,.55)" />
        <text x={94} y={13} className="axis-label">rain</text>
        <text x={146} y={13} className="axis-label">source: {weather.source}</text>
      </g>
    </svg>
    </div>
    </ChartTable>
  );
}

function ExpectedObserved({ weather }: { weather: WeatherContext }) {
  const width = 860;
  const height = 250;
  const padL = 46;
  const padB = 28;
  const padT = 44;
  const n = Math.min(220, weather.dates.length);
  const start = weather.dates.length - n;
  const obs = weather.observed.slice(start);
  const exp = weather.expected.slice(start);
  const max = Math.max(...obs, ...exp, 1) * 1.05;
  const x = (i: number) => padL + (i / Math.max(1, n - 1)) * (width - padL - 20);
  const y = (v: number) => padT + (1 - v / max) * (height - padT - padB);
  const line = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const res = weather.residual.slice(start);
  return (
    <ChartTable
      columns={['Date', 'Observed harmonized', 'Expected from stress', 'Residual']}
      rows={obs.map((v, i) => [weather.dates[start + i] ?? `d${i + 1}`, nf(v), nf(exp[i]), `${res[i] >= 0 ? '+' : ''}${nf(res[i])}`])}
      summary={`Table of the ${n} days plotted`}
      note={`Fit: log(activity + 1) on the stress index, r² ${weather.fit.r2.toFixed(3)}, slope ${weather.fit.slope.toFixed(4)}, n ${weather.fit.n} days (${weather.fit.period}). A positive residual means more burning than the weather alone would suggest.`}
    >
    <div className="chart-wrap">
    <svg viewBox={`0 0 ${width} ${height}`} className="chart" role="img" aria-label="Observed harmonized fire activity against the expectation from fire-weather stress.">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={padL} x2={width - 20} y1={y(max * f)} y2={y(max * f)} stroke="rgba(140,180,220,.1)" />
          <text x={padL - 8} y={y(max * f) + 3} textAnchor="end" className="axis-label">{nf(max * f)}</text>
        </g>
      ))}
      <path d={line(exp)} fill="none" stroke="#6ee7ff" strokeWidth={1.5} strokeOpacity={0.75} strokeDasharray="4 3" />
      <path d={line(obs)} fill="none" stroke="#ffffff" strokeWidth={2} />
      <text x={padL} y={16} className="axis-label">observed harmonized activity vs. weather-expected activity · last 220 days</text>
      <g transform={`translate(${width - 290}, 6)`}>
        <rect x={0} y={0} width={280} height={32} rx={3} fill="rgba(6,12,20,.85)" stroke="rgba(255,255,255,0.08)" />
        <line x1={8} x2={24} y1={10} y2={10} stroke="#fff" strokeWidth={2} />
        <text x={30} y={13} className="axis-label">observed</text>
        <line x1={8} x2={24} y1={23} y2={23} stroke="#6ee7ff" strokeWidth={2} strokeDasharray="3 2" />
        <text x={30} y={26} className="axis-label">expected from stress</text>
      </g>
    </svg>
    </div>
    </ChartTable>
  );
}

export function Outlook() {
  const store = useStore();
  const { region, records, today } = store;
  const clock = useMemo(() => seasonClock(records, Number(today.slice(0, 4)), today), [records, today]);
  const twin = useMemo(() => twinAnalogs(records, today, 8), [records, today]);
  const [weather, setWeather] = useState<WeatherContext | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setWeather(null);
    loadWeather(region.center, records, today)
      .then((w) => {
        if (alive) setWeather(w);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [region.center, records, today]);

  const monthly = useMemo(() => {
    const sums = new Array(12).fill(0);
    const counts = new Array(12).fill(0);
    for (const r of records) {
      if (r.year >= Number(today.slice(0, 4))) continue;
      sums[r.month - 1] += r.harmonized;
      counts[r.month - 1]++;
    }
    return sums.map((s, i) => ({ month: i + 1, value: counts[i] ? s / counts[i] : 0 }));
  }, [records, today]);
  const monthMax = Math.max(...monthly.map((m) => m.value), 1);
  const next4 = analogDeparture(twin);
  const currentMonth = Number(today.slice(5, 7));
  const recentRecs = useMemo(() => recordsInRange(records, today.slice(0, 4) + '-01-01', today), [records, today]);
  const recentTotal = recentRecs.reduce((s, r) => s + r.harmonized, 0);
  const lastWeather = weather?.days[weather.days.length - 1];
  const band = lastWeather ? stressBand(lastWeather.stress) : null;

  const seasonTone = clock.direction === 'ahead' ? 'warn' : clock.direction === 'behind' ? 'live' : 'good';
  const peakDistance = `${Math.abs(clock.currentOffsetDays)} d ${clock.currentOffsetDays < 0 ? 'to' : clock.currentOffsetDays > 0 ? 'past' : 'at'} peak`;
  const seasons = useMemo(() => notableSeasons(records, region), [records, region]);
  const observedSeason = seasonLabelFor(region);
  const driver = climateSourceFor(region);

  return (
    <div className="page outlook-page">
      <PageHeader
        eyebrow="Predict the future · seasonal intelligence"
        title="Predictive Risk Dashboard"
        intro="See the next 30 days through the region’s historical fire patterns. Explore seasonal risk, seven-day forecast winds and the evidence behind each day, then compare analog seasons and the four-week outlook."
        chips={
          <>
            <Badge tone="default">{region.name}</Badge>
            <Badge tone="warn">conditional · not LIVE</Badge>
            <Badge tone="good">leave-one-out analog test</Badge>
            <span aria-live="polite">
              {weather && <Badge tone={weather.source === 'NASA POWER' ? 'live' : 'warn'}>{weather.source}</Badge>}
            </span>
          </>
        }
        actions={
          <>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => store.setView('atlas')}>← Atlas</button>
            <button type="button" className="btn btn-primary btn-small" onClick={() => store.setView('brief')}>Build brief →</button>
          </>
        }
      />

      <FutureRiskCalendar />

      <div className="atlas-kpi-bar" role="region" aria-label="Key outlook metrics">
        <div className="atlas-kpi-card">
          <span className="atlas-kpi-label">Season peak</span>
          <div className="atlas-kpi-val">{clock.peakLabel}</div>
          <span className="atlas-kpi-sub">{clock.startLabel} → {clock.endLabel}</span>
        </div>
        <div className="atlas-kpi-card" style={{ borderLeftColor: riskColor(clock.direction === 'ahead' ? 'elevated' : clock.direction === 'behind' ? 'high' : 'normal') }}>
          <span className="atlas-kpi-label">Pace vs. climatology</span>
          <div className="atlas-kpi-val" style={{ color: riskColor(clock.direction === 'ahead' ? 'elevated' : clock.direction === 'behind' ? 'high' : 'normal') }}>{clock.direction}</div>
          <span className="atlas-kpi-sub">{Math.round(clock.yearShare)}% expected · {peakDistance}</span>
        </div>
        <div className="atlas-kpi-card" style={{ borderLeftColor: next4 > 0 ? '#ff8a3d' : '#34d399' }}>
          <span className="atlas-kpi-label">Analog outlook · 4 wk</span>
          <div className="atlas-kpi-val" style={{ color: next4 > 0 ? '#ff8a3d' : '#34d399' }}>{pct(next4)}</div>
          <span className="atlas-kpi-sub">median of {twin.analogs.length} twins · {Math.round(twin.backtestHitRate)}% hit rate</span>
        </div>
        <div className="atlas-kpi-card" style={{ borderLeftColor: band?.color ?? 'rgba(255,255,255,0.1)' }}>
          <span className="atlas-kpi-label">Fire-weather stress</span>
          <div className="atlas-kpi-val" style={{ color: band?.color ?? 'inherit' }}>
            {lastWeather ? `${lastWeather.stress}` : loading ? <span className="skeleton-pill">Loading…</span> : 'Unavailable'}
          </div>
          <span className="atlas-kpi-sub">
            {band ? `${band.label} · ${nf(lastWeather?.t2m ?? 0, 1)} °C · ${nf(lastWeather?.precip ?? 0, 1)} mm` : loading ? 'Fetching NASA POWER…' : 'Upstream telemetry offline'}
          </span>
        </div>
      </div>

      <Panel
        title="The decision this outlook supports"
        eyebrow="Predict the future · conditional, computed from this area's record"
        right={<Badge tone="warn">not an ignition forecast</Badge>}
      >
        <div className="decision-grid">
          <div className="decision-card">
            <span className="eyebrow">Posture</span>
            <strong>{next4 > 8 && (lastWeather?.stress ?? 0) >= 50 ? 'Stage readiness' : next4 < -8 ? 'Hold and watch' : 'Watch closely'}</strong>
            <p>
              {next4 > 8 && (lastWeather?.stress ?? 0) >= 50
                ? 'Analog seasons and current fire-weather stress point the same way. Treat the next four weeks as an elevated planning window.'
                : next4 < -8
                  ? 'The analog ensemble points below its own climatology. Keep the standing watch, but this is not a season to surge resources on the forecast alone.'
                  : 'The signals disagree or are weak. Keep the record open, watch the season clock, and revisit when the fire-weather stress moves.'}
            </p>
          </div>
          <div className="decision-facts">
            <div><span>Median analog departure · 4 wk</span><b style={{ color: next4 >= 0 ? '#ff9a6a' : '#56d6a0' }}>{pct(next4)}</b></div>
            <div><span>Analog hit rate</span><b>{Math.round(twin.backtestHitRate)}%</b></div>
            <div><span>Season pace</span><b>{clock.direction}</b></div>
            <div><span>Fire-weather stress</span><b>{lastWeather ? `${lastWeather.stress} · ${stressBand(lastWeather.stress).label}` : loading ? 'Fetching…' : 'Unavailable'}</b></div>
          </div>
        </div>
        <p className="panel-note">
          The posture is a reading aid, not an instruction. It combines only two pieces of evidence the app actually owns:
          the selected area&apos;s analog seasons and the current NASA POWER stress at its coordinates. Ignition, fuel
          treatment, access and suppression capacity are not in this model.
        </p>
      </Panel>

      <div className="grid-2">
        <Panel title="Season clock" eyebrow="When this landscape burns">
          <div className="clock-layout">
            <SeasonDial clock={clock} />
            <div className="clock-facts">
              <div><span>Typical start</span><b>{clock.startLabel}</b></div>
              <div><span>Peak</span><b>{clock.peakLabel}</b></div>
              <div><span>Typical end</span><b>{clock.endLabel}</b></div>
              <div><span>Cycle start</span><b>{clock.seasonStartLabel}</b></div>
              <div><span>Phase</span><b>{clock.phase}</b></div>
              <div><span>Position vs. peak</span><b>{peakDistance}</b></div>
              <div><span>Activity to date</span><b>{Math.round(clock.yearShare)}% of expected</b></div>
              <div><span>Year to date</span><b>{nf(recentTotal)}</b></div>
              <Badge tone={seasonTone}>pace: {clock.direction}</Badge>
              <Badge tone="default">burn-weather season: {observedSeason}</Badge>
              {driver?.proxied && (
                <Badge tone="warn">reanalysis driver proxied from the nearest POWER point, {driver.distanceKm} km</Badge>
              )}
            </div>
          </div>
          <div className="monthly-bars" aria-label="Average activity by month">
            {monthly.map((m) => (
              <div key={m.month} className={`monthly-bar ${m.month === currentMonth ? 'active' : ''}`}>
                <i style={{ height: `${Math.max(2, (m.value / monthMax) * 100)}%` }} />
                <span>{MONTHS[m.month - 1]}</span>
              </div>
            ))}
          </div>
          <p className="panel-note">
            The season is anchored at the off-season trough, not at 1 January, so a Southern Hemisphere peak cannot fall
            outside its own window. Start and end are the 25th and 75th percentile crossings of cumulative activity within
            that trough-to-trough year. Pace compares activity since the trough with climatology over the same span; before
            the typical start the denominator is small, so read the percentage as indicative, not decisive.
          </p>
        </Panel>

        <Panel title="Fire Twin" eyebrow="Closest analog seasons">
          <TwinChart twin={twin} />
          <div className="analog-list">
            {twin.analogs.map((a, i) => (
              <div key={a.year} className="analog-row">
                <span className="analog-rank">{String(i + 1).padStart(2, '0')}</span>
                <strong>{a.year}</strong>
                <span>similarity {Math.round(a.similarity)}%</span>
                <span>correlation {a.correlation.toFixed(2)}</span>
                <b style={{ color: a.next4WeeksAnomalyPct >= 0 ? '#ff8a3d' : '#56d6a0' }}>next 4 wk {pct(a.next4WeeksAnomalyPct)}</b>
              </div>
            ))}
          </div>
          <p className="panel-note">
            Leave-one-out backtest: the analog ensemble was asked to predict the next four weeks of each reference season,
            then scored against what actually happened. Hit rate {Math.round(twin.backtestHitRate)}% over {twin.sampleYears} seasons, against 50% for a coin flip.
            Analogues are evidence, not prophecy.
          </p>
        </Panel>
      </div>

      <Panel
        title="Fire weather, from real NASA POWER data"
        eyebrow={`${region.center[0].toFixed(2)}°, ${region.center[1].toFixed(2)}° · daily MERRA-2`}
        right={weather ? <Badge tone={weather.source === 'NASA POWER' ? 'live' : 'warn'}>{weather.source}</Badge> : <Badge tone="mute">telemetry</Badge>}
      >
        {loading && (
          <div className="skeleton-block" role="status" aria-label="Loading telemetry">
            <span style={{ position: 'absolute', opacity: 0 }}>Fetching NASA POWER telemetry…</span>
          </div>
        )}
        {!loading && weather && (
          <>
            <WeatherStrip weather={weather} />
            <div className="weather-facts">
              <div><span>Fit</span><b>log activity ~ stress</b></div>
              <div><span>R²</span><b>{weather.fit.r2.toFixed(2)}</b></div>
              <div><span>Slope</span><b>{weather.fit.slope.toFixed(3)}</b></div>
              <div><span>Sample</span><b>{nf(weather.fit.n)} days</b></div>
              <div><span>Window</span><b>{weather.fit.period}</b></div>
              <div><span>Source</span><b>{weather.source}</b></div>
            </div>
            <ExpectedObserved weather={weather} />
            <p className="panel-note">
              Stress combines temperature anomaly, 30-day rainfall deficit and dry air: 0.46·heat + 0.38·dry + 0.16·dry-air.
              It is an association, not a causal claim; terrain, ignition and suppression are not in this model. When POWER is unreachable,
              the page says “offline estimate” instead of pretending.
            </p>
          </>
        )}
        {!loading && !weather && <Empty>Weather unavailable. The rest of the record is unaffected.</Empty>}
      </Panel>

      <div className="grid-2">
        <Panel title="The outlook, in words" eyebrow="Conditional, probabilistic, honest">
          <p className="big-copy">
            {region.shortName} is at the <strong>{ordinal(Math.round(store.status.percentile))} percentile</strong> of its own
            {' '}{Math.max(1, Number(today.slice(0, 4)) - 2000)}-year record for this point in {MONTHS[currentMonth - 1]}.
            {' '}The closest analog seasons point to a <strong style={{ color: next4 >= 0 ? '#ff8a3d' : '#56d6a0' }}>{pct(next4)}</strong> four-week
            departure from their own climatology. {band ? `Current fire-weather stress is ${lastWeather?.stress} (${band.label}).` : ''}
          </p>
          <div className="outlook-actions">
            <button type="button" className="btn btn-small btn-primary" onClick={() => store.setView('brief')}>Turn into a field brief →</button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => store.setView('method')}>Read the assumptions</button>
          </div>
          <div className="caveat">
            <strong>What this is not.</strong> Not a forecast of ignition, not an evacuation order, not a substitute for a national
            fire-danger rating. It is a calibrated way to ask “unusual compared with what?” before resources are committed.
          </div>
        </Panel>

        <Panel title="The biggest seasons in this record" eyebrow="Ranked from the data itself, not a curated list">
          {seasons.length ? (
            <div className="event-list">
              {seasons.map((s) => (
                <div key={s.year} className="event-row">
                  <span className="event-year">{s.year}</span>
                  <span
                    className="event-dot"
                    style={{ background: s.percentile >= 97 ? '#ff4d4d' : s.percentile >= 90 ? '#ff8a3d' : '#ffc247' }}
                  />
                  <div>
                    <strong>{nf(s.value)} harmonized detections</strong>
                    <small>
                      {ordinal(Math.round(s.percentile))} percentile of this record
                      {s.weatherAnomaly != null
                        ? ` · burn-weather anomaly ${s.weatherAnomaly >= 0 ? '+' : ''}${s.weatherAnomaly.toFixed(2)} SD`
                        : ''}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>No complete season in this record yet. The calendar still carries every daily value.</Empty>
          )}
          <p className="panel-note">
            These are the top annual totals of the area’s own reconstructed record, with the observed MERRA-2 burn-weather
            anomaly of the same year beside them. Nothing here is a hand-picked event list: change the area or rebuild the
            bundle and the list is recomputed.
          </p>
        </Panel>
      </div>
    </div>
  );
}
