// One task, from its file to agent/dev (build steps 4 and 5).
//
//   the agent works → the gauge runs on its way out
//     green            → one commit on the task branch, then the merge into
//                        agent/dev, behind the merge profile
//     red              → the agent is handed the failure and goes back in
//     red, last attempt, agent error, nothing changed
//                      → the work is parked, the task paused, a person told
//
// The result has the shape of a journal line (DESIGN.md §11) so that writing
// the journal (step 6) is appending it.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { formatGauge, runGauge } from './gauge.mjs'
import { abortMerge, beginMerge, concludeMerge, deleteBranch, git, setRef, snapshotOnto, snapshotRefs, tip } from './git.mjs'
import { judge } from './lock.mjs'
import { notify as defaultNotify } from './notify.mjs'
import { commitSubject, implementPrompt } from './prompt.mjs'
import { moveTask, taskBranch } from './task.mjs'
import { withTask } from './workspace.mjs'
import { invoke as defaultInvoke } from './agents.mjs'
import { JOURNAL_FILE, appendJournal } from './journal.mjs'
import { PRODUCT_FILE } from './product.mjs'

export async function runTask(product, repo, task, { invoke = defaultInvoke, notify = defaultNotify, now = () => new Date() } = {}) {
  const role = repo.models.implement
  if (!role) throw new Error(`${repo.name} has no implementing agent — set models.implement in product.json`)

  const integration = product.branches.integration
  const limit = product.attempts
  const record = {
    kind: 'task',
    task: task.id,
    slug: task.slug,
    repo: repo.name,
    started: now().toISOString(),
    finished: null,
    outcome: null,
    reason: null,
    resumed: false,
    attempts: 0,
    lock: repo.gauge.exit.length > 0 ? 'enforced' : 'absent',
    gauge: { profile: 'exit', failedStage: null },
    models: { implement: { agent: role.agent, requested: role.model ?? null, actual: null } },
    cost: { usd: null, tokens: null },
    branch: taskBranch(product, task),
    commit: null,
    merged: false,
  }

  let ran
  try {
    ran = await withTask(product, repo, task, async ({ cwd, branch, resumed, setAttempt, parkWith }) => {
      record.resumed = resumed
      const start = tip(cwd, integration)
      const watched = humanRefs(cwd)
      const judges = fingerprints([join(product.dir, PRODUCT_FILE), task.file, join(product.dir, JOURNAL_FILE)])
      const history = []
      let feedback = null

      const pause = (outcome, reason, gauge) => {
        record.outcome = outcome
        record.reason = reason
        parkWith(
          [
            `wip(${task.slug}): attempt ${record.attempts}, ${gauge && !gauge.green ? `gauge red on ${gauge.failed.stage}` : outcome}`,
            '',
            `Task: ${task.id}`,
            ...(gauge ? [`Gauge: ${formatGauge(gauge)}`] : []),
            `Outcome: ${outcome} — ${reason}`,
            agentTrailer(record),
          ].join('\n'),
        )
      }

      // Build step 5. The merge is staged on a detached HEAD and checked there,
      // so agent/dev only ever moves to a merged tree whose merge gauge is
      // green; red or a conflict leaves it exactly where it was.
      const land = async (subject, exitGauge) => {
        const merging = beginMerge(cwd, integration, branch)
        if (merging.conflicts) {
          record.conflicts = merging.conflicts
          return pause('escalated', `merging into ${integration} conflicts in ${merging.conflicts.join(', ')}`)
        }
        const gauge = await runGauge(repo.gauge.merge, { cwd, profile: 'merge' })
        if (gauge.lock === 'enforced' && !gauge.green) {
          abortMerge(cwd)
          record.gauge = { profile: 'merge', failedStage: gauge.failed.stage }
          return pause('escalated', `the merge gauge is red on ${gauge.failed.stage}`, gauge)
        }
        record.commit = concludeMerge(
          cwd,
          integration,
          start,
          [
            `merge: task ${task.id} — ${subject}`,
            '',
            `Task: ${task.id}`,
            `Gauge: ${formatGauge(exitGauge)} (exit) · ${formatGauge(gauge)} (merge)`,
            agentTrailer(record),
          ].join('\n'),
        )
        deleteBranch(cwd, branch)
        record.outcome = 'passed'
        record.merged = true
      }

      for (let attempt = 1; attempt <= limit; attempt += 1) {
        setAttempt(attempt)
        record.attempts = attempt

        const answer = await invoke(role, { cwd, prompt: implementPrompt({ task, repo, branch, attempt, limit, resumed, feedback }) })
        account(record, answer)

        // The agent has a shell, so the boundary is checked after it, not
        // assumed. agent/dev is detent's to put back; a human ref is not, and
        // is only named.
        const breach = checkBoundary(cwd, { integration, start, branch, watched, judges, productDir: product.dir })
        if (breach) return pause('error', breach)
        if (!answer.ok) return pause('error', `the agent failed: ${answer.error}`)

        const gauge = await runGauge(repo.gauge.exit, { cwd, profile: 'exit' })
        history.push(gauge)
        const verdict = judge(history, { limit })

        if (verdict.verdict === 'leave' || verdict.verdict === 'unlocked') {
          record.gauge.failedStage = null
          const subject = commitSubject(answer.message, task)
          const message = [
            subject,
            '',
            `Task: ${task.id}`,
            `Gauge: ${formatGauge(gauge)} (${attempt} ${attempt === 1 ? 'attempt' : 'attempts'})`,
            agentTrailer(record),
          ].join('\n')
          const before = tip(cwd, branch)
          // Always a commit of detent's own, even when the agent committed
          // everything itself: the trailers are git's copy of the journal.
          snapshotOnto(cwd, branch, message, { exclude: repo.neverCommit, allowEmpty: true })
          if (git(cwd, ['rev-parse', `refs/heads/${branch}^{tree}`]) === git(cwd, ['rev-parse', `${start}^{tree}`])) {
            setRef(cwd, branch, before, 'drop an empty commit')
            return pause('error', 'the gauge is green but the agent changed nothing')
          }
          record.commit = tip(cwd, branch)
          return land(subject, gauge)
        }

        record.gauge.failedStage = verdict.stage
        if (verdict.verdict === 'escalate') return pause('escalated', verdict.reason, gauge)
        feedback = verdict.feedback
      }
    })
  } catch (error) {
    // The repository is already back; what is left is to say what happened.
    record.outcome = 'error'
    record.reason = `the run failed: ${error.message.split('\n')[0]}`
  }

  if (ran?.outcome === 'skipped') {
    record.outcome = 'skipped'
    record.reason = ran.reason
    record.branch = null
  }
  record.finished = now().toISOString()
  return settle(product, task, record, notify)
}

