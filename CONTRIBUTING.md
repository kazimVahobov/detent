# How a change lands

detent is a tool built for one workspace, and this is not an invitation to send
patches. The process below is here because it is the method detent exists to
enforce, applied to detent — a repository about the line between a person and an
agent cannot be developed by committing to `main` on good judgement alone.

## Branches

```
feature/<slug>  →  dev  →  staging  →  main          the human side
                    │
                    └──→  agent/dev  ──→  (PR back into dev)
```

| Branch | What it is |
|---|---|
| `main` | released. Tags here publish to npm under `latest` |
| `staging` | release candidate. Tags here publish a prerelease under `next` |
| `dev` | human integration, and the branch `agent/dev` is compared against |
| `feature/*`, `hotfix/*` | one change, off `dev` |
| `agent/dev`, `agent/task-*` | the agent namespace. See [ADR 0001](docs/adr/0001-agent-branch-namespace.md) |

Three human stages rather than two because the package is published: `staging`
is the branch where a version is a release candidate under the `next` dist-tag,
which is a stage with an observable output rather than a ceremony.

**Nothing reaches `dev`, `staging` or `main` except through a pull request with
a green gauge.** Self-merging is expected — the pull request is the record and
the place the gauge reports, not a ritual of asking permission.

**`agent/dev` is never pushed by the tool** and is merged back by a person. That
boundary is the product; a shortcut here would be a shortcut in the thing being
sold.

## The gauge

```
npm run verify
```

Zero dependencies, so there is no install step. It must be green before a pull
request, and CI runs the same command on `main`, `dev`, `staging` and anything
under `agent/`. Three things run in it:

1. `check-no-deps.mjs` — the zero-dependency claim
2. `check-progress.mjs` — `PROGRESS.md` says nothing it cannot prove
3. `node --test` — the tests

## Commits

`type(scope): subject`, imperative, in English. Types in use: `feat`, `fix`,
`docs`, `build`, `ci`, `test`, `refactor`, `chore`.

The body carries **why**, not what — the diff already says what. A commit that
only restates its own diff is the one worth rewriting.

Commits made by detent carry the trailers from
[DESIGN.md §10](DESIGN.md#10-commits):

```
Task: 0042
Gauge: lint ✓ typecheck ✓ test ✗ — 3 failing tests
Outcome: escalated — three identical failures on one stage
```

Human commits do not. The side effect is worth having: `git log` says who did
what without a separate report.

Everything inside the repository is written in English — it is a public
portfolio, and a reader should not need a second language to follow the
reasoning.

## Decisions

A change that **reverses or narrows** an earlier choice carries an ADR in
[`docs/adr/`](docs/adr/). A change that clarifies wording does not. The test is
whether a reader six months from now would ask "why is it not the obvious way?"

`DESIGN.md` says what detent is *now*; it carries no history. ADRs carry what
was displaced and what it cost. When the two disagree, `DESIGN.md` wins as the
specification and the ADR wins as the record — and the disagreement is a missing
ADR.

ADRs are never edited, only superseded by a later one.

## Progress

Finishing a step of the build order means editing `PROGRESS.md` in the same
pull request: the state, the proof, the date. The gauge refuses a `done` that
names no proof, so this is not a convention to remember.

## Releases

```
npm version <x.y.z>          # or <x.y.z>-rc.N on staging
git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which refuses to publish
unless the tag matches the version in `package.json`, derives the dist-tag from
the version (a prerelease goes to `next`, everything else to `latest`), and
publishes with `--provenance` so the chain from package to commit to workflow is
verifiable rather than asserted.

Nothing is published by hand. See
[ADR 0006](docs/adr/0006-zero-dependencies-node-22.md) for why the published
artifact is the source, and
[ADR 0007](docs/adr/0007-scoped-package-name.md) for why the package name
carries a scope.
