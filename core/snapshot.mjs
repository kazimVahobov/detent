// Everything the dashboard shows, read in one pass from what already exists:
// product.json, state.json, the queue, the journal and git. Nothing here
// writes; a dashboard that changed the product would be a second writer, and
// two writers shuffling the same files is a bug that arrives later (§12).

import { readFileSync } from 'node:fs'
import { branchExists, currentBranch, git, isClean } from './git.mjs'
import { blindSpot, byModel, byRepo, readJournal, summarise } from './journal.mjs'
import { isAlive, readState } from './state.mjs'
import { FOLDERS, readQueue } from './task.mjs'

export function snapshot(product, { now = new Date() } = {}) {
  const { lines, unreadable } = readJournal(product.dir)
  const tasks = lines.filter((l) => l.kind === 'task')
  const last = new Map()
  for (const line of tasks) if (line.outcome !== 'skipped') last.set(Number(line.task), line)

  const state = readState(product.dir)
  const active = Object.entries(state.repos).map(([repo, entry]) => ({ repo, ...entry, alive: isAlive(entry.pid) }))

  let queue
  let queueProblems = []
  try {
    queue = readQueue(product.dir, product)
  } catch (error) {
    queue = []
    queueProblems = error.problems ?? [error.message]
  }

  const folders = Object.fromEntries(FOLDERS.map((f) => [f, []]))
  for (const task of queue) {
    const previous = last.get(Number(task.id))
    folders[task.folder].push({
      id: task.id,
      slug: task.slug,
      repo: task.repo ?? previous?.repo ?? repoFromFile(task.file),
      // Why it stopped, for a paused task: the question a person opens hold/ with.
      outcome: previous?.outcome ?? null,
      reason: previous?.reason ?? null,
      doubts: previous?.acceptance?.doubts ?? [],
      branch: previous?.branch ?? null,
    })
  }

  const all = summarise(tasks, () => 'all')[0] ?? null

  return {
    product: { name: product.name, summary: product.summary, dir: product.dir },
    generated: now.toISOString(),
    running: active.some((a) => a.alive),
    active,
    repos: product.repos.map((repo) => standing(product, repo, active.find((a) => a.repo === repo.name))),
    queue: folders,
    queueProblems,
    numbers: {
      all,
      byRepo: summarise(tasks, byRepo),
      byModel: summarise(tasks, byModel),
      blindSpot: blindSpot(tasks),
      skipped: tasks.filter((l) => l.outcome === 'skipped').length,
      unreadable,
    },
    recent: tasks.slice(-15).reverse(),
  }
}

// Where a repository's agent/dev stands against its human branch — reported,
// never acted on (§2). Reading a ref is not touching a branch.
function standing(product, repo, active) {
  const integration = product.branches.integration
  const base = {
    name: repo.name,
    compare: repo.compare,
    lock: repo.gauge.exit.length ? 'enforced' : 'absent',
    gauge: repo.gauge.exit.map((s) => s.stage),
    implement: repo.models.implement ?? null,
    accept: repo.models.accept ?? null,
    active: active ? { task: active.task, attempt: active.attempt, started: active.started, alive: active.alive } : null,
  }
  let head
  try {
    head = { branch: currentBranch(repo.dir), clean: isClean(repo.dir) }
  } catch {
    return { ...base, missing: true }
  }
  if (!branchExists(repo.dir, integration)) return { ...base, ...head, integration: null }
  if (!branchExists(repo.dir, repo.compare)) return { ...base, ...head, integration, divergence: null }

  const [ahead, behind] = git(repo.dir, ['rev-list', '--left-right', '--count', `refs/heads/${integration}...refs/heads/${repo.compare}`])
    .split(/\s+/)
    .map(Number)
  // "3 tasks ahead" reads better than "17 commits ahead": count what landed.
  const tasksAhead = git(repo.dir, ['log', '--format=%(trailers:key=Task,valueonly)', '--merges', `refs/heads/${repo.compare}..refs/heads/${integration}`])
    .split('\n')
    .filter(Boolean).length
  return { ...base, ...head, integration, divergence: { ahead, behind, tasksAhead } }
}

function repoFromFile(file) {
  try {
    return /^repo:\s*(.+?)\s*$/m.exec(readFileSync(file, 'utf8'))?.[1] ?? null
  } catch {
    return null
  }
}
