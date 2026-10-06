// detent summary — pass rate, attempts, cost per pass, from the journal alone.

import process from 'node:process'
import { byModel, byRepo, readJournal, summarise } from '../journal.mjs'

export const options = { repo: { type: 'string' } }

export function run(product, _positionals, { repo }) {
  const { lines, unreadable } = readJournal(product.dir)
  const selected = repo ? lines.filter((l) => l.repo === repo) : lines
  const tasks = selected.filter((l) => l.kind === 'task')
  const promotions = selected.length - tasks.length
  const skipped = tasks.filter((l) => l.outcome === 'skipped').length

  if (tasks.length - skipped === 0) {
    process.stdout.write(`no task runs in ${product.name}'s journal yet${skipped ? ` (${skipped} skipped by the gate)` : ''}\n`)
  } else {
    process.stdout.write(table('repository', summarise(tasks, byRepo)))
    process.stdout.write('\n')
    process.stdout.write(table('agent and model', summarise(tasks, byModel)))
  }

  const notes = []
  if (skipped) notes.push(`${skipped} ${skipped === 1 ? 'run was' : 'runs were'} skipped by the gate, and not counted`)
  if (promotions) notes.push(`${promotions} promotion ${promotions === 1 ? 'line is' : 'lines are'} not summarised yet (build step 10)`)
  if (unreadable) notes.push(`${unreadable} journal ${unreadable === 1 ? 'line' : 'lines'} could not be read`)
  if (tasks.some((l) => l.lock === 'absent')) notes.push('— in pass rate: a repository with no gauge has nothing to pass')
  if (notes.length) process.stdout.write(`\n${notes.map((n) => `  ${n}`).join('\n')}\n`)
  return 0
}

function table(title, rows) {
  const head = [title, 'runs', 'passed', 'pass rate', 'attempts/run', 'cost/pass', 'not passed']
  const body = rows
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => [
      r.name,
      String(r.runs),
      String(r.passed),
      r.passRate === null ? '—' : `${Math.round(r.passRate * 100)}%`,
      r.attemptsPerRun.toFixed(1),
      cost(r.costPerPass),
      Object.entries(r.outcomes).map(([o, n]) => `${o} ${n}`).join(', ') || '—',
    ])
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)))
  const line = (cells) => cells.map((c, i) => (i === 0 || i === cells.length - 1 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ').trimEnd()
  return `${[line(head), ...body.map(line)].join('\n')}\n`
}

function cost(c) {
  if (!c) return '—'
  if (c.usd !== undefined) return `$${c.usd.toFixed(2)}`
  return `${Math.round(c.tokens).toLocaleString('en-US')} tok`
}
