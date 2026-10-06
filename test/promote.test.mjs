// Build step 10: promotion, against real repositories. Tasks land on agent/dev
// the way detent lands them — a merge commit with a Task trailer — and the
// batch is promoted, or not, onto agent/staging.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { snapshotRefs } from '../core/git.mjs'
import { readJournal } from '../core/journal.mjs'
import { validateProduct } from '../core/product.mjs'
import { landedSince, promote } from '../core/promote.mjs'
import { claim, readState } from '../core/state.mjs'
import { assertInvariant, gitProduct, sh, show } from './support/product.mjs'

const root = join(import.meta.dirname, '..')

function setup(promoteStages = [{ stage: 'e2e', command: 'test "$(cat a.txt b.txt 2>/dev/null | wc -l)" -lt 3 || { echo "a and b together break the build"; exit 1; }' }]) {
  const s = gitProduct()
  sh(s.repoDir, 'branch', 'agent/staging', 'agent/dev')
  const raw = {
    version: 1,
    product: { name: 'acme' },
    branches: { staging: 'agent/staging' },
    repos: [{ name: 'acme-api', compare: 'dev', gauge: { exit: [{ stage: 'test', command: 'true' }], promote: promoteStages } }],
  }
  writeFileSync(join(s.dir, '.detent', 'product.json'), JSON.stringify(raw))
  const { product } = validateProduct(raw, s.dir)
  return { ...s, product, repo: product.repos[0] }
}

// Land a task on agent/dev as detent does: a task branch, a merge with a trailer.
function land(repoDir, id, file, text) {
  const branch = `agent/task-${id}-t`
  sh(repoDir, 'switch', '--quiet', '-c', branch, 'agent/dev')
  writeFileSync(join(repoDir, file), text)
  sh(repoDir, 'add', '.')
  sh(repoDir, 'commit', '--quiet', '-m', `feat: ${id}`)
  sh(repoDir, 'switch', '--quiet', 'agent/dev')
  sh(repoDir, 'merge', '--quiet', '--no-ff', '-m', `merge: task ${id}\n\nTask: ${id}`, branch)
  sh(repoDir, 'branch', '-D', branch)
}

function notifier() {
  const sent = []
  return { sent, notify: (_, d) => (sent.push(d), { sent: true, via: 'test' }) }
}

test('the batch is what landed since the last promotion, by Task trailer', () => {
  const s = setup()
  land(s.repoDir, '0001', 'a.txt', 'a\n')
  land(s.repoDir, '0003', 'c.txt', 'c\n')
  assert.deepEqual(landedSince(s.repoDir, 'agent/staging', 'agent/dev'), ['0001', '0003'])
})

test('green: agent/staging moves to a merge that names the batch, and the repository comes back', async () => {
  const s = setup()
  land(s.repoDir, '0001', 'a.txt', 'a\n')
  land(s.repoDir, '0002', 'c.txt', 'c\n')
  const before = snapshotRefs(s.repoDir)
  const devTip = sh(s.repoDir, 'rev-parse', 'agent/dev')
  const n = notifier()

  const r = await promote(s.product, s.repo, { notify: n.notify })
  assert.equal(r.outcome, 'passed', r.reason)
  assert.equal(r.kind, 'promote')
  assert.deepEqual(r.tasks, ['0001', '0002'])
  assert.equal(r.commit, sh(s.repoDir, 'rev-parse', 'agent/staging'))
  const message = sh(s.repoDir, 'log', '-1', '--format=%B', 'agent/staging')
  assert.match(message, /^promote: 2 tasks from agent\/dev$/m)
  assert.match(message, /^Tasks: 0001, 0002$/m)
  assert.match(message, /^Gauge: e2e ✓ \(promote profile, \d+s\)$/m)
  assert.equal(sh(s.repoDir, 'rev-parse', 'agent/dev'), devTip, 'agent/dev is not touched')
  assert.equal(show(s.repoDir, 'agent/staging', 'c.txt'), 'c')
  assertInvariant(s.repoDir, before, s.product)
  assert.deepEqual(n.sent, [])
  assert.equal(readJournal(s.dir).lines.at(-1).kind, 'promote')

  const again = await promote(s.product, s.repo, { notify: n.notify })
  assert.equal(again.outcome, 'skipped')
  assert.match(again.reason, /no task has landed on agent\/dev since the last promotion/)
})

test('red: every task green alone, the batch red together — nothing promoted, nothing reverted', async () => {
  const s = setup()
  land(s.repoDir, '0001', 'a.txt', 'a\n')
  land(s.repoDir, '0002', 'b.txt', 'b\nb\n')
  const before = snapshotRefs(s.repoDir)
  const stagingTip = sh(s.repoDir, 'rev-parse', 'agent/staging')
  const devTip = sh(s.repoDir, 'rev-parse', 'agent/dev')
  const n = notifier()

  const r = await promote(s.product, s.repo, { notify: n.notify })
  assert.equal(r.outcome, 'red')
  assert.equal(r.gauge.failedStage, 'e2e')
  assert.equal(r.merged, false)
  assert.equal(sh(s.repoDir, 'rev-parse', 'agent/staging'), stagingTip, 'nothing promoted')
  assert.equal(sh(s.repoDir, 'rev-parse', 'agent/dev'), devTip, 'nothing reverted')
  assert.match(n.sent[0].message, /stays on agent\/dev; nothing was reverted/)
  assertInvariant(s.repoDir, before, s.product)

  const summary = execFileSync(process.execPath, [join(root, 'cli.mjs'), 'summary', '--product', s.dir], { encoding: 'utf8' })
  assert.match(summary, /^red batch: 1 of 1 batch came out red with every task in it green \(100%\)$/m)
})

