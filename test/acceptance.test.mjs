// Build step 11: the acceptance pass, against a real repository and gauge,
// with both agents scripted. The implementer and the reviewer are told apart
// by the read-only flag the reviewer is always called with.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { snapshotRefs } from '../core/git.mjs'
import { parseVerdict } from '../core/acceptance.mjs'
import { readJournal } from '../core/journal.mjs'
import { runTask } from '../core/run.mjs'
import { readQueue } from '../core/task.mjs'
import { assertInvariant, gitProduct, sh, show } from './support/product.mjs'

const BRANCH = 'agent/task-0042-wallet-endpoint'
const GAUGE = { exit: [{ stage: 'test', command: 'test "$(cat value.txt 2>/dev/null)" = ok' }] }
const MODELS = { implement: { agent: 'claude', model: 'claude-opus-5' }, accept: { agent: 'codex', model: 'gpt-5-codex' } }

function setup(repo = {}) {
  const s = gitProduct({ gauge: GAUGE, models: MODELS, ...repo })
  mkdirSync(join(s.dir, 'tasks', 'todo'), { recursive: true })
  writeFileSync(
    join(s.dir, 'tasks', 'todo', '0042-wallet-endpoint.md'),
    '---\nid: 0042\nrepo: acme-api\n---\n\n# Goal\n\nWallet balance.\n\n# Acceptance criteria\n\n- [ ] value.txt says ok\n\n# Out of scope\n\nTouching README.md.\n',
  )
  const [task] = readQueue(s.dir, s.product)
  return { ...s, task, before: snapshotRefs(s.repoDir) }
}

function reply(message, extra = {}) {
  return { ok: true, message, model: { requested: null, actual: null }, cost: { usd: 0.1, tokens: { input: 10, output: 1 } }, session: null, error: null, ms: 1, ...extra }
}

// Each call goes to `implement` or `review` by the read-only flag; prompts and
// flags are recorded.
function agents({ implement = [(cwd) => writeFileSync(join(cwd, 'value.txt'), 'ok\n')], review = [() => reply('Looks complete.\nVERDICT: NO DOUBTS')] } = {}) {
  const calls = { implement: [], review: [] }
  const invoke = async (role, { cwd, prompt, readOnly }) => {
    const kind = readOnly ? 'review' : 'implement'
    calls[kind].push({ role, prompt, readOnly })
    const step = (kind === 'review' ? review : implement)[calls[kind].length - 1]
    if (!step) throw new Error(`no ${kind} step ${calls[kind].length}`)
    return (await step(cwd)) ?? reply('Commit: feat(wallet): balance')
  }
  return { invoke, calls }
}

function notifier() {
  const sent = []
  return { sent, notify: (_, details) => (sent.push(details), { sent: true, via: 'test' }) }
}

test('no doubts: the machine-checked green stands, and the merge says who read it', async () => {
  const s = setup()
  const a = agents()
  const result = await runTask(s.product, s.repo, s.task, { invoke: a.invoke, notify: notifier().notify })
  assert.equal(result.outcome, 'passed')
  assert.deepEqual(result.acceptance, { verdict: 'accepted', doubts: [], cost: { usd: 0.1, tokens: { input: 10, output: 1 } } })
  assert.deepEqual(result.models.accept, { agent: 'codex', requested: 'gpt-5-codex', actual: null })
  assert.equal(result.cost.usd, 0.2, 'the review is part of what the pass cost')
  assert.match(sh(s.repoDir, 'log', '-1', '--format=%B', 'agent/dev'), /^Acceptance: codex \(gpt-5-codex\) — no doubts$/m)

  const [review] = a.calls.review
  assert.equal(review.readOnly, true)
  assert.equal(review.role.agent, 'codex')
  assert.match(review.prompt, /You cannot approve it/)
  assert.match(review.prompt, /- \[ \] value.txt says ok/)
  assert.match(review.prompt, /Touching README\.md/)
  assert.match(review.prompt, /\+ok/, 'the diff is in the prompt')
  assert.match(review.prompt, /git diff agent\/dev\.\.\.agent\/task-0042-wallet-endpoint/)
  assertInvariant(s.repoDir, s.before, s.product)
})

