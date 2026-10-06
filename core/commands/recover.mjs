import process from 'node:process'
import { recover } from '../workspace.mjs'

export const options = {}

export function run(product) {
  const report = recover(product)
  if (report.length === 0) {
    process.stdout.write('nothing to recover: no repository is out\n')
    return 0
  }
  for (const line of report) {
    const what =
      line.action === 'returned'
        ? `returned to ${product.branches.integration}${line.aborted ? `, ${line.aborted} aborted` : ''}${line.parked ? `, work parked as ${line.parked.slice(0, 7)}` : ''}`
        : `${line.action}: ${line.reason}`
    process.stdout.write(`${line.repo}  task ${line.task}  ${what}\n`)
  }
  return report.every((line) => line.action === 'returned') ? 0 : 1
}
