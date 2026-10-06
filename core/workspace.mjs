// The gate, the unconditional return, and recover (DESIGN.md §2, §5).
//
// > Every exit from a task — success, red gauge, rejection, exception, Ctrl-C —
// > leaves the repository on agent/dev with a clean tree, and every ref that
// > moved lives under refs/heads/agent/.
//
// This is the only place detent can destroy work that is not its own.

import process from 'node:process'
import {
  abortOperation,
  branchExists,
  checkoutBranch,
  createBranch,
  createRef,
  currentBranch,
  forceCheckout,
  isClean,
  isRepository,
  operationInProgress,
  snapshotOnto,
} from './git.mjs'
import { claim, isAlive, readState, release, setAttempt } from './state.mjs'
import { taskBranch } from './task.mjs'

// Why a repository cannot take a task right now, or null. Any refusal skips
// the repository for this run; it never repairs anything, because the dirty
// tree or the half-finished rebase belongs to a person.
export function gate(product, repo) {
  const { dir } = repo
  if (!isRepository(dir)) return `${repo.path} is not a git repository`
  const operation = operationInProgress(dir)
  if (operation) return `a ${operation} is in progress`
  if (!isClean(dir)) return 'the working tree is not clean'
  const integration = product.branches.integration
  if (!branchExists(dir, integration)) {
    // Creating it means naming a start point, and the start point is a human
    // branch — so that is the person's command to run, not detent's.
    return `${integration} does not exist — create it from your branch: git branch ${integration} ${repo.compare}`
  }
  const active = readState(product.dir).repos[repo.name]
  if (active) return `task ${active.task} is already active here`
  return null
}

// Put a repository back: abort what git is in the middle of, park whatever is
// in the working tree as a wip commit on the task branch, and stand on the
// integration branch with a clean tree. Never a stash, never agent/dev.
export function returnHome(dir, { integration, branch, task, reason, message, exclude = [] }) {
  const operation = operationInProgress(dir)
  if (operation) abortOperation(dir, operation)

  let parked = null
  if (!isClean(dir)) {
    if (!branchExists(dir, branch)) createRef(dir, branch, integration)
    parked = snapshotOnto(dir, branch, message ?? `wip: task ${task} returned unfinished — ${reason}\n\nTask: ${task}\n`, { exclude })
  }

  if (currentBranch(dir) !== integration || !isClean(dir)) forceCheckout(dir, integration)
  return { aborted: operation, parked }
}

// Interrupts arrive at the process, not at a task, so one handler returns
// every repository that is out and then lets the process die as it would have.
const out = new Set()
let listening = false

function onSignal(signal) {
  for (const undo of [...out]) {
    try {
      undo(`interrupted by ${signal}`)
    } catch (error) {
      process.stderr.write(`detent: could not return a repository (${error.message}) — run detent recover\n`)
    }
  }
  process.exit(signal === 'SIGINT' ? 130 : 143)
}

function track(undo) {
  out.add(undo)
  if (!listening) {
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    listening = true
  }
}

function untrack(undo) {
  out.delete(undo)
  if (out.size === 0 && listening) {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    listening = false
  }
}

// Run `work` on the task branch — fresh, or the existing one when a paused task
// is resumed (ADR 0009) — and return the repository whatever happens. An
// exception from the work is rethrown after the return, not instead of it.
export async function withTask(product, repo, task, work) {
  const branch = taskBranch(product, task)
  const integration = product.branches.integration

  const refusal = gate(product, repo)
  if (refusal) return { outcome: 'skipped', reason: refusal }
  const resumed = branchExists(repo.dir, branch)

  claim(product.dir, repo.name, { task: task.id, branch })
  let returned = null
  let message = null
  const undo = (reason) => {
    if (returned) return returned
    returned = returnHome(repo.dir, { integration, branch, task: task.id, reason, message, exclude: repo.neverCommit })
    release(product.dir, repo.name)
    return returned
  }
  track(undo)

  let reason = 'the work ended without committing it'
  try {
    if (resumed) checkoutBranch(repo.dir, branch)
    else createBranch(repo.dir, branch, integration)
    const result = await work({
      cwd: repo.dir,
      branch,
      resumed,
      setAttempt: (n) => setAttempt(product.dir, repo.name, n),
      // What the wip commit should say if the work is parked: the work knows
      // the attempt and the outcome, the return only knows that it happened.
      parkWith: (text) => {
        message = text
      },
    })
    return { outcome: 'returned', branch, resumed, result, ...undo(reason) }
  } catch (error) {
    reason = `the run failed: ${error.message.split('\n')[0]}`
    throw error
  } finally {
    undo(reason)
    untrack(undo)
  }
}

// Return every repository state.json says a dead run left out. A repository
// whose run is still alive is left alone — it is not ours to return.
export function recover(product) {
  const report = []
  for (const [name, entry] of Object.entries(readState(product.dir).repos)) {
    if (isAlive(entry.pid)) {
      report.push({ repo: name, task: entry.task, action: 'left', reason: `the run that holds it (pid ${entry.pid}) is still alive` })
      continue
    }
    const repo = product.repos.find((r) => r.name === name)
    if (!repo) {
      report.push({ repo: name, task: entry.task, action: 'left', reason: 'it is no longer in product.json' })
      continue
    }
    try {
      const result = returnHome(repo.dir, {
        integration: product.branches.integration,
        branch: entry.branch,
        task: entry.task,
        reason: 'recovered after an interrupted run',
      })
      release(product.dir, name)
      report.push({ repo: name, task: entry.task, action: 'returned', ...result })
    } catch (error) {
      report.push({ repo: name, task: entry.task, action: 'failed', reason: error.message })
    }
  }
  return report
}
