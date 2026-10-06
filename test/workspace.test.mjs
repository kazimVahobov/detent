// The invariant of DESIGN.md §2, held by tests: every exit from a task leaves
// the repository on agent/dev with a clean tree, and every ref that moved lives
// under refs/heads/agent/. Each test snapshots every ref before and after, so
// it fails on a branch nobody thought to enumerate.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BoundaryError, createBranch, currentBranch, forceCheckout, git, isClean, operationInProgress, snapshotRefs, snapshotOnto } from '../core/git.mjs'
import { validateProduct } from '../core/product.mjs'
import { claim, readState } from '../core/state.mjs'
import { gate, recover, withTask } from '../core/workspace.mjs'

const root = join(import.meta.dirname, '..')
const TASK = { id: '0042', slug: 'wallet-endpoint' }
const BRANCH = 'agent/task-0042-wallet-endpoint'

function sh(cwd, ...args) {
  return git(cwd, args)
}

// A product folder with one repository holding a human history — dev, a
// feature branch, a tag — and agent/dev made from dev, as a person would.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'detent-ws-'))
  const repoDir = join(dir, 'acme-api')
  mkdirSync(repoDir)
  sh(repoDir, 'init', '--quiet', '--initial-branch=dev')
  sh(repoDir, 'config', 'user.name', 'Person')
  sh(repoDir, 'config', 'user.email', 'person@example.com')
  sh(repoDir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repoDir, 'README.md'), 'acme\n')
  writeFileSync(join(repoDir, 'app.js'), 'export const a = 1\n')
  writeFileSync(join(repoDir, '.gitignore'), 'node_modules/\n')
  sh(repoDir, 'add', '.')
  sh(repoDir, 'commit', '--quiet', '-m', 'init')
  sh(repoDir, 'branch', 'feature/human-work')
  sh(repoDir, 'tag', 'v1')
  sh(repoDir, 'branch', 'agent/dev', 'dev')

  const raw = { version: 1, product: { name: 'acme' }, repos: [{ name: 'acme-api', compare: 'dev' }] }
  mkdirSync(join(dir, '.detent'))
  writeFileSync(join(dir, '.detent', 'product.json'), JSON.stringify(raw))
  const { product, problems } = validateProduct(raw, dir)
  assert.deepEqual(problems, [])
  return { dir, repoDir, product, repo: product.repos[0] }
}

// The invariant, as one assertion over every ref.
function assertInvariant(repoDir, before, product) {
  const after = snapshotRefs(repoDir)
  const moved = new Set()
  for (const [ref, object] of before) if (after.get(ref) !== object) moved.add(ref)
  for (const [ref] of after) if (!before.has(ref)) moved.add(ref)
  const outside = [...moved].filter((ref) => !ref.startsWith('refs/heads/agent/'))
  assert.deepEqual(outside, [], `refs moved outside refs/heads/agent/: ${outside.join(', ')}`)
  assert.equal(currentBranch(repoDir), 'agent/dev', 'the repository rests on agent/dev')
  assert.equal(operationInProgress(repoDir), null, 'git is not left in the middle of anything')
  assert.equal(isClean(repoDir), true, `the tree is clean:\n${sh(repoDir, 'status', '--short')}`)
  assert.deepEqual(readState(product.dir).repos, {}, 'state.json lists nothing as out')
  assert.equal(sh(repoDir, 'stash', 'list'), '', 'nothing was stashed')
}

function show(repoDir, rev, path) {
  return sh(repoDir, 'show', `${rev}:${path}`)
}

