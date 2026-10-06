import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { schedule } from '../core/scheduler.mjs'
import { validateProduct } from '../core/product.mjs'
import { readQueue } from '../core/task.mjs'
import { run as runCommand } from '../core/commands/run.mjs'
import { runTask } from '../core/run.mjs'
import { readJournal } from '../core/journal.mjs'
import { assertInvariant, gitProduct, sh } from './support/product.mjs'
import { snapshotRefs } from '../core/git.mjs'

const task = (id, repo, touchesContract = false) => ({ id: String(id).padStart(4, '0'), repo, touchesContract })

// A runOne that records what ran at once, finishing after `ms` with `outcome`.
function recorder(plan = {}) {
  const log = []
  let now = 0
  const active = new Set()
  const runOne = async (t) => {
    active.add(t)
    log.push({ start: t.id, alongside: [...active].map((a) => a.id).filter((id) => id !== t.id), t: now++ })
    await new Promise((r) => setTimeout(r, plan[t.id]?.ms ?? 20))
    active.delete(t)
    log.push({ end: t.id, t: now++ })
    if (plan[t.id]?.throws) throw new Error('boom')
    return { outcome: plan[t.id]?.outcome ?? 'passed' }
  }
  return { log, runOne, order: () => log.filter((e) => e.start).map((e) => e.start) }
}

test('at most concurrency at once, never two in one repository, one repository in id order', async () => {
  const r = recorder()
  const tasks = [task(1, 'api'), task(2, 'api'), task(3, 'web'), task(4, 'docs'), task(5, 'web')]
  await schedule(tasks, { concurrency: 2, runOne: r.runOne })
  for (const entry of r.log.filter((e) => e.start)) {
    assert.ok(entry.alongside.length <= 1, `${entry.start} ran beside ${entry.alongside}`)
    const repoOf = (id) => tasks.find((t) => t.id === id).repo
    assert.ok(!entry.alongside.some((id) => repoOf(id) === repoOf(entry.start)), `${entry.start} shared a repository`)
  }
  const starts = r.order()
  assert.ok(starts.indexOf('0001') < starts.indexOf('0002'))
  assert.ok(starts.indexOf('0003') < starts.indexOf('0005'))
  assert.equal(starts.length, 5)
  assert.deepEqual(starts.slice(0, 2), ['0001', '0003'], 'a busy repository does not hold up another')
})

test('concurrency 1 is the sequential run, in id order', async () => {
  const r = recorder()
  await schedule([task(3, 'web'), task(1, 'api'), task(2, 'api')], { concurrency: 1, runOne: r.runOne })
  assert.deepEqual(r.order(), ['0001', '0002', '0003'])
  assert.ok(r.log.filter((e) => e.start).every((e) => e.alongside.length === 0))
})

test('a barrier: the pool drains, it runs alone, nothing past it starts until it is done', async () => {
  const r = recorder({ '0001': { ms: 60 } })
  const tasks = [task(1, 'api'), task(2, 'web'), task(3, 'api', true), task(4, 'docs'), task(5, 'web')]
  await schedule(tasks, { concurrency: 3, runOne: r.runOne })
  const at = (kind, id) => r.log.find((e) => e[kind] === id).t
  const barrier = r.log.find((e) => e.start === '0003')
  assert.deepEqual(barrier.alongside, [], 'it ran alone')
  assert.ok(at('start', '0003') > at('end', '0001') && at('start', '0003') > at('end', '0002'), 'everything before it finished first')
  assert.ok(at('start', '0004') > at('end', '0003'), '0004 — another repository — did not start past it')
  assert.ok(at('start', '0005') > at('end', '0003'))
})

test('a barrier that does not pass ends the run there', async () => {
  const r = recorder({ '0002': { outcome: 'escalated' } })
  const { results, stoppedAt } = await schedule([task(1, 'api'), task(2, 'api', true), task(3, 'web'), task(4, 'docs')], { concurrency: 2, runOne: r.runOne })
  assert.deepEqual(r.order(), ['0001', '0002'])
  assert.equal(stoppedAt.task.id, '0002')
  assert.deepEqual(stoppedAt.left.map((t) => t.id), ['0003', '0004'])
  assert.equal(results.length, 2)
})

test('a task that throws is its own error, and the pool goes on', async () => {
  const r = recorder({ '0001': { throws: true } })
  const { results } = await schedule([task(1, 'api'), task(2, 'web')], { concurrency: 2, runOne: r.runOne })
  assert.deepEqual(results.map(({ task: t, result }) => [t.id, result.outcome]).sort(), [['0001', 'error'], ['0002', 'passed']])
})

// --- two real repositories, two agents at once --------------------------------

test('two repositories run side by side, each returned, each journaled, each landed', async () => {
  const s = gitProduct()
  // A second repository beside the first.
  const web = join(s.dir, 'acme-web')
  mkdirSync(web)
  sh(web, 'init', '--quiet', '--initial-branch=dev')
  sh(web, 'config', 'user.name', 'P')
  sh(web, 'config', 'user.email', 'p@x')
  writeFileSync(join(web, 'README.md'), 'web\n')
  sh(web, 'add', '.')
  sh(web, 'commit', '--quiet', '-m', 'init')
  sh(web, 'branch', 'agent/dev')
  const gauge = { exit: [{ stage: 'test', command: 'test -f done.txt' }] }
  const { product } = validateProduct(
    {
      version: 1,
      product: { name: 'acme' },
      concurrency: 2,
      models: { implement: { agent: 'claude' } },
      repos: [{ name: 'acme-api', compare: 'dev', gauge }, { name: 'acme-web', compare: 'dev', gauge }],
    },
    s.dir,
  )
  mkdirSync(join(s.dir, 'tasks', 'todo'), { recursive: true })
  for (const [id, repo] of [['0001', 'acme-api'], ['0002', 'acme-web']]) {
    writeFileSync(join(s.dir, 'tasks', 'todo', `${id}-t.md`), `---\nid: ${id}\nrepo: ${repo}\n---\n\n# Acceptance criteria\n\n- [ ] done\n`)
  }
  const before = { api: snapshotRefs(s.repoDir), web: snapshotRefs(web) }

  let concurrent = 0
  let peak = 0
  const invoke = async (role, { cwd }) => {
    concurrent += 1
    peak = Math.max(peak, concurrent)
    await new Promise((r) => setTimeout(r, 150))
    writeFileSync(join(cwd, 'done.txt'), 'yes\n')
    concurrent -= 1
    return { ok: true, message: 'Commit: feat: done', model: { requested: null, actual: null }, cost: { usd: 0.1, tokens: null }, session: null, error: null, ms: 1 }
  }
  const out = []
  const write = process.stdout.write
  process.stdout.write = (chunk) => (out.push(String(chunk)), true)
  let code
  try {
    code = await runCommand(product, [], {}, { runTask: (p, repo, t) => runTask(p, repo, t, { invoke, notify: () => ({ sent: true }) }) })
  } finally {
    process.stdout.write = write
  }
  assert.equal(code, 0, out.join(''))
  assert.equal(peak, 2, 'both agents worked at once')
  assertInvariant(s.repoDir, before.api, product)
  assertInvariant(web, before.web, product)
  assert.equal(readJournal(s.dir).lines.filter((l) => l.outcome === 'passed').length, 2)
  assert.equal(readQueue(s.dir, product).filter((t) => t.folder === 'done').length, 2)
})
