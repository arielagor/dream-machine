/**
 * @dream-machine/council
 *
 * The merge judgement, made by a council of three model families instead of a
 * human reviewer.
 *
 * Upstream's rule was "evaluation is not promotion — the machine never merges;
 * a human does." This fork keeps the first half and replaces the second: the
 * nightly session still never merges its own work, but the reviewer on the other
 * side of the gate is now a panel of Claude, Gemini and Grok, voting from
 * different providers so no single family's blind spot becomes the repository's.
 *
 * Two properties do the safety work here, and both are structural rather than
 * advisory:
 *
 *   1. The producer never judges. The nightly agent opens the PR; a separate
 *      process with no authoring context votes on it. That separation, not a
 *      human, is what makes a majority mean anything.
 *   2. A degraded panel never merges. If any family is unreachable the vote is
 *      void — because the families that DID answer still return confident-looking
 *      votes, and without this rule an outage silently converts a three-family
 *      gate into a one-family one that still reads as unanimous.
 */

import { stamp } from '@dream-machine/witness';
import { CALLERS, type FamilyCaller } from './families.js';
import { assessRisk, resolvePolicy, type CouncilPolicy, type RiskAssessment } from './policy.js';
import {
  buildCritiquePrompt,
  buildProposalPrompt,
  SYSTEM_PROMPT,
  truncateDiff,
  type PeerSummary,
  type PrEvidence,
} from './prompt.js';
import type { CouncilVote, Family } from './schema.js';
import { tally, type TallyResult } from './tally.js';

export * from './policy.js';
export * from './prompt.js';
export * from './schema.js';
export * from './tally.js';
export { CALLERS, modelFor, type FamilyCaller } from './families.js';

export interface CouncilVerdict {
  repo: string;
  pr: number;
  decision: 'MERGE' | 'BLOCK';
  rationale: string;
  policy: CouncilPolicy;
  risk: RiskAssessment;
  /** Families that actually answered — check this before trusting a verdict. */
  familiesUsed: Family[];
  round1: CouncilVote[];
  round2: CouncilVote[];
  result: TallyResult;
  /** sha256(sha256(transcript) + headSha) — the same provenance the reports use. */
  witness: string;
  transcriptHash: string;
}

