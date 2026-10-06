# Design

What detent is, written down before it is built. Decisions are recorded with
the reason that produced them: in six months the reason is worth more than the
decision.

> **Status: being built.** This is the specification the code is written
> against, not a description of working software. [PROGRESS.md](PROGRESS.md)
> says which steps of the build order exist.

---

## 1. Four invariants

detent is opinionated about how a product is laid out. It is worth separating
what it actually *requires* from how that requirement happens to be met, because
only the first kind of deviation is fatal.

| | Invariant | How detent meets it |
|---|---|---|
| **I1** | A unit of work is **isolable** — a task gets a clean, private place to work | one task at a time per repository, on its own branch |
| **I2** | Done is **machine-checkable locally**, in seconds | the gauge: declared stages, run on the agent's way out |
| **I3** | Work lands **somewhere that is not the human's branch** | `agent/dev`, optionally a second stop on `agent/staging`, and the human merges from it |
| **I4** | A task's blast radius is **declarable** | the exclusion key is the repository |

Repositories side by side in one folder, a documentation submodule, the names
`dev` and `agent/dev`, how many stops the work makes before the human gate —
none of that is an invariant. It is one implementation of the four above, and it
is the one detent implements.

---

## 2. The territory

```
       human                   │                     agents
  ─────────────────────────────┼──────────────────────────────────────────
  dev → staging → main         │   agent/task-<id>-<slug>
  feature/*, hotfix/*          │         │ merge, when the gauge is green
                               │         ▼
                               │   agent/dev
                               │         │ promote, when the batch is green
                               │         ▼   (optional, §7)
                               │   agent/staging
                               │
  dev → agent/dev  ────────────┼──→  here is my work, take it into account
  agent/staging → dev  ←───────┼───  I accept yours
```

detent reads and writes refs under **`refs/heads/agent/`** and nothing else. It
does not check out, commit to, merge into, or create a branch outside that
namespace — including the starting point of `agent/dev` itself.

The namespace is a single predicate rather than a convention spread across
string comparisons: a ref about to be written either begins with `agent/` or the
write is a bug. Everything detent owns is also one glob —
`git for-each-ref refs/heads/agent/` — which is what makes the invariant below
testable in one assertion instead of a list of branch names somebody has to
remember to extend.

One git detail travels with the slash: **a branch named exactly `agent` cannot
coexist with the namespace.** Refs are stored as paths, and a path cannot be
both a file and a directory — `'refs/heads/agent' exists; cannot create
'refs/heads/agent/dev'`, and the same error in the other direction. `detent
doctor` checks for it, because encountered mid-run it reads as a mystery rather
than a naming clash.

**Both gates are human operations, in both directions.** detent does not offer
to run them, because the point of the boundary is that crossing it is a
decision, not a step.

Two consequences, stated so they are not mistaken for oversights:

- **You create `agent/dev` yourself** — and `agent/staging`, if you declare one.
  Creating a branch means naming a start point, and the start point is a human
  branch. `detent doctor` prints the command and stops there.
- **A repository rests on `agent/dev`, not on your branch.** detent does not put
  you back where you were, because putting you back means naming your branch.
  You switch back yourself.

### The invariant that gets tested first

> Every exit from a task — success, red gauge, rejection, exception, Ctrl-C —
> leaves the repository **on `agent/dev` with a clean tree**, and every ref that
> moved lives under `refs/heads/agent/`.

This is the only place detent can destroy work that is not its own, so it is the
first thing covered by tests and the thing `detent recover` exists to restore.

The test is a snapshot of *every* ref before a run and after it, asserting that
the difference falls entirely inside the namespace. One assertion, and it fails
on a branch nobody thought to enumerate.

### Divergence is reported, never acted on

A human branch may be read to report how far `agent/dev` has drifted from it:

```
acme-api      agent/dev  ≡ dev
acme-web      agent/dev  12 commits behind dev   ⚠ agents cannot see your work
acme-admin    agent/dev  3 tasks ahead of dev    waiting for your review
```

Reading a ref is not touching a branch. Nothing follows from this report
automatically — stale `agent/dev` turns the gauge red for reasons that are not
the agent's fault, and knowing that is the point.

---

## 3. What detent expects of a product

Nine conditions. `detent doctor` checks all of them and names what to change.

1. git, not a shallow clone
2. the product's repositories sit side by side in one folder — one per unit of ownership
3. each repository names **one** human branch as the point `agent/dev` is
   reported against — a release train behind it is not detent's business
4. the gauge is declared as stages: a name and a command, runnable locally — the
   per-attempt profile in seconds
