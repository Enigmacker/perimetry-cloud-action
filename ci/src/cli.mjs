// perimetry-ci: run (or read) an audit of a proved domain in CI and fail the build when it gets worse.
// Exit codes: 0 passed, 1 the gate failed, 2 configuration or API error, 3 the audit did not finish in time.
import { parseArgs } from 'node:util';
import { appendFile, writeFile } from 'node:fs/promises';
import { createClient, ApiError } from './client.mjs';
import { evaluate, SEVERITIES } from './gate.mjs';
import { markdownSummary, consoleSummary } from './summary.mjs';

export const VERSION = '0.1.0';

const HELP = `perimetry-ci ${VERSION}: Perimetry Cloud in your CI

Usage: perimetry-ci check --domain <name or id> [options]

The API key is read from the PERIMETRY_API_KEY environment variable (never from an argument).

  --domain <d>          the proved domain (example.com) or its id               [PERIMETRY_DOMAIN]
  --mode run|latest     run a new audit and wait for it (default), or read the latest one
  --timeout <seconds>   how long to wait for the audit (default 900, at most 7200)
  --poll <seconds>      how often to ask how the audit is doing (default 15)
  --min-score <n>       fail when the score is below n (0-100; default: no minimum)
  --fail-on-drop <bool> fail when the score is lower than at the previous audit (default true)
  --max-drop <n>        points the score may lose before --fail-on-drop fails (default 0)
  --fail-on-new <sev>   fail when a new finding at or above this severity appears:
                        critical (default), high, medium, low, info or none
  --fail-on-open <sev>  fail when any open finding is at or above this severity (default none)
  --on-too-soon <what>  when an audit on demand ran too recently: latest (read it, default) or fail
  --json <file>         write the result as JSON
  --summary <file>      append a Markdown summary (default: $GITHUB_STEP_SUMMARY when set)
  --lang en|fr          language of finding titles (default en)
  --api-url <url>       default https://app.perimetry.cloud                     [PERIMETRY_API_URL]
  --quiet               print only the final line
  --version, --help
`;

const bool = (v, d) => (v == null ? d : !/^(false|0|no|off)$/i.test(String(v).trim()));
function intIn(v, name, min, max, d) {
  if (v == null || v === '') return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(0, 'config', `--${name} must be a whole number from ${min} to ${max}`);
  return n;
}
function sevOr(v, name, d) {
  if (v == null || v === '') return d;
  const s = String(v).trim().toLowerCase();
  if (s !== 'none' && !SEVERITIES.includes(s)) throw new ApiError(0, 'config', `--${name} must be one of ${SEVERITIES.join(', ')} or none`);
  return s;
}

