// runs/journal.jsonl — one line per run, appended and never rewritten
// (DESIGN.md §11). The numbers detent reports are computed from this file and
// nothing else, so nothing reported can disagree with it.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const JOURNAL_FILE = join('runs', 'journal.jsonl')

const KINDS = new Set(['task', 'promote'])

// Every line this process appended, so a watcher can tell detent's own writes —
// another task finishing beside this one — from somebody else's.
const ours = new Set()

export function appendJournal(productDir, record) {
  // kind is never defaulted: a promotion counted as a task run would quietly
  // corrupt the pass rate.
  if (!KINDS.has(record.kind)) throw new Error(`a journal line needs a kind, got ${JSON.stringify(record.kind)}`)
  const file = join(productDir, JOURNAL_FILE)
  mkdirSync(dirname(file), { recursive: true })
  // One write of one line, opened for append: lines from two runs interleave
  // whole or not at all.
  const line = JSON.stringify(record)
  ours.add(line)
  appendFileSync(file, `${line}\n`, { flag: 'a' })
}

// Watch the journal across an agent's turn. The journal is append-only and
// other tasks append to it while this one runs, so a change is allowed only if
// what was there is still there, untouched, and everything after it is lines
// detent itself appended.
export function watchJournal(productDir) {
  const file = join(productDir, JOURNAL_FILE)
  let seen = read(file)
  return {
    file,
    changed() {
      const now = read(file)
      if (!now.startsWith(seen)) return true
      const added = now.slice(seen.length).split('\n').filter(Boolean)
      if (added.some((line) => !ours.has(line))) return true
      seen = now
      return false
    },
    reset() {
      seen = read(file)
    },
  }
}

function read(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

// Every line that can be read, and how many could not.
export function readJournal(productDir) {
  let text
  try {
    text = readFileSync(join(productDir, JOURNAL_FILE), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { lines: [], unreadable: 0 }
    throw error
  }
  const lines = []
  let unreadable = 0
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    try {
      const line = JSON.parse(raw)
      if (line && typeof line === 'object' && KINDS.has(line.kind)) lines.push(line)
      else unreadable += 1
    } catch {
      unreadable += 1
    }
  }
  return { lines, unreadable }
}

// The most recent run of a task, or null.
export function lastRun(productDir, taskId) {
  const runs = readJournal(productDir).lines.filter((line) => line.kind === 'task' && Number(line.task) === Number(taskId) && line.outcome !== 'skipped')
  return runs.at(-1) ?? null
}

// The numbers, grouped by `key`. Skipped runs are not runs: the gate refused
// and no agent was involved, so counting them would dilute the pass rate with
// a dirty tree.
export function summarise(lines, key) {
  const groups = new Map()
  for (const line of lines) {
    if (line.kind !== 'task' || line.outcome === 'skipped') continue
    const name = key(line)
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(line)
  }

  return [...groups].map(([name, runs]) => {
    const passed = runs.filter((r) => r.outcome === 'passed')
    const outcomes = {}
    for (const r of runs) if (r.outcome !== 'passed') outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1

    // A pass rate over runs that had no lock would be a rate of nothing
    // checked. It exists only where every run was locked.
    const locked = runs.every((r) => r.lock === 'enforced')

    // Cost per pass, never per run: a cheap model that needs three attempts is
    // not cheap. Every run's cost counts, the failures' included.
    const allDollars = runs.every((r) => typeof r.cost?.usd === 'number')
    const allTokens = runs.every((r) => r.cost?.tokens)
    let costPerPass = null
    if (passed.length > 0 && allDollars) {
      costPerPass = { usd: runs.reduce((t, r) => t + r.cost.usd, 0) / passed.length }
    } else if (passed.length > 0 && allTokens) {
      costPerPass = { tokens: runs.reduce((t, r) => t + r.cost.tokens.input + r.cost.tokens.output, 0) / passed.length }
    }

    return {
      name,
      runs: runs.length,
      passed: passed.length,
      passRate: locked ? passed.length / runs.length : null,
      attemptsPerRun: runs.reduce((t, r) => t + (r.attempts ?? 0), 0) / runs.length,
      costPerPass,
      outcomes,
    }
  })
}

// The number the acceptance pass exists to produce (ADR 0004): of the runs the
// gauge let through and a reviewer read, how many were green and not done.
export function blindSpot(lines) {
  const read = lines.filter(
    (l) => l.kind === 'task' && (l.outcome === 'passed' || l.outcome === 'rejected') && l.acceptance && l.acceptance.verdict !== 'absent',
  )
  return { read: read.length, rejected: read.filter((l) => l.outcome === 'rejected').length }
}

export const byRepo = (line) => line.repo
export const byModel = (line) => {
  const m = line.models?.implement ?? {}
  return `${m.agent ?? '?'} ${m.actual ?? m.requested ?? '(default)'}`
}
