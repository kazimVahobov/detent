# 0005. The queue lives in the product folder, not in the documentation repository

- **Date:** 2026-10-03
- **Status:** accepted

## Context

The method detent serves gives every product a documentation repository, mounted
as a git submodule inside each product repository so that agents working
anywhere can read it. That makes the documentation repository the natural-looking
home for the task queue: it is shared, it is versioned, and it is already
mounted everywhere.

## Decision

The queue and everything that churns live in the **product folder**, beside the
repositories rather than inside any of them:

```
<product>/
  .detent/product.json      .detent/state.json
  tasks/{todo,hold,done,failed}/NNNN-<slug>.md
  runs/journal.jsonl
  acme-api/ acme-web/ …
```

The documentation repository receives the **decision** a batch of tasks came
from — one document, one commit.

## Consequences

- A task file moves between folders dozens of times during a run and produces no
  commits at all.
- Nothing has to move a submodule pointer in every repository every time a task
  changes folder — which would also have violated the rule against committing
  submodule pointers.
- The queue is not versioned, and does not need to be: the journal is
  append-only, and git on `agent/dev` holds a second copy of every outcome.
- A product folder is not a repository, so nothing tempts a person to clone "the
  queue" on its own.

## Alternatives rejected

**The queue in the documentation repository.** Churn and record are different
things. A document that says "here is why we are building wallets this week"
belongs in a repository; a file that moves from `todo/` to `done/` forty times a
day does not, and mounted as a submodule it turns one move into a pointer
commit in every repository that mounts it.

**A queue inside each product repository.** Then cross-repository scheduling —
one active task per repository, barriers that stop everything — has no place to
live, and the state of the product is assembled by reading eight repositories.
