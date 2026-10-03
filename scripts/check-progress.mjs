// PROGRESS.md is a claim about what exists, and this project refuses claims
// nobody checks. So the table is parsed rather than read: a step marked done
// has to name a proof that is really there, and the table has to still match
// the build order in DESIGN.md it is tracking.

import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import process from 'node:process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const progress = readFileSync(join(root, 'PROGRESS.md'), 'utf8')
const design = readFileSync(join(root, 'DESIGN.md'), 'utf8')

const STATES = new Set(['todo', 'wip', 'done'])
const DATE = /^\d{4}-\d{2}-\d{2}$/
const NOTHING = new Set(['—', '-', ''])

const problems = []

// The table: | # | Step | State | Proof | Date |
const rows = []
for (const line of progress.split('\n')) {
  if (!line.startsWith('|')) continue
  const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
  if (cells.length !== 5 || !/^\d+$/.test(cells[0])) continue
  const [number, step, state, proof, date] = cells
  rows.push({ number: Number(number), step, state, proof, date })
}

if (rows.length === 0) problems.push('no step rows found — has the table changed shape?')

for (const row of rows) {
  const where = `step ${row.number}`

  if (!STATES.has(row.state)) {
    problems.push(`${where}: state "${row.state}" is not one of ${[...STATES].join(', ')}`)
    continue
  }

  if (row.state !== 'done') continue

  if (NOTHING.has(row.proof)) {
    problems.push(`${where}: done without a proof — name the test that holds it`)
  } else {
    for (const path of row.proof.split(',').map((p) => p.trim().replaceAll('`', ''))) {
      let size = -1
      try {
        size = statSync(join(root, path)).size
      } catch {
        problems.push(`${where}: proof "${path}" does not exist`)
        continue
      }
      if (size === 0) problems.push(`${where}: proof "${path}" is empty`)
    }
  }

  if (!DATE.test(row.date)) problems.push(`${where}: done without a date (YYYY-MM-DD)`)
}

// Numbers are the index into the build order, so they must not repeat or go backwards.
for (let i = 1; i < rows.length; i += 1) {
  if (rows[i].number <= rows[i - 1].number) {
    problems.push(`step ${rows[i].number} comes after ${rows[i - 1].number} — numbers must ascend`)
  }
}

// The table tracks DESIGN.md's build order, so it must still cover it exactly.
const section = design.split(/^## \d+\. Build order$/m)[1]?.split(/^## /m)[0] ?? ''
const build = section.split('\n').flatMap((line) => {
  const match = /^(\d+)\.\s/.exec(line)
  return match ? [Number(match[1])] : []
})

if (build.length === 0) {
  problems.push('could not find the build order in DESIGN.md — section renamed?')
} else {
  const tracked = new Set(rows.map((row) => row.number))
  for (const step of build) {
    if (!tracked.has(step)) problems.push(`build order step ${step} has no row in PROGRESS.md`)
  }
  // Step 0 is the work that came before the build order; anything else must be in it.
  for (const row of rows) {
    if (row.number !== 0 && !build.includes(row.number)) {
      problems.push(`step ${row.number} is not in DESIGN.md's build order`)
    }
  }
}

if (problems.length > 0) {
  process.stderr.write('progress is claimed but not supported:\n')
  for (const problem of problems) process.stderr.write(`  ${problem}\n`)
  process.exit(1)
}

const done = rows.filter((row) => row.state === 'done').length
process.stdout.write(`progress: ${done}/${rows.length} steps done, each with a proof\n`)
