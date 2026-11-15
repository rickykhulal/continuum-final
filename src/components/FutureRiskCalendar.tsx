import { useEffect, useMemo, useRef, useState } from 'react';
import { addDays, compact, longDate, MONTHS, nf, parseISO } from '../lib/format';
import { forecastToday, HIGH_WIND_KMH, loadPredictionArchive, predictFutureRisk, RISK_LABELS } from '../lib/prediction';
import { fetchWindForecast, windCompass, type ForecastWindDay } from '../lib/wind';
import type { ArchiveBundle } from '../lib/archive';
import { useStore } from '../lib/store';
import { REGIONS } from '../lib/data';
import { Badge, Panel } from './ui';
import './FutureRiskCalendar.css';

export function FutureRiskCalendar() {
  const { region, selectRegion } = useStore();
  const [startDate, setStartDate] = useState(forecastToday);
  const [selectedDate, setSelectedDate] = useState(startDate);
  const [retry, setRetry] = useState(0);
  const [archiveRetry, setArchiveRetry] = useState(0);
  const [archive, setArchive] = useState<ArchiveBundle | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [forecast, setForecast] = useState<{
    key: string; days: ForecastWindDay[]; error: string | null; fetchedAt: string | null;
  } | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [lat, lon] = region.center;
  const requestKey = `${region.id}:${lat}:${lon}:${startDate}:${retry}`;
  const activeForecast = forecast?.key === requestKey ? forecast : null;

  useEffect(() => {
    let alive = true;
    setDataLoading(true);
    setArchiveError(null);
    loadPredictionArchive().then(data => {
      if (alive) setArchive(data);
    }).catch(error => {
      if (alive) {
        setArchive(null);
        setArchiveError(error instanceof Error ? error.message : 'Archive unavailable.');
      }
    }).finally(() => { if (alive) setDataLoading(false); });
    return () => { alive = false; };
  }, [archiveRetry]);

  useEffect(() => { setSelectedDate(startDate); }, [region.id, startDate]);

  useEffect(() => {
    const timer = window.setInterval(() => setStartDate(forecastToday()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchWindForecast(lat, lon, controller.signal).then(days => {
      if (controller.signal.aborted) return;
      const current = days.filter(d => d.date >= startDate && d.date <= addDays(startDate, 6));
      if (!current.length) throw new Error('The provider returned no wind dates in the current seven-day window.');
      setForecast({ key: requestKey, days: current, error: null, fetchedAt: new Date().toISOString() });
    }).catch(error => {
      if (!controller.signal.aborted) setForecast({ key: requestKey, days: [], error: error instanceof Error ? error.message : 'Wind forecast unavailable.', fetchedAt: null });
    });
    return () => controller.abort();
  }, [lat, lon, startDate, requestKey]);

  const model = useMemo(() => predictFutureRisk(region.id, {
    archive, startDate, wind: activeForecast?.days,
  }), [region.id, archive, startDate, activeForecast]);
  const selected = model.days.find(d => d.date === selectedDate) ?? model.days[0];
  const lead = (parseISO(startDate).getUTCDay() + 6) % 7;
  const highDays = model.days.filter(d => d.risk === 'high' || d.risk === 'critical').length;
  const criticalDays = model.days.filter(d => d.risk === 'critical').length;
  const noRisk = model.days.every(d => d.risk === 'unavailable');

  return <>
    <Panel title="30-Day Future Fire Risk Calendar" eyebrow={`${region.shortName} · archive climatology + forecast wind`}
      className="future-risk-panel" right={<Badge tone="warn">MODEL OUTPUT</Badge>}>
      <div className="future-risk-summary" data-region-id={model.regionId}>
        <div><span>Training record · {region.shortName}</span><strong>{dataLoading ? 'Loading…' : `${model.training.years} years`}</strong><small>Observed archive only · {nf(model.training.days)} days</small></div>
        <div><span>High-risk days ahead</span><strong>{noRisk ? '—' : highDays}<small>{noRisk ? 'Insufficient history' : ` / 30 · ${criticalDays} critical`}</small></strong><small>Relative to this region’s seasonal cycle</small></div>
        <div><span>Wind forecast coverage</span><strong>{activeForecast ? activeForecast.days.length : '…'}<small> / 7 days</small></strong><small>Open-Meteo · area centre · UTC</small></div>
      </div>
      <div className="future-wind-status" role="status">
        {!activeForecast ? 'Fetching seven-day wind forecast… Calendar colours currently use climatology only.'
          : activeForecast.error ? `Wind unavailable. ${activeForecast.error} Calendar colours use climatology only.`
          : `Wind forecast available for ${activeForecast.days.length} of the next 7 days. Remaining dates use climatology only.`}
        {activeForecast && <button type="button" className="btn btn-ghost btn-small" onClick={() => setRetry(n => n + 1)}>{activeForecast.error ? 'Retry wind forecast' : 'Refresh wind forecast'}</button>}
      </div>
      {dataLoading && <p role="status">Loading archive_daily.json…</p>}
      {!dataLoading && !model.training.days && <div className="future-archive-empty" role="status">
        <strong>No Data Available</strong>
        <p>{archiveError ?? `No observed archive history matches ${region.name} (ID: ${region.id}). Country borders and custom areas do not inherit a pilot region’s history.`}</p>
        {archiveError ? <button type="button" className="btn btn-ghost btn-small" onClick={() => setArchiveRetry(n => n + 1)}>Retry archive</button>
          : <><p>Select an available archive area:</p><div className="future-archive-options">{REGIONS.filter(r => archive?.regions[r.id]).map(r => <button key={r.id} type="button" className="btn btn-ghost btn-small" onClick={() => selectRegion(r.id)}>{r.shortName}</button>)}</div></>}
      </div>}
      <div className="future-risk-layout">
        <div className="future-calendar">
          <div className="future-calendar-heading"><strong>{longDate(startDate)} — {longDate(addDays(startDate, 29))}</strong><span>UTC · select a day</span></div>
          <div className="future-calendar-grid future-weekdays" aria-hidden="true">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <span key={d}>{d}</span>)}</div>
          <div className="future-calendar-grid" role="group" aria-label="Future fire risk by date; arrow keys move between days">
            {Array.from({ length: lead }, (_, i) => <span key={`blank-${i}`} aria-hidden="true" />)}
            {model.days.map((day, i) => <button key={day.date} type="button" ref={el => { buttons.current[i] = el; }}
              className={`future-day risk-${day.risk}`} data-date={day.date} data-risk={day.risk}
              aria-pressed={selected.date === day.date} aria-controls="future-day-detail"
              aria-label={`${longDate(day.date)}: ${RISK_LABELS[day.risk]} risk. ${day.mean == null ? 'No historical average.' : `Expected ${nf(day.mean, 1)} sensor detections.`} ${day.wind ? `Forecast wind ${nf(day.wind.speedKmh, 1)} km/h.` : 'Climatology only; wind unavailable.'}`}
              onClick={() => setSelectedDate(day.date)}
              onKeyDown={event => {
                const offset = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 }[event.key];
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? 29 : offset != null ? Math.max(0, Math.min(29, i + offset)) : null;
                if (next == null) return;
                event.preventDefault();
                setSelectedDate(model.days[next].date);
                buttons.current[next]?.focus();
              }}>
              <span className="future-day-month">{i === 0 ? 'Today' : MONTHS[Number(day.date.slice(5, 7)) - 1]}</span>
              <strong>{Number(day.date.slice(8))}</strong>
              <span className="future-day-risk">{RISK_LABELS[day.risk]}</span>
              <span className="future-day-expected" title="Expected sensor detections">{day.mean == null ? '—' : `${compact(day.mean)} avg`}</span>
              <span className="future-day-wind">{day.wind ? `${nf(day.wind.speedKmh)} km/h` : 'Seasonal'}</span>
            </button>)}
          </div>
          <div className="future-risk-legend" aria-label="Risk colour legend">
            {(['low', 'moderate', 'high', 'critical'] as const).map(risk => <span key={risk} className={`risk-${risk}`}><i aria-hidden="true" />{RISK_LABELS[risk]}</span>)}
          </div>
          <p className="panel-note">Cell average = expected sensor detections for that date. Low: zero or below the seasonal mean. Moderate: mean to seasonal P90. High: above seasonal P90. Critical: High + forecast wind &gt; {HIGH_WIND_KMH} km/h.</p>
        </div>
        <aside id="future-day-detail" className={`future-day-detail risk-${selected.risk}`} aria-live="polite" aria-atomic="true" aria-label="Selected day risk explanation">
          <span className="eyebrow">Why this day?</span>
          <h3>{longDate(selected.date)}</h3>
          <strong className="future-risk-title">{RISK_LABELS[selected.risk]} risk</strong>
          <p>{selected.risk === 'unavailable' ? 'No Data Available for a risk ranking. At least three observed archive samples per calendar day across a full seasonal cycle are required.'
            : selected.risk === 'critical' ? 'This date is in the highest part of the region’s historical seasonal cycle, with strong forecast winds that may support fire spread.'
            : selected.risk === 'high' ? 'This date’s expected activity exceeds the 90th percentile of the region’s seasonal daily averages.'
            : selected.risk === 'low' ? 'This date’s expected activity is zero or below the region’s average seasonal activity.'
            : 'This date’s expected activity is at or above the seasonal mean, within the usual seasonal range.'}</p>
          <dl className="future-day-facts">
            <div><dt>Expected sensor detections</dt><dd>{selected.mean == null ? '—' : nf(selected.mean, 1)}</dd></div>
            <div><dt>This date’s historical P90</dt><dd>{selected.p90 == null ? '—' : nf(selected.p90, 1)}</dd></div>
            <div><dt>Years with activity</dt><dd>{selected.fireYears} / {selected.sampleYears}</dd></div>
          </dl>
          {selected.sampleYears > 0 && <p className="future-frequency">{nf(100 * selected.fireYears / selected.sampleYears)}% of this calendar date’s {selected.sampleYears} observed archive samples contain fire activity. This is record frequency, not an ignition probability.</p>}
          <div className="future-wind-detail"><span className="eyebrow">Forecast wind · Open-Meteo</span>
            {selected.wind ? <><strong>{nf(selected.wind.speedKmh, 1)} km/h</strong><p>Daily maximum at 10 m. Dominant direction: {selected.wind.direction == null ? 'unavailable' : `from ${windCompass(selected.wind.direction)} (${nf(selected.wind.direction)}°)`}.</p></>
              : <p>{selected.date > addDays(startDate, 6) ? 'Beyond the seven-day wind horizon. Climatology only.' : !activeForecast ? 'Loading wind for this date…' : 'No wind forecast for this date. Climatology only.'}</p>}
          </div>
        </aside>
      </div>
      <details className="future-method"><summary>How this prediction is calculated</summary>
        <p>The model reads only the selected area’s entry in archive_daily.json and groups observed counts by calendar day, keeping leap day separate. It averages prior years and calculates each day’s historical 90th percentile. The current year is held out. Colours compare the expected count with the mean ({nf(model.referenceMean ?? NaN, 1)}) and P90 ({nf(model.referenceP90 ?? NaN, 1)}) of the seasonal daily averages.</p>
        <p>Training: {model.training.first ?? 'unavailable'} to {model.training.last ?? 'unavailable'} · {nf(model.training.days)} observed days. Source ID: {model.regionId}. Counts sum the published sensors ({model.training.sensors.join(', ') || 'none'}). These are raw sensor detections, not unique fires or harmonized counts; changes in sensor coverage can affect comparisons between years. Uncovered days are excluded, with no reconstructed values or live-window calibration. Covered days with no detections remain observed zeros.</p>
        <p>Wind is the forecast at the area centre ({lat.toFixed(2)}°, {lon.toFixed(2)}°), not a region-wide maximum. It can elevate High to Critical; it does not change the expected detection count. {activeForecast?.fetchedAt ? `Retrieved ${activeForecast.fetchedAt.slice(0, 16).replace('T', ' ')} UTC.` : ''} Seasonal recurrence and wind do not establish ignition, fuel conditions or forecast skill.</p>
      </details>
    </Panel>
    <Panel title="Historical Pattern Insights" eyebrow={`${region.shortName} · learned from this area's record`} className="future-insights"
      right={<Badge tone="mute">{dataLoading ? 'LOADING ARCHIVE' : !model.training.days ? 'NO TRAINING DATA' : 'OBSERVED ARCHIVE ONLY'}</Badge>}>
      {dataLoading ? <p>Loading historical patterns…</p> : <ul>{model.insights.map(insight => <li key={insight}>{insight}</li>)}</ul>}
    </Panel>
  </>;
}
