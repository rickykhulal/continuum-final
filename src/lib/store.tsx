import { createContext, useContext, useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from 'react';
import type { DailyRecord, LiveBundle, Metric, Mode, Region, StatusResult } from '../lib/types';
import type { CalendarResolution, CalendarSpan } from '../components/charts';
import {
  REGIONS,
  getRecord,
  loadLiveBundle,
  resetLiveBundle,
  regionRecord,
  statusFor,
  recordsInRange,
} from '../lib/data';
import { customRegion, customBounds } from '../data/places';
import { countryById, countryRegion, installWorldLayer, loadWorldLayer, uninstallWorldLayer } from '../lib/countries';
import { isoDate } from '../lib/format';
import { t as translate, type Lang, type StringKey } from '../lib/i18n';

export type ViewId = 'watch' | 'atlas' | 'diagnosis' | 'outlook' | 'brief' | 'method' | 'community' | 'developers';

export interface Settings {
  lang: Lang;
  theme: 'dark' | 'light';
  contrast: boolean;
  textures: boolean;
  reduceMotion: boolean;
  labels: boolean;
}

export interface AlertItem {
  region: Region;
  status: StatusResult;
  score: number;
}

export type FrameGap = 0 | 1 | 5 | 10;

/** How the burning calendar is read: binning, depth, focus year and comparison gap. */
export interface FrameState {
  res: CalendarResolution;
  span: CalendarSpan;
  focusYear: number;
  gap: FrameGap;
}

interface Store {
  view: ViewId;
  region: Region;
  regionId: string;
  setView: (v: ViewId) => void;
  selectRegion: (id: string) => void;
  selectCustom: (lat: number, lon: number, radiusKm?: number, name?: string, countryId?: string) => void;
  selectBounds: (bbox: Region['bbox']) => void;
  /** Any of the 241 country polygons in the bundle, framed by its real border. */
  selectCountry: (id: string) => void;
  live: LiveBundle | null;
  /** True while the live bundle is being fetched for the first time. */
  loading: boolean;
  /** Error message when live loading has failed and retry is available. */
  loadError: string | null;
  /** Retry loading the live bundle (bounded to one in-flight attempt). */
  retryLoad: () => void;
  records: DailyRecord[];
  today: string;
  range: [string, string];
  setRange: (r: [string, string]) => void;
  metric: Metric;
  setMetric: (m: Metric) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  frame: FrameState;
  setFrame: (patch: Partial<FrameState>) => void;
  split: boolean;
  setSplit: (s: boolean) => void;
  selectedDate: string | null;
  setSelectedDate: (d: string | null) => void;
  settings: Settings;
  setSettings: (patch: Partial<Settings>) => void;
  watchlist: string[];
  toggleWatch: (id: string) => void;
  alerts: AlertItem[];
  status: StatusResult;
  t: (key: StringKey) => string;
  shareLink: () => Promise<string>;
  shareUrl: string;
  alertsOpen: boolean;
  setAlertsOpen: (v: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
  tourOpen: boolean;
  setTourOpen: (v: boolean) => void;
  toastMsg: string | null;
  toast: (msg: string) => void;
}

const SettingsKey = 'continuum.settings.v2';
const WatchKey = 'continuum.watchlist.v2';

function readSettings(): Settings {
  const fallback: Settings = { lang: 'en', theme: 'dark', contrast: false, textures: false, reduceMotion: false, labels: true };
  try {
    const raw = localStorage.getItem(SettingsKey);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function readWatchlist(): string[] {
  try {
    const raw = localStorage.getItem(WatchKey);
    const parsed = raw ? (JSON.parse(raw) as string[]) : null;
    if (parsed?.length) return parsed.filter((id) => REGIONS.some((r) => r.id === id));
  } catch {
    /* fall through */
  }
  return ['chilecito', 'pantanal', 'california'];
}

interface HashState {
  view: ViewId;
  regionId: string;
  metric: Metric;
  mode: Mode;
  from?: string;
  to?: string;
  lat?: number;
  lon?: number;
  rad?: number;
  name?: string;
  bbox?: Region['bbox'];
  res?: CalendarResolution;
  span?: CalendarSpan;
  fy?: number;
  gap?: FrameGap;
}

function parseHash(): HashState {
  const fallback: HashState = { view: 'watch', regionId: 'chilecito', metric: 'hotspots', mode: 'harmonized' };
  const raw = location.hash.replace(/^#\/?/, '');
  if (!raw) return fallback;
  const [path, query] = raw.split('?');
  const view = (['watch', 'atlas', 'diagnosis', 'outlook', 'brief', 'method', 'community', 'developers'] as ViewId[]).includes(path as ViewId)
    ? (path as ViewId)
    : fallback.view;
  const params = new URLSearchParams(query ?? '');
  const rParam = params.get('r');
  // A border arrives either as c=<id> (what the URL writer emits) or as r=country-<id>, which is what a
  // hand-pasted or bookmarked link usually carries. Both must mean the same area.
  const countryId = params.get('c') ?? (rParam?.startsWith('country-') ? rParam.slice('country-'.length) : null);
  const regionId = countryId ? `country-${countryId}` : rParam ?? fallback.regionId;
  const metric = (['hotspots', 'firedays', 'frp'] as Metric[]).includes(params.get('m') as Metric)
    ? (params.get('m') as Metric)
    : fallback.metric;
  const mode = params.get('mode') === 'raw' ? 'raw' : 'harmonized';
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  const hasPoint = params.has('lat') && params.has('lon') && Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const rad = Number(params.get('rad'));
  const boxValues = params.get('box')?.split(',').map(Number);
  let bbox: Region['bbox'] | undefined;
  if (boxValues?.length === 4 && params.get('box')?.split(',').every(v => v.trim())) {
    try { bbox = customBounds(boxValues as Region['bbox']).bbox; } catch { /* invalid share bounds */ }
  }
  const resRaw = params.get('res');
  const res = (['day', 'week', 'month', 'quarter', 'year'] as CalendarResolution[]).find((r) => r === resRaw);
  const spanRaw = params.get('span');
  const span = (['all', 20, 10, 5, 2, 1] as CalendarSpan[]).find((s) => String(s) === spanRaw);
  const fyRaw = Number(params.get('fy'));
  const fy = params.has('fy') && Number.isInteger(fyRaw) && fyRaw >= 2000 && fyRaw <= 2100 ? fyRaw : undefined;
  const gapRaw = Number(params.get('gap'));
  const gap = ([0, 1, 5, 10] as FrameGap[]).find((g) => params.has('gap') && String(g) === String(gapRaw));
  return {
    view,
    regionId: bbox || hasPoint || countryId ? regionId : REGIONS.some((r) => r.id === regionId) ? regionId : fallback.regionId,
    metric,
    mode,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    lat: hasPoint ? lat : undefined,
    lon: hasPoint ? lon : undefined,
    rad: Number.isFinite(rad) && rad > 0 ? Math.min(2000, rad) : undefined,
    name: params.get('n')?.slice(0, 80) ?? undefined,
    bbox,
    res,
    span,
    fy,
    gap,
  };
}

/** Shareable hash for the current view, preserving a custom AOI's coordinates and the calendar frame. */
function hashFor(
  view: ViewId,
  regionId: string,
  metric: Metric,
  mode: Mode,
  custom: Region | null,
  range?: [string, string],
  frame?: FrameState,
  todayYear?: number,
): string {
  const qs = new URLSearchParams({ r: regionId, m: metric, mode });
  if (range) {
    qs.set('from', range[0]);
    qs.set('to', range[1]);
  }
  if (custom && custom.id === regionId) {
    if (custom.selection === 'bounds') {
      qs.set('box', custom.bbox.join(','));
      qs.set('n', custom.shortName);
    } else if (custom.countryId) {
      qs.set('c', custom.countryId);
    } else {
      qs.set('lat', custom.center[0].toFixed(4));
      qs.set('lon', custom.center[1].toFixed(4));
      qs.set('rad', String(Math.round(Math.sqrt(custom.areaKm2 / Math.PI))));
      qs.set('n', custom.shortName);
    }
  }
  // Only non-default frame settings ride in the URL, so a plain share stays short and the
  // default reading frame can change without invalidating older links.
  if (frame) {
    if (frame.res !== 'day') qs.set('res', frame.res);
    if (frame.span !== 'all') qs.set('span', String(frame.span));
    if (todayYear == null || frame.focusYear !== todayYear) qs.set('fy', String(frame.focusYear));
    if (frame.gap !== 1) qs.set('gap', String(frame.gap));
  }
  return `#/${view}?${qs.toString()}`;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(parseHash, []);
  const initialCustom = useMemo(
    () => initial.bbox ? customBounds(initial.bbox, initial.name) : (initial.lat != null && initial.lon != null ? customRegion(initial.lat, initial.lon, initial.rad ?? 140, initial.name) : null),
    [initial],
  );
  const [view, setViewState] = useState<ViewId>(initial.view);
  const viewRef = useRef<ViewId>(initial.view);
  const [regionId, setRegionId] = useState(initialCustom?.id ?? initial.regionId);
  const [custom, setCustom] = useState<Region | null>(initialCustom);
  const [live, setLive] = useState<LiveBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>(initial.metric);
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [frame, setFrameState] = useState<FrameState>(() => ({
    res: initial.res ?? 'day',
    span: initial.span ?? 8,
    focusYear: initial.fy ?? Number(isoDate(new Date()).slice(0, 4)),
    gap: initial.gap ?? 1,
  }));
  const [split, setSplit] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [settings, setSettingsState] = useState<Settings>(readSettings);
  const [watchlist, setWatchlist] = useState<string[]>(readWatchlist);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 4000);
  }, []);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const region = useMemo(() => (custom && custom.id === regionId ? custom : REGIONS.find((r) => r.id === regionId) ?? REGIONS[0]), [regionId, custom]);

  const today = live?.meta.windowEnd ?? isoDate(new Date());
  const earliest = '2000-11-01';
  const [range, setRangeState] = useState<[string, string]>([initial.from ?? earliest, initial.to ?? isoDate(new Date())]);

  useEffect(() => {
    let alive = true;
    let floorTimer: number | undefined;
    setLoading(true);
    setLoadError(null);
    const startedAt = Date.now();
    loadLiveBundle().then(b => {
      if (!alive) return;
      floorTimer = window.setTimeout(() => {
        if (!alive) return;
        setLive(b);
        setLoading(false);
        if (b.loadNotice) toast(b.loadNotice);
        if (!initial.to) setRangeState(r => [r[0], b.meta.windowEnd]);
      }, Math.max(0, 700 - (Date.now() - startedAt)));
    }).catch(() => {
      if (!alive) return;
      setLoading(false);
      setLoadError('The bundled FIRMS snapshot could not be loaded. Check the connection and retry.');
    });
    return () => { alive = false; window.clearTimeout(floorTimer); };
  }, [initial.to, loadAttempt, toast]);

  const retryLoad = useCallback(() => {
    resetLiveBundle();
    setLive(null);
    setLoading(true);
    setLoadError(null);
    setLoadAttempt(attempt => attempt + 1);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.dataset.contrast = settings.contrast ? 'high' : 'normal';
    root.dataset.textures = settings.textures ? 'on' : 'off';
    root.dataset.motion = settings.reduceMotion ? 'reduced' : 'full';
    root.lang = settings.lang;
    try {
      localStorage.setItem(SettingsKey, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  useEffect(() => {
    try {
      localStorage.setItem(WatchKey, JSON.stringify(watchlist));
    } catch {
      /* ignore */
    }
  }, [watchlist]);

  const records = useMemo(() => {
    if (custom && custom.id === regionId) return regionRecord(custom, live);
    return getRecord(regionId, live);
  }, [regionId, live, custom]);

  const status = useMemo(() => statusFor(region, records, today, metric, mode), [region, records, today, metric, mode]);

  const alerts = useMemo<AlertItem[]>(() => {
    if (!live) return [];
    const out: AlertItem[] = [];
    for (const r of REGIONS) {
      const recs = getRecord(r.id, live);
      const st = statusFor(r, recs, today, 'hotspots', 'harmonized');
      const last = recordsInRange(recs, live.meta.windowStart, live.meta.windowEnd);
      const liveCount = last.reduce((s, d) => s + d.harmonized, 0);
      out.push({ region: r, status: st, score: st.percentile * 10 + liveCount });
    }
    return out.sort((a, b) => b.score - a.score);
  }, [live, today]);

  const setView = useCallback((v: ViewId) => {
    // Mounting a page is the app's heaviest work and it lands in the click's own task. Let the click
    // return first and render in the next task: input stays responsive and the mount is not sliced
    // across frames, which a transition does once the outgoing page keeps animating.
    document.documentElement.dataset.viewPending = v;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (v === viewRef.current) return;
    window.setTimeout(() => setViewState(v), 0);
  }, []);

  // The cue is DOM state, not React state: a React pending flag would re-render the outgoing page
  // inside the same click task that the deferral exists to keep short. The ref tracks the committed
  // view here — not in setView — so hash restores and returns-to-the-current-view stay consistent.
  useEffect(() => {
    viewRef.current = view;
    const root = document.documentElement;
    if (root.dataset.viewPending === view) delete root.dataset.viewPending;
  }, [view]);

  const selectRegion = useCallback((id: string) => {
    setCustom(null);
    setRegionId(id);
    setRangeState((r) => [r[0], live?.meta.windowEnd ?? r[1]]);
  }, [live]);

  const selectCustom = useCallback((lat: number, lon: number, radiusKm = 140, name?: string, countryId?: string) => {
    const reg = customRegion(lat, lon, radiusKm, name, countryId);
    setCustom(reg);
    setRegionId(reg.id);
    setRangeState((r) => [r[0], live?.meta.windowEnd ?? r[1]]);
  }, [live]);

  const selectBounds = useCallback((bbox: Region['bbox']) => {
    const reg = customBounds(bbox);
    setCustom(reg);
    setRegionId(reg.id);
    setSelectedDate(null);
    setRangeState((r) => [r[0], live?.meta.windowEnd ?? r[1]]);
  }, [live]);

  const selectCountry = useCallback((id: string) => {
    const entry = countryById(id);
    if (!entry) return;
    const reg = countryRegion(entry);
    setCustom(reg);
    setRegionId(reg.id);
    setRangeState((r) => [r[0], live?.meta.windowEnd ?? r[1]]);
  }, [live]);

  // The world layer is what makes an area outside the seven pilot bboxes measurable: it hands the
  // reconstruction the exact per-country window instead of the pooled pilot density. The install
  // itself lives in src/lib/countries.ts so the API registers the identical layer from disk.
  useEffect(() => {
    let alive = true;
    loadWorldLayer().then(() => {
      if (!alive) return;
      installWorldLayer();
      const wanted = initial.regionId;
      if (wanted.startsWith('country-') && !countryById(wanted.slice(8))) return;
      if (wanted.startsWith('country-') && !custom) selectCountry(wanted.slice(8));
    });
    return () => {
      alive = false;
      uninstallWorldLayer();
    };
  }, []);

  const setSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((s) => ({ ...s, ...patch }));
  }, []);

  const toggleWatch = useCallback((id: string) => {
    setWatchlist((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]));
  }, []);

  const setRange = useCallback((r: [string, string]) => {
    setRangeState(r);
  }, []);

  const setFrame = useCallback((patch: Partial<FrameState>) => {
    setFrameState((f) => ({ ...f, ...patch }));
  }, []);

  // Pasting a share link into an open tab only fires hashchange, which must
  // restore the full view state, not just the page.
  useEffect(() => {
    const applyHash = () => {
      const h = parseHash();
      setViewState(h.view);
      if (h.bbox) {
        const reg = customBounds(h.bbox, h.name);
        setCustom(reg);
        setRegionId(reg.id);
      } else if (h.lat != null && h.lon != null) {
        const reg = customRegion(h.lat, h.lon, h.rad ?? 140, h.name);
        setCustom(reg);
        setRegionId(reg.id);
      } else if (h.regionId.startsWith('country-')) {
        // A border has no entry in REGIONS, so the pilot-only branch below would drop it and the hash
        // writer would snap the link back to the default area. Same path a click uses: build the
        // country's region record and select it. Unknown ids leave the current area untouched.
        selectCountry(h.regionId.slice('country-'.length));
      } else {
        setCustom(null);
        if (REGIONS.some((r) => r.id === h.regionId)) setRegionId(h.regionId);
      }
      setMetric(h.metric);
      setMode(h.mode);
      setFrameState({
        res: h.res ?? 'day',
        span: h.span ?? 'all',
        focusYear: h.fy ?? Number((h.to ?? isoDate(new Date())).slice(0, 4)),
        gap: h.gap ?? 1,
      });
      if (h.from && h.to) setRangeState([h.from, h.to]);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);

  // Keep the address bar in sync with the settled state so a copied URL always
  // reproduces what is on screen, including custom AOI coordinates and the calendar frame.
  useEffect(() => {
    history.replaceState(null, '', hashFor(view, regionId, metric, mode, custom, range, frame, Number(today.slice(0, 4))));
  }, [view, regionId, metric, mode, custom, range, frame, today]);

  const shareUrl = useMemo(() => {
    const base = `${location.origin}${location.pathname}`;
    return `${base}${hashFor(view, regionId, metric, mode, custom, range, frame, Number(today.slice(0, 4)))}`;
  }, [view, regionId, metric, mode, range, custom, frame, today]);

  const shareLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      /* clipboard blocked; the URL is shown in the toast regardless */
    }
    return shareUrl;
  }, [shareUrl]);

  const t = useCallback((key: StringKey) => translate(settings.lang, key), [settings.lang]);



  return (
    <Ctx.Provider
      value={{
        view, region, regionId,
        setView, selectRegion, selectCustom, selectBounds, selectCountry,
        live, loading, loadError, retryLoad,
        records, today,
        range, setRange,
        metric, setMetric, mode, setMode, split, setSplit,
        frame, setFrame,
        selectedDate, setSelectedDate,
        settings, setSettings,
        watchlist, toggleWatch,
        alerts, status, t, shareLink, shareUrl,
        alertsOpen, setAlertsOpen,
        settingsOpen, setSettingsOpen,
        tourOpen, setTourOpen,
        toastMsg, toast,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useStore(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useStore outside StoreProvider');
  return ctx;
}
