import { describe, expect, it } from 'vitest';
import {
  appendCouncilLog,
  assessRisk,
  coerceVote,
  councilLogRow,
  deliberate,
  extractJsonObject,
  isEligible,
  renderTranscript,
  resolvePolicy,
  tally,
  truncateDiff,
  unreachableVote,
  type CouncilVote,
  type Family,
  type FamilyCaller,
  type PrEvidence,
} from './index.js';

const FAMILIES: Family[] = ['claude', 'gemini', 'xai'];

function pr(overrides: Partial<PrEvidence> = {}): PrEvidence {
  return {
    repo: 'arielagor/dream-machine',
    number: 42,
    title: 'dream(compiler-parity): tighten the snapshot',
    body: 'Hypothesis: ...',
    author: 'dream-machine[bot]',
    sameRepoAuthor: true,
    baseRef: 'main',
    headSha: 'a'.repeat(40),
    changedFiles: ['packages/compile/src/index.ts'],
    additions: 12,
    deletions: 3,
    diff: '--- a\n+++ b\n+ one line\n',
    diffTruncated: false,
    checks: [{ name: 'ci', conclusion: 'success' }],
    checksGreen: true,
    ledgerTail: '| 2026-08-27 | ... |',
    draft: true,
    ...overrides,
  };
}

function vote(family: Family, decision: CouncilVote['decision'], extra: Partial<CouncilVote> = {}): CouncilVote {
  return {
    family,
    model: 'test',
    decision,
    confidence: 0.9,
    reasons: [],
    risks: [],
    blockingObjections: [],
    round: 1,
    ...extra,
  };
}

/** A caller that always answers with the given decision. */
function stub(decision: CouncilVote['decision'] | 'unreachable'): FamilyCaller {
  return async ({ round }) => {
    if (decision === 'unreachable') return unreachableVote('claude', 'test', round, 'stubbed outage');
    return {
      family: 'claude',
      model: 'test',
      decision,
      confidence: 0.8,
      reasons: ['stub'],
      risks: [],
      blockingObjections: [],
      round,
    };
  };
}

/** Bind a stub to the family it is standing in for. */
function stubFor(family: Family, decision: CouncilVote['decision'] | 'unreachable'): FamilyCaller {
  const inner = stub(decision);
  return async (opts) => ({ ...(await inner(opts)), family });
}

