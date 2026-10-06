// detent gauge — the gauge by hand, outside any run: what an agent will be
// held to, seen before an agent is ever held to it.

import process from 'node:process'
import { runGauge } from '../gauge.mjs'
import { UsageError } from './usage.mjs'

export const options = { profile: { type: 'string', default: 'exit' } }

const PROFILES = ['exit', 'merge', 'promote']

export async function run(product, names, { profile }) {
  if (!PROFILES.includes(profile)) throw new UsageError(`unknown profile "${profile}" — expected ${PROFILES.join(' or ')}`)
  const unknown = names.filter((name) => !product.repos.some((repo) => repo.name === name))
  if (unknown.length > 0) {
    throw new UsageError(`not in product.json: ${unknown.join(', ')} — repositories are ${product.repos.map((r) => r.name).join(', ')}`)
  }
  const repos = names.length === 0 ? product.repos : product.repos.filter((repo) => names.includes(repo.name))

  let red = 0
  for (const repo of repos) {
    const result = await runGauge(repo.gauge[profile], { cwd: repo.dir, profile })
    if (result.lock === 'absent') {
      // Not a pass. A repository with nothing to check gets no lock, and saying
      // "green" about it would be the invented result detent exists to refuse.
      process.stdout.write(`${repo.name}  no ${profile} stages declared — no lock\n`)
      continue
    }
    process.stdout.write(`${repo.name}  ${profile}  ${result.green ? 'green' : 'red'}\n`)
    for (const stage of result.stages) {
      process.stdout.write(`  ${stage.ok ? '✓' : '✗'} ${stage.stage}  ${seconds(stage.ms)}\n`)
    }
    const skipped = repo.gauge[profile].slice(result.stages.length)
    for (const stage of skipped) process.stdout.write(`  · ${stage.stage}  not run\n`)
    if (!result.green) {
      red += 1
      const { command, code, signal, output } = result.failed
      process.stdout.write(`\n  ${command} — ${signal ? `killed by ${signal}` : `exit code ${code}`}\n`)
      process.stdout.write(`${output.trimEnd().replace(/^/gm, '  │ ')}\n\n`)
    }
  }
  return red > 0 ? 1 : 0
}

function seconds(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