test('a doubt demotes: rejected, paused with the doubts on the branch, nothing lands', async () => {
  const s = setup()
  const n = notifier()
  const a = agents({
    implement: [(cwd) => (writeFileSync(join(cwd, 'value.txt'), 'ok\n'), writeFileSync(join(cwd, 'README.md'), 'changed\n'))],
    review: [() => reply('Value is right, but:\nVERDICT: DOUBTS\n- README.md was changed, which the task puts out of scope\n- no test covers the balance')],
  })
  const result = await runTask(s.product, s.repo, s.task, { invoke: a.invoke, notify: n.notify })

  assert.equal(result.outcome, 'rejected')
  assert.equal(result.merged, false)
  assert.deepEqual(result.acceptance.doubts, ['README.md was changed, which the task puts out of scope', 'no test covers the balance'])
  assert.equal(result.reason, 'the acceptance pass raised 2 doubts: README.md was changed, which the task puts out of scope; no test covers the balance')
  assert.equal(sh(s.repoDir, 'rev-parse', 'agent/dev'), sh(s.repoDir, 'rev-parse', 'dev'))
  assert.ok(existsSync(join(s.dir, 'tasks', 'hold', '0042-wallet-endpoint.md')))
  assert.match(n.sent[0].message, /rejected: the acceptance pass raised 2 doubts/)

  const parked = sh(s.repoDir, 'log', '-1', '--format=%B', BRANCH)
  assert.match(parked, /^wip\(wallet-endpoint\): rejected by the acceptance pass/)
  assert.match(parked, /^Outcome: rejected — the gauge is green and the task is not done$/m)
  assert.match(parked, /^Doubt: README\.md was changed, which the task puts out of scope$/m)
  assert.match(parked, /^Acceptance: codex \(gpt-5-codex\) — rejected$/m)
  assert.equal(show(s.repoDir, BRANCH, 'value.txt'), 'ok', 'the green work is kept for a person to read')
  assertInvariant(s.repoDir, s.before, s.product)
})

test('a rejected task resumed hands the doubts to the implementer', async () => {
  const s = setup()
  await runTask(s.product, s.repo, s.task, {
    invoke: agents({ review: [() => reply('VERDICT: DOUBTS\n- no test covers the balance')] }).invoke,
    notify: notifier().notify,
  })
  execFileSync('mv', [join(s.dir, 'tasks', 'hold', '0042-wallet-endpoint.md'), join(s.dir, 'tasks', 'todo')])
  const [task] = readQueue(s.dir, s.product).filter((t) => t.folder === 'todo')
  const a = agents({ implement: [(cwd) => writeFileSync(join(cwd, 'balance.test.js'), 'test\n')] })
  const result = await runTask(s.product, s.repo, task, { invoke: a.invoke, notify: notifier().notify })
  assert.equal(result.outcome, 'passed')
  assert.match(a.calls.implement[0].prompt, /a reviewer read the change and doubted the task was done/)
  assert.match(a.calls.implement[0].prompt, /^- no test covers the balance$/m)
})

test('a verdict detent cannot read is an error, never a pass', async () => {
  const s = setup()
  const result = await runTask(s.product, s.repo, s.task, {
    invoke: agents({ review: [() => reply('I think it is probably fine.')] }).invoke,
    notify: notifier().notify,
  })
  assert.equal(result.outcome, 'error')
  assert.equal(result.reason, 'the acceptance pass gave no verdict detent can read')
  assert.equal(result.acceptance.verdict, null)
  assert.equal(sh(s.repoDir, 'rev-parse', 'agent/dev'), sh(s.repoDir, 'rev-parse', 'dev'))
})

