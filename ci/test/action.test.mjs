// The composite action as GitHub runs it: its bash step, with the inputs in the environment, against the fake API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeApi, KEY_AUDIT } from './fake-api.mjs';

const ACTION = new URL('../../', import.meta.url).pathname;

async function stepScript() {
  const yml = await readFile(join(ACTION, 'action.yml'), 'utf8');
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'run: |');
  const body = [];
  for (const l of lines.slice(start + 1)) { if (l && !l.startsWith('        ')) break; body.push(l.slice(8)); }
  return body.join('\n');
}

async function runAction(inputs, api) {
  const dir = await mkdtemp(join(tmpdir(), 'pga-'));
  const summary = join(dir, 'summary.md'), output = join(dir, 'output');
  await writeFile(summary, ''); await writeFile(output, '');
  const env = {
    PATH: process.env.PATH, GITHUB_ACTION_PATH: ACTION, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output,
    PERIMETRY_API_KEY: KEY_AUDIT, PERIMETRY_API_URL: api.url, PERIMETRY_DOMAIN: 'example.com',
    IN_MODE: 'run', IN_TIMEOUT: '1', IN_MIN_SCORE: '', IN_FAIL_ON_DROP: 'true', IN_MAX_DROP: '0', IN_FAIL_ON_NEW: 'critical', IN_FAIL_ON_OPEN: 'none', IN_ON_TOO_SOON: 'latest', IN_LANG: 'en',
    ...inputs,
  };
  const script = await stepScript();
  const r = await new Promise((resolve) => execFile('bash', ['-e', '-c', script], { env, timeout: 90_000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
  return { ...r, summary: await readFile(summary, 'utf8'), output: await readFile(output, 'utf8'), result: await readFile(join(dir, 'perimetry-result.json'), 'utf8').catch(() => '') };
}

test('the action fails the job on a drop, and passes once the thresholds allow it', async () => {
  const api = await fakeApi();
  try {
    let r = await runAction({}, api);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.summary, /❌ Failed/);
    assert.match(r.output, /^result-file=.*perimetry-result\.json$/m);
    assert.equal(JSON.parse(r.result).passed, false);
    r = await runAction({ IN_MODE: 'latest', IN_FAIL_ON_DROP: 'false', IN_FAIL_ON_NEW: 'none', IN_MIN_SCORE: '60' }, api);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.output, /^passed=true$/m);
  } finally { await api.close(); }
});

test('without the CLI next to it, the action fails clearly and fetches nothing (the key goes nowhere)', async () => {
  const api = await fakeApi();
  try {
    const lone = await mkdtemp(join(tmpdir(), 'pga-lone-'));
    const r = await runAction({ GITHUB_ACTION_PATH: lone, PATH: '/usr/bin:/bin' }, api);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /::error title=Perimetry Cloud::The command of this action/);
    assert.equal(api.state.requests.length, 0);
    assert.ok(!(await readFile(join(ACTION, 'action.yml'), 'utf8')).includes('npx'), 'no package fetched by name');
  } finally { await api.close(); }
});

test('the action refuses a bad timeout, and an input cannot inject a command', async () => {
  const api = await fakeApi();
  try {
    let r = await runAction({ IN_TIMEOUT: '5; echo pwned' }, api);
    assert.equal(r.code, 2);
    assert.ok(!r.stdout.includes('pwned') || r.stdout.includes('::error'));
    r = await runAction({ IN_MODE: 'latest', IN_LANG: '$(echo pwned)', IN_FAIL_ON_NEW: 'none', IN_FAIL_ON_DROP: 'false' }, api);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('pwned'));
  } finally { await api.close(); }
});
