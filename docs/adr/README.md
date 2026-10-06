# Decisions

`DESIGN.md` says what detent is **now**. These say **why not otherwise, and when
that changed**.

| # | Decision | Status |
|---|---|---|
| [0001](0001-agent-branch-namespace.md) | The agent branch namespace, and two human gates | accepted |
| [0002](0002-no-worktrees.md) | No worktrees: one active task per repository | accepted |
| [0003](0003-declared-gauge-stages.md) | The gauge is declared as stages, in profiles | accepted; escalation superseded by 0009 |
| [0004](0004-acceptance-demotes-only.md) | The acceptance pass may demote, never approve | accepted |
| [0005](0005-queue-in-the-product-folder.md) | The queue lives in the product folder | accepted |
| [0006](0006-zero-dependencies-node-22.md) | Zero dependencies, and the published artifact is the source | accepted |
| [0007](0007-scoped-package-name.md) | Published under a scope, because npm refuses the bare name | accepted |
| [0008](0008-optional-agent-staging.md) | Optional agent-side staging, for a gauge that checks a batch | accepted |
| [0009](0009-three-attempts-then-pause.md) | Three attempts, then the task is paused and a person is told | accepted |
| [0010](0010-three-agent-clis.md) | Three agent CLIs behind one call, and a role names its agent | accepted |

## The rules

**An ADR is never edited.** It is replaced by a later one, which says
`Status: superseded by NNNN`, and the old one says `superseded by NNNN` in
return. The record of a decision that was later reversed is more useful than a
document that has always been right.

**A commit that reverses or narrows an earlier choice carries an ADR.** A commit
that clarifies wording does not. The test is whether a reader six months from
now would ask "why is it not the obvious way?" — if yes, the answer belongs
here rather than in a commit message nobody greps for.

**Each one names what it displaced.** A decision recorded without its rejected
alternatives is a description, and descriptions are already in `DESIGN.md`.

## Shape

```markdown
# NNNN. Title in the imperative or as a statement

- **Date:** YYYY-MM-DD
- **Status:** accepted | superseded by NNNN

## Context      what forced a choice
## Decision     what was chosen, precisely enough to implement
## Consequences what follows, including what got worse
## Alternatives rejected
```
