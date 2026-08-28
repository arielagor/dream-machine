import { describe, expect, it } from 'vitest';
import { checksFrom, gatherPr, type Exec } from './gather.js';

const PR = {
  number: 7,
  title: 'dream(x): a candidate',
  body: 'Hypothesis: ...',
  isDraft: true,
  baseRefName: 'main',
  headRefName: 'dream/2026-08-28-x',
  headRefOid: 'c'.repeat(40),
  headRepositoryOwner: { login: 'arielagor' },
  author: { login: 'dream-machine[bot]' },
  additions: 3,
  deletions: 1,
  files: [{ path: 'README.md' }, { path: 'packages/compile/src/index.ts' }],
  statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }],
};

function exec(overrides: { view?: unknown; viewCode?: number; diff?: string; diffCode?: number } = {}): Exec {
  return async (cmd) => {
    if (cmd.includes('gh pr view')) {
      return {
        code: overrides.viewCode ?? 0,
        stdout: typeof overrides.view === 'string' ? overrides.view : JSON.stringify(overrides.view ?? PR),
        stderr: overrides.viewCode ? 'boom' : '',
      };
    }
    if (cmd.includes('gh pr diff')) {
      return { code: overrides.diffCode ?? 0, stdout: overrides.diff ?? '--- a\n+++ b\n+x\n', stderr: '' };
    }
    return { code: 127, stdout: '', stderr: 'unexpected' };
  };
}

describe('checksFrom', () => {
  it('treats SUCCESS, NEUTRAL and SKIPPED as green', () => {
    const r = checksFrom([
      { name: 'a', conclusion: 'SUCCESS' },
      { name: 'b', conclusion: 'NEUTRAL' },
      { name: 'c', conclusion: 'SKIPPED' },
    ]);
    expect(r.green).toBe(true);
  });

  it('is not green with a failure', () => {
    expect(checksFrom([{ name: 'a', conclusion: 'FAILURE' }]).green).toBe(false);
  });

  it('is not green while a check is still running', () => {
    const r = checksFrom([{ name: 'a', state: 'IN_PROGRESS' }]);
    expect(r.green).toBe(false);
    expect(r.checks[0].conclusion).toBe('IN_PROGRESS');
  });

  it('is NOT green when there are no checks at all', () => {
    // "Nothing failed" must not read as "everything passed" — a PR with no
    // configured checks would otherwise inherit a free pass.
    expect(checksFrom([]).green).toBe(false);
    expect(checksFrom(null).green).toBe(false);
  });

  it('falls back to the context name for a legacy status', () => {
    expect(checksFrom([{ context: 'ci/circleci', state: 'SUCCESS' }]).checks[0].name).toBe('ci/circleci');
  });
});

describe('gatherPr', () => {
  it('collects the evidence the panel votes on', async () => {
    const r = await gatherPr({ repo: 'arielagor/dream-machine', pr: 7, exec: exec() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pr.number).toBe(7);
    expect(r.pr.changedFiles).toHaveLength(2);
    expect(r.pr.checksGreen).toBe(true);
    expect(r.pr.sameRepoAuthor).toBe(true);
    expect(r.pr.draft).toBe(true);
  });

  it('marks a PR from another owner as not same-repo', async () => {
    const r = await gatherPr({
      repo: 'arielagor/dream-machine',
      pr: 7,
      exec: exec({ view: { ...PR, headRepositoryOwner: { login: 'a-stranger' } } }),
    });
    expect(r.ok && r.pr.sameRepoAuthor).toBe(false);
  });

  it('compares owners case-insensitively', async () => {
    const r = await gatherPr({
      repo: 'ArielAgor/dream-machine',
      pr: 7,
      exec: exec({ view: { ...PR, headRepositoryOwner: { login: 'arielagor' } } }),
    });
    expect(r.ok && r.pr.sameRepoAuthor).toBe(true);
  });

  it('treats a missing head owner as external rather than assuming trust', async () => {
    const r = await gatherPr({
      repo: 'arielagor/dream-machine',
      pr: 7,
      exec: exec({ view: { ...PR, headRepositoryOwner: null } }),
    });
    expect(r.ok && r.pr.sameRepoAuthor).toBe(false);
  });

  it('fails when gh cannot read the PR', async () => {
    const r = await gatherPr({ repo: 'a/b', pr: 7, exec: exec({ viewCode: 1 }) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/gh pr view failed/);
  });

  it('fails on unparseable gh output instead of voting on nothing', async () => {
    const r = await gatherPr({ repo: 'a/b', pr: 7, exec: exec({ view: 'not json' }) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/could not parse/);
  });

  it('fails when the diff cannot be fetched', async () => {
    const r = await gatherPr({ repo: 'a/b', pr: 7, exec: exec({ diffCode: 1 }) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/gh pr diff failed/);
  });

  it('fails on an empty diff — a degraded fetch is not a clean no-op change', async () => {
    const r = await gatherPr({ repo: 'a/b', pr: 7, exec: exec({ diff: '  \n ' }) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/empty/);
  });

  it('includes the ledger tail when a ledger is readable', async () => {
    const r = await gatherPr({
      repo: 'a/b',
      pr: 7,
      exec: exec(),
      ledgerPath: 'L.md',
      readFile: async () => '| h |\n| - |\n| r1 |\n| r2 |\n',
    });
    expect(r.ok && r.pr.ledgerTail).toContain('r2');
  });

  it('degrades gracefully when the ledger is missing', async () => {
    const r = await gatherPr({
      repo: 'a/b',
      pr: 7,
      exec: exec(),
      ledgerPath: 'L.md',
      readFile: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(r.ok && r.pr.ledgerTail).toBe('(ledger unavailable)');
  });
});
