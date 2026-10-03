import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'cli.mjs')

function run(args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' }) }
  } catch (error) {
    return { code: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('bare invocation prints usage and succeeds', () => {
  const { code, out } = run([])
  assert.equal(code, 0)
  assert.match(out, /Usage: detent/)
})

test('every command is listed in usage', () => {
  const { out } = run(['--help'])
  for (const command of ['doctor', 'init', 'plan', 'run', 'summary', 'dashboard', 'recover', 'prune']) {
    assert.match(out, new RegExp(`\\b${command}\\b`), `usage is missing "${command}"`)
  }
})

test('usage states the branch boundary', () => {
  const { out } = run(['--help'])
  assert.match(out, /agent-task\/<id>/)
  assert.match(out, /agent-dev/)
})

test('--version prints a bare version', () => {
  const { code, out } = run(['--version'])
  assert.equal(code, 0)
  assert.match(out.trim(), /^\d+\.\d+\.\d+$/)
})

test('an unknown command fails with usage, not a stack trace', () => {
  const { code, out } = run(['nonsense'])
  assert.equal(code, 2)
  assert.match(out, /unknown command "nonsense"/)
  assert.doesNotMatch(out, /at \S+:\d+:\d+/)
})

test('a known but unbuilt command says so instead of pretending', () => {
  const { code, out } = run(['run'])
  assert.equal(code, 70)
  assert.match(out, /not implemented yet/)
})