// Where the task file goes, who hears about it, and the one journal line every
// run leaves — skipped runs included, so the journal is the whole history.
function settle(product, task, record, notify) {
  if (record.outcome === 'passed') {
    moveTask(product.dir, task, 'done')
  } else if (record.outcome === 'escalated' || record.outcome === 'error') {
    moveTask(product.dir, task, 'hold')
    const file = `tasks/hold/${task.id}-${task.slug}.md`
    // A conflict is the one pause a resume cannot get past by itself: detent
    // never resolves one, and the agent is not let into a merge. So the person
    // is told the step that is theirs.
    const next = record.conflicts
      ? `Resolve it on the task branch — git switch ${record.branch} && git merge ${product.branches.integration} — then move ${file} back to todo/.`
      : `The work is on ${record.branch}; move ${file} back to todo/ to resume.`
    const message = `task ${record.task} (${record.repo}) is paused — ${record.outcome}: ${record.reason}. ${next}`
    record.notified = notify(product, { task: record.task, repo: record.repo, outcome: record.outcome, branch: record.branch, message })
  }
  appendJournal(product.dir, record)
  return record
}

function account(record, answer) {
  if (answer.model.actual) record.models.implement.actual = answer.model.actual
  const cost = record.cost
  const first = record.attempts === 1
  // Dollars only if every attempt reported them: a partial sum would read as
  // a total and be smaller than the truth.
  cost.usd = answer.cost.usd === null || (!first && cost.usd === null) ? null : round((cost.usd ?? 0) + answer.cost.usd)
  if (answer.cost.tokens) {
    cost.tokens = {
      input: (cost.tokens?.input ?? 0) + answer.cost.tokens.input,
      output: (cost.tokens?.output ?? 0) + answer.cost.tokens.output,
    }
  }
}

function agentTrailer(record) {
  const { agent, requested, actual } = record.models.implement
  const model = actual ?? requested
  return `Agent: ${agent}${model ? ` (${model})` : ''}`
}

// Branches and tags outside the namespace: what an agent with a shell could
// move and detent must never write.
function humanRefs(cwd) {
  const refs = new Map()
  for (const [ref, object] of snapshotRefs(cwd)) {
    if (ref.startsWith('refs/heads/agent/')) continue
    if (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) refs.set(ref, object)
  }
  return refs
}

function checkBoundary(cwd, { integration, start, branch, watched, judges, productDir }) {
  const problems = []

  // The files that judge the agent live outside its repository, within reach
  // of a shell. They are the person's, so a change is named, not undone — and
  // this run goes on using the product it loaded before the agent started.
  const edited = [...judges].filter(([file, hash]) => digest(file) !== hash).map(([file]) => relative(productDir, file))
  if (edited.length > 0) {
    problems.push(`the agent changed ${edited.join(', ')} — the files that judge it are not its to edit; look at them before resuming`)
    for (const file of judges.keys()) judges.set(file, digest(file))
  }

  const now = humanRefs(cwd)
  const moved = [...new Set([...watched.keys(), ...now.keys()])].filter((ref) => watched.get(ref) !== now.get(ref))
  if (moved.length > 0) {
    problems.push(`the agent moved ${moved.join(', ')} — detent does not write outside agent/, so this is left for you`)
    for (const ref of moved) watched.set(ref, now.get(ref))
  }

  const current = tip(cwd, integration)
  if (current !== start) {
    // Failed work never reaches agent/dev: put it back, and keep what the
    // agent put there on a branch of its own.
    const stray = `${branch}-stray`
    setRef(cwd, stray, current, `keep commits the agent made on ${integration}`)
    setRef(cwd, integration, start, `restore ${integration} after the agent moved it`)
    problems.push(`the agent committed to ${integration}; it is restored, and those commits are kept on ${stray}`)
  }

  return problems.length > 0 ? problems.join('; ') : null
}

function fingerprints(files) {
  return new Map(files.map((file) => [file, digest(file)]))
}

function digest(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function round(usd) {
  return Math.round(usd * 1e6) / 1e6
}
