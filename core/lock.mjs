// The lock: the decision on the agent's way out (DESIGN.md §5, §6).
//
// The agent is allowed to stop when the project's checks pass, not when it
// says it is done. Red means it stays, and is handed the failed stage and its
// output to work from. The same failure, unchanged, `limit` times in a row is
// an escalation: a fourth identical attempt buys nothing a person would not
// rather know about now.

export function judge(history, { limit }) {
  const last = history.at(-1)
  if (!last) throw new Error('judge needs at least one gauge result')

  if (last.lock === 'absent') return { verdict: 'unlocked', attempts: history.length }
  if (last.green) return { verdict: 'leave', attempts: history.length }

  const tail = history.slice(-limit)
  if (tail.length === limit && tail.every((r) => !r.green && fingerprint(r) === fingerprint(last))) {
    return {
      verdict: 'escalate',
      attempts: history.length,
      stage: last.failed.stage,
      reason: `${limit} identical failures on ${last.failed.stage}`,
    }
  }

  return { verdict: 'retry', attempts: history.length, stage: last.failed.stage, feedback: feedback(last) }
}

// What makes two failures "identical": the same stage, the same exit, and the
// same output once what changes on every run regardless — colour codes,
// timestamps, durations — is taken out. A different failing assertion, or a
// different number of failing tests, is progress of a kind and is not
// identical.
export function fingerprint(result) {
  const failed = result.failed
  if (!failed) return null
  return [failed.stage, failed.code, failed.signal, normalise(failed.output)].join('\u0000')
}

export function normalise(output) {
  return output
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ns|µs|us|ms|s|sec|secs|seconds|m|min)\b/g, '<duration>')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

function feedback(result) {
  const { stage, command, code, signal, output } = result.failed
  const exit = signal ? `killed by ${signal}` : `exit code ${code}`
  return [
    `The gauge is red on stage "${stage}" (${result.profile} profile): \`${command}\` finished with ${exit}.`,
    'You are not done until it is green. Its output:',
    '',
    output.trimEnd(),
  ].join('\n')
}
