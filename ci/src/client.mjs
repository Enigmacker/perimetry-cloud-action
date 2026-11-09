// A small client of the Perimetry Cloud API v1, with no dependency (fetch of Node 20 and later).
// The key is sent in the Authorization header only: it is never logged, never put in a URL, never echoed.

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The base address, refused when it is plain http anywhere but on this machine (the key would travel in clear). */
export function apiBase(url) {
  let u;
  try { u = new URL(url); } catch { throw new ApiError(0, 'config', `not a valid API address: ${String(url).slice(0, 100)}`); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.has(u.hostname))) throw new ApiError(0, 'config', 'the API address must use https');
  return u.origin;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ apiUrl?: string, apiKey: string, fetch?: typeof fetch, userAgent?: string, retries?: number, maxWaitMs?: number }} o
 */
export function createClient({ apiUrl = 'https://app.perimetry.cloud', apiKey, fetch: f = globalThis.fetch, userAgent = 'perimetry-cloud-ci', retries = 3, maxWaitMs = 120_000 }) {
  if (!apiKey || !/^pc_[A-Za-z0-9_-]{20,}$/.test(apiKey)) throw new ApiError(0, 'config', 'PERIMETRY_API_KEY is missing or is not a Perimetry Cloud API key (it starts with pc_)');
  const base = apiBase(apiUrl);
  async function call(method, path, query) {
    const qs = query ? Object.entries(query).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';
    const url = `${base}${path}${qs ? `?${qs}` : ''}`;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await f(url, { method, headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'user-agent': userAgent }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue; }
        throw new ApiError(0, 'network', `could not reach ${base}: ${String(e?.cause?.code ?? e?.name ?? 'network error')}`);
      }
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      if (res.ok) return body;
      const code = body?.code ?? (res.status >= 500 ? 'server' : 'error');
      // The hourly limit or a busy server: wait as told (bounded), then try again. Other refusals are final.
      const retryable = (res.status === 429 && code === 'rate_limited') || res.status === 502 || res.status === 503 || res.status === 504;
      if (retryable && attempt < retries) {
        const after = Number(res.headers.get('retry-after')) * 1000;
        const wait = Math.min(maxWaitMs, Number.isFinite(after) && after > 0 ? after : 2000 * 2 ** attempt);
        if (wait < maxWaitMs || res.status !== 429) { await sleep(wait); continue; }
      }
      throw new ApiError(res.status, code, String(body?.error ?? `HTTP ${res.status}`).slice(0, 300));
    }
  }
  const ref = (d) => encodeURIComponent(String(d));
  return {
    base,
    me: () => call('GET', '/api/v1/me'),
    domains: (q) => call('GET', '/api/v1/domains', q),
    domain: (d, q) => call('GET', `/api/v1/domains/${ref(d)}`, q),
    findings: (d, q) => call('GET', `/api/v1/domains/${ref(d)}/findings`, q),
    compare: (d, q) => call('GET', `/api/v1/domains/${ref(d)}/compare`, q),
    startAudit: (d) => call('POST', `/api/v1/domains/${ref(d)}/audit`),
    run: (id) => call('GET', `/api/v1/runs/${ref(id)}`),
  };
}
