# Progress

One row per step of the build order in [DESIGN.md §14](DESIGN.md#14-build-order),
in dependency order rather than in order of interest.

This file is a claim about what exists, so the claim is checked:

> **A step is `done` only when it names a proof that exists** — normally the
> test that holds it. `scripts/check-progress.mjs` runs inside `npm run verify`
> and fails the gauge if a row claims `done` without a proof or a date, if the
> file it names is missing or empty, or if the table has drifted from the build
> order it tracks. A progress table nobody checks is exactly the invented green
> this project exists to refuse.

## Where the build is

| # | Step | State | Proof | Date |
|---|---|---|---|---|
| 0 | the name, the CLI skeleton, the repo's own gauge, the specification | done | `test/cli.test.mjs` | 2026-10-03 |
| 1 | `product.json` + task reading + frontmatter validation | done | `test/product.test.mjs`, `test/task.test.mjs` | 2026-10-06 |
| 2 | the gauge and the lock — useful on their own, before any run exists | done | `test/gauge.test.mjs` | 2026-10-06 |
| 3 | the gate, `state.json`, unconditional return, `recover` | done | `test/workspace.test.mjs` | 2026-10-06 |
| 4 | one task from file to commit on a task branch, sequentially | done | `test/run.test.mjs`, `test/agents.test.mjs` | 2026-10-06 |
| 5 | merge into `agent/dev`, with abort on conflict | done | `test/run.test.mjs` | 2026-10-06 |
| 6 | journal + `summary` | done | `test/journal.test.mjs`, `test/run.test.mjs` | 2026-10-06 |
| 7 | `doctor` and `init` pass 1 — the deterministic scan they share | done | `test/init.test.mjs`, `test/doctor.test.mjs` | 2026-10-06 |
| 8 | `dashboard` — reading what already exists | done | `test/dashboard.test.mjs` | 2026-10-06 |
| 9 | the scheduler: repository occupancy and barriers | done | `test/scheduler.test.mjs` | 2026-10-06 |
| 10 | `promote`: `agent/staging`, the batch profile, its journal line | done | `test/promote.test.mjs`, `test/doctor.test.mjs` | 2026-10-06 |
| 11 | the acceptance pass | done | `test/acceptance.test.mjs` | 2026-10-06 |
| 12 | `init` pass 2 — the model pass and its schema | done | `test/model-pass.test.mjs` | 2026-10-07 |
| 13 | `plan` | todo | — | — |

States are `todo`, `wip`, `done`. Step 3 is where the tests live: it holds the
invariant that every exit leaves the repository on `agent/dev` with a clean tree
and moves no ref outside `refs/heads/agent/`.

## Milestones

| | |
|---|---|
| **end to end** | after step 6 — a task goes from a file to a commit on `agent/dev`, and the journal says what it cost |
| **worth showing** | after step 8 — there are numbers, and a page that displays them |
| **self-hosting** | the first time detent runs a task in this repository instead of a person running it by hand |

## Versions

`0.0.x` is the skeleton and holds the name. Published to npm as
`@kazimvakhobov/detent`; not yet installable for any purpose.

| Version | Means |
|---|---|
| `0.1.0` | end to end — step 6 |
| `0.2.0` | worth showing — step 8 |
| `1.0.0` | all thirteen steps, and a real batch of tasks run against a real product |

## detent does not build itself yet

Until step 6 there is nothing to dispatch with, so the branch model, the commit
format and the acceptance of work are followed **by hand** — by a person and an
agent in a session, under the same names and the same rules the tool will use.

**The names do not change when that flips.** `agent/dev` is already the
integration branch, `agent/task-<id>-<slug>` is already the shape of a task
branch, and `npm run verify` is already the gauge. What changes at self-hosting
is who types the commands, and that is the point: a process that only works when
a person is careful is not the process this project is about.
