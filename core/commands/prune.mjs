// detent prune — delete agent/task-* branches whose work is already on
// agent/dev. A landed task's branch is deleted when it lands; what is left in
// the namespace is paused work a person may still need, and the occasional
// branch a person merged by hand. Only the second kind goes.

import process from 'node:process'
import { currentBranch, deleteBranch, git } from '../git.mjs'
import { isAgentBranch } from '../refs.mjs'
import { readState } from '../state.mjs'
import { UsageError } from './usage.mjs'

export const options = { 'dry-run': { type: 'boolean', default: false } }

export function run(product, names, values) {
  const unknown = names.filter((n) => !product.repos.some((r) => r.name === n))
  if (unknown.length) throw new UsageError(`not in product.json: ${unknown.join(', ')}`)
  const repos = names.length ? product.repos.filter((r) => names.includes(r.name)) : product.repos
  const integration = product.branches.integration
  const active = readState(product.dir).repos
  const dry = values['dry-run']

  let gone = 0
  for (const repo of repos) {
    const branches = git(repo.dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/agent/task-*']).split('\n').filter(Boolean)
    for (const branch of branches) {
      if (!isAgentBranch(branch)) continue
      // Its work is all on agent/dev: every commit on it is reachable from there.
      const merged = git(repo.dir, ['rev-list', '--count', `refs/heads/${integration}..refs/heads/${branch}`]) === '0'
      let keep = null
      if (!merged) keep = 'has work not on agent/dev'
      else if (currentBranch(repo.dir) === branch) keep = 'checked out'
      else if (active[repo.name]?.branch === branch) keep = 'its task is running'
      if (keep) {
        process.stdout.write(`${repo.name}  kept     ${branch} — ${keep}\n`)
        continue
      }
      if (!dry) deleteBranch(repo.dir, branch)
      gone += 1
      process.stdout.write(`${repo.name}  ${dry ? 'would go' : 'deleted '} ${branch}\n`)
    }
  }
  if (gone === 0) process.stdout.write('nothing to prune\n')
  return 0
}
