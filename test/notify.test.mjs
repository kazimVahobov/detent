import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notify } from '../core/notify.mjs'

const details = { task: '0042', repo: 'acme-api', outcome: 'escalated', branch: 'agent/task-0042-wallet', message: 'task 0042 is paused: 3 identical failures on test' }

test('the notify command gets the message on stdin and the details in its environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'detent-notify-'))
  const result = notify({ dir, notify: 'cat > message; env | grep ^DETENT_ | sort > env' }, details)
  assert.deepEqual(result, { sent: true, via: 'command' })
  assert.equal(readFileSync(join(dir, 'message'), 'utf8'), details.message)
  const env = readFileSync(join(dir, 'env'), 'utf8')
  assert.match(env, /^DETENT_TASK=0042$/m)
  assert.match(env, /^DETENT_REPO=acme-api$/m)
  assert.match(env, /^DETENT_OUTCOME=escalated$/m)
  assert.match(env, /^DETENT_BRANCH=agent\/task-0042-wallet$/m)
  assert.match(env, /^DETENT_MESSAGE=task 0042 is paused/m)
})

test('a failing notifier is reported, never thrown', () => {
  const result = notify({ dir: tmpdir(), notify: 'echo "no route to chat" >&2; exit 4' }, details)
  assert.equal(result.sent, false)
  assert.match(result.error, /exit code 4: no route to chat/)
})

test('without a command, a desktop notifier is tried, and its absence is reported', () => {
  const bin = mkdtempSync(join(tmpdir(), 'detent-bin-'))
  const env = process.env.PATH
  try {
    process.env.PATH = bin
    assert.deepEqual(notify({ dir: tmpdir(), notify: null }, details), {
      sent: false,
      via: null,
      error: 'no notify command in product.json, and no desktop notifier answered',
    })

    const name = process.platform === 'darwin' ? 'osascript' : 'notify-send'
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$@" > ${JSON.stringify(join(bin, 'called'))}\n`)
    chmodSync(join(bin, name), 0o755)
    assert.deepEqual(notify({ dir: tmpdir(), notify: null }, details), { sent: true, via: name })
    assert.match(readFileSync(join(bin, 'called'), 'utf8'), /3 identical failures on test/)
  } finally {
    process.env.PATH = env
  }
})