5. a clean tree when a run starts
6. an agent CLI installed and authenticated
7. the integration branch is not deployed; pushing is done by hand
8. one person per workspace
9. macOS or Linux, Node 22

A product that does not match is not bent into shape by detent. It is told what
does not match.

---

## 4. Tasks

### Identity

A task has a number, assigned when it is created. The number is the key; the
slug is for people.

```
tasks/todo/0042-wallet-endpoint.md   →   agent/task-0042-wallet-endpoint
```

The number appears in the filename and in the frontmatter, so it is visible
whichever one you opened. It never changes — the file moves between folders, the
number does not. The counter is the highest number across all four folders:
there is no separate counter file, and therefore nothing that can disagree with
reality.

### Shape

```markdown
---
id: 0042
repo: acme-api
touches_contract: false
---

# Goal

One paragraph: what must work when this is done.

# Acceptance criteria

- [ ] a checkable statement
- [ ] another one

# Out of scope

What not to do while you are in there.
```

The frontmatter is bookkeeping. **Only the body reaches the agent** — the spec
written before the work *is* the prompt, not a second document that drifts away
from it.

`touches_contract: true` makes the task a barrier (§8).

### Validation before any of it runs

`detent plan` and `detent run` both reject a queue that cannot be executed:
the repository must exist in `product.json`, acceptance criteria must be
non-empty, the id must be unique. Catching this before the first agent starts is
the difference between a typo and three wasted attempts.

---

## 5. Lifecycle

```
tasks/todo/0042-wallet-endpoint.md

  gate: clean tree · no merge or rebase in progress · agent/dev exists · repo free
        ──→ any of these fails: the repository is skipped, the run continues

  git checkout -b agent/task-0042-wallet-endpoint agent/dev

  ┌── the agent works in the main copy
  │   gauge (exit profile)
  │     red   → the agent is handed the stage and the failure text; attempt++
  │     red 3× on the same stage → escalation, no fourth attempt
  └── green → commit

  acceptance pass, on a different model — may demote, never approve

  accepted  → checkout agent/dev → merge → done/
              conflict → merge --abort → escalation
  otherwise → wip commit on the task branch → failed/

  always    → checkout agent/dev, clean tree
  always    → one line appended to the journal
```

### Outcomes

| Outcome | Meaning | Branch | Merged |
|---|---|---|---|
| `passed` | gauge green, acceptance raised nothing | deleted after merge | yes |
| `rejected` | **gauge green and the task still was not done** | kept | no |
| `escalated` | three identical failures on one stage | kept | no |
| `error` | the run itself broke — quota, crash, exception | kept | no |
| `skipped` | the gate refused: dirty tree, no `agent/dev` | none | no |

`rejected` is a separate outcome on purpose. It is the number this project
exists to produce: the machine checks were green and the work was still not
done. Folding it into `escalated` would hide exactly the measurement that
justifies running an acceptance pass at all.

Failed work never reaches `agent/dev`, so the next task in that repository
branches from a clean base and does not inherit someone else's mess.

---

## 6. The gauge

Stages are declared, not discovered:

```json
"gauge": {
  "exit":  [
    { "stage": "lint",      "command": "npm run lint" },
    { "stage": "typecheck", "command": "npm run typecheck" },
    { "stage": "test",      "command": "npm test" }
  ],
  "merge": [
    { "stage": "build",     "command": "npm run build" }
  ],
  "promote": [
    { "stage": "e2e",       "command": "npm run e2e" }
  ]
}
```

Guessing which link of a `&&` chain died by pattern-matching its output works
for exactly one package manager. Declaring the stages costs three lines and
gives an exact answer for make, cargo, pytest and everything else.

**Three profiles, because one gauge cannot answer three questions.** Each is
tied to what it is allowed to cost, and the unit it checks:

| Profile | Runs | Unit | Budget |
|---|---|---|---|
| `exit` | every attempt, on the agent's way out | one attempt | seconds — anything slower makes each iteration expensive |
| `merge` | once, before landing on `agent/dev` | one task | may be slow |
| `promote` | once, before landing on `agent/staging` | a batch of tasks | may be very slow (§7) |

`promote` is optional and does nothing on its own: without a declared
`agent/staging` there is nowhere to promote to.

**A repository that declares no gauge gets no lock.** It is not refused, and it
is not pretended at: the journal records `"lock": "absent"` and the summary
shows a dash rather than a pass rate. A green result invented for a project with
no checks is worse than no result.

A gauge of `lint + typecheck` with no tests checks that the code compiles, not
that it works. detent will run it and will say so in the summary; it will not
call it behaviour.

