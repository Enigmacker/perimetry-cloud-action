import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consoleSummary, line } from '../src/summary.mjs';

const base = { domain: { name: 'example.com' }, audit: { score: 80, grade: 'B' }, scoreDelta: null, newFindings: [], passed: true, reasons: [] };

test('console: no workflow command can come from the API (notice, report link)', () => {
  const out = consoleSummary({ ...base, notice: 'x\n::add-mask::secret\r::set-output name=a::b', links: { app: 'https://app.example\n::error::forged' } });
  for (const l of out.split('\n')) assert.ok(!l.startsWith('::'), `line starts a workflow command: ${l}`);
  assert.equal(out.split('\n').length, 4);
  assert.match(out, /^Note: x ::add-mask::secret ::set-output/m);
});

test('line(): control characters become spaces, bounded', () => {
  assert.equal(line('a\nb\u0000c‮d'), 'a b c d');
  assert.equal(line('x'.repeat(400)).length, 300);
});
