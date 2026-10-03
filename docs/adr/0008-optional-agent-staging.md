# 0008. Optional agent-side staging, for a gauge that checks a batch

- **Date:** 2026-10-03
- **Status:** accepted

## Context

Both existing gauge profiles check **one task**: `exit` on every attempt,
`merge` once before the task lands on `agent/dev`. Nothing checks the
combination, and the combination is what actually breaks — five tasks green on
their own, and together a failing build, a broken integration, a contract that
no longer matches its consumer.

So the branch a person was being asked to review had passed no check stronger
than its weakest individual task.

A separate, weaker request pointed the same way: a release train
(`dev → staging → main`) so that work passes through stages. That part needs
nothing from detent — the human side of the boundary is already invisible to it
(0001), and a human `staging` branch works today with no configuration. What was
missing was a stage on the **agent** side, with a check of its own.

## Decision

An optional second stop in the namespace, declared or absent:

```json
"branches": { "integration": "agent/dev", "staging": "agent/staging", … },
"gauge":    { "exit": [ … ], "merge": [ … ], "promote": [ … ] }
```

**`detent promote`** merges `agent/dev` into `agent/staging` behind the
`promote` profile. Explicit, never automatic after a task.

- Gate: clean tree · no active run · `agent/staging` exists · at least one task
  landed since the last promotion.
- Green: the merge happens, and the human gate becomes `agent/staging → dev`.
- Red: **nothing is promoted and nothing is reverted.** The work stays on
  `agent/dev`; the failed stage goes to the journal.
- Conflict: `merge --abort`, escalate — as everywhere.
- Interrupted: `detent recover` returns the repository to `agent/dev`, clean.

A promotion is its own journal line, `"kind": "promote"`, carrying the list of
tasks in the batch.

## Consequences

- **`summary` gains the number this exists for:** how often a batch came out red
  after every task in it was green. That is the per-task gauge's blind spot,
  measured — the same kind of evidence as `rejected` (0004), one level up.
- The branch a human reviews has passed more checks than any single task in it.
- **`kind` becomes required on every journal line, never defaulted.** A
  `summary` that counted promotions as task runs would corrupt the pass rate
  silently, which is the failure mode the `requested`/`actual` model pair
  already exists to prevent.
- `recover` has a second interrupted operation to handle.
- `doctor` gains a check: `gauge.promote` declared with no `branches.staging` is
  a declared check that nothing runs — the same invented green as a missing
  gauge.
- Two configurable branches instead of one, so "no field can name a human
  branch" stops resting on there being a single field and becomes `^agent/`
  validated on load (0001).
- Nothing changes for a product that declares neither: the command says there is
  no staging branch and exits.
- The invariants are untouched. Staging refines **I3** — work lands somewhere
  that is not the human's branch, now with two stops — and adds no fifth
  invariant.

## Alternatives rejected

**Put the slow checks in the `merge` profile.** Pays the full cost once per
task, and still never checks a combination: `merge` runs before the task joins
the others.

**Promote automatically after every task.** Then the batch is always one task,
and the profile is a slow `merge` under a new name.

**A human-side `staging` branch only.** Free, already supported, and it checks
nothing and produces no number. Worth having as a release train; not a substitute
for a gauge.

**Bisect a red batch to find the culprit.** Tempting, and it means replaying
subsets of a batch — a build system, not a dispatcher. A confident wrong culprit
costs more than no answer; the journal says which batch went red and which tasks
were in it, and a person reads it.