export function parseOptions(argv, env) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      domain: { type: 'string' }, mode: { type: 'string' }, timeout: { type: 'string' }, 'min-score': { type: 'string' },
      'fail-on-drop': { type: 'string' }, 'max-drop': { type: 'string' }, 'fail-on-new': { type: 'string' }, 'fail-on-open': { type: 'string' },
      'on-too-soon': { type: 'string' }, json: { type: 'string' }, summary: { type: 'string' }, lang: { type: 'string' }, 'api-url': { type: 'string' },
      poll: { type: 'string' }, quiet: { type: 'boolean' }, version: { type: 'boolean' }, help: { type: 'boolean' },
    },
  });
  const command = positionals[0] ?? 'check';
  const mode = values.mode ?? 'run';
  if (!['run', 'latest'].includes(mode)) throw new ApiError(0, 'config', '--mode must be run or latest');
  const onTooSoon = values['on-too-soon'] ?? 'latest';
  if (!['latest', 'fail'].includes(onTooSoon)) throw new ApiError(0, 'config', '--on-too-soon must be latest or fail');
  return {
    command, help: values.help, version: values.version, quiet: Boolean(values.quiet),
    domain: (values.domain ?? env.PERIMETRY_DOMAIN ?? '').trim(),
    mode, onTooSoon,
    timeoutMs: intIn(values.timeout, 'timeout', 5, 7200, 900) * 1000,
    pollMs: intIn(values.poll, 'poll', 1, 120, 15) * 1000,
    minScore: intIn(values['min-score'], 'min-score', 0, 100, null),
    failOnDrop: bool(values['fail-on-drop'], true),
    maxDrop: intIn(values['max-drop'], 'max-drop', 0, 100, 0),
    failOnNew: sevOr(values['fail-on-new'], 'fail-on-new', 'critical'),
    failOnOpen: sevOr(values['fail-on-open'], 'fail-on-open', 'none'),
    json: values.json ?? null,
    summary: values.summary ?? env.GITHUB_STEP_SUMMARY ?? null,
    lang: values.lang === 'fr' ? 'fr' : 'en',
    apiUrl: values['api-url'] ?? env.PERIMETRY_API_URL ?? 'https://app.perimetry.cloud',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Timeout extends Error {}

/** Runs the gate and returns { code, result }; prints through `log` (never the key). */
export async function check(o, { env = process.env, log = console.log, fetch } = {}) {
  if (!o.domain) throw new ApiError(0, 'config', '--domain is required (or PERIMETRY_DOMAIN)');
  const api = createClient({ apiUrl: o.apiUrl, apiKey: env.PERIMETRY_API_KEY, fetch, userAgent: `perimetry-cloud-ci/${VERSION}` });
  const say = (s) => { if (!o.quiet) log(s); };
  const d = (await api.domain(o.domain, { lang: o.lang })).domain;
  if (!d.verified) throw new ApiError(409, 'not_verified', `${d.name} is not proved yet (status: ${d.status}); prove it in Perimetry Cloud first`);
  let audit = null, previous = null, notice = null, runInfo = null;
  if (o.mode === 'run') {
    let started = null;
    try {
      started = await api.startAudit(d.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'audit_too_soon' && o.onTooSoon === 'latest') notice = `No new audit: ${e.message}. The latest audit is used instead.`;
      else if (e instanceof ApiError && e.code === 'insufficient_scope') throw new ApiError(403, e.code, 'this API key is read-only: create one that can start audits, or use --mode latest');
      else throw e;
    }
    if (started) {
      let run = started.run;
      say(`Audit of ${d.name} ${started.alreadyQueued ? 'already queued' : 'queued'}; waiting up to ${Math.round(o.timeoutMs / 60000)} min.`);
      const deadline = Date.now() + o.timeoutMs;
      let last = '';
      while (run.status === 'queued' || run.status === 'running') {
        if (Date.now() > deadline) throw new Timeout(`the audit did not finish within ${Math.round(o.timeoutMs / 1000)} s (it goes on; its result will be on the domain page)`);
        await sleep(o.pollMs);
        run = (await api.run(run.id)).run;
        const now = run.status === 'running' ? `running${run.progress?.percent != null ? ` ${run.progress.percent}%` : ''}` : run.status;
        if (now !== last) { say(`  ${now}`); last = now; }
      }
      if (run.status !== 'done') throw new ApiError(502, 'audit_failed', run.error ?? 'the audit did not finish');
      runInfo = { id: run.id, status: run.status };
      audit = run.audit;
      previous = run.previous;
    }
  }
  const summary = await api.domain(d.id, { lang: o.lang });
  if (!audit) {
    if (!summary.lastAudit) throw new ApiError(404, 'no_audit', `${d.name} has no audit yet`);
    audit = summary.lastAudit;
    previous = summary.lastAudit.previous;
  }
  // New findings: those of this audit that the previous one did not have.
  const cmp = await api.compare(d.id, { lang: o.lang });
  const sameAudit = cmp.audit?.id === audit.id;
  if (!sameAudit) notice = [notice, 'A newer audit finished meanwhile; its comparison is used.'].filter(Boolean).join(' ');
  const newFindings = cmp.comparison?.added ?? [];
  const top = await api.findings(d.id, { min_severity: 'high', limit: 10, lang: o.lang });
  const previousScore = previous?.score ?? null;
  const gate = evaluate({ score: audit.score, previousScore, newFindings, counts: audit.counts ?? {} }, o);
  const result = {
    version: 1, passed: gate.passed, reasons: gate.reasons, mode: o.mode, notice,
    domain: { id: d.id, name: d.name },
    audit: { id: audit.id, startedAt: audit.startedAt, score: audit.score, grade: audit.grade, counts: audit.counts ?? {} },
    previous: previous ? { id: previous.id ?? null, startedAt: previous.startedAt ?? null, score: previous.score, grade: previous.grade ?? null } : null,
    scoreDelta: previousScore == null ? null : audit.score - previousScore,
    newFindings: newFindings.map((f) => ({ severity: f.severity, id: f.id, title: f.title, target: f.target })),
    topFindings: (top.findings ?? []).map((f) => ({ severity: f.severity, id: f.id, title: f.title, target: f.target, fix: f.fix })),
    thresholds: { minScore: o.minScore, failOnDrop: o.failOnDrop, maxDrop: o.maxDrop, failOnNew: o.failOnNew, failOnOpen: o.failOnOpen },
    run: runInfo,
    links: { app: d.links?.app ?? null },
  };
  return { code: gate.passed ? 0 : 1, result };
}

async function githubOutputs(env, result, jsonFile) {
  if (!env.GITHUB_OUTPUT) return;
  const out = {
    passed: String(result.passed), score: String(result.audit.score), grade: String(result.audit.grade),
    'previous-score': result.previous ? String(result.previous.score) : '', 'score-delta': result.scoreDelta == null ? '' : String(result.scoreDelta),
    'new-findings': String(result.newFindings.length), 'report-url': result.links.app ?? '', 'result-file': jsonFile ?? '',
  };
  // One line each; values never hold a line break (all are numbers, words, an address or a path).
  await appendFile(env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, ' ')}`).join('\n') + '\n');
}

export async function main(argv = process.argv.slice(2), env = process.env, { log = console.log, error = console.error, fetch } = {}) {
  let o;
  try { o = parseOptions(argv, env); } catch (e) { error(`perimetry-ci: ${e.message}\n\n${HELP}`); return 2; }
  if (o.help) { log(HELP); return 0; }
  if (o.version) { log(VERSION); return 0; }
  if (o.command !== 'check') { error(`perimetry-ci: unknown command "${o.command}"\n\n${HELP}`); return 2; }
  try {
    const { code, result } = await check(o, { env, log, fetch });
    log(consoleSummary(result));
    if (o.json) await writeFile(o.json, `${JSON.stringify(result, null, 2)}\n`);
    if (o.summary) await appendFile(o.summary, `${markdownSummary(result)}\n`);
    await githubOutputs(env, result, o.json);
    return code;
  } catch (e) {
    const timeout = e instanceof Timeout;
    const msg = e instanceof ApiError ? `${e.message}${e.status ? ` (HTTP ${e.status}${e.code ? `, ${e.code}` : ''})` : ''}` : timeout ? e.message : `unexpected error: ${String(e?.message ?? e).slice(0, 200)}`;
    error(`perimetry-ci: ${msg}`);
    if (o.summary) await appendFile(o.summary, `### Perimetry Cloud — ${timeout ? '⏱️ Timed out' : '⚠️ Error'}\n\n${msg.replace(/[<>|`*_[\]]/g, (c) => `\\${c}`)}\n\n`).catch(() => {});
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, 'passed=false\n').catch(() => {});
    return timeout ? 3 : 2;
  }
}