describe('tally — the merge arithmetic', () => {
  const policy = resolvePolicy({ families: FAMILIES, quorum: 2 });

  it('merges on a simple majority', () => {
    const r = tally({
      votes: [vote('claude', 'MERGE'), vote('gemini', 'MERGE'), vote('xai', 'BLOCK')],
      policy,
      checksGreen: true,
    });
    expect(r.decision).toBe('MERGE');
    expect(r.mergeVotes).toBe(2);
  });

  it('blocks below quorum', () => {
    const r = tally({
      votes: [vote('claude', 'MERGE'), vote('gemini', 'BLOCK'), vote('xai', 'BLOCK')],
      policy,
      checksGreen: true,
    });
    expect(r.decision).toBe('BLOCK');
  });

  it('counts ABSTAIN as not-a-merge', () => {
    const r = tally({
      votes: [vote('claude', 'MERGE'), vote('gemini', 'ABSTAIN'), vote('xai', 'ABSTAIN')],
      policy,
      checksGreen: true,
    });
    expect(r.decision).toBe('BLOCK');
    expect(r.abstainVotes).toBe(2);
    expect(r.rationale).toMatch(/abstention/);
  });

  it('BLOCKS a degraded panel even when the families that answered agree', () => {
    // The failure this rule exists for: two MERGE votes look unanimous once the
    // third family has silently dropped out.
    const r = tally({
      votes: [
        vote('claude', 'MERGE'),
        vote('gemini', 'MERGE'),
        vote('xai', 'ABSTAIN', { unreachable: true, error: 'XAI_API_KEY unset' }),
      ],
      policy,
      checksGreen: true,
    });
    expect(r.decision).toBe('BLOCK');
    expect(r.degraded).toBe(true);
    expect(r.missing).toEqual(['xai']);
    expect(r.mergeVotes).toBe(2); // the votes are real; the panel is not complete
  });

  it('blocks a family that never answered at all', () => {
    const r = tally({ votes: [vote('claude', 'MERGE'), vote('gemini', 'MERGE')], policy, checksGreen: true });
    expect(r.decision).toBe('BLOCK');
    expect(r.missing).toEqual(['xai']);
  });

  it('blocks when required checks are red', () => {
    const r = tally({
      votes: [vote('claude', 'MERGE'), vote('gemini', 'MERGE'), vote('xai', 'MERGE')],
      policy,
      checksGreen: false,
    });
    expect(r.decision).toBe('BLOCK');
    expect(r.rationale).toMatch(/not green/);
  });

  it('lets a round-2 vote supersede the same family’s round-1 vote', () => {
    const r = tally({
      votes: [
        vote('claude', 'MERGE', { round: 1 }),
        vote('claude', 'BLOCK', { round: 2 }),
        vote('gemini', 'MERGE', { round: 2 }),
        vote('xai', 'BLOCK', { round: 2 }),
      ],
      policy,
      checksGreen: true,
    });
    expect(r.decision).toBe('BLOCK');
    expect(r.mergeVotes).toBe(1);
  });

  it('collects blocking objections with attribution', () => {
    const r = tally({
      votes: [
        vote('claude', 'BLOCK', { blockingObjections: ['deletes an assertion'] }),
        vote('gemini', 'MERGE'),
        vote('xai', 'MERGE'),
      ],
      policy,
      checksGreen: true,
    });
    expect(r.objections).toEqual([{ family: 'claude', objection: 'deletes an assertion' }]);
  });
});

describe('policy', () => {
  it('clamps a sub-majority quorum upward rather than trusting it', () => {
    expect(resolvePolicy({ quorum: 1 }).quorum).toBe(2);
    expect(resolvePolicy({ quorum: 0 }).quorum).toBe(2);
  });

  it('never lets quorum exceed the panel size', () => {
    expect(resolvePolicy({ families: ['claude', 'gemini'], quorum: 3 }).quorum).toBe(2);
  });

  it('drops unknown families and falls back to the full panel', () => {
    const p = resolvePolicy({ families: ['claude', 'llama' as Family] });
    expect(p.families).toEqual(['claude']);
    expect(resolvePolicy({ families: [] }).families).toEqual(FAMILIES);
  });
});

describe('assessRisk', () => {
  it('reports ordinary paths as unelevated', () => {
    const r = assessRisk(['packages/compile/src/index.ts', 'README.md']);
    expect(r.elevated).toBe(false);
    expect(r.selfModification).toBe(false);
  });

  it('flags the council changing its own code', () => {
    const r = assessRisk(['packages/council/src/tally.ts']);
    expect(r.selfModification).toBe(true);
    expect(r.sensitive[0].label).toMatch(/COUNCIL ITSELF/);
  });

  it('flags the workflow that runs the council', () => {
    expect(assessRisk(['.github/workflows/council-gate.yml']).selfModification).toBe(true);
  });

  it('flags CI, manifests, thresholds and the security policy', () => {
    const r = assessRisk([
      '.github/workflows/ci.yml',
      'package-lock.json',
      'packages/compile/package.json',
      'src/scorer/threshold.ts',
      'SECURITY.md',
    ]);
    expect(r.sensitive).toHaveLength(5);
    expect(r.elevated).toBe(true);
  });

  it('normalises Windows separators so a backslash path is still classified', () => {
    expect(assessRisk(['packages\\council\\src\\policy.ts']).selfModification).toBe(true);
  });
});