### The lock, and what "identical" means

Stages run in order and the first red one ends the gauge: it is the answer, and
a stage built on top of it would report the same failure in other words. The
agent is handed that stage's command and the end of its output — stdout and
stderr together, in the order they arrived — two pipes guarantee no more than
that — capped from the front because the failure is almost always reported
last.

`attempts` in `product.json` is how many **identical failures in a row** end a
task as `escalated`. Identical means the same stage, the same exit, and the same
output once what changes on every run regardless — colour codes, timestamps,
durations — is removed. A different failing assertion, or a different number of
failing tests, is not identical: the count starts again.

---

## 7. Promotion

Both other profiles check **one task**. The thing that actually breaks is the
combination: five tasks green on their own, and together a broken integration, a
failing build, a contract that no longer matches. `agent/staging` is where that
is checked.

It is optional — declare the branch and the profile, or neither.

### Promotion is a command, not a step of a run

`detent promote` is explicit, and never automatic after a task. A batch gauge
that runs after every task is merely a slow `merge` profile, which already
exists; the value is in checking what a batch does that its tasks did not.

The gate: clean tree · no active run · `agent/staging` exists · at least one
task landed on `agent/dev` since the last promotion.

| | |
|---|---|
| green | `agent/dev` merges into `agent/staging`, and the human gate becomes `agent/staging → dev` |
| red | **nothing is promoted and nothing is reverted** — the work stays on `agent/dev`, the failed stage goes to the journal |
| conflict | `merge --abort`, escalate — as everywhere |
| interrupted | `detent recover` returns the repository to `agent/dev` with a clean tree |

**Nothing is bisected.** A red batch means the combination broke; which task is
at fault detent does not know and does not guess. Bisecting a batch is a
different product, and a confident wrong answer here costs more than no answer
(§15).

### What promotion is for: measuring the blind spot

A promotion is its own line in the journal, so `detent summary` can report the
number this section exists to produce: **how often a batch came out red after
every task in it was green.** That is the per-task gauge's blind spot, measured
— the same kind of number as `rejected`, and the reason staging is a mechanism
here rather than one more branch.

A side effect worth having: the branch a human reviews has passed more checks
than any single task in it ever did.

---

## 8. Scheduling

Two rules, and no others:

1. **One active task per repository.** The exclusion key is the repository name.
   There are no zones: zones existed to let two tasks share a repository, which
   requires separate working copies, which detent does not use.
2. **A barrier runs alone, and nothing starts past it.** The pool drains, the
   barrier task runs by itself, and only then does anything else begin. A
   contract change is an ordering point, not merely an exclusive slot — a task
   queued behind one must not begin against the contract that change is about to
   replace.

The concurrency ceiling is therefore bounded by the number of repositories, and
configured below it.

---

## 9. The acceptance pass

One model implements, a different model reads the diff against the acceptance
criteria. Different by design, not for economy: a model tends to approve its own
reasoning, and its blind spots are exactly its own.

**It can demote, never approve.** Green is granted by machine checks. A model's
judgement may only raise a doubt and send the task to a person. Otherwise
"proven" quietly becomes "a second model agreed", and the whole thing is
theatre.

---

## 10. Commits

**Green and accepted** — a real commit, and the branch merges:

```
feat(wallet): driver wallet balance in the app

Task: 0042
Gauge: lint ✓ typecheck ✓ test ✓ (2 attempts)
Acceptance: claude-opus-5 — accepted

Co-Authored-By: ...
```

**Anything else** — a wip commit, and the branch stays where it is:

```
wip(wallet): attempt 3, gauge red on test

Task: 0042
Gauge: lint ✓ typecheck ✓ test ✗ — 3 failing tests
Outcome: escalated — three identical failures on one stage

Co-Authored-By: ...
```

Parking the work as a commit rather than leaving a dirty tree matters: a dirty
tree would fail the gate and block that repository for every task behind it.
The wip commit is written with git's plumbing, onto the task branch, without
checking anything out and **without running the repository's hooks** — a
failing pre-commit hook is exactly the situation in which unfinished work most
needs saving. Never a stash, and never `agent/dev`.

**A promotion** — a merge commit on `agent/staging` that names what it carries:

```
promote: 5 tasks from agent/dev

Tasks: 0042, 0043, 0045, 0046, 0048
Gauge: e2e ✓ (promote profile, 14m22s)

Co-Authored-By: ...
```

A side effect worth having — **git becomes a second journal.** If
`runs/journal.jsonl` is ever lost, the history under `refs/heads/agent/` still
says which stage failed, how many attempts there were, what the acceptance pass
concluded, and which tasks went into which batch.

