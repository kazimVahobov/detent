# 0010. Three agent CLIs behind one call, and a role names its agent

- **Date:** 2026-10-06
- **Status:** accepted

## Context

Condition 6 of the product ("an agent CLI installed and authenticated") and the
`models` field in `product.json` assumed one agent and named only a model —
`"implement": "claude-sonnet-5"`. A model name does not say which program to
run, and the products detent is for use more than one: Claude Code, Codex and
Gemini CLI. The point of the journal is to compare them on the same repository,
which needs all three behind the same lock.

## Decision

- **Three adapters, one call.** `invoke(role, { cwd, prompt })` runs Claude
  Code, Codex or Gemini CLI and resolves with the same shape: what the agent
  said, `model: { requested, actual }`, `cost: { usd, tokens }`, its session,
  and an error if there was one. Nothing above `core/agents.mjs` knows which
  agent ran.
- **A role names its agent.** `models.implement` and `models.accept` are
  `{ "agent": "claude" | "codex" | "gemini", "model"?: string }`. A repository
  overrides a role whole, agent and model together.
- **Unattended and non-interactive, the way each CLI offers it.**
  `claude -p --output-format json --permission-mode bypassPermissions`;
  `codex exec --json --sandbox workspace-write`; `gemini --output-format json
  --approval-mode yolo`. The prompt always goes on stdin — no argument-length
  limit, and nothing of the task in the process list.
- **Each attempt is a fresh invocation,** not a resumed session. The working
  tree carries the state between attempts; the gauge's failure text is
  self-contained. Resuming is spelled differently by each CLI and would make the
  retry path the one part of the loop that differs per agent.
- **What a CLI does not report is null.** Claude Code reports its cost in
  dollars; Codex and Gemini report tokens only, and Codex does not name the
  model that ran. The journal says so rather than estimating — an invented price
  or model would corrupt every comparison built on it.

## Consequences

- Choosing an agent per role and per repository is configuration, and the
  journal can compare agents on equal terms — the lock, the gauge and the
  budget are the same for all three.
- Cost per pass in dollars exists only for Claude Code today. For the others
  `summary` will show tokens and a dash, until their CLIs report a price.
- The agents run with full permission inside the repository (Codex inside its
  workspace sandbox). The boundary detent enforces is git and the gauge, not the
  agent's own sandbox: the agent may do anything to the working tree, and
  nothing it does reaches a human branch.
- Each adapter is tested against output taken from its CLI. A CLI that changes
  its format breaks one adapter and its test, not the run loop.

## Alternatives rejected

**Infer the agent from the model name** (`claude-*`, `gpt-*`, `gemini-*`).
Short, and wrong for aliases, for local models, and for the day two CLIs serve
the same model. A guess that looks like configuration.

**One generic adapter configured by a command template.** Flexible, and it
moves the reading of each CLI's output into the user's configuration, where the
next format change breaks it silently instead of breaking a test here.

**Resume the agent's session on retry.** Cheaper in tokens, and three different
mechanisms for the one step that must behave identically for every agent.
