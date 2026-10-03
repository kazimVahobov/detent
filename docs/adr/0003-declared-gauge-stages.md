# 0003. The gauge is declared as stages, in profiles

- **Date:** 2026-10-03
- **Status:** accepted

## Context

The whole product rests on one claim: an agent is allowed to stop when the
project's own checks pass, not when it says it is done. That makes the checks a
first-class object, and raises two questions the naive form cannot answer.

The naive form is one command — `npm run lint && npm run typecheck && npm test`.
When it exits non-zero, *which* check failed? The only way to know is to
pattern-match the output, which works for exactly one package manager and breaks
on make, cargo, pytest and everything else. And an agent handed "it failed" with
4000 lines of output is being asked to guess.

The second question: the same set of checks cannot run on every attempt and also
include a fifteen-minute end-to-end suite.

## Decision

Stages are **declared**, each a name and a command:

```json
"gauge": {
  "exit":    [ { "stage": "lint", "command": "npm run lint" }, … ],
  "merge":   [ { "stage": "build", "command": "npm run build" } ],
  "promote": [ { "stage": "e2e", "command": "npm run e2e" } ]
}
```

Three profiles, each tied to what it checks and what it is allowed to cost:

| Profile | Runs | Unit | Budget |
|---|---|---|---|
| `exit` | every attempt, on the agent's way out | one attempt | seconds |
| `merge` | before landing on `agent/dev` | one task | may be slow |
| `promote` | before landing on `agent/staging` | a batch | may be very slow |

**A repository that declares no gauge gets no lock.** It is not refused: the
journal records `"lock": "absent"` and the summary shows a dash instead of a
pass rate.

## Consequences

- The failed stage is reported exactly, in any ecosystem, and the agent is
  handed that stage's output rather than the whole run's.
- Three identical failures on **the same stage** is a meaningful escalation
  rule; without stage identity it would be three failures on "the command".
- Declaring stages costs three lines of configuration per repository, paid once.
- A gauge of `lint + typecheck` with no tests checks that the code compiles, not
  that it works. detent runs it and says so in the summary rather than calling
  it behaviour — an invented green is worse than no result.

## Alternatives rejected

**One command, with the failed stage recovered from its output.** Cheapest to
configure, and it only works where the output format is known. The first
non-npm repository turns the feature into a guess.

**Discovering the gauge from `package.json` scripts.** Convenient, and it
produces a guess that looks like a fact: a `test` script may be a placeholder,
an `e2e` script may need a running database. Discovery is good enough to
*propose* stages during `init` — where a person reviews the diff — and not good
enough to run unattended.
