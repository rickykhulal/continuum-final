/** Bound the whole operation, including response decoding or an API-key retry. */
export class RequestTimeoutError extends Error {
  constructor() { super('Request timed out.'); this.name = 'RequestTimeoutError'; }
}

export async function withRequestTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new RequestTimeoutError()); controller.abort(); }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export function fetchJsonWithTimeout<T>(url: string, timeoutMs = 10_000, init: RequestInit = {}): Promise<T> {
  return withRequestTimeout(async signal => {
    const response = await fetch(url, { ...init, signal });
    if (!response.ok) throw new Error(`Data request failed (HTTP ${response.status}).`);
    return response.json() as Promise<T>;
  }, timeoutMs);
}
