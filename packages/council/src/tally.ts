/**
 * The tally — the one place the merge decision is actually made.
 *
 * This is deliberately plain arithmetic and NOT a model call. The families
 * supply judgement; the count that turns judgement into a merge is code anyone
 * can read, re-run, and disagree with. A synthesiser model deciding "what the
 * panel meant" would put the whole gate back inside a single model's opinion.
 */

import type { CouncilPolicy } from './policy.js';
import type { CouncilVote, Family } from './schema.js';

export type CouncilDecision = 'MERGE' | 'BLOCK';

export interface TallyInput {
  /** The final vote per family (round 2 when it ran, else round 1). */
  votes: CouncilVote[];
  policy: CouncilPolicy;
  /** Whether every required check on the PR is green. */
  checksGreen: boolean;
}

export interface TallyResult {
  decision: CouncilDecision;
  mergeVotes: number;
  blockVotes: number;
  abstainVotes: number;
  quorum: number;
  /** Families that were configured but never answered. */
  missing: Family[];
  /** True when the panel was not complete — always forces BLOCK. */
  degraded: boolean;
  /** Every blocking objection raised, attributed to its family. */
  objections: Array<{ family: Family; objection: string }>;
  /** Human-readable one-liner explaining the decision. */
  rationale: string;
}

/**
 * Count the panel.
 *
 * A merge requires ALL of:
 *   1. the panel is complete — every configured family answered (see below),
 *   2. every required check on the PR is green,
 *   3. at least `quorum` families voted MERGE.
 *
 * Rule 1 is the important one. A degraded panel still returns confident-looking
 * votes from the families that DID answer, so without this check a two-family
 * outage silently converts a three-family gate into a one-family gate that
 * still reads as unanimous. Unreachable never merges.
 */
export function tally(input: TallyInput): TallyResult {
  const { policy, checksGreen } = input;
  const byFamily = new Map<Family, CouncilVote>();
  for (const vote of input.votes) {
    const existing = byFamily.get(vote.family);
    // Later rounds supersede earlier ones for the same family.
    if (!existing || vote.round >= existing.round) byFamily.set(vote.family, vote);
  }

  const missing = policy.families.filter((f) => {
    const v = byFamily.get(f);
    return !v || v.unreachable === true;
  });

  const final = policy.families.map((f) => byFamily.get(f)).filter((v): v is CouncilVote => Boolean(v) && !v!.unreachable);

  const mergeVotes = final.filter((v) => v.decision === 'MERGE').length;
  const blockVotes = final.filter((v) => v.decision === 'BLOCK').length;
  const abstainVotes = final.filter((v) => v.decision === 'ABSTAIN').length;

  const objections = final.flatMap((v) =>
    v.blockingObjections.map((objection) => ({ family: v.family, objection })),
  );

  const degraded = missing.length > 0;
  const quorum = policy.quorum;

  let decision: CouncilDecision = 'BLOCK';
  let rationale: string;

  if (degraded) {
    rationale = `degraded panel — no answer from ${missing.join(', ')}; a partial council never merges`;
  } else if (policy.requireAllChecksGreen && !checksGreen) {
    rationale = 'required checks are not green — the council does not vote a red PR in';
  } else if (mergeVotes >= quorum) {
    decision = 'MERGE';
    rationale = `${mergeVotes}/${policy.families.length} families voted MERGE (quorum ${quorum})`;
  } else {
    rationale =
      `${mergeVotes}/${policy.families.length} MERGE votes, quorum is ${quorum}` +
      (abstainVotes ? ` — ${abstainVotes} abstention(s) count as not-a-merge` : '');
  }

  return { decision, mergeVotes, blockVotes, abstainVotes, quorum, missing, degraded, objections, rationale };
}
