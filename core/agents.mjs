// The agents detent can run, behind one call (ADR 0010).
//
// Each adapter knows three things about its CLI: how to run it unattended and
// non-interactively, how to hand it a prompt, and how to read what it printed.
// Everything above this file sees the same result whichever agent ran.
//
// What a CLI does not report is null, never estimated: an invented model name
// or cost would quietly corrupt every comparison built on the journal.

import { spawn } from 'node:child_process'
import process from 'node:process'

export const AGENTS = {
  // Claude Code: one JSON object on stdout.
  claude: {
    command: 'claude',
    // Plan mode is Claude Code's read-only mode: it reads and refuses to write.
    args: ({ model, readOnly }) => ['-p', '--output-format', 'json', '--permission-mode', readOnly ? 'plan' : 'bypassPermissions', ...(model ? ['--model', model] : [])],
    parse(stdout) {
      const out = lastJson(stdout)
      if (!out) return null
      const usage = out.usage ?? {}
      const models = Object.entries(out.modelUsage ?? {}).map(([name, u]) => [name, u.outputTokens ?? 0])
      return {
        ok: out.is_error === false && out.subtype === 'success',
        message: typeof out.result === 'string' ? out.result : '',
        actual: busiest(models),
        usd: typeof out.total_cost_usd === 'number' ? out.total_cost_usd : null,
        tokens: tokens(
          sum(usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens),
          usage.output_tokens,
        ),
        session: out.session_id ?? null,
        error: out.is_error ? `${out.subtype ?? 'error'}${out.api_error_status ? ` (${out.api_error_status})` : ''}: ${out.result ?? ''}`.trim() : null,
      }
    },
  },

  // Codex: `codex exec --json` prints one JSON event per line. The prompt is
  // read from stdin when it is given as "-".
  codex: {
    command: 'codex',
    args: ({ model, readOnly }) => ['exec', '--json', '--sandbox', readOnly ? 'read-only' : 'workspace-write', '--color', 'never', ...(model ? ['--model', model] : []), '-'],
    parse(stdout) {
      const events = stdout.split('\n').flatMap((line) => {
        try {
          const event = JSON.parse(line)
          return event && typeof event === 'object' ? [event] : []
        } catch {
          return []
        }
      })
      if (events.length === 0) return null
      let message = ''
      let input = 0
      let output = 0
      let counted = false
      let session = null
      let error = null
      for (const event of events) {
        if (event.type === 'thread.started') session = event.thread_id ?? null
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text ?? ''
        if (event.type === 'turn.completed' && event.usage) {
          counted = true
          input += sum(event.usage.input_tokens, event.usage.cached_input_tokens)
          output += event.usage.output_tokens ?? 0
        }
        if (event.type === 'turn.failed') error = event.error?.message ?? 'turn failed'
        if (event.type === 'error') error = event.message ?? 'error'
      }
      return {
        ok: error === null,
        message,
        // codex exec does not name the model that ran in its events.
        actual: null,
        usd: null,
        tokens: counted ? tokens(input, output) : null,
        session,
        error,
      }
    },
  },

  // Gemini CLI: one JSON object. --prompt is required for headless mode and is
  // appended to stdin, so it carries only a pointer to the real prompt.
  gemini: {
    command: 'gemini',
    args: ({ model, readOnly }) => [
      '--output-format', 'json',
      '--approval-mode', readOnly ? 'plan' : 'yolo',
      '--skip-trust',
      ...(model ? ['--model', model] : []),
      '--prompt', 'The task is above. Work on it in this repository.',
    ],
    parse(stdout) {
      const out = lastJson(stdout)
      if (!out) return null
      const models = Object.entries(out.stats?.models ?? {}).map(([name, m]) => [name, m?.tokens?.total ?? 0])
      let input = 0
      let output = 0
      for (const [, m] of Object.entries(out.stats?.models ?? {})) {
        input += m?.tokens?.prompt ?? 0
        output += m?.tokens?.candidates ?? 0
      }
      return {
        ok: !out.error,
        message: typeof out.response === 'string' ? out.response : '',
        actual: busiest(models),
        usd: null,
        tokens: models.length > 0 ? tokens(input, output) : null,
        session: out.session_id ?? null,
        error: out.error ? (out.error.message ?? JSON.stringify(out.error)) : null,
      }
    },
  },
}