---

## 11. On disk

```
<product>/
  .detent/product.json       composition, branches, gauge, models
  .detent/state.json         per repository: active task, attempt, started at
  tasks/{todo,hold,done,failed}/NNNN-<slug>.md
  runs/journal.jsonl         append-only, one line per run
  map.json  map.mmd          the relationship map; committed, diffed by a person
  acme-api/ acme-web/ …      the product's repositories
```

The queue lives in the product folder rather than in a documentation
repository, even when one exists. A task moves between folders dozens of times
during a run; in a repository that is noise, and in a repository mounted as a
submodule it is a submodule pointer to move everywhere. Documentation receives
the *decision* a batch of tasks came from — one document, one commit. Churn and
record are different things and belong in different places.

### `product.json`

```json
{
  "version": 1,
  "product": { "name": "acme", "summary": "freight marketplace" },
  "branches": {
    "integration": "agent/dev",
    "staging":     "agent/staging",
    "task":        "agent/task-{id}-{slug}"
  },
  "concurrency": 3,
  "attempts": 3,
  "models": { "implement": "claude-sonnet-5", "accept": "claude-opus-5" },
  "repos": [
    {
      "name": "acme-api",
      "path": "acme-api",
      "role": "REST API backend, owns the database schema",
      "stack": ["node", "nestjs", "postgres"],
      "compare": "dev",
      "gauge": { "exit": [], "merge": [], "promote": [] },
      "models": { "implement": "claude-opus-5" },
      "neverCommit": ["shared-docs"]
    }
  ],
  "edges": [
    { "from": "acme-web", "to": "acme-docs", "kind": "submodule", "source": "scan" },
    { "from": "acme-web", "to": "acme-api", "kind": "api-contract", "source": "model" }
  ]
}
```

Four things about this shape are deliberate:

- **No field can name a human branch.** Every value in `branches` is validated
  against `^agent/` on load and by `doctor`. With two configurable branches the
  guarantee stops being "there is only one field to get wrong" and becomes a
  check, which is the stronger form of the same promise. `compare` is the single
  exception and is read-only: it names the branch `agent/dev` is reported
  against, and nothing else is ever done with it.
- **The schema is strict: an unknown key is an error.** It catches a typo
  instead of silently ignoring it, and it is what lets a field be specified here
  before it is implemented — until the code honours it, the loader refuses it by
  name and points at the version where it arrives. A field that exists and does
  nothing is worse than a field that does not exist.
- **A repository overrides a *role*, never "the model"** — otherwise you could
  not say "expensive implementation in the backend, one reviewer everywhere".
- **Every edge carries its `source`.** Edges established by the deterministic
  scan are drawn plain; edges a model proposed are labelled with their kind, so
  a guess never looks like a fact.

### A journal line

```json
{
  "kind": "task",
  "task": "0042",
  "slug": "wallet-endpoint",
  "repo": "acme-api",
  "started": "2026-10-07T09:12:03Z",
  "finished": "2026-10-07T09:18:43Z",
  "outcome": "passed",
  "attempts": 2,
  "lock": "enforced",
  "gauge": { "profile": "exit", "failedStage": null },
  "models": {
    "implement": { "requested": "claude-opus-5", "actual": "claude-opus-5" },
    "accept": { "requested": "claude-sonnet-5", "actual": "claude-sonnet-5" }
  },
  "cost": { "usd": 0.41 },
  "branch": "agent/task-0042-wallet-endpoint",
  "commit": "a1b2c3d",
  "merged": true
}
```

**`kind` is on every line, never defaulted.** A promotion is a run too, and a
`summary` that counted promotions as task runs would quietly corrupt the pass
rate — the same class of silent corruption the `requested`/`actual` pair below
exists to prevent.

The model that actually ran is recorded alongside the one requested, because a
silent substitution would quietly corrupt every comparison built on this file.

Cost is reported **per pass**, never per run: a cheap model that needs three
attempts is not cheap.

A promotion line is the same shape with `"kind": "promote"`, no `task`/`slug`,
and the batch it carried:

```json
{
  "kind": "promote",
  "repo": "acme-api",
  "started": "2026-10-07T18:40:11Z",
  "finished": "2026-10-07T18:54:33Z",
  "outcome": "passed",
  "tasks": ["0042", "0043", "0045"],
  "gauge": { "profile": "promote", "failedStage": null },
  "branch": "agent/staging",
  "commit": "f9e8d7c",
  "merged": true
}
```

---

## 12. Commands

