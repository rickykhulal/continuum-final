export interface ReportLocation { locationName: string; lat: number; lon: number }

export async function searchReportLocations(query: string, signal?: AbortSignal): Promise<ReportLocation[]> {
  if (query.trim().length < 2) return [];
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.search = new URLSearchParams({ name: query.trim(), count: '5', language: 'en', format: 'json' }).toString();
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 10000);
  try {
    const response = await fetch(url.href, { signal: controller.signal });
    if (!response.ok) throw new Error(`Location search unavailable (HTTP ${response.status}).`);
    const body = await response.json();
    if (body.results == null) return [];
    if (!Array.isArray(body.results)) throw new Error('Location search returned invalid data.');
    return body.results.filter((r: any) => typeof r.name === 'string'
      && typeof r.latitude === 'number' && Number.isFinite(r.latitude) && Math.abs(r.latitude) <= 90
      && typeof r.longitude === 'number' && Number.isFinite(r.longitude) && Math.abs(r.longitude) <= 180)
      .slice(0, 5).map((r: any) => ({ locationName: [r.name, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude }));
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error('Location search timed out. Try again or enter coordinates.');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
