// Promotion: agent/dev into agent/staging behind the batch gauge (DESIGN.md §7,
// ADR 0008, build step 10).
//
// Both other profiles check one task. What actually breaks is the combination,
// so a promotion checks the batch: the merge of everything that landed since
// the last one, staged on a detached HEAD, with the promote profile run on it.
//
//   green    → agent/staging moves to the merge; the human gate becomes
//              agent/staging → dev
//   red      → nothing is promoted and nothing is reverted; the work stays on
//              agent/dev, the failed stage goes to the journal
//   conflict → merge --abort, escalate — as everywhere
//
// Nothing is bisected: which task broke the batch detent does not know and
// does not guess.

import { formatGauge, runGauge } from './gauge.mjs'
import { abortMerge, beginMerge, branchExists, concludeMerge, git, tip } from './git.mjs'
import { appendJournal } from './journal.mjs'
import { notify as defaultNotify } from './notify.mjs'
import { withPromotion } from './workspace.mjs'

export async function promote(product, repo, { notify = defaultNotify, now = () => new Date() } = {}) {
  const integration = product.branches.integration
  const staging = product.branches.staging
  const record = {
    kind: 'promote',
    repo: repo.name,
    started: now().toISOString(),
    finished: null,
    outcome: null,
    reason: null,
    tasks: [],
    lock: repo.gauge.promote.length ? 'enforced' : 'absent',
    gauge: { profile: 'promote', failedStage: null, ms: null },
    branch: staging,
    commit: null,
    merged: false,
  }

  const finish = () => {
    record.finished = now().toISOString()
    if (['red', 'escalated', 'error'].includes(record.outcome)) {
      record.notified = notify(product, {
        task: 'promote',
        repo: repo.name,
        outcome: record.outcome,
        branch: staging,
        message: `promotion of ${repo.name} did not happen — ${record.outcome}: ${record.reason}. The batch (${record.tasks.join(', ')}) stays on ${integration}; nothing was reverted.`,
      })
    }
    appendJournal(product.dir, record)
    return record
  }

  // The gate's own conditions, read before anything is claimed.
  if (!branchExists(repo.dir, staging)) {
    record.outcome = 'skipped'
    record.reason = `${staging} does not exist — create it: git branch ${staging} ${integration}`
    return finish()
  }
  record.tasks = landedSince(repo.dir, staging, integration)
  if (record.tasks.length === 0) {
    record.outcome = 'skipped'
    record.reason = `no task has landed on ${integration} since the last promotion`
    return finish()
  }

  try {
    const held = await withPromotion(product, repo, async ({ cwd }) => {
      const start = tip(cwd, staging)
      const merging = beginMerge(cwd, staging, integration)
      if (merging.conflicts) {
        record.outcome = 'escalated'
        record.reason = `merging ${integration} into ${staging} conflicts in ${merging.conflicts.join(', ')}`
        record.conflicts = merging.conflicts
        return
      }
      const started = Date.now()
      const gauge = await runGauge(repo.gauge.promote, { cwd, profile: 'promote' })
      record.gauge.ms = Date.now() - started
      if (gauge.lock === 'enforced' && !gauge.green) {
        abortMerge(cwd)
        record.gauge.failedStage = gauge.failed.stage
        record.outcome = 'red'
        record.reason = `the promote gauge is red on ${gauge.failed.stage}, with every task in the batch green on its own`
        return
      }
      record.commit = concludeMerge(
        cwd,
        staging,
        start,
        [
          `promote: ${record.tasks.length} ${record.tasks.length === 1 ? 'task' : 'tasks'} from ${integration}`,
          '',
          `Tasks: ${record.tasks.join(', ')}`,
          `Gauge: ${formatGauge(gauge)} (promote profile, ${duration(record.gauge.ms)})`,
        ].join('\n'),
      )
      record.outcome = 'passed'
      record.merged = true
    })
    if (held.outcome === 'skipped') {
      record.outcome = 'skipped'
      record.reason = held.reason
    }
  } catch (error) {
    record.outcome = 'error'
    record.reason = `the promotion failed: ${error.message.split('\n')[0]}`
  }
  return finish()
}

// The tasks that landed on agent/dev and are not on agent/staging yet, by the
// Task trailers of their merge commits.
export function landedSince(cwd, staging, integration) {
  const out = git(cwd, ['log', '--merges', '--format=%(trailers:key=Task,valueonly,separator=%x2C)', `refs/heads/${staging}..refs/heads/${integration}`])
  const ids = out.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
  return [...new Set(ids)].sort((a, b) => Number(a) - Number(b))
}

function duration(ms) {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
