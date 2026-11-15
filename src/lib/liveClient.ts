/**
 * liveClient.ts — Client-side module for live FIRMS data polling.
 *
 * This module provides:
 * 1. A React hook (useLiveFirms) that polls /api/v1/live-firms every 10 minutes
 *    and fetches real data from the Continuum API server (server/live.mjs).
 * 2. A React hook (useMockLiveFirms) for dev/testing behind an explicit
 *    VITE_ALLOW_MOCK_LIVE=1 flag — mock data only, never used in production.
 * 3. Provenance labeling ('live' | 'model' | 'blend' | 'archive') so the UI can
 *    hatch/stale the calendar and other displays consistently.
 * 4. Transport state: 'loading' | 'live' | 'stale' | 'offline' | 'not_configured'.
 *
 * Transport state and provenance are deliberately separate: a payload can be
 * stale *and* still carry archive/model provenance, and the UI must not relabel
 * one as the other.
 *
 * IMPORTANT:
 * - The polling fetch targets /api/v1/live-firms on the running API server.
 * - In production the server must be running (npm run api) for real data.
 * - Mock data is only available when VITE_ALLOW_MOCK_LIVE=1 is set in the environment.
 * - The LIVE label is never applied outside this module — provenance flows through
 *   the data pipeline so the UI can style accordingly.
 * - When mock mode is on the UI shows a "DEMO DATA" badge so operators know
 *   the data is not live.
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { apiFetch } from './api';
import { withRequestTimeout, RequestTimeoutError } from './request';

/** Shape of one live fire entry – matches the LiveFire tuple type used in the bundle. */
export type LiveFire = [number, number, number, number, number, number]; // [lat, lon, frp, sensorId, confidence, unixSeconds]

/** Aggregated live window metadata returned by the API endpoint. */
export interface LiveWindowMeta {
  /** Not emitted by the current server; `fetchedAt` is the authoritative timestamp. */
  generatedAt?: string;
  windowStart: string;
  windowEnd: string;
  sensors: string[];
}

/** Full response from /api/v1/live-firms (success case). */
export interface LiveFirmsResponse {
  data: LiveFire[];
  /** Server sends the same array under both `fires` and `data`; either is accepted. */
  fires?: LiveFire[];
  count?: number;
  /** Unix milliseconds of the upstream fetch that produced this payload. */
  fetchedAt?: number;
  perSatelliteCounts?: Record<string, number>;
  /** True when the server is serving its cache beyond TTL. */
  stale?: boolean;
  meta: LiveWindowMeta;
}

/** Error envelope from /api/v1/live-firms (503 not_configured / offline). */
export interface LiveFirmsErrorBody {
  error?: string;
  message?: string;
  stale?: boolean;
}

/** Provenance source used by the UI to style provenance-hatched outputs. */
export type DataSource = 'model' | 'live' | 'blend' | 'archive';

/**
 * Transport state — how the last request to the live endpoint went. Deliberately
 * distinct from `DataSource` (where the numbers come from) and from the payload's
 * own `stale` freshness flag.
 */
export type TransportStatus = 'loading' | 'live' | 'stale' | 'offline' | 'not_configured';

/** Last payload that actually arrived from the upstream feed, kept for stale fallback. */
export interface LiveGood {
  data: LiveFire[];
  meta: LiveWindowMeta;
  provenance: DataSource;
  fetchedAt: number | null;
}

/** Everything the hook exposes: transport state, payload, provenance and freshness. */
export interface LivePayload {
  status: TransportStatus;
  data: LiveFire[];
  meta: LiveWindowMeta | null;
  provenance: DataSource | null;
  fetchedAt: number | null;
  error: string | null;
}

export const LIVE_INITIAL: LivePayload = {
  status: 'loading',
  data: [],
  meta: null,
  provenance: null,
  fetchedAt: null,
  error: null,
};

function fallback(previous: LiveGood | null, error: string): LivePayload {
  if (previous) {
    return {
      status: 'stale',
      data: previous.data,
      meta: previous.meta,
      provenance: previous.provenance,
      fetchedAt: previous.fetchedAt,
      error,
    };
  }
  return { status: 'offline', data: [], meta: null, provenance: null, fetchedAt: null, error };
}

/**
 * Pure classifier for an HTTP result from /api/v1/live-firms. Separated from the
 * hook so the transport/provenance/freshness rules are testable without React.
 *
 * - 503 `not_configured` → 'not_configured' (no live feed at all; no payload).
 * - 503 with a last-known-good → 'stale' carrying that payload; otherwise 'offline'.
 * - Other non-2xx / unparseable body → same fallback rule.
 * - 2xx with a valid payload → 'stale' when the server's cache flag says so,
 *   else 'live'. Provenance stays 'live' in both cases: the numbers did come
 *   from the live feed; only their freshness differs.
 */