test('success: the work commits on its task branch, and the repository comes back', async () => {
  const { repoDir, product, repo } = fixture()
  sh(repoDir, 'switch', '--quiet', 'feature/human-work')
  const before = snapshotRefs(repoDir)

  const result = await withTask(product, repo, TASK, ({ cwd, branch }) => {
    assert.equal(currentBranch(cwd), BRANCH)
    assert.equal(branch, BRANCH)
    writeFileSync(join(cwd, 'wallet.js'), 'export const balance = 0\n')
    sh(cwd, 'add', '.')
    sh(cwd, 'commit', '--quiet', '-m', 'feat: wallet')
    return 'done'
  })

  assert.equal(result.outcome, 'returned')
  assert.equal(result.result, 'done')
  assert.equal(result.parked, null, 'nothing left to park')
  assertInvariant(repoDir, before, product)
  assert.equal(show(repoDir, BRANCH, 'wallet.js'), 'export const balance = 0')
  assert.equal(sh(repoDir, 'rev-parse', 'agent/dev'), sh(repoDir, 'rev-parse', 'dev'), 'agent/dev did not move: nothing merges here yet')
})

test('an exception: unfinished work is parked as a wip commit, and the exception still surfaces', async () => {
  const { repoDir, product, repo } = fixture()
  const before = snapshotRefs(repoDir)

  await assert.rejects(
    withTask(product, repo, TASK, ({ cwd }) => {
      writeFileSync(join(cwd, 'app.js'), 'export const a = 2\n') // modified
      rmSync(join(cwd, 'README.md')) // deleted
      writeFileSync(join(cwd, 'new.js'), 'new\n') // untracked
      mkdirSync(join(cwd, 'node_modules'))
      writeFileSync(join(cwd, 'node_modules', 'ignored.js'), '') // ignored
      sh(cwd, 'add', 'app.js') // half staged, half not
      throw new Error('quota exceeded\nstack…')
    }),
    /quota exceeded/,
  )

  assertInvariant(repoDir, before, product)
  const message = sh(repoDir, 'log', '-1', '--format=%B', BRANCH)
  assert.match(message, /^wip: task 0042 returned unfinished — the run failed: quota exceeded$/m)
  assert.match(message, /^Task: 0042$/m)
  assert.equal(show(repoDir, BRANCH, 'app.js'), 'export const a = 2')
  assert.equal(show(repoDir, BRANCH, 'new.js'), 'new')
  assert.throws(() => show(repoDir, BRANCH, 'README.md'), 'the deletion was recorded')
  assert.throws(() => show(repoDir, BRANCH, 'node_modules/ignored.js'), 'ignored files are not work')
  assert.equal(readFileSync(join(repoDir, 'README.md'), 'utf8'), 'acme\n', 'agent/dev is checked out as it was')
})

test('a merge left half-done is aborted, not resolved', async () => {
  const { repoDir, product, repo } = fixture()
  sh(repoDir, 'switch', '--quiet', 'feature/human-work')
  writeFileSync(join(repoDir, 'app.js'), 'export const a = "human"\n')
  sh(repoDir, 'commit', '--quiet', '-am', 'human change')
  sh(repoDir, 'switch', '--quiet', 'dev')
  const before = snapshotRefs(repoDir)

  await withTask(product, repo, TASK, ({ cwd }) => {
    writeFileSync(join(cwd, 'app.js'), 'export const a = "agent"\n')
    sh(cwd, 'commit', '--quiet', '-am', 'agent change')
    assert.throws(() => sh(cwd, 'merge', 'feature/human-work'), /conflict|CONFLICT|failed/i)
  })

  assertInvariant(repoDir, before, product)
  assert.equal(show(repoDir, BRANCH, 'app.js'), 'export const a = "agent"', 'the agent commit is kept, the merge is not')
})

test('a rebase left half-done is aborted', async () => {
  const { repoDir, product, repo } = fixture()
  const before = snapshotRefs(repoDir)

  await withTask(product, repo, TASK, ({ cwd }) => {
    writeFileSync(join(cwd, 'app.js'), 'export const a = 3\n')
    sh(cwd, 'commit', '--quiet', '-am', 'one')
    writeFileSync(join(cwd, 'app.js'), 'export const a = 4\n')
    sh(cwd, 'commit', '--quiet', '-am', 'two')
    assert.throws(() => sh(cwd, '-c', 'sequence.editor=true', 'rebase', '--quiet', '-x', 'false', 'HEAD~1'))
  })

  assertInvariant(repoDir, before, product)
})

