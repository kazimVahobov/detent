import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../core/commands/prune.mjs'
import { snapshotRefs } from '../core/git.mjs'
import { claim } from '../core/state.mjs'
import { gitProduct, sh } from './support/product.mjs'

function commitOn(repoDir, branch, file) {
  sh(repoDir, 'switch', '--quiet', '-c', branch, 'agent/dev')
  writeFileSync(join(repoDir, file), `${file}\n`)
  sh(repoDir, 'add', '.')
  sh(repoDir, 'commit', '--quiet', '-m', file)
  sh(repoDir, 'switch', '--quiet', 'agent/dev')
}

function prune(s, values = {}) {
  const out = []
  const write = process.stdout.write
  process.stdout.write = (chunk) => (out.push(String(chunk)), true)
  try {
    return { code: run(s.product, [], { 'dry-run': false, ...values }), out: out.join('') }
  } finally {
    process.stdout.write = write
  }
}

function setup() {
  const s = gitProduct()
  // Merged by hand into agent/dev: its work is all there.
  commitOn(s.repoDir, 'agent/task-0001-landed', 'one.txt')
  sh(s.repoDir, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'agent/task-0001-landed')
  // Paused: work that never landed.
  commitOn(s.repoDir, 'agent/task-0002-paused', 'two.txt')
  // Stray: commits an agent put on agent/dev, kept aside — not on agent/dev now.
  commitOn(s.repoDir, 'agent/task-0003-x-stray', 'three.txt')
  // A branch outside the task prefix, merged: not prune's to touch.
  sh(s.repoDir, 'branch', 'agent/staging', 'agent/dev')
  sh(s.repoDir, 'branch', 'feature/merged-human', 'agent/dev')
  return s
}

test('only task branches whose work is all on agent/dev go', () => {
  const s = setup()
  const { code, out } = prune(s)
  assert.equal(code, 0)
  assert.match(out, /deleted +agent\/task-0001-landed/)
  assert.match(out, /kept +agent\/task-0002-paused — has work not on agent\/dev/)
  assert.match(out, /kept +agent\/task-0003-x-stray — has work not on agent\/dev/)
  const refs = [...snapshotRefs(s.repoDir).keys()]
  assert.ok(!refs.includes('refs/heads/agent/task-0001-landed'))
  for (const kept of ['agent/task-0002-paused', 'agent/task-0003-x-stray', 'agent/staging', 'feature/merged-human', 'dev', 'agent/dev']) {
    assert.ok(refs.includes(`refs/heads/${kept}`), kept)
  }
})

test('--dry-run deletes nothing', () => {
  const s = setup()
  const before = snapshotRefs(s.repoDir)
  assert.match(prune(s, { 'dry-run': true }).out, /would go agent\/task-0001-landed/)
  assert.deepEqual(snapshotRefs(s.repoDir), before)
})

test('a merged branch that is checked out, or whose task is running, is kept', () => {
  const s = gitProduct()
  sh(s.repoDir, 'branch', 'agent/task-0004-here', 'agent/dev')
  sh(s.repoDir, 'branch', 'agent/task-0005-running', 'agent/dev')
  sh(s.repoDir, 'switch', '--quiet', 'agent/task-0004-here')
  claim(s.dir, 'acme-api', { task: '0005', branch: 'agent/task-0005-running' })
  const { out } = prune(s)
  assert.match(out, /kept +agent\/task-0004-here — checked out/)
  assert.match(out, /kept +agent\/task-0005-running — its task is running/)
  assert.match(out, /nothing to prune/)
})
