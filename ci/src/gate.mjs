// The decision of the gate, from figures only (no network): kept apart so that it can be tested on its own.

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));
const atOrAbove = (sev, min) => min !== 'none' && RANK[sev] !== undefined && RANK[sev] <= RANK[min];

/**
 * @param {{ score: number, previousScore: number | null, newFindings: { severity: string }[], counts: Record<string, number> }} r
 * @param {{ minScore: number | null, failOnDrop: boolean, maxDrop: number, failOnNew: string, failOnOpen: string }} o
 * @returns {{ passed: boolean, reasons: string[] }}
 */
export function evaluate(r, o) {
  const reasons = [];
  if (o.minScore != null && r.score < o.minScore) reasons.push(`score ${r.score} is below the minimum of ${o.minScore}`);
  if (o.failOnDrop && r.previousScore != null && r.previousScore - r.score > o.maxDrop) {
    reasons.push(`score dropped from ${r.previousScore} to ${r.score}${o.maxDrop ? ` (more than the ${o.maxDrop} points allowed)` : ''}`);
  }
  if (o.failOnNew !== 'none') {
    const fresh = r.newFindings.filter((f) => atOrAbove(f.severity, o.failOnNew));
    if (fresh.length) reasons.push(`${fresh.length} new finding${fresh.length > 1 ? 's' : ''} at or above "${o.failOnNew}" since the previous audit`);
  }
  if (o.failOnOpen !== 'none') {
    const open = SEVERITIES.filter((s) => atOrAbove(s, o.failOnOpen)).reduce((n, s) => n + (Number(r.counts?.[s]) || 0), 0);
    if (open) reasons.push(`${open} open finding${open > 1 ? 's' : ''} at or above "${o.failOnOpen}"`);
  }
  return { passed: reasons.length === 0, reasons };
}
