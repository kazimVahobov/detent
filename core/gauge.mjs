// The gauge: a profile's declared stages, run in order in one repository
// (DESIGN.md §6, ADR 0003). Declared rather than discovered, so the stage that
// went red is known exactly instead of guessed from output.

import { spawn } from 'node:child_process'
import process from 'node:process'

// What an agent is handed is the end of the output, where the failure is
// almost always reported; the head of a long log is noise by comparison.
export const OUTPUT_LIMIT = 64 * 1024

export async function runGauge(stages, { cwd, profile = 'exit', env = process.env, limit = OUTPUT_LIMIT } = {}) {
  // No declared stages is no lock: not refused and not pretended at. green is
  // null rather than true, because a pass invented for a project with no
  // checks is worse than no result.
  if (stages.length === 0) return { profile, lock: 'absent', green: null, stages: [], failed: null }

  const results = []
  for (const { stage, command } of stages) {
    const result = await runStage(command, { cwd, env, limit })
    results.push({ stage, command, ...result })
    // Later stages are not run: a red stage is the answer, and a stage built
    // on top of it would only report the same failure in other words.
    if (!result.ok) break
  }

  const failed = results.find((r) => !r.ok) ?? null
  return { profile, lock: 'enforced', green: failed === null, stages: results, failed }
}

// The form commit trailers use: "lint ✓ typecheck ✓ test ✗".
export function formatGauge(result) {
  if (result.lock === 'absent') return 'no gauge declared'
  return result.stages.map((s) => `${s.stage} ${s.ok ? '✓' : '✗'}`).join(' ')
}

function runStage(command, { cwd, env, limit }) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint()
    const chunks = []
    let size = 0
    let dropped = false

    // Both streams into one buffer in arrival order, which is the order a
    // person would have seen them in a terminal.
    const keep = (chunk) => {
      chunks.push(chunk)
      size += chunk.length
      while (size - chunks[0].length >= limit) {
        size -= chunks.shift().length
        dropped = true
      }
    }

    const child = spawn('sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)

    const finish = (code, signal, extra = '') => {
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n)
      let output = Buffer.concat(chunks).toString('utf8')
      if (output.length > limit) {
        dropped = true
        output = output.slice(-limit)
      }
      if (dropped) output = `[… earlier output dropped]\n${output}`
      resolve({ ok: code === 0, code, signal, ms, output: output + extra })
    }

    child.on('error', (error) => finish(null, null, `\n${error.message}\n`))
    child.on('close', (code, signal) => finish(code, signal))
  })
}
