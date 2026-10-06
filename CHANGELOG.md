# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions mean what
[`PROGRESS.md`](PROGRESS.md) says they mean.

## Unreleased

### Added

- Build step 1: `core/product.mjs` loads `.detent/product.json` strictly — every
  problem at once, each naming its path; branch values checked against
  `agent/` and as git ref names; `branches.staging` and `gauge.promote` refused
  by name until step 10. `core/task.mjs` reads the queue in
  `tasks/{todo,hold,done,failed}` and rejects one that cannot be executed.
  Nothing calls either yet.
- Build step 2: `core/gauge.mjs` runs a profile's declared stages and names the
  one that went red; `core/lock.mjs` turns a history of gauge results into the
  decision on the agent's way out — leave, retry with the failure text, or
  escalate after `attempts` identical failures in a row. DESIGN.md §6 now says
  what "identical" means.
- Build step 3: `core/workspace.mjs` holds the invariant — every exit from a
  task, including Ctrl-C, leaves the repository on `agent/dev` with a clean tree
  and moves no ref outside `refs/heads/agent/`. Unfinished work is parked as a
  wip commit on the task branch, written without running hooks.
  `.detent/state.json` records which repository is out, and `detent recover` —
  the first command that does something — returns what a hard kill left behind.

- `detent gauge [repo…] [--profile exit|merge]` runs a repository's gauge by
  hand, outside any run.

- Claude Code, Codex and Gemini CLI run behind one call, `core/agents.mjs`,
  each tested against the output its CLI really prints
  ([ADR 0010](docs/adr/0010-three-agent-clis.md)).

### Changed

- A role in `models` names its agent: `{ "agent": "claude" | "codex" |
  "gemini", "model"?: string }`, instead of a bare model name.

- A task gets `attempts` attempts (default 3); red on the last one pauses it in
  `tasks/hold/`, keeps its branch, and notifies the developer through the
  `notify` command in `product.json` or a desktop notification. Moving it back
  to `todo/` resumes it on the same branch. Identical failures no longer decide
  when to stop, only how the escalation reads
  ([ADR 0009](docs/adr/0009-three-attempts-then-pause.md)).

- Session work on detent itself now goes through a task file and an
  `agent/task-<id>-<slug>` branch, as `CONTRIBUTING.md` said it would once the
  queue existed.

## 0.0.2 — 2026-10-03

The first release cut by the workflow rather than by hand: tagged, checked
against `package.json`, published with provenance.

### Added

- The agent branch namespace moved behind a slash — `agent/dev`,
  `agent/task-<id>-<slug>` — making the boundary one predicate, one glob and one
  assertion instead of a prefix convention
  ([ADR 0001](docs/adr/0001-agent-branch-namespace.md)).
- Optional agent-side staging: `branches.staging`, a third gauge profile
  `promote`, and a `detent promote` command that checks a batch rather than a
  task ([ADR 0008](docs/adr/0008-optional-agent-staging.md)). Specified, and
  refused by the loader until build step 10.
- Eight decision records in [`docs/adr/`](docs/adr/).
- [`PROGRESS.md`](PROGRESS.md), with `check-progress.mjs` in the gauge so a step
  cannot be marked done without a proof that exists.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): branches, commit format, when a change
  needs an ADR, how a release is cut.
- A release workflow that publishes from a tag with provenance and **no stored
  credential** — npm trusts the repository and the workflow file over OIDC — and
  refuses a tag that disagrees with `package.json`.

### Changed

- `detent promote` is listed in `detent --help`, and exits 70 like every other
  command that does not exist yet. This is the only change to the published
  artifact; the rest of the release is the reasoning behind it.
- The package metadata spells the GitHub account `kazimVakhobov` —
  `repository`, `homepage`, `bugs` and `author` previously resolved only
  through a rename redirect.
- Condition 3 loosened: a repository names *one* human branch to be compared
  against, and a release train behind it is not detent's business.
- `product.json` validates every branch value against `^agent/`, and the schema
  is strict — an unknown key is an error rather than a silent no-op.
- Journal lines carry `kind`, never defaulted, so a promotion can never be
  counted as a task run.

Still nothing implemented — [`PROGRESS.md`](PROGRESS.md) says where the build
actually is.

## 0.0.1 — 2026-10-03

### Added

- The name, held on npm as `@kazimvakhobov/detent`.
- A CLI skeleton that lists its commands and exits 70 on the ones that do not
  exist yet, rather than pretending.
- The repository's own gauge: zero dependencies, checked; tests on Node 22.
- [`DESIGN.md`](DESIGN.md) — the specification the code is written against.

Nothing is implemented. The package exists to hold the name.
