import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeApi, KEY_AUDIT, KEY_READ } from './fake-api.mjs';
import { evaluate } from '../src/gate.mjs';
import { md, markdownSummary } from '../src/summary.mjs';
import { apiBase, createClient } from '../src/client.mjs';

const BIN = new URL('../bin/perimetry-ci.mjs', import.meta.url).pathname;

/** Runs the real command, as a CI job would, and collects what it printed and wrote. */
async function cli(args, { key = KEY_AUDIT, api, extraEnv = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pci-'));
  const summary = join(dir, 'summary.md'), output = join(dir, 'output'), json = join(dir, 'result.json');
  await writeFile(summary, ''); await writeFile(output, '');
  const env = { PATH: process.env.PATH, PERIMETRY_API_KEY: key, PERIMETRY_API_URL: api.url, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, ...extraEnv };
  const r = await new Promise((resolve) => execFile(process.execPath, [BIN, 'check', '--poll', '1', '--json', json, ...args], { env, timeout: 60_000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
  const read = (f) => readFile(f, 'utf8').catch(() => '');
  return { ...r, summary: await read(summary), output: await read(output), json: await read(json) };
}

test('gate: minimum score, drop, new findings, open findings', () => {
  const o = { minScore: null, failOnDrop: true, maxDrop: 0, failOnNew: 'critical', failOnOpen: 'none' };
  assert.deepEqual(evaluate({ score: 80, previousScore: 80, newFindings: [], counts: {} }, o), { passed: true, reasons: [] });
  assert.equal(evaluate({ score: 79, previousScore: 80, newFindings: [], counts: {} }, o).passed, false);
  assert.equal(evaluate({ score: 78, previousScore: 80, newFindings: [], counts: {} }, { ...o, maxDrop: 2 }).passed, true, 'within the allowed drop');
  assert.equal(evaluate({ score: 70, previousScore: 80, newFindings: [], counts: {} }, { ...o, failOnDrop: false }).passed, true);
  assert.equal(evaluate({ score: 90, previousScore: null, newFindings: [], counts: {} }, o).passed, true, 'first audit: nothing to compare');
  assert.match(evaluate({ score: 60, previousScore: 60, newFindings: [], counts: {} }, { ...o, minScore: 70 }).reasons[0], /below the minimum of 70/);
  assert.equal(evaluate({ score: 80, previousScore: 80, newFindings: [{ severity: 'high' }], counts: {} }, o).passed, true, 'a new high finding does not fail on "critical"');
  assert.equal(evaluate({ score: 80, previousScore: 80, newFindings: [{ severity: 'high' }], counts: {} }, { ...o, failOnNew: 'high' }).passed, false);
  assert.equal(evaluate({ score: 80, previousScore: 80, newFindings: [{ severity: 'critical' }], counts: {} }, { ...o, failOnNew: 'none' }).passed, true);
  assert.equal(evaluate({ score: 80, previousScore: 80, newFindings: [], counts: { high: 1 } }, { ...o, failOnOpen: 'high' }).passed, false);
  assert.equal(evaluate({ score: 80, previousScore: 80, newFindings: [], counts: { medium: 3 } }, { ...o, failOnOpen: 'high' }).passed, true);
});

test('summary: text from audited sites cannot become markup or workflow commands', () => {
  assert.equal(md('a|b <script> **x** [l](u)'), 'a\\|b \\<script\\> \\*\\*x\\*\\* \\[l\\]\\(u\\)');
  assert.equal(md('line\nbreak‮evil'), 'line break evil');
  assert.equal(md('x'.repeat(500)).length, 160);
  const s = markdownSummary({ passed: false, reasons: ['score dropped'], domain: { name: 'example.com' }, audit: { score: 70, grade: 'C', counts: {} }, scoreDelta: -10, newFindings: [{ severity: 'critical', title: '</details><img src=x onerror=alert(1)>', target: 'a|b' }], topFindings: [], links: { app: 'https://app.perimetry.cloud/domains/1' } });
  assert.ok(!/(^|[^\\])<img/.test(s) && s.includes('\\<img') && s.includes('a\\|b'));
});

test('summary: addresses quoted from sites never become automatic links', () => {
  const s = md('Go to https://evil.example/login, www.evil.example or admin@evil.example');
  assert.ok(!/https:\/\/evil/.test(s) && s.includes('https://​evil'), 'nothing right after ://');
  assert.ok(!/www\.evil/.test(s) && s.includes('www.​evil'), 'nothing right after www.');
  assert.ok(!/@evil/.test(s) && s.includes('@​evil'), 'nothing right after @');
  assert.ok(md('WWW.X.example').includes('WWW.​X'), 'whatever the case');
  const full = markdownSummary({ passed: true, reasons: [], domain: { name: 'example.com' }, audit: { score: 90, grade: 'A', counts: {} }, scoreDelta: null, newFindings: [{ severity: 'high', title: 'Redirects to http://phish.example', target: 'www.example.com' }], topFindings: [], links: { app: 'https://app.perimetry.cloud/domains/1' } });
  assert.ok(!full.includes('http://phish') && !full.includes('www.example.com'), 'none in the whole summary');
  assert.ok(full.includes('(https://app.perimetry.cloud/domains/1)'), 'our own report link stays a link');
});

test('client: refuses plain http except on this machine, and a malformed key', () => {
  assert.throws(() => apiBase('http://app.perimetry.cloud'), /https/);
  assert.equal(apiBase('http://127.0.0.1:3000/x'), 'http://127.0.0.1:3000');
  assert.throws(() => createClient({ apiKey: 'nope' }), /PERIMETRY_API_KEY/);
});

test('run mode: starts an audit, waits, fails on the drop and the new critical finding, writes the summary and outputs', async () => {
  const api = await fakeApi();
  try {
    const r = await cli(['--domain', 'example.com'], { api });
    assert.equal(r.code, 1, r.stderr);
    assert.equal(api.state.runs, 1);
    assert.ok(api.state.polls >= 2, 'polled until done');
    const res = JSON.parse(r.json);
    assert.equal(res.passed, false);
    assert.equal(res.audit.score, 70); assert.equal(res.previous.score, 80); assert.equal(res.scoreDelta, -10);
    assert.equal(res.reasons.length, 2);
    assert.match(r.summary, /❌ Failed/); assert.match(r.summary, /score dropped from 80 to 70/);
    assert.ok(!r.summary.includes('<b>') && r.summary.includes('\\<b\\>'), 'titles escaped in the summary');
    assert.ok(!/^::/m.test(r.stdout), 'no line of output can be read as a workflow command');
    assert.match(r.output, /^passed=false$/m); assert.match(r.output, /^score=70$/m); assert.match(r.output, /^previous-score=80$/m); assert.match(r.output, /^report-url=https:\/\/app\.perimetry\.cloud\/domains\//m);
    for (const text of [r.stdout, r.stderr, r.summary, r.output, r.json]) assert.ok(!text.includes(KEY_AUDIT), 'the key is never printed or written');
    assert.ok(api.state.requests.every((q) => q.auth === `Bearer ${KEY_AUDIT}` && !JSON.stringify(q.query).includes('pc_')), 'the key goes in the header only');
  } finally { await api.close(); }
});

test('run mode: passes when nothing got worse', async () => {
  const api = await fakeApi({ score: 85, previousScore: 80, added: [{ fp: 'f2', id: 'web.headers.csp', severity: 'medium', title: 'No CSP', target: 'example.com' }] });
  try {
    const r = await cli(['--domain', 'example.com', '--min-score', '80'], { api });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.summary, /✅ Passed/); assert.match(r.output, /^passed=true$/m); assert.match(r.output, /^score-delta=5$/m);
  } finally { await api.close(); }
});

test('latest mode with a read-only key reads the last audit and never starts one', async () => {
  const api = await fakeApi({ score: 80, previousScore: 80, added: [] });
  try {
    const r = await cli(['--domain', 'example.com', '--mode', 'latest'], { api, key: KEY_READ });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(api.state.runs, 0);
    assert.ok(!api.state.requests.some((q) => q.method === 'POST'));
  } finally { await api.close(); }
});

test('a read-only key in run mode is a clear configuration error', async () => {
  const api = await fakeApi();
  try {
    const r = await cli(['--domain', 'example.com'], { api, key: KEY_READ });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /read-only/);
    assert.match(r.output, /^passed=false$/m);
  } finally { await api.close(); }
});

test('an audit asked too soon falls back to the latest one (or fails when asked to)', async () => {
  const api = await fakeApi({ tooSoon: true, score: 80, previousScore: 80, added: [] });
  try {
    let r = await cli(['--domain', 'example.com'], { api });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /latest audit is used instead/);
    r = await cli(['--domain', 'example.com', '--on-too-soon', 'fail'], { api });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /audit_too_soon/);
  } finally { await api.close(); }
});

test('timeout, failed audit, unknown or unproved domain, wrong key, rate limit retried', async () => {
  let api = await fakeApi({ neverFinishes: true });
  try {
    const r = await cli(['--domain', 'example.com', '--timeout', '5', '--poll', '2'], { api });
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.summary, /Timed out/);
  } finally { await api.close(); }
  api = await fakeApi({ failRun: true });
  try {
    const r = await cli(['--domain', 'example.com'], { api });
    assert.equal(r.code, 2); assert.match(r.stderr, /did not finish/);
    assert.equal((await cli(['--domain', 'nope.org'], { api })).code, 2);
    const p = await cli(['--domain', 'pending.org'], { api });
    assert.equal(p.code, 2); assert.match(p.stderr, /not proved/);
    const bad = await cli(['--domain', 'example.com'], { api, key: 'pc_wrongwrongwrongwrongwrong0001' });
    assert.equal(bad.code, 2); assert.match(bad.stderr, /401/);
    assert.ok(!bad.stderr.includes('pc_wrong'));
    const none = await cli(['--domain', 'example.com'], { api, key: '' });
    assert.equal(none.code, 2); assert.match(none.stderr, /PERIMETRY_API_KEY/);
  } finally { await api.close(); }
  api = await fakeApi({ rateLimitOnce: true, score: 80, previousScore: 80, added: [] });
  try {
    const r = await cli(['--domain', 'example.com', '--mode', 'latest'], { api });
    assert.equal(r.code, 0, r.stderr);
  } finally { await api.close(); }
});

test('bad options are refused with the help', async () => {
  const api = await fakeApi();
  try {
    for (const args of [['--domain', 'example.com', '--mode', 'later'], ['--domain', 'example.com', '--min-score', '120'], ['--domain', 'example.com', '--fail-on-new', 'severe'], ['--domain', 'example.com', '--api-url', 'http://evil.example']]) {
      const r = await cli(args, { api });
      assert.equal(r.code, 2, args.join(' '));
    }
    assert.equal(api.state.requests.length, 0, 'nothing sent before the options are valid');
  } finally { await api.close(); }
});