test('a conflict between agent/dev and agent/staging is aborted, never resolved', async () => {
  const s = setup([])
  // Something on agent/staging that agent/dev does not have — a person's fix there.
  sh(s.repoDir, 'switch', '--quiet', 'agent/staging')
  writeFileSync(join(s.repoDir, 'app.js'), 'export const a = "staging"\n')
  sh(s.repoDir, 'commit', '--quiet', '-am', 'fix on staging')
  sh(s.repoDir, 'switch', '--quiet', 'agent/dev')
  land(s.repoDir, '0001', 'app.js', 'export const a = "dev"\n')
  const before = snapshotRefs(s.repoDir)
  const n = notifier()
  const r = await promote(s.product, s.repo, { notify: n.notify })
  assert.equal(r.outcome, 'escalated')
  assert.deepEqual(r.conflicts, ['app.js'])
  assert.equal(n.sent.length, 1)
  assertInvariant(s.repoDir, before, s.product)
})

test('the gate: a dirty tree, a task out, a missing staging branch', async () => {
  const dirty = setup()
  land(dirty.repoDir, '0001', 'a.txt', 'a\n')
  writeFileSync(join(dirty.repoDir, 'scratch.txt'), 'mine')
  assert.match((await promote(dirty.product, dirty.repo, { notify: notifier().notify })).reason, /not clean/)

  const busy = setup()
  land(busy.repoDir, '0001', 'a.txt', 'a\n')
  claim(busy.dir, 'acme-api', { task: '0009', branch: 'agent/task-0009-x' })
  assert.match((await promote(busy.product, busy.repo, { notify: notifier().notify })).reason, /task 0009 is already active here/)

  const none = setup()
  sh(none.repoDir, 'branch', '-D', 'agent/staging')
  const r = await promote(none.product, none.repo, { notify: notifier().notify })
  assert.equal(r.outcome, 'skipped')
  assert.match(r.reason, /agent\/staging does not exist — create it: git branch agent\/staging agent\/dev/)
})

test('no promote stages: it promotes, and says the batch was not checked', async () => {
  const s = setup([])
  land(s.repoDir, '0001', 'a.txt', 'a\n')
  const r = await promote(s.product, s.repo, { notify: notifier().notify })
  assert.equal(r.outcome, 'passed')
  assert.equal(r.lock, 'absent')
  const out = execFileSync(process.execPath, [join(root, 'cli.mjs'), 'summary', '--product', s.dir], { encoding: 'utf8' })
  assert.doesNotMatch(out, /red batch: 0 of 1/, 'an unchecked batch is not counted as checked green')
})

test('a product with no staging branch is told so', () => {
  const s = gitProduct()
  const out = execFileSync(process.execPath, [join(root, 'cli.mjs'), 'promote', '--product', s.dir], { encoding: 'utf8' })
  assert.match(out, /no branches\.staging in product\.json/)
})

test('a promotion killed mid-gauge is returned by detent recover', async () => {
  const s = setup([{ stage: 'e2e', command: 'echo started > gauge-started; echo junk > junk.txt; sleep 30' }])
  land(s.repoDir, '0001', 'a.txt', 'a\n')
  const before = snapshotRefs(s.repoDir)
  const script = join(s.dir, 'child.mjs')
  writeFileSync(
    script,
    `import { loadProduct } from ${JSON.stringify(pathToFileURL(join(root, 'core', 'product.mjs')).href)}
import { promote } from ${JSON.stringify(pathToFileURL(join(root, 'core', 'promote.mjs')).href)}
const product = loadProduct(${JSON.stringify(s.dir)})
await promote(product, product.repos[0], { notify: () => ({ sent: true }) })
`,
  )
  const child = spawn(process.execPath, [script], { stdio: 'ignore' })
  for (let i = 0; i < 200 && !existsSync(join(s.repoDir, 'gauge-started')); i += 1) await new Promise((r) => setTimeout(r, 25))
  assert.ok(existsSync(join(s.repoDir, 'gauge-started')), 'the promote gauge started')
  child.kill('SIGKILL')
  await new Promise((r) => child.on('exit', r))
  assert.ok(readState(s.dir).repos['acme-api'], 'state.json remembers the promotion')

  const out = execFileSync(process.execPath, [join(root, 'cli.mjs'), 'recover', '--product', s.dir], { encoding: 'utf8' })
  assert.match(out, /^acme-api {2}task promote {2}returned to agent\/dev, merge aborted$/m)
  assertInvariant(s.repoDir, before, s.product)
  assert.equal(sh(s.repoDir, 'rev-parse', 'agent/staging'), before.get('refs/heads/agent/staging'), 'nothing promoted')
})