test('a reviewer that fails is an error', async () => {
  const s = setup()
  const result = await runTask(s.product, s.repo, s.task, {
    invoke: agents({ review: [() => reply('', { ok: false, error: 'usage limit reached' })] }).invoke,
    notify: notifier().notify,
  })
  assert.equal(result.outcome, 'error')
  assert.equal(result.reason, 'the acceptance pass failed: usage limit reached')
})

test('a reviewer that writes is caught, and what it wrote is discarded rather than parked', async () => {
  const s = setup()
  const a = agents({
    review: [
      (cwd) => {
        writeFileSync(join(cwd, 'value.txt'), 'reviewer was here\n')
        sh(cwd, 'commit', '--quiet', '-am', 'the reviewer committed')
        writeFileSync(join(cwd, 'stray.txt'), 'x\n')
        return reply('VERDICT: NO DOUBTS')
      },
    ],
  })
  const result = await runTask(s.product, s.repo, s.task, { invoke: a.invoke, notify: notifier().notify })
  assert.equal(result.outcome, 'error')
  assert.match(result.reason, /^the acceptance pass changed the repository/)
  assert.equal(show(s.repoDir, BRANCH, 'value.txt'), 'ok', 'the branch is back at the implementer\'s commit')
  assert.match(sh(s.repoDir, 'log', '-1', '--format=%B', BRANCH), /^Task: 0042$/m)
  assert.throws(() => show(s.repoDir, BRANCH, 'stray.txt'))
  assert.equal(sh(s.repoDir, 'rev-parse', 'agent/dev'), sh(s.repoDir, 'rev-parse', 'dev'))
  assertInvariant(s.repoDir, s.before, s.product)
})

test('without models.accept the pass is absent, and the gauge alone lands the task', async () => {
  const s = setup({ models: { implement: MODELS.implement } })
  const a = agents({ review: [] })
  const result = await runTask(s.product, s.repo, s.task, { invoke: a.invoke, notify: notifier().notify })
  assert.equal(result.outcome, 'passed')
  assert.equal(result.acceptance.verdict, 'absent')
  assert.equal(a.calls.review.length, 0)
  assert.match(sh(s.repoDir, 'log', '-1', '--format=%B', 'agent/dev'), /^Acceptance: none declared$/m)
})

test('summary reports how often green was not done', async () => {
  const s = setup()
  await runTask(s.product, s.repo, s.task, {
    invoke: agents({ review: [() => reply('VERDICT: DOUBTS\n- x')] }).invoke,
    notify: notifier().notify,
  })
  const out = execFileSync(process.execPath, [join(import.meta.dirname, '..', 'cli.mjs'), 'summary', '--product', s.dir], { encoding: 'utf8' })
  assert.match(out, /^green but not done: 1 of 1 green run the acceptance pass read \(100%\)$/m)
  assert.equal(readJournal(s.dir).lines[0].acceptance.verdict, 'rejected')
})

test('parseVerdict reads the last verdict line, strictly', () => {
  assert.deepEqual(parseVerdict('All good.\nVERDICT: NO DOUBTS'), { verdict: 'accepted', doubts: [] })
  assert.deepEqual(parseVerdict('**VERDICT: NO DOUBTS**'), { verdict: 'accepted', doubts: [] })
  assert.deepEqual(parseVerdict('verdict: doubts\n- a\n* b\nnot a doubt'), { verdict: 'rejected', doubts: ['a', 'b'] })
  assert.deepEqual(parseVerdict('VERDICT: DOUBTS'), { verdict: 'rejected', doubts: ['the reviewer raised a doubt and gave no reason'] })
  assert.deepEqual(parseVerdict('VERDICT: NO DOUBTS\n…on reflection:\nVERDICT: DOUBTS\n- c'), { verdict: 'rejected', doubts: ['c'] })
  assert.deepEqual(parseVerdict('No doubts at all.'), { verdict: null, doubts: [] })
  assert.deepEqual(parseVerdict('VERDICT: APPROVED'), { verdict: null, doubts: [] }, 'there is no approval to give')
  assert.deepEqual(parseVerdict(undefined), { verdict: null, doubts: [] })
})
