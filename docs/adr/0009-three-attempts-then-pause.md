# 0009. Three attempts, then the task is paused and a person is told

- **Date:** 2026-10-06
- **Status:** accepted — supersedes the escalation rule in 0003

## Context

0003 made "three identical failures on the same stage" the escalation rule, and
`attempts` the length of that run of identical failures. Specifying the lock
(build step 2) exposed what that rule leaves open: an agent that fails
*differently* every time is never stopped. Each new failure resets the count,
and the run is bounded by nothing but the bill. Identity of failures is a good
signal of being stuck; it is a poor budget.

The same review raised the other half: what happens to a task that did not
pass. The lifecycle sent it to `failed/` — a verdict, delivered by the tool,
about work a person has not looked at yet, and with nobody told.

## Decision

- **`attempts` is a budget, not a pattern.** A task gets `attempts` attempts
  (default 3). The red gauge on the last one ends the run as `escalated`,
  whether or not the failures were identical. Identity is still computed and
  recorded — "three identical failures on test" and "three failed attempts,
  last on test" are different news for the person reading them — but it no
  longer decides when to stop.
- **Anything that needs a person pauses the task.** `escalated`, `rejected`
  and `error` move the task file to `tasks/hold/`, keep the task branch with the
  work parked on it, and send a notification.
- **Resuming is moving the file back.** A task in `todo/` whose branch already
  exists continues on that branch, with a fresh budget, and with whatever the
  person added to the task file. Nothing is lost by pausing.
- **`failed/` belongs to the person.** detent never moves a task there; a
  person does, when they abandon it.
- **Notification is a command.** `notify` in `product.json` is run through the
  shell with the message on stdin and the details in the environment
  (`DETENT_TASK`, `DETENT_REPO`, `DETENT_OUTCOME`, `DETENT_BRANCH`,
  `DETENT_MESSAGE`). Without one, detent tries a desktop notification. A
  notifier that fails is reported and never fails the run.

## Consequences

- The cost of a task is bounded by construction: at most `attempts` agent
  invocations per resume.
- A run never ends with work in a state nobody was told about.
- The journal needs no new outcome: `escalated` keeps its name, with a reason
  that says whether the failures were identical.
- `hold/` stops meaning only "parked by a person" and also means "waiting for
  one" — the queue reads the same either way, which is the point.
- Resuming on an existing branch means the gate no longer refuses a task whose
  branch exists. A person who wants a fresh start deletes the branch.

## Alternatives rejected

**Keep identical-only escalation and add a separate hard ceiling.** Two numbers
to configure for one question — how much is this task allowed to cost before a
person looks — and the first number never fires before the second in practice.

**Send unfinished work to `failed/`.** It reads as a verdict, and it makes
resuming a move out of a folder named for giving up.

**Notify through a built-in channel (email, Slack, a webhook).** Each one is a
dependency or a credential, and every team already has a command that reaches
them. A command is the smallest interface that reaches all of them.