describe('vote coercion — untrusted model output', () => {
  it('reads a clean JSON vote', () => {
    const v = coerceVote({
      family: 'gemini',
      model: 'm',
      round: 1,
      raw: '{"decision":"MERGE","confidence":0.8,"reasons":["ok"],"risks":[],"blockingObjections":[]}',
    });
    expect(v.decision).toBe('MERGE');
    expect(v.confidence).toBeCloseTo(0.8);
  });

  it('reads a fenced vote wrapped in prose', () => {
    const v = coerceVote({
      family: 'xai',
      model: 'm',
      round: 1,
      raw: 'Here is my vote:\n```json\n{"decision":"BLOCK","confidence":90}\n```\nHope that helps.',
    });
    expect(v.decision).toBe('BLOCK');
    expect(v.confidence).toBeCloseTo(0.9); // a 0-100 scale is rescaled, not trusted
  });

  it('coerces unparseable output to ABSTAIN rather than guessing', () => {
    const v = coerceVote({ family: 'claude', model: 'm', round: 1, raw: 'I think you should merge this.' });
    expect(v.decision).toBe('ABSTAIN');
    expect(v.error).toMatch(/no JSON object/);
  });

  it('coerces an unrecognised decision to ABSTAIN', () => {
    const v = coerceVote({ family: 'claude', model: 'm', round: 1, raw: '{"decision":"APPROVE"}' });
    expect(v.decision).toBe('ABSTAIN');
    expect(v.error).toMatch(/unrecognised decision/);
  });

  it('accepts snake_case blocking_objections', () => {
    const v = coerceVote({
      family: 'claude',
      model: 'm',
      round: 1,
      raw: '{"decision":"BLOCK","blocking_objections":["weakens a test"]}',
    });
    expect(v.blockingObjections).toEqual(['weakens a test']);
  });

  it('extracts a balanced object without swallowing trailing prose braces', () => {
    const obj = extractJsonObject('{"decision":"MERGE","reasons":["uses {braces} inside"]} and then {noise');
    expect((obj as any).decision).toBe('MERGE');
  });

  it('clamps a confidence outside the range', () => {
    expect(coerceVote({ family: 'claude', model: 'm', round: 1, raw: '{"decision":"MERGE","confidence":-5}' }).confidence).toBe(0);
  });
});