test('work that wandered onto a human branch is parked on the task branch, and the human branch is untouched', async () => {
  const { repoDir, product, repo } = fixture()
  const before = snapshotRefs(repoDir)

  await withTask(product, repo, TASK, ({ cwd }) => {
    sh(cwd, 'switch', '--quiet', 'dev')
    writeFileSync(join(cwd, 'stray.js'), 'oops\n')
  })

  assertInvariant(repoDir, before, product)
  assert.equal(show(repoDir, BRANCH, 'stray.js'), 'oops')
})

test('a detached HEAD comes back', async () => {
  const { repoDir, product, repo } = fixture()
  const before = snapshotRefs(repoDir)

  await withTask(product, repo, TASK, ({ cwd }) => {
    sh(cwd, 'switch', '--quiet', '--detach', 'v1')
    writeFileSync(join(cwd, 'detached.js'), 'x\n')
  })

  assertInvariant(repoDir, before, product)
})

test('a failing pre-commit hook does not stop the work from being parked', async () => {
  const { repoDir, product, repo } = fixture()
  writeFileSync(join(repoDir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const before = snapshotRefs(repoDir)

  await withTask(product, repo, TASK, ({ cwd }) => {
    writeFileSync(join(cwd, 'app.js'), 'export const a = 5\n')
  })

  assertInvariant(repoDir, before, product)
  assert.equal(show(repoDir, BRANCH, 'app.js'), 'export const a = 5')
})

test('the gate refuses, and a refusal touches nothing', async () => {
  const cases = [
    ['a dirty tree', ({ repoDir }) => writeFileSync(join(repoDir, 'scratch.txt'), 'mine'), /working tree is not clean/],
    ['a merge in progress', ({ repoDir }) => {
      sh(repoDir, 'switch', '--quiet', 'feature/human-work')
      writeFileSync(join(repoDir, 'app.js'), 'export const a = "x"\n')
      sh(repoDir, 'commit', '--quiet', '-am', 'x')
      sh(repoDir, 'switch', '--quiet', 'dev')
      writeFileSync(join(repoDir, 'app.js'), 'export const a = "y"\n')
      sh(repoDir, 'commit', '--quiet', '-am', 'y')
      assert.throws(() => sh(repoDir, 'merge', 'feature/human-work'))
    }, /a merge is in progress/],
    ['no agent/dev', ({ repoDir }) => sh(repoDir, 'branch', '-D', 'agent/dev'), /agent\/dev does not exist — create it from your branch: git branch agent\/dev dev/],
    ['a repository already out', ({ product }) => claim(product.dir, 'acme-api', { task: '0007', branch: 'agent/task-0007-x' }), /task 0007 is already active here/],
  ]

  for (const [name, setup, reason] of cases) {
    const context = fixture()
    setup(context)
    const before = snapshotRefs(context.repoDir)
    const head = currentBranch(context.repoDir)
    const status = sh(context.repoDir, 'status', '--porcelain')
    let ran = false
    const result = await withTask(context.product, context.repo, TASK, () => {
      ran = true
    })
    assert.equal(result.outcome, 'skipped', name)
    assert.match(result.reason, reason, name)
    assert.equal(ran, false, `${name}: the work did not run`)
    assert.deepEqual(snapshotRefs(context.repoDir), before, `${name}: no ref moved`)
    assert.equal(currentBranch(context.repoDir), head, `${name}: HEAD did not move`)
    assert.equal(sh(context.repoDir, 'status', '--porcelain'), status, `${name}: the tree is as it was`)
  }
})

test('a paused task resumes on its kept branch, with the work it left there', async () => {
  const { repoDir, product, repo } = fixture()
  const before = snapshotRefs(repoDir)

  const first = await withTask(product, repo, TASK, ({ cwd, resumed }) => {
    assert.equal(resumed, false)
    writeFileSync(join(cwd, 'wallet.js'), 'half\n')
  })
  assert.equal(first.resumed, false)
  const parked = sh(repoDir, 'rev-parse', BRANCH)

  const second = await withTask(product, repo, TASK, ({ cwd, resumed }) => {
    assert.equal(resumed, true)
    assert.equal(currentBranch(cwd), BRANCH)
    assert.equal(readFileSync(join(cwd, 'wallet.js'), 'utf8'), 'half\n', 'the parked work is there to continue from')
    writeFileSync(join(cwd, 'wallet.js'), 'whole\n')
  })
  assert.equal(second.resumed, true)
  assertInvariant(repoDir, before, product)
  assert.equal(sh(repoDir, 'rev-parse', `${BRANCH}~1`), parked, 'the second attempt builds on the first')
  assert.equal(show(repoDir, BRANCH, 'wallet.js'), 'whole')
})

test('gate passes on a clean repository standing on a human branch', () => {
  const { product, repo } = fixture()
  assert.equal(gate(product, repo), null)
})

test('state.json says which repository is out while the work runs', async () => {
  const { repoDir, product, repo } = fixture()
  await withTask(product, repo, TASK, ({ setAttempt }) => {
    const entry = readState(product.dir).repos['acme-api']
    assert.equal(entry.task, '0042')
    assert.equal(entry.branch, BRANCH)
    assert.equal(entry.pid, process.pid)
    assert.equal(entry.attempt, 0)
    setAttempt(2)
    assert.equal(readState(product.dir).repos['acme-api'].attempt, 2)
  })
  assert.deepEqual(readState(product.dir).repos, {})
  assert.equal(currentBranch(repoDir), 'agent/dev')
})

test('every write path refuses a ref outside agent/, before git is called', () => {
  const { repoDir } = fixture()
  const before = snapshotRefs(repoDir)
  assert.throws(() => createBranch(repoDir, 'dev', 'agent/dev'), BoundaryError)
  assert.throws(() => createBranch(repoDir, 'agent/task-1-x', 'dev'), BoundaryError)
  assert.throws(() => forceCheckout(repoDir, 'dev'), BoundaryError)
  assert.throws(() => snapshotOnto(repoDir, 'feature/human-work', 'x'), BoundaryError)
  assert.throws(() => snapshotOnto(repoDir, 'agent', 'x'), BoundaryError)
  assert.deepEqual(snapshotRefs(repoDir), before)
})

// --- interrupts -------------------------------------------------------------

// A separate process runs a task whose work dirties the tree, says so through
// a marker file, and then waits to be interrupted.
function child(context) {
  const script = join(context.dir, 'child.mjs')
  const marker = join(context.dir, 'working')
  writeFileSync(
    script,
    `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateProduct } from ${JSON.stringify(pathToFileURL(join(root, 'core', 'product.mjs')).href)}
import { withTask } from ${JSON.stringify(pathToFileURL(join(root, 'core', 'workspace.mjs')).href)}
const { product } = validateProduct(${JSON.stringify({ version: 1, product: { name: 'acme' }, repos: [{ name: 'acme-api', compare: 'dev' }] })}, ${JSON.stringify(context.dir)})
await withTask(product, product.repos[0], ${JSON.stringify(TASK)}, async ({ cwd }) => {
  writeFileSync(join(cwd, 'half.js'), 'half done\\n')
  writeFileSync(${JSON.stringify(marker)}, '')
  await new Promise(() => setInterval(() => {}, 1000))
})
`,
  )
  const process_ = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  process_.stderr.on('data', (chunk) => (stderr += chunk))
  const exited = new Promise((resolve) => process_.on('exit', (code, signal) => resolve({ code, signal, stderr })))
  const working = (async () => {
    for (let i = 0; i < 200 && !existsSync(marker); i += 1) await new Promise((r) => setTimeout(r, 25))
    if (!existsSync(marker)) throw new Error(`the child never started its work: ${stderr}`)
  })()
  return { process: process_, exited, working }
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${signal} during the work returns the repository before the process exits`, async () => {
    const context = fixture()
    const before = snapshotRefs(context.repoDir)
    const run = child(context)
    await run.working
    run.process.kill(signal)
    const { code: exitCode, stderr } = await run.exited
    assert.equal(exitCode, code, stderr)
    assertInvariant(context.repoDir, before, context.product)
    assert.match(sh(context.repoDir, 'log', '-1', '--format=%s', BRANCH), new RegExp(`interrupted by ${signal}`))
    assert.equal(show(context.repoDir, BRANCH, 'half.js'), 'half done')
  })
}

test('after SIGKILL nothing can run, so detent recover returns the repository', async () => {
  const context = fixture()
  const before = snapshotRefs(context.repoDir)
  const run = child(context)
  await run.working
  run.process.kill('SIGKILL')
  await run.exited

  assert.equal(currentBranch(context.repoDir), BRANCH, 'the kill left it out')
  assert.ok(readState(context.dir).repos['acme-api'], 'and state.json remembers')

  const out = execFileSync(process.execPath, [join(root, 'cli.mjs'), 'recover', '--product', context.dir], { encoding: 'utf8' }).replace(/\n$/, '')
  assert.match(out, /^acme-api {2}task 0042 {2}returned to agent\/dev, work parked as [0-9a-f]{7}$/)
  assertInvariant(context.repoDir, before, context.product)
  assert.equal(show(context.repoDir, BRANCH, 'half.js'), 'half done')
  assert.match(sh(context.repoDir, 'log', '-1', '--format=%s', BRANCH), /recovered after an interrupted run/)
})

test('recover leaves alone a repository whose run is still alive', async () => {
  const context = fixture()
  const run = child(context)
  await run.working
  try {
    const report = recover(context.product)
    assert.equal(report.length, 1)
    assert.equal(report[0].action, 'left')
    assert.match(report[0].reason, /still alive/)
    assert.equal(currentBranch(context.repoDir), BRANCH)
  } finally {
    run.process.kill('SIGINT')
    await run.exited
  }
})

test('recover parks work even when the run died before its task branch existed', () => {
  const { repoDir, product } = fixture()
  const before = snapshotRefs(repoDir)
  // A run that claimed the repository, switched to agent/dev, and died before
  // creating its branch — with something already in the tree.
  claim(product.dir, 'acme-api', { task: '0042', branch: BRANCH })
  const state = JSON.parse(readFileSync(join(product.dir, '.detent', 'state.json'), 'utf8'))
  state.repos['acme-api'].pid = 2 ** 22 + 12345 // no such process
  writeFileSync(join(product.dir, '.detent', 'state.json'), JSON.stringify(state))
  sh(repoDir, 'switch', '--quiet', 'agent/dev')
  writeFileSync(join(repoDir, 'early.js'), 'x\n')

  const report = recover(product)
  assert.equal(report[0].action, 'returned')
  assertInvariant(repoDir, before, product)
  assert.equal(show(repoDir, BRANCH, 'early.js'), 'x')
  assert.equal(sh(repoDir, 'rev-parse', 'agent/dev'), sh(repoDir, 'rev-parse', 'dev'), 'agent/dev did not receive the work')
})

test('recover with nothing out says so', () => {
  const { dir } = fixture()
  const out = execFileSync(process.execPath, [join(root, 'cli.mjs'), 'recover', '--product', dir], { encoding: 'utf8' })
  assert.equal(out, 'nothing to recover: no repository is out\n')
})
