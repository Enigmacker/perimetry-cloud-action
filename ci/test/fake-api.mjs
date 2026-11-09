// A stand-in for the Perimetry Cloud API v1, for the tests of the CLI and of the MCP server: the same routes and
// shapes, a few domains, an audit that goes queued → running → done, and a record of every request.
import { createServer } from 'node:http';

export const KEY_READ = 'pc_readreadreadreadreadreadread01';
export const KEY_AUDIT = 'pc_auditauditauditauditauditaud01';

export function fakeApi(opts = {}) {
  const state = {
    requests: [], polls: 0, runs: 0,
    score: opts.score ?? 70, previousScore: opts.previousScore ?? 80,
    added: opts.added ?? [{ fp: 'f1', id: 'web.tls.expired', severity: 'critical', title: 'Certificate expired | <b>bad</b> **x** ::set-output', target: 'www.example.com' }],
    tooSoon: Boolean(opts.tooSoon), neverFinishes: Boolean(opts.neverFinishes), failRun: Boolean(opts.failRun),
    rateLimitOnce: Boolean(opts.rateLimitOnce),
  };
  const domain = { id: '11111111-1111-4111-8111-111111111111', name: 'example.com', status: 'verified', verified: true, client: null, score: state.score, grade: 'C', counts: { critical: 1, high: 2, medium: 0, low: 0, info: 0 }, lastAuditAt: '2026-11-09T10:00:00.000Z', nextAuditAt: null, attention: true, links: { app: 'https://app.perimetry.cloud/domains/11111111-1111-4111-8111-111111111111', api: '/api/v1/domains/11111111-1111-4111-8111-111111111111' } };
  const pending = { ...domain, id: '22222222-2222-4222-8222-222222222222', name: 'pending.org', status: 'pending', verified: false };
  const audit = () => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', startedAt: '2026-11-09T10:00:00.000Z', score: state.score, grade: 'C', counts: domain.counts });
  const previous = () => ({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', startedAt: '2026-11-02T10:00:00.000Z', score: state.previousScore, grade: 'B' });
  const runOut = (status) => ({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status, domain: { id: domain.id, name: domain.name }, progress: status === 'running' ? { percent: 40, step: 'DNS' } : null, audit: status === 'done' ? audit() : null, previous: previous(), scoreDelta: status === 'done' ? state.score - state.previousScore : null, ...(status === 'failed' ? { error: 'the audit did not finish; the next scheduled audit will run as usual' } : {}) });
  const find = (ref) => [domain, pending].find((d) => d.id === ref || d.name === decodeURIComponent(ref));

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization ?? '' });
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'perimetry-api-version': '1', ...headers }); res.end(JSON.stringify(body)); };
    const auth = req.headers.authorization ?? '';
    const key = auth.replace(/^Bearer /, '');
    if (key !== KEY_READ && key !== KEY_AUDIT) return send(401, { error: 'invalid API key', code: 'unauthorized' });
    if (state.rateLimitOnce) { state.rateLimitOnce = false; return send(429, { error: 'this plan allows 300 API calls an hour', code: 'rate_limited' }, { 'retry-after': '1' }); }
    const scopes = key === KEY_AUDIT ? ['read', 'audit'] : ['read'];
    let m;
    if (url.pathname === '/api/v1/me') return send(200, { apiVersion: 1, workspace: { name: 'Acme', plan: 'solo' }, key: { name: 'CI', prefix: key.slice(0, 8), scopes }, rateLimit: { limit: 300, remaining: 299, resetAt: '2026-11-09T11:00:00.000Z' } });
    if (url.pathname === '/api/v1/domains') return send(200, { apiVersion: 1, domains: [domain, pending] });
    if ((m = /^\/api\/v1\/domains\/([^/]+)$/.exec(url.pathname))) {
      const d = find(m[1]); if (!d) return send(404, { error: 'not found', code: 'not_found' });
      return send(200, { apiVersion: 1, domain: d, lastAudit: d.verified ? { ...audit(), trigger: 'schedule', previous: previous(), scoreDelta: state.score - state.previousScore } : null, doFirst: state.added });
    }
    if ((m = /^\/api\/v1\/domains\/([^/]+)\/compare$/.exec(url.pathname))) {
      const d = find(m[1]); if (!d) return send(404, { error: 'not found', code: 'not_found' });
      return send(200, { apiVersion: 1, domain: { id: d.id, name: d.name }, audit: audit(), previous: previous(), comparison: { score: { from: state.previousScore, to: state.score, delta: state.score - state.previousScore }, added: state.added, resolved: [], severityChanged: [], infra: {} } });
    }
    if ((m = /^\/api\/v1\/domains\/([^/]+)\/findings$/.exec(url.pathname))) {
      const d = find(m[1]); if (!d) return send(404, { error: 'not found', code: 'not_found' });
      return send(200, { apiVersion: 1, domain: { id: d.id, name: d.name }, audit: audit(), total: 1, findings: state.added.map((f) => ({ ...f, fix: 'Renew it.', records: [], compliance: ['NIS2 21(2)(h)'] })) });
    }
    if ((m = /^\/api\/v1\/domains\/([^/]+)\/audit$/.exec(url.pathname)) && req.method === 'POST') {
      if (!scopes.includes('audit')) return send(403, { error: 'this API key cannot start audits', code: 'insufficient_scope' });
      if (state.tooSoon) return send(429, { error: 'One audit on demand per hour on this plan.', code: 'audit_too_soon' });
      state.runs++;
      return send(202, { apiVersion: 1, queued: true, alreadyQueued: false, run: runOut('queued') });
    }
    if ((m = /^\/api\/v1\/runs\/([^/]+)$/.exec(url.pathname))) {
      state.polls++;
      const status = state.neverFinishes ? 'running' : state.polls < 2 ? 'running' : state.failRun ? 'failed' : 'done';
      return send(200, { apiVersion: 1, run: runOut(status) });
    }
    return send(404, { error: 'not found', code: 'not_found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((r) => server.close(r)) })));
}
