# ADR-0003: A council of model families replaces the human merge gate

- **Status:** Accepted
- **Date:** 2026-08-28
- **Supersedes in part:** [ADR-0001](ADR-0001-dream-machine-engine.md) (the
  "evaluation is not promotion — a human decides" boundary and the guarded
  auto-merge policy)

## Context

The upstream Dream Machine's central safety claim is *"evaluation is not
promotion — the machine never merges; a human does."* That boundary was enforced
in five places: the guarded auto-merge workflow (which required a human to
attach an `automerge-safe` label, and refused any PR touching a protected path
outright), the compiled nightly prompt, the GitHub-Actions nightly script, the
scheduler's paste-in instructions, and the CLI help text.

The boundary was well chosen for its stated threat model. ADR-0001 cites the
Sakana "AI Scientist" reward-hacking incident and the AutoGPT-lineage loops with
roughly 5% follow-through: an open-loop agent that can promote its own work
optimises for the promotion signal rather than for the truth. A human in the
merge path is a cheap, reliable interrupt on that failure mode.

It also has a cost the upstream design acknowledges implicitly: the loop only
compounds as fast as a human reviews it. A machine that produces one evidenced
candidate every night, and needs a person to read each one, is bounded by that
person's attention, not by its own evidence. Upstream's own ledger records draft
PR #24 sitting green and unmerged for days across multiple nights.

This fork removes the human from the merge path. The question this ADR answers
is what replaces them, because *nothing* is not an acceptable answer — removing
the interrupt without replacing it is exactly the open-loop design the prior art
warns about.

## Decision

**The merge judgement is made by a council of three model families — Claude,
Gemini and Grok — voting from three different providers. Two concurring votes
merge. Nothing is human-gated.**

Five properties make that defensible:

1. **The producer never judges.** The nightly session still never merges its own
   candidate. A separate process, with no authoring context, casts the votes.
   This is the load the human used to carry, and it is the reason a majority
   means anything: the agent that wants the merge is not in the room.

2. **The families are from different providers.** A same-family panel shares its
   blind spots, so a three-Claude jury is closer to one vote than to three.
   Cross-provider diversity is the point, not redundancy.

3. **A degraded panel never merges.** If any configured family is unreachable —
   missing key, timeout, provider outage — the vote is void. This rule exists
   because the failure is silent: the families that *do* answer still return
   confident, well-formed votes, so without it an outage quietly converts a
   three-family gate into a one-family gate that still reads as unanimous.
   Unparseable output is coerced to `ABSTAIN`, which counts as not-a-merge.

4. **The count is code, not a model.** `tally()` is plain arithmetic. A
   synthesiser model deciding "what the panel concluded" would collapse the
   whole gate back into one model's opinion, which is what the panel exists to
   avoid.

5. **Every verdict is witnessed.** The transcript is bound to the head commit by
   the same reproducible double-sha256 the nightly reports use, and logged to
   `docs/dream-cycle/COUNCIL.md`. A merge nobody can reconstruct afterwards is
   not an improvement on a merge nobody reviewed.

### Flat majority, including the council's own code

The quorum is uniform. Two votes merge a README typo and two votes merge a
change to `packages/council/` or to `council-gate.yml`. The council can rewrite
the rules it is judged by.

This was chosen deliberately over a tiered scheme (unanimity on sensitive paths)
and over a small never-merge core. A never-merge core is a human gate wearing a
different hat — it would mean the honest description of this repository is
"autonomous except where it matters", which is worse than either alternative
because it reads as fully autonomous while quietly not being.

The risk is real and is not mitigated by threshold. It is mitigated, partially,
by making it *legible*:

- `assessRisk()` classifies every changed path and the vote prompt states, in
  terms, when the PR modifies the gate deciding it;
- the council log records a `Self-mod?` column, so gate changes are countable
  after the fact rather than buried in commit history;
- `COUNCIL_ENABLED=false` is an operator kill switch — an off switch, not a
  review step.

If this proves wrong, the evidence will be in that column, and the remedy is a
quorum change in config rather than a redesign.

### The public-repository authorship guard

`council-gate.yml` runs on `pull_request_target`, so on a public repository it
executes with repository secrets and write permission. Only PRs whose head
branch lives in this repository are council-judged. This is an authorship check,
not a review gate: the nightly runner pushes `dream/*` branches here and is
unaffected, while an arbitrary third party cannot obtain a three-model merge
vote by opening a PR. The workflow also checks out `base.sha`, never the PR
head, so untrusted code never executes beside the credentials.

## Consequences

**Gained.** The loop closes without a person in it. A candidate that survives
the nightly pipeline's own gates *and* an adversarial cross-provider panel lands
the night it is produced. Merge decisions become a reviewable, witnessed record
rather than an unrecorded human judgement.

**Lost.** The human interrupt is gone, along with the guarantee ADR-0001 offered
against a sufficiently sophisticated reward hack. Three models can agree and be
wrong together — particularly on a failure mode all three share. The panel is
adversarial by construction (round 2 is explicitly a cross-examination) but it
is not a proof.

**Costs.** Each PR spends three families over two rounds — six model calls plus
the diff, twice. Claude runs through the CLI on a subscription; Gemini and Grok
are metered per PR.

**Reversible.** Setting `council.enabled: false` restores the upstream
compile-time prose and merge behaviour exactly; the compile golden snapshot for
a council-less config moved by two clarifying lines and nothing else.

## Alternatives considered

- **Tiered quorum** (majority for ordinary paths, unanimity for gates, CI and
  dependencies). Prices the risk honestly and keeps everything autonomous.
  Rejected in favour of the simpler uniform rule, which is easier to reason
  about and does not invite argument about which paths are "really" sensitive.
- **A never-merge core** (the council may merge anything except itself).
  Genuinely safer, and rejected because it is a human gate in the one place the
  gate matters most, while presenting as fully autonomous.
- **A single strong model as reviewer.** Cheaper and much simpler. Rejected: it
  reintroduces the single point of failure — the reviewer's blind spots become
  the repository's, with no second opinion to catch them.
- **Keeping the human and adding the council as advisory.** The safest option
  and not what was asked for; it also leaves the throughput ceiling exactly
  where it was.
