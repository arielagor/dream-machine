# Council verdicts

Every merge judgement this repository has made, and who made it.

There is no human reviewer behind these decisions. A council of three model
families — Claude, Gemini and Grok — reads each pull request and votes; two
concurring votes merge it. See
[ADR-0003](../adrs/ADR-0003-council-of-model-families-merge-gate.md) for why,
and what was given up to get there.

Each row is written by `.github/workflows/council-gate.yml`; the full transcript
of any verdict is posted as a comment on the PR it judged. The `Witness` column
is the first 8 hex of `sha256(sha256(transcript) + head_commit)` — the same
provenance stamp the nightly reports carry, so a verdict can be re-derived from
its transcript and the commit it judged.

Read the `Self-mod?` column. `YES` means the council merged a change to its own
code or to the workflow that runs it. Repository policy permits that on the same
simple majority as any other change, so this column is how the consequence of
that choice stays countable rather than buried in commit history.

A `BLOCK` row is a working gate, not a failure. So is a degraded-panel block —
if any family could not be reached, the vote is void, because the families that
did answer still return confident-looking votes.

| Date | PR | Decision | Tally | Panel | Self-mod? | Rationale | Witness |
| --- | --- | --- | --- | --- | --- | --- | --- |
