# 0004. The acceptance pass may demote, never approve

- **Date:** 2026-10-03
- **Status:** accepted

## Context

A green gauge says the project's checks pass. It does not say the task was done:
an agent can satisfy lint, types and tests while solving a different problem,
or while quietly weakening a test. Something has to read the diff against the
acceptance criteria.

The obvious design is a reviewer model that returns approve or reject. The
obvious design is also where the whole claim of the product leaks away.

## Decision

A second pass, on a **different model** from the one that implemented, reads the
diff against the task's acceptance criteria. It **may demote, never approve.**

Green is granted by machine checks. The reviewer's judgement can only raise a
doubt and send the task to a person, as outcome `rejected`.

## Consequences

- **`rejected` is a first-class outcome,** separate from `escalated`: the gauge
  was green and the work was still not done. This is the number the project
  exists to produce — folding it into `escalated` would hide exactly the
  measurement that justifies running a second pass at all.
- Nothing lands on `agent/dev` on a model's word alone. "Proven" keeps meaning
  "the machine checked it", not "a second model agreed".
- A rejected task keeps its branch and its wip commit, so a person reads the
  work rather than reconstructing it.
- The implementing model and the reviewing model are configured separately, per
  product and per repository, because the cheap-reviewer/expensive-implementer
  split is the common case.

## Alternatives rejected

**Let the reviewer approve.** One line of code, and the definition of done
silently becomes a second model's opinion. Every number built on top of the
journal would then measure agreement between models instead of behaviour of
code.

**Review with the same model that implemented.** Cheaper and warmer: a model
tends to approve its own reasoning, and its blind spots are exactly its own.

**No acceptance pass at all.** Then nothing measures what a green gauge misses,
and the product's central claim has no evidence either way. The same argument
appears one level up in 0008, where nothing measured what a green *task* misses
about a batch.
