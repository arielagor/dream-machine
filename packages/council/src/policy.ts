/**
 * Council policy — thresholds, and the risk classification of a changed path.
 *
 * Upstream's `automerge.yml` carried this classification as a shell regex whose
 * only job was to REFUSE. Here the same knowledge is promoted into typed,
 * tested code with a different job: under flat majority nothing is refused
 * outright, so the classification instead tells the families what they are
 * voting on — in particular, when a PR modifies the gate that is judging it.
 */

import { FAMILIES, type Family } from './schema.js';

export interface CouncilPolicy {
  enabled: boolean;
  families: Family[];
  /** Votes required to merge. Flat across all paths by design. */
  quorum: number;
  /** ABSTAIN is never a merge; this records how it is reported. */
  abstainCountsAs: 'block';
  requireAllChecksGreen: boolean;
  /** Only judge PRs whose head branch lives in this repo (public-fork safety). */
  requireSameRepoAuthor: boolean;
  /** Diffs longer than this are summarised rather than sent whole. */
  maxDiffLines: number;
  /** Run the round-2 cross-examination. */
  adversarialRound: boolean;
  /** Per-family timeout in milliseconds. */
  timeoutMs: number;
}

export const DEFAULT_POLICY: CouncilPolicy = {
  enabled: true,
  families: [...FAMILIES],
  quorum: 2,
  abstainCountsAs: 'block',
  requireAllChecksGreen: true,
  requireSameRepoAuthor: true,
  maxDiffLines: 800,
  adversarialRound: true,
  timeoutMs: 180_000,
};

/**
 * Paths upstream treated as human-review-only. The council may now merge them,
 * but every one of these is surfaced to the voters as elevated risk.
 */
export const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^\.github\//, label: 'CI workflow / repository automation' },
  { pattern: /^packages\/council\//, label: 'THE COUNCIL ITSELF — the gate judging this PR' },
  { pattern: /^(package\.json|package-lock\.json)$/, label: 'root dependency manifest' },
  { pattern: /^packages\/[^/]+\/package\.json$/, label: 'package dependency manifest' },
  { pattern: /(^|\/)(safety|gate)/i, label: 'safety / gate infrastructure' },
  { pattern: /threshold|promotion|scorer/i, label: 'evaluation threshold or scorer' },
  { pattern: /^SECURITY\.md$/, label: 'security policy' },
  { pattern: /^dream\.config\.json$/, label: 'the config that compiles the nightly routine' },
];

export interface RiskAssessment {
  /** Sensitive paths touched, each with the reason it is sensitive. */
  sensitive: Array<{ path: string; label: string }>;
  /** True when the PR changes the council's own code or the workflow that runs it. */
  selfModification: boolean;
  /** True when any sensitive path is touched at all. */
  elevated: boolean;
}

/** Classify a PR's changed files. Pure — no IO, fully unit-testable. */
export function assessRisk(changedFiles: string[]): RiskAssessment {
  const sensitive: Array<{ path: string; label: string }> = [];
  let selfModification = false;

  for (const file of changedFiles) {
    const path = file.replace(/^\.\//, '').replace(/\\/g, '/');
    for (const { pattern, label } of SENSITIVE_PATTERNS) {
      if (pattern.test(path)) {
        sensitive.push({ path, label });
        break; // one label per file — the first (most specific) match wins
      }
    }
    if (/^packages\/council\//.test(path) || /^\.github\/workflows\/council-gate\.yml$/.test(path)) {
      selfModification = true;
    }
  }

  return { sensitive, selfModification, elevated: sensitive.length > 0 };
}

/** Merge a partial config over the defaults, rejecting nonsense quietly-but-safely. */
export function resolvePolicy(partial?: Partial<CouncilPolicy>): CouncilPolicy {
  const p = { ...DEFAULT_POLICY, ...(partial ?? {}) };
  const families = (p.families ?? []).filter((f): f is Family => (FAMILIES as readonly string[]).includes(f));
  const resolved: CouncilPolicy = {
    ...p,
    families: families.length ? families : [...FAMILIES],
    abstainCountsAs: 'block',
  };
  // A quorum below 2, or above the panel size, is not a majority of anything.
  // Clamp rather than throw: a misconfigured gate must fail toward *more* votes.
  resolved.quorum = Math.min(Math.max(2, Math.floor(resolved.quorum) || 2), resolved.families.length);
  resolved.maxDiffLines = Math.max(50, Math.floor(resolved.maxDiffLines) || DEFAULT_POLICY.maxDiffLines);
  resolved.timeoutMs = Math.max(10_000, Math.floor(resolved.timeoutMs) || DEFAULT_POLICY.timeoutMs);
  return resolved;
}
