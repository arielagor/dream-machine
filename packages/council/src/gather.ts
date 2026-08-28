/**
 * Evidence gathering — what the council is shown before it votes.
 *
 * Everything here goes through an injected `exec`, so the whole path is unit
 * testable without a network or a `gh` login, and so a failure to gather is a
 * typed result rather than a thrown exception. That matters: an evidence
 * gathering failure must surface as "we could not see the PR", never as an
 * empty diff the panel would happily wave through.
 */

import type { PrEvidence } from './prompt.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (cmd: string) => Promise<ExecResult>;

export interface GatherOptions {
  repo: string;
  pr: number;
  exec: Exec;
  /** Path to the durable ledger, for cross-night context. */
  ledgerPath?: string;
  readFile?: (path: string) => Promise<string>;
}

export type GatherResult = { ok: true; pr: PrEvidence } | { ok: false; error: string };

/** Conclusions that do not count as green. `null`/'' means still running. */
const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

interface GhPr {
  number: number;
  title: string;
  body: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  headRepositoryOwner?: { login?: string } | null;
  author?: { login?: string } | null;
  additions: number;
  deletions: number;
  files?: Array<{ path: string }>;
  statusCheckRollup?: Array<{ name?: string; context?: string; conclusion?: string; state?: string }> | null;
}

/**
 * Decide whether the head branch lives in the target repository.
 *
 * `gh pr view` reports the head repository's OWNER, not its full name, so this
 * compares owners. A same-owner fork would pass, which is acceptable: the guard
 * exists to keep arbitrary third parties out, and anything under the same owner
 * is already trusted to push branches here.
 */
function isSameRepoHead(pr: GhPr, repo: string): boolean {
  const owner = pr.headRepositoryOwner?.login;
  if (!owner) return false;
  return owner.toLowerCase() === repo.split('/')[0].toLowerCase();
}

export function checksFrom(rollup: GhPr['statusCheckRollup']): {
  checks: Array<{ name: string; conclusion: string }>;
  green: boolean;
} {
  const checks = (rollup ?? []).map((c) => ({
    name: c.name || c.context || 'check',
    // A check that has not concluded reports only a state; surface that rather
    // than letting an in-flight check read as an empty (and therefore ignored)
    // conclusion.
    conclusion: (c.conclusion || c.state || 'PENDING').toUpperCase(),
  }));
  // No checks at all is not green. An unprotected PR with zero configured
  // checks must not inherit the benefit of "nothing failed".
  const green = checks.length > 0 && checks.every((c) => GREEN.has(c.conclusion));
  return { checks, green };
}

/** Collect everything the panel needs to judge one pull request. */
export async function gatherPr(opts: GatherOptions): Promise<GatherResult> {
  const fields = [
    'number',
    'title',
    'body',
    'isDraft',
    'baseRefName',
    'headRefName',
    'headRefOid',
    'headRepositoryOwner',
    'author',
    'additions',
    'deletions',
    'files',
    'statusCheckRollup',
  ].join(',');

  const view = await opts.exec(`gh pr view ${opts.pr} --repo ${opts.repo} --json ${fields}`);
  if (view.code !== 0) {
    return { ok: false, error: `gh pr view failed (exit ${view.code}): ${view.stderr.trim().slice(0, 300)}` };
  }

  let raw: GhPr;
  try {
    raw = JSON.parse(view.stdout) as GhPr;
  } catch (e) {
    return { ok: false, error: `could not parse gh pr view output: ${(e as Error).message}` };
  }

  const diffRes = await opts.exec(`gh pr diff ${opts.pr} --repo ${opts.repo}`);
  if (diffRes.code !== 0) {
    return { ok: false, error: `gh pr diff failed (exit ${diffRes.code}): ${diffRes.stderr.trim().slice(0, 300)}` };
  }
  // An empty diff is not something to vote on — it means the fetch degraded, or
  // the PR is genuinely empty. Either way there is no change to judge.
  if (!diffRes.stdout.trim()) {
    return { ok: false, error: 'the PR diff is empty — nothing to judge' };
  }

  let ledgerTail = '';
  if (opts.ledgerPath && opts.readFile) {
    try {
      const md = await opts.readFile(opts.ledgerPath);
      ledgerTail = md.trimEnd().split('\n').slice(-5).join('\n');
    } catch {
      ledgerTail = '(ledger unavailable)';
    }
  }

  const { checks, green } = checksFrom(raw.statusCheckRollup);

  return {
    ok: true,
    pr: {
      repo: opts.repo,
      number: raw.number,
      title: raw.title ?? '',
      body: raw.body ?? '',
      author: raw.author?.login ?? 'unknown',
      sameRepoAuthor: isSameRepoHead(raw, opts.repo),
      baseRef: raw.baseRefName ?? 'main',
      headSha: raw.headRefOid ?? '',
      changedFiles: (raw.files ?? []).map((f) => f.path),
      additions: raw.additions ?? 0,
      deletions: raw.deletions ?? 0,
      diff: diffRes.stdout,
      diffTruncated: false,
      checks,
      checksGreen: green,
      ledgerTail,
      draft: Boolean(raw.isDraft),
    },
  };
}
