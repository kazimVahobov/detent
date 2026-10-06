// Telling a person that a task needs them (ADR 0009).
//
// The channel is a command, because every team already has one that reaches
// them and detent should hold no credential for any of them. A notifier that
// fails is reported and never fails the run: the task is already paused, and
// losing the run over a message about it would be the worse outcome.

import { spawnSync } from 'node:child_process'
import process from 'node:process'

export function notify(product, { task, repo, outcome, branch, message }) {
  const env = {
    ...process.env,
    DETENT_TASK: task,
    DETENT_REPO: repo,
    DETENT_OUTCOME: outcome,
    DETENT_BRANCH: branch ?? '',
    DETENT_MESSAGE: message,
  }

  if (product.notify) {
    const result = spawnSync('sh', ['-c', product.notify], { cwd: product.dir, env, input: message, encoding: 'utf8', timeout: 30_000 })
    if (result.status === 0) return { sent: true, via: 'command' }
    // The exit status first: a command that never reads stdin makes the write
    // fail with EPIPE, which is noise beside what the command itself said.
    const why =
      result.status !== null
        ? `exit code ${result.status}: ${result.stderr.trim()}`
        : result.signal
          ? `killed by ${result.signal}`
          : result.error.message
    return { sent: false, via: 'command', error: why }
  }

  for (const [command, args] of desktop(message)) {
    const result = spawnSync(command, args, { env, stdio: 'ignore', timeout: 10_000 })
    if (result.status === 0) return { sent: true, via: command }
  }
  return { sent: false, via: null, error: 'no notify command in product.json, and no desktop notifier answered' }
}

function desktop(message) {
  const title = 'detent'
  if (process.platform === 'darwin') {
    return [['osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]]]
  }
  return [['notify-send', [title, message]]]
}