```
detent doctor       whether this product is in the shape detent expects
detent init         scan the workspace and write product.json
detent plan         discuss a task with an agent; it writes the task files
detent run          work the queue
detent promote      merge agent/dev into agent/staging behind the batch gauge
detent summary      pass rate, iterations, cost per pass
detent dashboard    a page that watches this product
detent recover      return repositories an interrupted run left behind
detent prune        delete agent/task-* branches already merged into agent/dev
```

`init` runs in three passes, in this order and for a reason:

1. **A deterministic scan** — manifests, submodules, remotes, lockfiles,
   branches, scripts, test files. Cheap, exact, repeatable, no model involved.
   Facts should not be guessed at by something that can be wrong.
2. **A model pass** over that skeleton plus the READMEs, answering only what the
   scan cannot: what each repository is *for*, which relations are real, and
   what the gauge stages should be. Forced to a schema, retried on mismatch.
3. **Validation against the scan.** A repository the model invents is dropped
   rather than written, because a gap is visible and an invention is not.

`init --no-agent` stops after pass 1 and leaves the model's fields empty for a
person to fill. The tool has to work for someone who has no agent installed,
or the first such person leaves.

Re-running `init` produces a **diff to review**, not a silent overwrite. The
machine proposes, a person accepts.

### Three things `doctor` checks beyond the nine conditions

- **no branch named exactly `agent`** — it makes the whole namespace
  uncreatable, and the error arrives mid-run looking like something else (§2)
- **every value in `branches` matches `^agent/`** — the guarantee that no
  configuration can aim detent at a human branch
- **`gauge.promote` declared with no `branches.staging`** — a declared check
  that nothing ever runs is the same invented green as a missing gauge (§6)

### The dashboard is read-only while a run is active

The queue cannot be edited during a run: detent has already read it and moves
tasks by its own results. Two writers shuffling the same files is a bug that
arrives later disguised as a mystery.

---

## 13. Rules that are not configurable

- **Never write a ref outside `refs/heads/agent/`.** One predicate, checked on
  every write path, rather than a prefix convention remembered in several
  places.
- **Never push.** detent merges into a local `agent/dev` and stops. Someone's CI
  deploys from the branch you did not expect.
- **Never commit a submodule pointer** (`neverCommit`). Moving a pointer without
  pushing the submodule leaves everyone else with a reference to nowhere.
- **Never resolve a merge conflict.** `merge --abort`, escalate, let a person
  look at it.
- **Never work in a dirty repository.** Skip it, say so, continue elsewhere.
  Stashing is how work gets lost.

---

## 14. Build order

By what the rest depends on, not by what is most interesting.

1. `product.json` + task reading + frontmatter validation
2. the gauge and the lock — *useful on their own, before any run exists*
3. the gate, `state.json`, unconditional return, `recover` — **tests live here**
4. one task from file to commit on a task branch, sequentially
5. merge into `agent/dev`, with abort on conflict
6. journal + `summary` — *numbers start existing*
7. `doctor` and `init` pass 1 — *the deterministic scan is the same code in
   both: one checks the nine conditions with it, the other writes
   `product.json` from it*
8. `dashboard` — reading what already exists
9. the scheduler: repository occupancy and barriers
10. `promote`: `agent/staging`, the batch profile, the promotion journal line —
    and `doctor` gains its staging checks here
11. the acceptance pass
12. `init` pass 2 — the model pass and its schema
13. `plan`

End to end after 6. Worth showing after 8.

Until step 10, `branches.staging` and `gauge.promote` are **refused by the
loader by name**, with the version they arrive in. They are specified (§7)
before they are accepted, and accepted before they are advertised — see
`PROGRESS.md` for where the build actually is.

---

## 15. Deliberately not here

Named so they read as decisions rather than gaps.

- **Worktrees.** One task per repository instead. Worktrees would allow two, at
  the cost of installing dependencies per worktree — hundreds of megabytes per
  task on a typical Node repository — and of a second working copy's worth of
  environment. The price buys parallelism inside a repository that a product of
  eight repositories does not need.
- **Zones.** They only make sense with worktrees.
- **Bisecting a red batch.** When a promotion fails, the combination is at
  fault and the individual tasks were all green. Finding the culprit means
  replaying subsets of a batch, which is a build system, not a dispatcher. The
  journal says which batch went red and which tasks were in it; a person reads
  it (§7).
- **Multiple people on one workspace.** Two dispatchers merging into one
  `agent/dev` need a lock and per-person integration branches. Later, honestly,
  rather than half-done now.
- **Windows.** WSL or neither.
- **Anything that is not git.**
- **Task import from an issue tracker.** The task file is the prompt; a Jira
  description is not one yet.