// `readOnly` runs the agent in its CLI's read-only mode — for a reviewer, which
// has no business changing what it reviews. `timeoutMs` bounds the call: past
// it the agent gets SIGTERM, then SIGKILL after `graceMs` if it is still there.
export function invoke(role, { cwd, prompt, readOnly = false, timeoutMs = null, graceMs = 10_000, env = process.env }) {
  const adapter = AGENTS[role.agent]
  if (!adapter) throw new Error(`unknown agent "${role.agent}"`)
  const requested = role.model ?? null

  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    // Its own process group, so that stopping it stops what it started too: an
    // agent's shell commands outlive a SIGTERM to the agent alone, and keep its
    // output open. The price is that a terminal's Ctrl-C no longer reaches it,
    // so detent stops every live agent itself (stopAgents).
    const child = spawn(adapter.command, adapter.args({ model: role.model, readOnly }), {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    if (child.pid) live.add(child.pid)
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.stdin.on('error', () => {}) // an agent that exits without reading is reported below
    child.stdin.end(prompt)

    let settled = false
    let timedOut = false
    let killer = null
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            timedOut = true
            signalGroup(child, 'SIGTERM')
            killer = setTimeout(() => signalGroup(child, 'SIGKILL'), graceMs)
          }, timeoutMs)

    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killer)
      live.delete(child.pid)
      resolve({
        agent: role.agent,
        ok: r.ok ?? false,
        message: r.message ?? '',
        model: { requested, actual: r.actual ?? null },
        cost: { usd: r.usd ?? null, tokens: r.tokens ?? null },
        session: r.session ?? null,
        error: r.error ?? null,
        ms: Date.now() - started,
      })
    }

    child.on('error', (error) => {
      finish({ error: error.code === 'ENOENT' ? `${adapter.command} is not installed, or not on PATH` : error.message })
    })
    child.on('close', (code, signal) => {
      if (timedOut) {
        // What it cost up to the cut is kept if it was printed; the verdict is
        // that it did not finish, whatever it said before it was stopped.
        const partial = adapter.parse(stdout) ?? {}
        return finish({ ...partial, ok: false, error: `${adapter.command} ran past the ${minutes(timeoutMs)} limit and was stopped` })
      }
      const parsed = adapter.parse(stdout)
      const exit = signal ? `killed by ${signal}` : `exit code ${code}`
      if (!parsed) return finish({ error: `${adapter.command} printed nothing detent can read (${exit})${tail(stderr)}` })
      if (code !== 0 && parsed.ok) return finish({ ...parsed, ok: false, error: `${adapter.command} finished with ${exit}${tail(stderr)}` })
      finish(parsed)
    })
  })
}

function lastJson(text) {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    // Some CLIs print a line of their own before the result.
    const start = trimmed.lastIndexOf('\n{')
    if (start === -1) return null
    try {
      return JSON.parse(trimmed.slice(start + 1))
    } catch {
      return null
    }
  }
}

// The model that did most of the work, when a CLI used more than one — a
// subagent on a small model should not be reported as the model that ran.
function busiest(models) {
  if (models.length === 0) return null
  return models.reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0]
}

function sum(...values) {
  return values.reduce((total, value) => total + (typeof value === 'number' ? value : 0), 0)
}

function tokens(input, output) {
  return { input: input ?? 0, output: output ?? 0 }
}

// Every agent process group still running, for stopAgents.
const live = new Set()

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}

// Stop every agent still running — on Ctrl-C, on SIGTERM, and on any exit, so
// no agent keeps writing into a repository detent has already put back.
export function stopAgents(signal = 'SIGTERM') {
  for (const pid of live) {
    try {
      process.kill(-pid, signal)
    } catch {}
  }
}
process.on('exit', () => stopAgents('SIGKILL'))

function minutes(ms) {
  const m = ms / 60_000
  return Number.isInteger(m) ? `${m}-minute` : `${(ms / 1000).toFixed(1)}-second`
}

function tail(stderr) {
  const text = stderr.trim()
  return text ? `: ${text.split('\n').slice(-5).join('\n')}` : ''
}
