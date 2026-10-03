# 0006. Zero runtime dependencies, Node 22, and the published artifact is the source

- **Date:** 2026-10-03
- **Status:** accepted

## Context

detent is installed globally and then runs inside other people's repositories,
with permission to create branches and commits. Two properties follow from that
position rather than from taste: whatever it drags in is dragged into a
developer's machine, and whatever it claims about verification it should be
possible to verify about itself.

Node 22 also changed the arithmetic. A test runner, argument parsing, `fetch`
and a glob are built in; the dependencies a CLI used to need are now standard
library.

## Decision

- **Zero runtime dependencies** — `dependencies`, `peerDependencies`,
  `optionalDependencies` and `bundledDependencies` are all empty, and
  `scripts/check-no-deps.mjs` fails the gauge if that stops being true.
- **Node 22 or newer**, ESM only.
- **No build step.** The files published to npm are the files in git.

## Consequences

- CI needs no install step at all: `npm run verify` on a bare checkout.
- `npm i -g` pulls one package. There is no transitive surface to audit, and
  nothing in detent can break by someone else's release.
- What is published can be read and compared against the repository, which with
  provenance attestation on the release makes the chain from package to commit
  machine-checkable — the same standard the product applies to a definition of
  done.
- Conveniences get written by hand. That is the cost, and it is bounded by the
  fact that the tool orchestrates processes and git rather than parsing anything
  interesting.
- The claim is in the gauge, not in the README. A dependency added in a hurry
  turns the build red rather than aging into a lie.

## Alternatives rejected

**A few small, well-known dependencies** (argument parsing, colours, a glob).
Each is defensible alone; together they are a supply chain inside a tool that
has write access to repositories, and they make "zero dependencies" a thing the
README used to say.

**TypeScript with a build step.** Static types would be worth real money on a
codebase this shape. The cost is that the published artifact stops being the
source: a tool whose entire argument is "verify, do not trust" should be
readable in the form it ships. Types are recoverable later from JSDoc and
`checkJs` without changing what is published — a smaller decision, revisitable
without reversing this one.
