import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '../core/commands/dashboard.mjs'
import { PAGE } from '../core/dashboard-page.mjs'
import { appendJournal } from '../core/journal.mjs'
import { snapshotRefs } from '../core/git.mjs'
import { snapshot } from '../core/snapshot.mjs'
import { gitProduct, sh } from './support/product.mjs'

function setup() {
  const s = gitProduct({ gauge: { exit: [{ stage: 'test', command: 'true' }] }, models: { implement: { agent: 'claude' }, accept: { agent: 'codex' } } })
  for (const folder of ['todo', 'hold']) mkdirSync(join(s.dir, 'tasks', folder), { recursive: true })
  writeFileSync(join(s.dir, 'tasks', 'todo', '0003-next.md'), '---\nid: 0003\nrepo: acme-api\n---\n\n# Acceptance criteria\n\n- [ ] x\n')
  writeFileSync(join(s.dir, 'tasks', 'hold', '0002-float.md'), '---\nid: 0002\nrepo: acme-api\n---\n\n# Acceptance criteria\n\n- [ ] x\n')
  const line = (o) => ({ kind: 'task', repo: 'acme-api', attempts: 1, lock: 'enforced', models: { implement: { agent: 'claude', requested: null, actual: 'claude-opus-5' } }, cost: { usd: 0.1, tokens: null }, acceptance: { verdict: 'accepted', doubts: [] }, ...o })
  appendJournal(s.dir, line({ task: '0001', slug: 'first', outcome: 'passed', finished: '2026-10-06T10:00:00Z' }))
  appendJournal(s.dir, line({ task: '0002', slug: 'float', outcome: 'rejected', reason: 'the acceptance pass raised a doubt: add rounds', branch: 'agent/task-0002-float', acceptance: { verdict: 'rejected', doubts: ['add rounds'] }, finished: '2026-10-06T11:00:00Z' }))
  return s
}

test('the snapshot: numbers from the journal, the queue, and why a paused task is paused', () => {
  const s = setup()
  const snap = snapshot(s.product)
  assert.equal(snap.running, false)
  assert.equal(snap.numbers.all.runs, 2)
  assert.equal(snap.numbers.all.passed, 1)
  assert.deepEqual(snap.numbers.blindSpot, { read: 2, rejected: 1 })
  assert.deepEqual(snap.queue.todo.map((t) => t.id), ['0003'])
  const [held] = snap.queue.hold
  assert.equal(held.outcome, 'rejected')
  assert.deepEqual(held.doubts, ['add rounds'])
  assert.equal(held.branch, 'agent/task-0002-float')
  assert.equal(held.repo, 'acme-api')
  assert.deepEqual(snap.recent.map((r) => r.task), ['0002', '0001'], 'newest first')
})

test('agent/dev against compare: identical, behind, tasks ahead — reported, never acted on', () => {
  const s = setup()
  assert.deepEqual(snapshot(s.product).repos[0].divergence, { ahead: 0, behind: 0, tasksAhead: 0 })

  // A person's work on dev that agent/dev does not have yet.
  sh(s.repoDir, 'switch', '--quiet', 'dev')
  writeFileSync(join(s.repoDir, 'human.txt'), 'x\n')
  sh(s.repoDir, 'add', '.')
  sh(s.repoDir, 'commit', '--quiet', '-m', 'human')
  // And a task that landed on agent/dev.
  sh(s.repoDir, 'switch', '--quiet', '-c', 'agent/task-0001-first', 'agent/dev')
  writeFileSync(join(s.repoDir, 'agent.txt'), 'y\n')
  sh(s.repoDir, 'add', '.')
  sh(s.repoDir, 'commit', '--quiet', '-m', 'work')
  sh(s.repoDir, 'switch', '--quiet', 'agent/dev')
  sh(s.repoDir, 'merge', '--quiet', '--no-ff', '-m', 'merge: task 0001\n\nTask: 0001', 'agent/task-0001-first')

  const before = snapshotRefs(s.repoDir)
  const repo = snapshot(s.product).repos[0]
  assert.deepEqual(repo.divergence, { ahead: 2, behind: 1, tasksAhead: 1 })
  assert.equal(repo.lock, 'enforced')
  assert.deepEqual(snapshotRefs(s.repoDir), before, 'reading moved nothing')
})

test('a missing agent/dev is shown as missing', () => {
  const s = setup()
  sh(s.repoDir, 'branch', '-D', 'agent/dev')
  assert.equal(snapshot(s.product).repos[0].integration, null)
})

test('the page loads nothing from outside and sets every value as text', () => {
  assert.doesNotMatch(PAGE, /(src|href)=["']?https?:/i)
  assert.doesNotMatch(PAGE, /@import|url\(/)
  assert.doesNotMatch(PAGE, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
})

test('the server: 127.0.0.1 only, GET only, the page and its state', async () => {
  const s = setup()
  const server = await serve(s.product, { port: 0 })
  try {
    const { address, port } = server.address()
    assert.equal(address, '127.0.0.1')
    const base = `http://127.0.0.1:${port}`

    const page = await fetch(`${base}/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/)
    assert.match(await page.text(), /<title>detent<\/title>/)

    const state = await fetch(`${base}/state.json`)
    assert.equal(state.status, 200)
    assert.equal((await state.json()).product.name, 'acme')

    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await fetch(`${base}/state.json`, { method })
      assert.equal(response.status, 405, method)
    }
    assert.equal((await fetch(`${base}/nope`)).status, 404)
  } finally {
    server.close()
  }
})