export interface DeliberateOptions {
  pr: PrEvidence;
  policy?: Partial<CouncilPolicy>;
  /** Injectable for tests; defaults to the real family adapters. */
  callers?: Partial<Record<Family, FamilyCaller>>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run the council over one pull request.
 *
 * Round 1 collects an independent vote per family, concurrently and blind to
 * each other. Round 2 shows every family what its peers said and asks for a
 * final vote — so a real objection can change minds, and a wrong one can be
 * rebutted. Then {@link tally} counts, in code.
 */
export async function deliberate(opts: DeliberateOptions): Promise<CouncilVerdict> {
  const policy = resolvePolicy(opts.policy);
  const env = opts.env ?? process.env;
  const callers = { ...CALLERS, ...(opts.callers ?? {}) };

  const truncated = truncateDiff(opts.pr.diff, policy.maxDiffLines);
  const pr: PrEvidence = { ...opts.pr, diff: truncated.diff, diffTruncated: truncated.truncated };
  const risk = assessRisk(pr.changedFiles);

  const proposal = buildProposalPrompt(pr, risk);
  const round1 = await Promise.all(
    policy.families.map((family) =>
      callers[family]({ prompt: proposal, system: SYSTEM_PROMPT, round: 1, timeoutMs: policy.timeoutMs, env }),
    ),
  );

  let round2: CouncilVote[] = [];
  // Cross-examination only makes sense with a complete panel; if a family is
  // already missing the verdict is void anyway, so do not spend a second round.
  const panelComplete = round1.every((v) => !v.unreachable);
  if (policy.adversarialRound && panelComplete && policy.families.length > 1) {
    round2 = await Promise.all(
      policy.families.map((family) => {
        const peers: PeerSummary[] = round1
          .filter((v) => v.family !== family)
          .map((v) => ({
            family: v.family,
            decision: v.decision,
            reasons: v.reasons,
            blockingObjections: v.blockingObjections,
          }));
        return callers[family]({
          prompt: buildCritiquePrompt(pr, risk, peers),
          system: SYSTEM_PROMPT,
          round: 2,
          timeoutMs: policy.timeoutMs,
          env,
        });
      }),
    );
    // A family that answered round 1 but dropped out of round 2 must not be
    // counted as absent — its round-1 judgement stands, and treating a flaky
    // second call as a missing seat would block every PR on transient noise.
    round2 = round2.map((v, i) => (v.unreachable ? { ...round1[i], round: 2 as const } : v));
  }

  const finalVotes = round2.length ? round2 : round1;
  const result = tally({ votes: finalVotes, policy, checksGreen: pr.checksGreen });

  const familiesUsed = finalVotes.filter((v) => !v.unreachable).map((v) => v.family);

  const verdict: Omit<CouncilVerdict, 'witness' | 'transcriptHash'> = {
    repo: pr.repo,
    pr: pr.number,
    decision: result.decision,
    rationale: result.rationale,
    policy,
    risk,
    familiesUsed,
    round1,
    round2,
    result,
  };

  // Bind the transcript to the exact commit it judged, with the same
  // double-sha256 the nightly reports use — a merge decision deserves at least
  // the provenance a research note gets.
  const transcript = renderTranscript({ ...verdict, witness: '', transcriptHash: '' });
  const w = stamp(transcript, pr.headSha);

  return { ...verdict, witness: w.witness, transcriptHash: w.reportHash };
}

/** Render a verdict as the markdown transcript posted to the PR and the log. */
export function renderTranscript(v: CouncilVerdict): string {
  const lines: string[] = [];
  lines.push(`# Council verdict — ${v.repo}#${v.pr}: **${v.decision}**`);
  lines.push('');
  lines.push(`> ${v.rationale}`);
  lines.push('');
  lines.push(
    `Panel: ${v.policy.families.join(', ')} · answered: ${v.familiesUsed.join(', ') || 'none'} · ` +
      `quorum ${v.result.quorum}/${v.policy.families.length} · ` +
      `tally ${v.result.mergeVotes} MERGE / ${v.result.blockVotes} BLOCK / ${v.result.abstainVotes} ABSTAIN`,
  );
  if (v.result.degraded) {
    lines.push('');
    lines.push(`**Degraded panel** — no answer from ${v.result.missing.join(', ')}. A partial council never merges.`);
  }
  if (v.risk.elevated) {
    lines.push('');
    lines.push('## Risk classification');
    for (const s of v.risk.sensitive) lines.push(`- \`${s.path}\` — ${s.label}`);
    if (v.risk.selfModification) {
      lines.push('');
      lines.push('**Self-modification:** this PR changes the council or the workflow that runs it.');
    }
  }

  const rounds: Array<[string, CouncilVote[]]> = [
    ['Round 1 — independent votes', v.round1],
    ['Round 2 — after cross-examination', v.round2],
  ];
  for (const [title, votes] of rounds) {
    if (!votes.length) continue;
    lines.push('');
    lines.push(`## ${title}`);
    for (const vote of votes) {
      lines.push('');
      lines.push(`### ${vote.family} (\`${vote.model}\`) — **${vote.decision}**`);
      if (vote.unreachable) {
        lines.push(`- unreachable: ${vote.error}`);
        continue;
      }
      lines.push(`- confidence: ${vote.confidence.toFixed(2)}`);
      for (const r of vote.reasons) lines.push(`- reason: ${r}`);
      for (const r of vote.risks) lines.push(`- risk: ${r}`);
      for (const o of vote.blockingObjections) lines.push(`- **blocking:** ${o}`);
      if (vote.error) lines.push(`- note: ${vote.error}`);
    }
  }

  if (v.witness) {
    lines.push('');
    lines.push('## Witness');
    lines.push(`- transcript sha256: \`${v.transcriptHash}\``);
    lines.push(`- witness: \`${v.witness}\``);
  }
  return lines.join('\n') + '\n';
}

/** One row for `docs/dream-cycle/COUNCIL.md`. */
export const COUNCIL_LOG_COLUMNS = [
  'Date',
  'PR',
  'Decision',
  'Tally',
  'Panel',
  'Self-mod?',
  'Rationale',
  'Witness',
] as const;

export function councilLogHeader(): string {
  return `| ${COUNCIL_LOG_COLUMNS.join(' | ')} |\n| ${COUNCIL_LOG_COLUMNS.map(() => '---').join(' | ')} |\n`;
}

function escapeCell(value: string): string {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

export function councilLogRow(v: CouncilVerdict, date: string): string {
  const cells = [
    date,
    `#${v.pr}`,
    v.decision,
    `${v.result.mergeVotes}/${v.policy.families.length}`,
    v.familiesUsed.join('+') || 'none',
    v.risk.selfModification ? 'YES' : 'no',
    v.rationale,
    v.witness.slice(0, 8),
  ];
  return `| ${cells.map(escapeCell).join(' | ')} |\n`;
}

/** Append a row, creating the table when the log does not exist yet. */
export function appendCouncilLog(existing: string, v: CouncilVerdict, date: string): string {
  const base = existing && existing.includes('| Date |') ? existing.replace(/\n*$/, '\n') : councilLogHeader();
  return base + councilLogRow(v, date);
}

/**
 * Whether the council is permitted to judge this PR at all.
 *
 * On a public repository `pull_request_target` runs with repository secrets and
 * write permission, so without this check any stranger's PR would get a
 * three-model council trying to merge it. This is an authorship check, not a
 * human review gate: the nightly runner pushes its branches to the repository
 * itself, so its PRs are unaffected.
 */
export function isEligible(pr: PrEvidence, policy: CouncilPolicy): { eligible: boolean; reason: string } {
  if (!policy.enabled) return { eligible: false, reason: 'council is disabled by config' };
  if (policy.requireSameRepoAuthor && !pr.sameRepoAuthor) {
    return {
      eligible: false,
      reason: `head branch is not in ${pr.repo} — external contributions are not council-judged`,
    };
  }
  return { eligible: true, reason: 'eligible' };
}
