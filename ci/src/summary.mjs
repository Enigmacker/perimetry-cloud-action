// The readable summary (GitHub job summary, GitLab or any Markdown viewer) and the console lines.
// Finding titles and targets come from the audited sites: escaped so that they can only ever be text.

const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** Plain text for one table cell or line of Markdown: no markup, no HTML, no line break, bounded. */
export function md(value, max = 160) {
  let s = String(value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  // No automatic link either: GitHub turns https://…, www.… and addresses into links even in plain text. A zero-width
  // space after "://", "www." and "@" keeps the text readable and unclickable.
  s = s.replace(/:\/\//g, '://​').replace(/\bwww\./gi, (w) => `${w}​`).replace(/@/g, '@​');
  return s.replace(/[\\`*_{}[\]()<>#+!|~&]/g, (c) => `\\${c}`).replace(/^-/, '\\-');
}

const ICON = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪' };

/** @param {any} result the JSON result of the gate */
export function markdownSummary(result) {
  const lines = [];
  const status = result.passed ? '✅ Passed' : '❌ Failed';
  lines.push(`### Perimetry Cloud: ${md(result.domain.name, 253)} — ${status}`, '');
  const delta = result.scoreDelta == null ? '' : ` (${result.scoreDelta > 0 ? '+' : ''}${result.scoreDelta} since the previous audit)`;
  lines.push(`**Score ${result.audit.score}/100, grade ${md(result.audit.grade, 3)}**${delta}`, '');
  if (result.notice) lines.push(`> ${md(result.notice, 300)}`, '');
  if (!result.passed) {
    lines.push('**Why it failed:**', '');
    for (const r of result.reasons) lines.push(`- ${md(r, 300)}`);
    lines.push('');
  }
  const c = result.audit.counts ?? {};
  lines.push('| Critical | High | Medium | Low |', '| ---: | ---: | ---: | ---: |', `| ${c.critical ?? 0} | ${c.high ?? 0} | ${c.medium ?? 0} | ${c.low ?? 0} |`, '');
  if (result.newFindings?.length) {
    lines.push(`**New since the previous audit (${result.newFindings.length}):**`, '', '| Severity | Finding | Target |', '| --- | --- | --- |');
    for (const f of result.newFindings.slice(0, 20)) lines.push(`| ${ICON[f.severity] ?? ''} ${md(f.severity, 10)} | ${md(f.title)} | ${md(f.target, 120)} |`);
    if (result.newFindings.length > 20) lines.push(`| | … and ${result.newFindings.length - 20} more | |`);
    lines.push('');
  }
  if (result.topFindings?.length) {
    lines.push('<details><summary>Most serious open findings</summary>', '', '| Severity | Finding | Target | Fix |', '| --- | --- | --- | --- |');
    for (const f of result.topFindings) lines.push(`| ${ICON[f.severity] ?? ''} ${md(f.severity, 10)} | ${md(f.title)} | ${md(f.target, 120)} | ${md(f.fix ?? '', 200)} |`);
    lines.push('', '</details>', '');
  }
  const when = result.audit.startedAt ? ` · audit of ${md(result.audit.startedAt.slice(0, 16).replace('T', ' '), 20)} UTC` : '';
  const link = /^https?:\/\//.test(result.links?.app ?? '') ? `[Open the report](${encodeURI(result.links.app)})` : '';
  lines.push(`${link}${when}`, '');
  return lines.join('\n');
}

export function consoleSummary(result) {
  const out = [];
  const delta = result.scoreDelta == null ? '' : ` (${result.scoreDelta > 0 ? '+' : ''}${result.scoreDelta})`;
  out.push(`Perimetry Cloud: ${md(result.domain.name, 253)}: score ${result.audit.score}, grade ${result.audit.grade}${delta}.`);
  if (result.notice) out.push(result.notice);
  for (const f of (result.newFindings ?? []).slice(0, 10)) out.push(`  new ${f.severity}: ${String(f.title).replace(CONTROL, ' ').slice(0, 160)} (${String(f.target).replace(CONTROL, ' ').slice(0, 120)})`);
  out.push(result.passed ? 'Passed.' : `Failed: ${result.reasons.join('; ')}.`);
  if (result.links?.app) out.push(`Report: ${result.links.app}`);
  return out.join('\n');
}
