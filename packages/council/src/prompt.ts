/**
 * The judge prompt.
 *
 * The council replaces a human reviewer, so it is shown what a human reviewer
 * would have opened: the PR, its diff, its checks, the hypothesis it claims to
 * have tested, and the ledger history it is supposed to advance. It is told
 * explicitly when the PR modifies the gate that is judging it — under flat
 * majority that is permitted, so it must at least be visible.
 */

import type { RiskAssessment } from './policy.js';

export interface PrEvidence {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  /** True when the head branch lives in `repo` itself. */
  sameRepoAuthor: boolean;
  baseRef: string;
  headSha: string;
  changedFiles: string[];
  additions: number;
  deletions: number;
  /** Unified diff, already truncated to the policy's line budget. */
  diff: string;
  diffTruncated: boolean;
  /** Required check runs and their conclusions. */
  checks: Array<{ name: string; conclusion: string }>;
  checksGreen: boolean;
  /** The last few LEDGER.md rows, for cross-night context. */
  ledgerTail: string;
  draft: boolean;
}

const VOTE_CONTRACT = `Answer with ONE JSON object and nothing else:

{
  "decision": "MERGE" | "BLOCK" | "ABSTAIN",
  "confidence": 0.0-1.0,
  "reasons": ["short, specific, tied to the diff"],
  "risks": ["what could go wrong if this merges"],
  "blockingObjections": ["only what genuinely must block a merge; empty if none"]
}

ABSTAIN means you could not form a judgement from the evidence given. It is
counted as NOT a merge, so do not use it as a polite MERGE.`;

export const SYSTEM_PROMPT = `You are one member of a three-family merge council for an autonomous
nightly repository-evolution system. There is no human reviewer behind you: your
vote, combined with two other model families from different providers, is the
final decision on whether this pull request enters the default branch.

Judge the change in front of you, not the process that produced it. Vote MERGE
only if you would stake your own repository on it. Specifically block anything
that:
  - weakens, deletes, or skips a test to make a result look better;
  - alters gold/benchmark data, an evaluation threshold, or a scorer in the same
    change that claims an improvement measured against it;
  - claims a quantitative result the diff and receipts do not support;
  - broadens permissions, credentials, or network/filesystem scope without cause;
  - is materially larger or broader than the hypothesis it says it is testing.

A clean, honest, negative result is a good change. A plausible-sounding but
unevidenced improvement is not. You are not rewarded for merging.`;

function riskSection(risk: RiskAssessment): string {
  if (!risk.elevated) return 'Risk classification: ordinary paths only.\n';
  const lines = risk.sensitive.map((s) => `  - ${s.path} — ${s.label}`).join('\n');
  const selfMod = risk.selfModification
    ? `\n>> SELF-MODIFICATION: this PR changes the council's own code or the workflow
   that runs it. Repository policy permits the council to merge such a change on
   the same simple majority as any other. Weigh accordingly: a change here alters
   how every future PR is judged, including changes to this gate itself.\n`
    : '';
  return `Risk classification — this PR touches paths a human reviewer was previously
required to sign off on:\n${lines}\n${selfMod}`;
}

/** Build the round-1 prompt: an independent judgement, no peer influence. */
export function buildProposalPrompt(pr: PrEvidence, risk: RiskAssessment): string {
  const checks = pr.checks.length
    ? pr.checks.map((c) => `  - ${c.name}: ${c.conclusion}`).join('\n')
    : '  (no check runs reported)';

  return `# Merge review — ${pr.repo}#${pr.number}

Title: ${pr.title}
Author: ${pr.author}${pr.sameRepoAuthor ? '' : '  (EXTERNAL — head branch is not in this repository)'}
Base: ${pr.baseRef}   Head: ${pr.headSha}
State: ${pr.draft ? 'draft' : 'ready for review'}
Size: +${pr.additions} / -${pr.deletions} across ${pr.changedFiles.length} file(s)

## Checks
${checks}
All required checks green: ${pr.checksGreen ? 'YES' : 'NO'}

## ${riskSection(risk)}
## PR body (the hypothesis, receipt, and evidence it claims)
${pr.body?.trim() || '(empty)'}

## Recent ledger history
${pr.ledgerTail?.trim() || '(no ledger rows)'}

## Diff${pr.diffTruncated ? ' (TRUNCATED — judge only what you can see, and say so if that is not enough)' : ''}
\`\`\`diff
${pr.diff}
\`\`\`

${VOTE_CONTRACT}`;
}

export interface PeerSummary {
  family: string;
  decision: string;
  reasons: string[];
  blockingObjections: string[];
}

/** Build the round-2 prompt: cross-examination of the other families' votes. */
export function buildCritiquePrompt(pr: PrEvidence, risk: RiskAssessment, peers: PeerSummary[]): string {
  const peerBlock = peers.length
    ? peers
        .map(
          (p) =>
            `### ${p.family} voted ${p.decision}\n` +
            `reasons: ${p.reasons.length ? p.reasons.join('; ') : '(none given)'}\n` +
            `blocking objections: ${p.blockingObjections.length ? p.blockingObjections.join('; ') : '(none)'}`,
        )
        .join('\n\n')
    : '(no peer votes available)';

  return `${buildProposalPrompt(pr, risk)}

---

# Round 2 — cross-examination

The other families on this council voted as follows. Read them adversarially.
Where a peer raised an objection you missed, verify it against the diff above
rather than deferring to it — and where a peer's objection is wrong, say so.

${peerBlock}

Now cast your FINAL vote. Change it if the cross-examination changed your mind;
keep it if it did not. Explain any change in \`reasons\`.

${VOTE_CONTRACT}`;
}

/** Truncate a unified diff to a line budget, keeping the head (where context lives). */
export function truncateDiff(diff: string, maxLines: number): { diff: string; truncated: boolean } {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return { diff, truncated: false };
  const kept = lines.slice(0, maxLines).join('\n');
  return {
    diff: `${kept}\n\n... [${lines.length - maxLines} more diff lines omitted]`,
    truncated: true,
  };
}
