# How a change lands

detent is a tool built for one workspace, and this is not an invitation to send
patches. The process below is here because it is the method detent exists to
enforce, applied to detent — a repository about the line between a person and an
agent cannot be developed by committing to `main` on good judgement alone.

## Branches

```
agent/task-*  →  agent/dev  ──PR──→  dev  →  staging  →  main
feature/*  ──────────────────PR──→   dev
```

| Branch | What it is |
|---|---|
| `main` | released. Tags here publish to npm under `latest` |
| `staging` | release candidate. Tags here publish a prerelease under `next` |
| `dev` | human integration, and the branch `agent/dev` is compared against |
| `feature/*`, `hotfix/*` | a change **you wrote yourself**, off `dev` |
| `agent/dev`, `agent/task-*` | everything **an agent** produced. See [ADR 0001](docs/adr/0001-agent-branch-namespace.md) |

### Which side a change belongs to

An agent's output goes into the agent namespace **whether a dispatcher produced
it or a person sat through the session watching.** The reason the boundary
exists — work written by a model gets accepted by a person before it mixes with
their own history — does not weaken because someone was present while it was
written. A session is not a different kind of authorship, only a different kind
of supervision.

So the work of a session lands on `agent/dev` and reaches `dev` through a pull
request. `feature/*` is for the changes you type.

**Session work is a task, on a task branch.** Each piece of work gets a task
file in the shape of [DESIGN.md §4](DESIGN.md#4-tasks), a real number, and its
own `agent/task-<id>-<slug>` branch off `agent/dev`. When `npm run verify` is
green it merges into `agent/dev` with `--no-ff`, so the task stays visible as
one unit in the history, and its commits carry a `Task: NNNN` trailer.

The task files live where detent expects them: in a product folder, beside the
repository rather than inside it
([ADR 0005](docs/adr/0005-queue-in-the-product-folder.md)). For detent that
folder is whichever directory holds the clone:

```
<folder>/
  .detent/product.json      one repository, "detent", compared against dev
  tasks/{todo,hold,done,failed}/NNNN-<slug>.md
  detent/                   this repository
```

with `.detent/product.json`:

```json
{
  "version": 1,
  "product": { "name": "detent" },
  "repos": [
    {
      "name": "detent",
      "compare": "dev",
      "gauge": {
        "exit": [
          { "stage": "deps", "command": "node scripts/check-no-deps.mjs" },
          { "stage": "progress", "command": "node scripts/check-progress.mjs" },
          { "stage": "test", "command": "node --test" }
        ]
      }
    }
  ]
}
```

The queue is not versioned, by design, so a fresh clone starts with an empty
one. The counter then continues from git rather than from the folders: the next
number is one past the highest `Task:` trailer on `agent/dev`
(`git log agent/dev --format='%(trailers:key=Task,valueonly)'`). The task's text
survives in the body of its merge commit.

Work done before step 1 landed went straight onto `agent/dev`: there was no
queue to take a number from, and a numbered branch with an invented number is
the decorative green this project refuses.

Three human stages rather than two because the package is published: `staging`
is the branch where a version is a release candidate under the `next` dist-tag,
which is a stage with an observable output rather than a ceremony.

**Nothing reaches `dev`, `staging` or `main` except through a pull request with
a green gauge.** Self-merging is expected — the pull request is the record and
the place the gauge reports, not a ritual of asking permission.

**`agent/dev` is never pushed by detent** and is merged back by a person. That
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
Outcome: escalated — 3 identical failures on test
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

A version bump is a change like any other; the tag is only a pointer. Those are
two separate steps on purpose — `npm version` on its own commits into whatever
branch you are standing in, which for a release is `main`, straight past the
rule above.

**Bump where the work is,** as part of an ordinary pull request:

```
npm version 0.0.2 --no-git-tag-version
git commit -am "build: 0.0.2"
```

**Tag once it has arrived,** after the bump has travelled `dev → staging → main`:

```
git switch main && git pull
git tag v0.0.2 && git push origin v0.0.2
```

The tag triggers `.github/workflows/release.yml`, which refuses to publish
unless the tag matches the version in `package.json`, derives the dist-tag from
the version (a prerelease goes to `next`, everything else to `latest`), and
publishes with `--provenance` so the chain from package to commit to workflow is
verifiable rather than asserted.

**There is no publish token.** npm trusts this repository and this workflow file
by name — configured once under Trusted Publisher on the package's npm settings
page — and exchanges the run's OIDC identity for a short-lived credential. The
repository stores no publishing secret: nothing to rotate, nothing to leak, and
nothing that stops working when npm retires the 2FA-bypassing tokens it is
retiring.

Two consequences worth knowing before a release goes red:

- **The workflow that runs is the one at the tagged commit.** Changing
  `release.yml` means the change must reach `main` before the tag is placed, or
  moved if it is already there.
- **The trusted publisher is matched by workflow filename.** Renaming
  `release.yml` breaks publishing until the npm side is updated to match.

**Bring the merge commits back down.** A pull request puts its merge commit on
the *target*, so after a release `staging` and `dev` sit a commit or two behind
`main` with identical contents. Nothing breaks, but to anyone browsing the
repository it reads as an abandoned `dev`:

```
git switch staging && git merge main && git push
git switch dev && git merge staging && git push
```

The last hop, `dev → agent/dev`, is the human gate. It is crossed when you
decide the agents should see your work, not as a step of a release.

A release candidate is the same thing with a prerelease version
(`0.1.0-rc.1`), tagged on `staging` rather than `main`. The workflow routes it
to `next` by itself, so a plain `npm install` can never resolve to it.

Nothing is published by hand. See
[ADR 0006](docs/adr/0006-zero-dependencies-node-22.md) for why the published
artifact is the source, and
[ADR 0007](docs/adr/0007-scoped-package-name.md) for why the package name
carries a scope.