export function classifyLiveResponse(
  httpStatus: number,
  body: (Partial<LiveFirmsResponse> & LiveFirmsErrorBody) | null,
  previous: LiveGood | null,
): LivePayload {
  const message = typeof body?.message === 'string' ? body.message : null;

  if (httpStatus === 503 && body?.error === 'not_configured') {
    return {
      status: 'not_configured',
      data: [],
      meta: null,
      provenance: null,
      fetchedAt: null,
      error: message ?? 'live data not configured',
    };
  }
  if (httpStatus === 503) {
    return fallback(previous, message ?? 'live FIRMS data offline');
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return fallback(previous, message ?? `HTTP ${httpStatus} from live-firms`);
  }

  const data = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.fires)
      ? body.fires
      : null;
  const meta = body?.meta;
  const validMeta =
    !!meta &&
    typeof meta.windowStart === 'string' &&
    typeof meta.windowEnd === 'string' &&
    Array.isArray(meta.sensors);
  if (!data || !validMeta) {
    return fallback(previous, 'malformed live-firms response');
  }

  const fetchedAt =
    typeof body?.fetchedAt === 'number' && body.fetchedAt > 0 ? body.fetchedAt : null;
  return {
    status: body?.stale === true ? 'stale' : 'live',
    data,
    meta,
    provenance: 'live',
    fetchedAt,
    error: null,
  };
}

/**
 * Polls /api/v1/live-firms every `intervalMs` (default 10 min = 600_000 ms) and
 * returns the latest transport state, payload, provenance and freshness. The
 * last upstream payload is retained so a failed poll can be marked 'stale'
 * instead of blanking the display.
 *
 * `status`:
 *   'loading' — initial fetch in progress
 *   'live' — fresh payload from the endpoint
 *   'stale' — cached upstream payload (server stale flag) or last-known-good after a failure
 *   'offline' — no payload available and no last-known-good
 *   'not_configured' — server has no FIRMS_MAP_KEY; there is no live feed
 */
export function useLiveFirms(
  intervalMs = 600_000, // 10 minutes
): LivePayload & { refresh: () => void } {
  const lastGood = useRef<LiveGood | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const [state, setState] = useState<LivePayload>(LIVE_INITIAL);

  const fetchLiveFirms = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    let httpStatus = 0;
    let body: (Partial<LiveFirmsResponse> & LiveFirmsErrorBody) | null = null;
    try {
      const result = await withRequestTimeout(async signal => {
        const res = await apiFetch('/live-firms', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal,
        // NOTE: In production the API server must be running (npm run api).
        // The server (server/api.mjs) handles the rate class and the key.
      });
        return { status: res.status, body: await res.json().catch(() => null) };
      });
      httpStatus = result.status;
      body = result.body as
        | (Partial<LiveFirmsResponse> & LiveFirmsErrorBody)
        | null;
    } catch (err) {
      body = {
        error: 'offline',
        message: err instanceof RequestTimeoutError ? 'Live API timeout. Using bundled snapshot.' : err instanceof Error ? err.message : 'unknown network error',
      };
    }
    inFlight.current = false;
    if (!mounted.current) return;

    const next = classifyLiveResponse(httpStatus, body, lastGood.current);
    if (next.provenance === 'live' && next.meta) {
      lastGood.current = {
        data: next.data,
        meta: next.meta,
        provenance: next.provenance,
        fetchedAt: next.fetchedAt,
      };
    }
    setState(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    fetchLiveFirms();
    timerRef.current = setInterval(fetchLiveFirms, intervalMs);

    return () => {
      mounted.current = false;
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [fetchLiveFirms, intervalMs]);

  return { ...state, refresh: fetchLiveFirms };
}

/**
 * Mock live FIRMS data — used only when VITE_ALLOW_MOCK_LIVE=1 is set in the
 * environment (e.g. local dev, early T2 flow before the backfill is complete).
 * This data mirrors the structure of live_fires.json: a 7-day rolling window
 * of FIRMS detections. The counts are representative but not derived from a
 * live keyed backfill — they are intentionally static so the UI can render
 * without blocking.
 *
 * Provenance: these are labelled 'model' so the UI can hatch/stale them
 * consistently with the rest of the record that is also 'model' until the
 * archive backfill runs.
 *
 * The UI must render a "DEMO DATA" badge when this data is in use.
 */
