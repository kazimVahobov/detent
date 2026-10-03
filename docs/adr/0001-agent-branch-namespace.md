# 0001. The agent branch namespace, and two human gates

- **Date:** 2026-10-03
- **Status:** accepted

## Context

An agent that writes code has to put the result somewhere, and the obvious
somewhere is the branch the person is working on. That is also the one place
where a tool can destroy work it did not create: uncommitted changes, a
half-finished rebase, a branch whose history someone is about to push.

A warning in the documentation does not prevent this. The question is what makes
it impossible, and what makes that impossibility checkable by a test rather than
by a careful reader.

## Decision

detent reads and writes refs under **`refs/heads/agent/`** and nothing else.

```
agent/dev                        integration
agent/task-<id>-<slug>           one task
agent/staging                    optional second stop (see 0008)
```

Three things follow and are part of the decision, not details of it:

1. **Both gates are human operations, in both directions.** `dev → agent/dev`
   carries the person's work to the agents; `agent/staging → dev` (or
   `agent/dev → dev`) accepts theirs. detent does not offer to run either,
   because the point of a boundary is that crossing it is a decision.
2. **detent never creates its own integration branch.** Creating a branch means
   naming a start point, and the start point is a human branch. `detent doctor`
   prints the command and stops.
3. **The configuration format cannot aim detent at a human branch.** Every value
   in `branches` is validated against `^agent/` on load and by `doctor`. The one
   exception, `compare`, is read-only: it names the branch `agent/dev` is
   *reported* against, and nothing else is ever done with it.

## Consequences

- **One predicate, not a convention.** Every write path asks the same question —
  does this ref start with `agent/` — instead of comparing against a list of
  names that has to be kept in sync.
- **One glob audits everything detent owns:**
  `git for-each-ref refs/heads/agent/`.
- **The invariant becomes one assertion.** The first test snapshots *every* ref
  before a run and after it and asserts the difference falls entirely inside the
  namespace. It fails on a branch nobody thought to enumerate, which a list of
  expected names cannot do.
- **A repository rests on `agent/dev`, not where you left it.** Putting you back
  would mean naming your branch. You switch back yourself.
- **A branch named exactly `agent` cannot coexist with the namespace** — in
  either direction. Verified rather than assumed:

  ```
  $ git branch agent && git branch agent/dev
  fatal: cannot lock ref 'refs/heads/agent/dev': 'refs/heads/agent' exists
  $ git branch agent/dev && git branch agent
  fatal: cannot lock ref 'refs/heads/agent': 'refs/heads/agent/dev' exists
  ```

  Refs are stored as paths, and a path cannot be both a file and a directory.
  `doctor` checks for it, because encountered mid-run the error reads as a
  mystery rather than a naming clash. The inverse costs nothing: once the
  namespace exists, git itself refuses to create `agent`.

## Alternatives rejected

**A prefix convention (`agent-dev`, `agent-task/*`).** This was the original
form. It needs two glob patterns, spreads the check across string comparisons at
each call site, and cannot enumerate what the tool owns. The slash costs one
`doctor` check and replaces all of that with a namespace.

**Configurable branch names, including the human one.** Flexible, and it makes
the boundary a warning: any configuration that can name `dev` is a configuration
that eventually does. Refusing to express it is stronger than refusing to use
it.

**Letting detent check out and restore the human branch for convenience.**
Convenience is the mechanism by which the work gets lost. The tool leaves the
repository on `agent/dev` and says so.

**Avoiding branch switching entirely with worktrees.** See 0002.