describe('deliberate — end to end with stubbed families', () => {
  it('merges when two of three vote MERGE', async () => {
    const v = await deliberate({
      pr: pr(),
      callers: { claude: stubFor('claude', 'MERGE'), gemini: stubFor('gemini', 'MERGE'), xai: stubFor('xai', 'BLOCK') },
    });
    expect(v.decision).toBe('MERGE');
    expect(v.familiesUsed).toEqual(FAMILIES);
    expect(v.round2).toHaveLength(3); // cross-examination ran
    expect(v.witness).toMatch(/^[0-9a-f]{64}$/);
  });

  it('blocks and skips cross-examination when a family is unreachable', async () => {
    const v = await deliberate({
      pr: pr(),
      callers: {
        claude: stubFor('claude', 'MERGE'),
        gemini: stubFor('gemini', 'MERGE'),
        xai: stubFor('xai', 'unreachable'),
      },
    });
    expect(v.decision).toBe('BLOCK');
    expect(v.result.degraded).toBe(true);
    expect(v.familiesUsed).toEqual(['claude', 'gemini']);
    expect(v.round2).toHaveLength(0);
  });

  it('keeps a round-1 vote when only the round-2 call fails', async () => {
    // A flaky second call must not read as a missing seat, or transient noise
    // would block every PR.
    let calls = 0;
    const flaky: FamilyCaller = async (opts) => {
      calls++;
      if (opts.round === 2) return unreachableVote('xai', 'test', 2, 'transient 503');
      return { ...(await stubFor('xai', 'MERGE')(opts)) };
    };
    const v = await deliberate({
      pr: pr(),
      callers: { claude: stubFor('claude', 'MERGE'), gemini: stubFor('gemini', 'MERGE'), xai: flaky },
    });
    expect(calls).toBe(2);
    expect(v.decision).toBe('MERGE');
    expect(v.result.degraded).toBe(false);
  });

  it('binds the transcript to the head commit', async () => {
    const a = await deliberate({
      pr: pr({ headSha: 'a'.repeat(40) }),
      callers: { claude: stubFor('claude', 'MERGE'), gemini: stubFor('gemini', 'MERGE'), xai: stubFor('xai', 'MERGE') },
    });
    const b = await deliberate({
      pr: pr({ headSha: 'b'.repeat(40) }),
      callers: { claude: stubFor('claude', 'MERGE'), gemini: stubFor('gemini', 'MERGE'), xai: stubFor('xai', 'MERGE') },
    });
    expect(a.transcriptHash).toBe(b.transcriptHash); // same transcript
    expect(a.witness).not.toBe(b.witness); // different commit
  });

  it('surfaces self-modification in the verdict and the transcript', async () => {
    const v = await deliberate({
      pr: pr({ changedFiles: ['packages/council/src/tally.ts'] }),
      callers: { claude: stubFor('claude', 'MERGE'), gemini: stubFor('gemini', 'MERGE'), xai: stubFor('xai', 'MERGE') },
    });
    expect(v.risk.selfModification).toBe(true);
    expect(v.decision).toBe('MERGE'); // flat majority: permitted, but recorded
    expect(renderTranscript(v)).toMatch(/Self-modification/);
  });

  it('passes the truncation budget through to the prompt', async () => {
    const seen: string[] = [];
    const spy: FamilyCaller = async (opts) => {
      seen.push(opts.prompt);
      return { ...(await stubFor('claude', 'MERGE')(opts)) };
    };
    await deliberate({
      pr: pr({ diff: Array.from({ length: 300 }, (_, i) => `+ line ${i}`).join('\n') }),
      policy: { maxDiffLines: 50, families: ['claude'], adversarialRound: false },
      callers: { claude: spy },
    });
    expect(seen[0]).toMatch(/250 more diff lines omitted/);
  });
});

describe('eligibility — the public-fork guard', () => {
  const policy = resolvePolicy({});

  it('judges a PR whose branch lives in the repo', () => {
    expect(isEligible(pr(), policy).eligible).toBe(true);
  });

  it('refuses an external PR before any secret is spent', () => {
    const r = isEligible(pr({ sameRepoAuthor: false }), policy);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/not council-judged/);
  });

  it('refuses everything when the council is disabled', () => {
    expect(isEligible(pr(), resolvePolicy({ enabled: false })).eligible).toBe(false);
  });
});

describe('council log', () => {
  it('creates the table on first append and escapes pipes', async () => {
    const v = await deliberate({
      pr: pr(),
      callers: { claude: stubFor('claude', 'MERGE'), gemini: stubFor('gemini', 'MERGE'), xai: stubFor('xai', 'MERGE') },
    });
    const log = appendCouncilLog('', v, '2026-08-28');
    expect(log).toMatch(/^\| Date \| PR \| Decision \|/);
    expect(log.trim().split('\n')).toHaveLength(3);

    const piped = councilLogRow({ ...v, rationale: 'a | b' }, '2026-08-28');
    expect(piped).toContain('a \\| b');
    expect(appendCouncilLog(log, v, '2026-08-29').trim().split('\n')).toHaveLength(4);
  });
});

describe('truncateDiff', () => {
  it('leaves a short diff alone', () => {
    expect(truncateDiff('a\nb', 10)).toEqual({ diff: 'a\nb', truncated: false });
  });
  it('marks how much it dropped', () => {
    const r = truncateDiff('a\nb\nc\nd', 2);
    expect(r.truncated).toBe(true);
    expect(r.diff).toMatch(/2 more diff lines omitted/);
  });
});
