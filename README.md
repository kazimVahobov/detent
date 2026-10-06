# detent

**Autonomy bounded by a machine-checkable gauge, and measured.**

A detent is the catch that holds a mechanism in a defined position until it is
deliberately released. Here it is released by a green gauge — the project's own
checks — and by nothing else.

> **Status: 0.1.0, end to end.** `detent run` takes tasks from a queue to
> `agent/dev` with Claude Code, Codex or Gemini CLI behind the gauge, and
> `detent summary` reports what it cost. Not built yet: `doctor` and `init`
> (write `product.json` by hand), the dashboard, parallel runs, promotion, the
> acceptance pass and `plan`. [PROGRESS.md](PROGRESS.md) says where the build is.

## What it will do

Runs coding agents against a queue of tasks, refuses to let them finish while
the project's own checks are red, and writes down what every run cost in
attempts, time and money.

The constraints are in the code, not in the prompt.

**When is the agent allowed to stop?** Not when it says it is done — when the
project's checks pass. The gauge runs on the agent's way out; red means it does
not get to leave, and it is handed the failure text to work from. Three attempts, then the task is paused and
you are told — not a fourth attempt, and not a verdict nobody has looked at.

**Was it worth it?** Every run is a line in a journal: which model, how many
times it hit red, which stage it died on, how long, how much. That turns "which
model should run this repository" from an opinion into a number.

**Where the boundary is.** The acceptance pass runs on a second model and can
*demote, never approve*. Green is granted by machine checks; a model's
judgement may only raise a doubt and send the task to a person. Otherwise
"proven" quietly becomes "a second model agreed".

## The line agents do not cross

```
       human                   │                     agents
  ─────────────────────────────┼──────────────────────────────────────────
  dev → staging → main         │   agent/task-<id>-<slug>
  feature/*, hotfix/*          │         │ merge, when the gauge is green
                               │         ▼
                               │   agent/dev
                               │         │ promote, when the batch is green
                               │         ▼   (optional)
                               │   agent/staging
                               │
  dev → agent/dev  ────────────┼──→  here is my work, take it into account
  agent/staging → dev  ←───────┼───  I accept yours
```

detent reads and writes refs under `refs/heads/agent/` and nothing else — one
namespace, one predicate, one glob to audit it with. Both gates between the
territories are human operations, in both directions. It refuses to start on a
dirty tree, and never moves a ref outside its own namespace.

`agent/staging` is optional and exists for one reason: the per-task gauge checks
a task, and what actually breaks is the combination. The batch gauge runs there,
and how often a batch came out red after every task in it was green is a number
detent reports.

## This product is opinionated

It expects a product shaped a particular way, and says so instead of adapting
to everything:

1. git, not a shallow clone
2. the product's repositories sit side by side in one folder — one per unit of ownership
3. each repository names one human branch to be compared against (any name) — a
   release train behind it is not detent's business
4. the gauge is declared as stages: a name and a command, runnable locally — the
   per-attempt profile in seconds
5. a clean tree when a run starts
6. an agent CLI installed and authenticated — Claude Code, Codex or Gemini CLI
7. the integration branch is not deployed; pushing is done by hand
8. one person per workspace
9. macOS or Linux, Node 22

`detent doctor` checks all nine and tells you what to change.

## Design

[DESIGN.md](DESIGN.md) is the specification the code is being written against:
the branch boundary and the invariant that guards it, the task lifecycle with
every outcome it can have, the shape of `product.json` and of a journal line,
what the gauge is and why it has two profiles, and what is deliberately left
out.

It is written before the code rather than after it, which is also how detent
expects tasks to be written.

## How this repository is built

The method the tool enforces, applied to the tool. Nothing reaches `dev`,
`staging` or `main` except through a pull request with a green gauge; decisions
are recorded with the alternatives they displaced; and progress is a table the
gauge refuses to let lie.

- [CONTRIBUTING.md](CONTRIBUTING.md) — branches, commit format, how a release is cut
- [docs/adr/](docs/adr/) — eight decisions, each with what it rejected and what that cost
- [PROGRESS.md](PROGRESS.md) — where the build actually is, against the build order
- [CHANGELOG.md](CHANGELOG.md)

detent does not build itself yet: until there is a journal there is nothing to
dispatch with, so the branch model and the commit format are followed by hand,
under the names the tool will use. What changes at self-hosting is who types the
commands.

## License

MIT
