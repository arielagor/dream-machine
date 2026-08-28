# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories
(**Security → Report a vulnerability**) on this repository. Do not open a public
issue for a suspected vulnerability.

This is a fork of [`ruvnet/dream-machine`](https://github.com/ruvnet/dream-machine).
A vulnerability in the shared engine should also go upstream (ruv@ruv.net); one
in the council gate (`packages/council`, `.github/workflows/council-gate.yml`)
exists only here.

## Threat model & design guarantees

The Dream Machine runs an autonomous nightly loop against a repository. Its
safety rests on a small set of invariants, enforced in code and CI:

**There is no human in the merge path.** That is the deliberate difference from
upstream, and it changes the threat model rather than merely relaxing it — see
[ADR-0003](docs/adrs/ADR-0003-council-of-model-families-merge-gate.md), which
states what was given up. What replaces the human:

- **The producer never judges.** The nightly session never merges and never
  self-promotes candidate state; it only opens *draft* PRs. The votes are cast
  by a separate process with no authoring context.
- **Merge by council, 2 of 3.** `.github/workflows/council-gate.yml` convenes
  Claude, Gemini and Grok. Two concurring votes merge. The threshold is flat
  across all paths, including the council's own code — a change that alters how
  every future PR is judged merges on the same simple majority as any other, and
  is recorded in the `Self-mod?` column of `docs/dream-cycle/COUNCIL.md`.
- **A degraded panel never merges.** Any unreachable family voids the vote. This
  is the most important rule here: the families that do answer still return
  confident, well-formed votes, so without it a provider outage silently reduces
  a three-family gate to a one-family gate that still reads as unanimous.
  Unparseable model output is coerced to `ABSTAIN`, never to consent.
- **The tally is code.** The count that turns votes into a merge is arithmetic,
  not a model call, so it is reviewable and cannot be argued with by a prompt.
- **The fail-closed invariant is proven in CI.** The `council-fails-closed` job
  runs the real gate with no model credentials and fails the build if it returns
  `MERGE`.
- **`pull_request_target` hardening.** The gate runs with repository secrets and
  write permission, so it (a) checks out `base.sha` and never the PR head, so
  untrusted code never executes beside the credentials, and (b) refuses to judge
  any PR whose head branch is not in this repository. Without (b), any third
  party could open a PR against this public repo and obtain a three-model merge
  vote. This is an authorship check, not a review gate.
- **Kill switch.** Repository variable `COUNCIL_ENABLED=false` halts all merging.
- **Least-privilege CI.** Each workflow declares the minimum `permissions:`
  it needs; `contents: read` is the default. The council gate is the exception
  and needs `contents: write` + `pull-requests: write` to do its job.
- **Optional dependencies are optional.** The ruvector/RVF wasm backends are
  peer-optional; a missing module is a graceful no-op (verified by the
  `no-optional-deps` CI job).
- **Witnessed provenance.** Every nightly report *and every merge verdict* is
  bound to its commit by a reproducible double-sha256 witness that any third
  party can re-derive.

## Supply chain

- npm publishes use OIDC provenance (`--provenance`).
- Dependabot watches npm and GitHub Actions.
- CodeQL (`security-extended`) runs on every push, PR, and weekly.
- A Dependabot PR is a council decision like any other. Dependency manifests are
  classified as elevated risk and surfaced to the voters, but they are not
  human-review-only, so a supply-chain change can merge on two votes.

## Known limitations

Stated rather than glossed:

- **Three models can be wrong together.** Cross-provider diversity reduces
  correlated error; it does not eliminate it. A reward hack that reads as a
  genuine improvement to all three lineages will merge.
- **The council can rewrite its own gate.** Flat majority is a deliberate choice
  (ADR-0003). The `Self-mod?` column exists so the consequence stays countable.
- **Prompt injection reaches the voters.** A PR title, body, or diff comment is
  attacker-controlled text that the panel reads. The voters are told to judge the
  diff rather than the narrative, and the tally is outside the model, so an
  injection must convince two independent families rather than flip a parser.
