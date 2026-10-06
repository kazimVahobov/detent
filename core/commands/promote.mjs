// detent promote — agent/dev into agent/staging behind the batch gauge.

import process from 'node:process'
import { promote } from '../promote.mjs'
import { UsageError } from './usage.mjs'

export const options = {}

export async function run(product, names, _values, { promote: promoteOne = promote } = {}) {
  if (!product.branches.staging) {
    process.stdout.write('no branches.staging in product.json — there is nowhere to promote to, and nothing to do\n')
    return 0
  }
  const unknown = names.filter((n) => !product.repos.some((r) => r.name === n))
  if (unknown.length) throw new UsageError(`not in product.json: ${unknown.join(', ')}`)
  const repos = names.length ? product.repos.filter((r) => names.includes(r.name)) : product.repos

  let ok = true
  for (const repo of repos) {
    const r = await promoteOne(product, repo)
    const batch = r.tasks.length ? ` (${r.tasks.join(', ')})` : ''
    switch (r.outcome) {
      case 'passed':
        process.stdout.write(`${repo.name}  promoted${batch} to ${r.branch} (${r.commit.slice(0, 7)})${r.lock === 'absent' ? ' — no promote stages, so the batch was not checked' : ''}\n`)
        break
      case 'skipped':
        process.stdout.write(`${repo.name}  skipped: ${r.reason}\n`)
        break
      default:
        ok = false
        process.stdout.write(`${repo.name}  not promoted (${r.outcome})${batch}: ${r.reason}\n`)
    }
    if (r.notified && !r.notified.sent) process.stdout.write(`      could not notify: ${r.notified.error}\n`)
  }
  return ok ? 0 : 1
}
