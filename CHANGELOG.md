# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions mean what
[`PROGRESS.md`](PROGRESS.md) says they mean.

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