const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
export const ALLOW_MOCK_LIVE = viteEnv?.VITE_ALLOW_MOCK_LIVE === '1';

export const useMockLiveFirms = (
  onUpdate: (data: LiveFire[], meta: LiveWindowMeta) => void,
  onError: (error: string) => void,
  intervalMs = 600_000,
) => {
  const [status, setStatus] = useState<'model' | 'stale'>('model');

  const fetchMockFirms = useCallback(async () => {
    if (!ALLOW_MOCK_LIVE) return;
    // Static mock data — 9 fires across the four sensors
    const fires: LiveFire[] = [
      [-12.0, -77.0, 12.5, 1, 1, Date.now()],
      [-11.8, -77.2, 8.3, 1, 1, Date.now()],
      [-12.1, -76.9, 15.0, 1, 1, Date.now()],
      [-12.3, -77.1, 6.7, 1, 1, Date.now()],
      [-12.4, -77.3, 20.1, 1, 1, Date.now()],
      [-11.9, -77.0, 10.2, 1, 1, Date.now()],
      [-12.2, -77.2, 18.4, 1, 1, Date.now()],
      [-10.5, -78.0, 25.3, 1, 1, Date.now()],
      [-13.0, -76.5, 30.1, 1, 1, Date.now()],
    ];
    const meta: LiveWindowMeta = {
      generatedAt: new Date().toISOString(),
      windowStart: '2026-10-20',
      windowEnd: '2026-10-27',
      sensors: ['MODIS', 'VIIRS S-NPP', 'NOAA-20', 'NOAA-21'],
    };
    setStatus('model');
    onUpdate(fires, meta);
  }, [onUpdate]);

  useEffect(() => {
    if (!ALLOW_MOCK_LIVE) return;
    fetchMockFirms();
    const interval = setInterval(fetchMockFirms, intervalMs);
    return () => clearInterval(interval);
  }, [onUpdate, intervalMs, ALLOW_MOCK_LIVE]);

  return { status, setStatus };
};

/**
 * Derives a DataSource provenance label from the provided live fire data.
 * When the API server is running and serving real data, callers should pass
 * 'live'. When only mock data is in use, 'model' is the correct label so the
 * UI applies consistent hatching/styling.
 *
 * @param fires The live fire data array
 * @param source Optional explicit source; defaults to 'model' when mock data is used
 * @returns A DataSource label
 */
export function deriveDataSource(fires: LiveFire[], source?: DataSource): DataSource {
  if (source) return source;
  if (fires.length === 0) return 'model';
  // If all have confidence=1 (nominal) default to model; otherwise blend/archive
  const allNominal = fires.every((f) => f[4] === 1);
  return allNominal ? 'model' : 'blend';
}

/**
 * Counts live fires per sensor from the provided data.
 * Returns an object with counts per sensor key.
 */
export function countBySensor(fires: LiveFire[]): Record<string, number> {
  const out: Record<string, number> = { modis: 0, viirs: 0, noaa20: 0, noaa21: 0 };
  for (const f of fires) {
    const sensorId = f[3];
    if (sensorId === 0) out.modis++;
    else if (sensorId === 1) out.viirs++;
    else if (sensorId === 2) out.noaa20++;
    else if (sensorId === 3) out.noaa21++;
  }
  return out;
}

/**
 * Computes the total FRP (Fire Radiative Power) from the provided live fire data.
 * FRP is in the third column (index 2) of each LiveFire tuple, in MW.
 */
export function totalFrp(fires: LiveFire[]): number {
  let sum = 0;
  for (const f of fires) {
    sum += f[2];
  }
  return sum;
}

/**
 * Returns the most recent window end date from the provided metadata, or today's
 * date formatted as ISO if meta is not available.
 */
export function windowEndMeta(meta?: LiveWindowMeta): string {
  if (!meta) return new Date().toISOString().slice(0, 10);
  return meta.windowEnd;
}

/**
 * Checks whether the live fire data represents a full 7-day window.
 * A full window has exactly 7 distinct dates covered by detections.
 * (mock data is intentionally sparse, so the meta reports the window.)
 */
export function isFullWindow(fires: LiveFire[]): boolean {
  if (!fires.length) return false;
  const dates = new Set<string>();
  for (const f of fires) {
    if (Array.isArray(f) && f.length >= 6 && typeof f[5] === 'number') {
      dates.add(new Date(f[5] * 1000).toISOString().slice(0, 10));
    }
  }
  return dates.size >= 7;
}
