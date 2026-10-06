// detent run — work the queue: every task in todo/, in id order, one at a time.

import process from 'node:process'
import { readQueue } from '../task.mjs'
import { runTask } from '../run.mjs'
import { UsageError } from './usage.mjs'

export const options = {}

export async function run(product, ids, _values, { runTask: runOne = runTask } = {}) {
  let tasks = readQueue(product.dir, product).filter((task) => task.folder === 'todo')
  if (ids.length > 0) {
    const wanted = new Set(ids.map(Number))
    const missing = ids.filter((id) => !tasks.some((task) => Number(task.id) === Number(id)))
    if (missing.length > 0) throw new UsageError(`not in tasks/todo/: ${missing.join(', ')}`)
    tasks = tasks.filter((task) => wanted.has(Number(task.id)))
  }
  if (tasks.length === 0) {
    process.stdout.write('nothing to run: tasks/todo/ is empty\n')
    return 0
  }

  // Refused before the first agent starts, like everything else a queue can
  // get wrong: three tasks in, a missing agent is a wasted run.
  const unarmed = [...new Set(tasks.map((task) => task.repo))].filter(
    (name) => !product.repos.find((repo) => repo.name === name).models.implement,
  )
  if (unarmed.length > 0) {
    throw new UsageError(`no implementing agent for ${unarmed.join(', ')} — set models.implement in product.json`)
  }

  let ok = true
  for (const task of tasks) {
    const repo = product.repos.find((r) => r.name === task.repo)
    process.stdout.write(`${task.id}  ${task.repo}  ${task.slug}  …\n`)
    const result = await runOne(product, repo, task)
    process.stdout.write(`${task.id}  ${line(result)}\n`)
    if (result.notified && !result.notified.sent) {
      process.stdout.write(`      could not notify: ${result.notified.error}\n`)
    }
    if (result.outcome !== 'committed') ok = false
  }
  return ok ? 0 : 1
}

function line(r) {
  const tries = `${r.attempts} ${r.attempts === 1 ? 'attempt' : 'attempts'}`
  const cost = r.cost.usd !== null ? `, $${r.cost.usd.toFixed(2)}` : r.cost.tokens ? `, ${r.cost.tokens.input + r.cost.tokens.output} tokens` : ''
  switch (r.outcome) {
    case 'committed':
      return `committed on ${r.branch} (${r.commit.slice(0, 7)}), ${tries}${cost}${r.lock === 'absent' ? ' — no gauge, so nothing was checked' : ''}`
    case 'skipped':
      return `skipped: ${r.reason}`
    default:
      return `paused (${r.outcome}): ${r.reason} — ${tries}${cost}`
  }
}
