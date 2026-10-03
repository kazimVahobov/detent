# 0002. No worktrees: one active task per repository

- **Date:** 2026-10-03
- **Status:** accepted

## Context

Running two tasks against one repository at the same time requires two working
copies. git offers exactly that — `git worktree` — and it is the answer most
dispatchers reach for, because it makes concurrency inside a repository look
free.

It is not free, and the price was measured rather than estimated. In the
reference product (eight repositories, Node, npm), `node_modules` runs **213 to
416 MB per repository**, and a freshly created worktree is empty: it gets
neither `node_modules` nor the untracked environment files a stack needs to run
its own gauge. Every task would pay a full install before its first check.

## Decision

**One active task per repository.** The exclusion key is the repository name.
The agent works in the main copy, on `agent/task-<id>-<slug>`.

No worktrees. No zones.

## Consequences

- **Concurrency is bounded by the number of repositories,** and configured below
  that. For a product of eight repositories this is enough parallelism to
  saturate anything a single person is paying for.
- **A dirty tree blocks that repository's queue.** This is why failed work is
  parked as a wip commit rather than left in the working tree: a dirty tree
  fails the gate for every task behind it.
- **Zones become unnecessary.** They existed to let two tasks share a repository
  safely, which requires separate working copies.
- **Environment setup happens once per repository, by the person who owns it,**
  the same way it happens for their own work.

## Alternatives rejected

**Worktrees plus zones.** Buys parallelism inside one repository, at the cost of
a full dependency install per task and a second copy of every untracked file the
stack needs. A product of eight repositories does not need that parallelism; it
has eight natural lanes already.

**A pool of pre-warmed worktrees.** Removes the install from the critical path
and replaces it with cache invalidation and per-ecosystem install logic — npm,
pnpm, cargo, uv, each with its own notion of a warm copy. That is a build
system, and detent is not one.
