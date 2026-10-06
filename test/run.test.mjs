// Build step 4: one task from its file to a commit on its task branch. The
// agent is scripted — each attempt is a function that edits the working tree
// the way an agent would and returns what invoke() returns — so what is tested
// is detent's loop, against a real git repository and a real gauge.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotRefs } from '../core/git.mjs'
import { readQueue } from '../core/task.mjs'
import { runTask } from '../core/run.mjs'
import { assertInvariant, gitProduct, sh, show } from './support/product.mjs'

const BRANCH = 'agent/task-0042-wallet-endpoint'
// Green when value.txt says "ok".
const GAUGE = { exit: [{ stage: 'lint', command: 'true' }, { stage: 'test', command: 'test "$(cat value.txt 2>/dev/null)" = ok || { echo "value is $(cat value.txt 2>/dev/null)"; exit 1; }' }] }

function setup(repo = {}, productOverrides = {}) {
  const context = gitProduct({ gauge: GAUGE, models: { implement: { agent: 'claude', model: 'claude-opus-5' } }, ...repo }, productOverrides)
  mkdirSync(join(context.dir, 'tasks', 'todo'), { recursive: true })
  writeFileSync(
    join(context.dir, 'tasks', 'todo', '0042-wallet-endpoint.md'),
    '---\nid: 0042\nrepo: acme-api\n---\n\n# Goal\n\nWallet balance.\n\n# Acceptance criteria\n\n- [ ] value.txt says ok\n',
  )
  const [task] = readQueue(context.dir, context.product)
  return { ...context, task, before: snapshotRefs(context.repoDir) }
}

function answer(message = 'Done.\nCommit: feat(wallet): balance endpoint', extra = {}) {
  return { agent: 'claude', ok: true, message, model: { requested: 'claude-opus-5', actual: 'claude-opus-5' }, cost: { usd: 0.25, tokens: { input: 1000, output: 100 } }, session: 's', error: null, ms: 10, ...extra }
}

// An agent that runs `steps` in order, one per attempt, and records its prompts.
function agent(...steps) {
  const prompts = []
  const invoke = async (role, { cwd, prompt }) => {
    prompts.push(prompt)
    const step = steps[prompts.length - 1]
    if (!step) throw new Error(`no step for attempt ${prompts.length}`)
    return (await step(cwd)) ?? answer()
  }
  return { invoke, prompts }
}

const write = (value) => (cwd) => writeFileSync(join(cwd, 'value.txt'), `${value}\n`)

function notifier() {
  const sent = []
  return { sent, notify: (product, details) => (sent.push(details), { sent: true, via: 'test' }) }
}

test('green on the first attempt: one commit on the task branch, the task done, agent/dev untouched', async () => {
  const s = setup()
  const a = agent(write('ok'))
  const n = notifier()
  const result = await runTask(s.product, s.repo, s.task, { invoke: a.invoke, notify: n.notify })

  assert.equal(result.outcome, 'committed')
  assert.equal(result.attempts, 1)
  assert.equal(result.lock, 'enforced')
  assert.equal(result.branch, BRANCH)
  assert.equal(result.commit, sh(s.repoDir, 'rev-parse', BRANCH))
  assert.deepEqual(result.models.implement, { agent: 'claude', requested: 'claude-opus-5', actual: 'claude-opus-5' })
  assert.deepEqual(result.cost, { usd: 0.25, tokens: { input: 1000, output: 100 } })
  assert.equal(result.kind, 'task')
  assert.ok(result.started <= result.finished)

  assert.equal(sh(s.repoDir, 'log', '-1', '--format=%B', BRANCH), 'feat(wallet): balance endpoint\n\nTask: 0042\nGauge: lint ✓ test ✓ (1 attempt)\nAgent: claude (claude-opus-5)')
  assert.equal(show(s.repoDir, BRANCH, 'value.txt'), 'ok')
  assert.equal(sh(s.repoDir, 'rev-list', '--count', `agent/dev..${BRANCH}`), '1')
  assertInvariant(s.repoDir, s.before, s.product)
  assert.equal(sh(s.repoDir, 'rev-parse', 'agent/dev'), sh(s.repoDir, 'rev-parse', 'dev'), 'merging is step 5')
  assert.ok(existsSync(join(s.dir, 'tasks', 'done', '0042-wallet-endpoint.md')))
  assert.deepEqual(n.sent, [])
})

test('the prompt carries the task, the rules, and the gauge it is held to', async () => {
  const s = setup()
  const a = agent(write('ok'))
  await runTask(s.product, s.repo, s.task, { invoke: a.invoke, notify: notifier().notify })
  const [prompt] = a.prompts
  assert.match(prompt, /task 0042 in the repository "acme-api"/)
  assert.match(prompt, /The branch agent\/task-0042-wallet-endpoint is checked out/)
  assert.match(prompt, /Do not switch branches, commit, merge, rebase, stash or push/)
  assert.match(prompt, / {4}lint: true\n/)
  assert.match(prompt, /# Acceptance criteria\n\n- \[ \] value.txt says ok/)
  assert.doesNotMatch(prompt, /^id: 0042$/m, 'the frontmatter is bookkeeping, not prompt')
  assert.match(prompt, /Commit: feat\(wallet\)/)
  assert.doesNotMatch(prompt, /Attempt \d of/)
})

test('red, then green: the retry is handed the failed stage and its output', async () => {
  const s = setup()
  const a = agent(write('nearly'), write('ok'))
  const result = await runTask(s.product, s.repo, s.task, { invoke: a.invoke, notify: notifier().notify })
  assert.equal(result.outcome, 'committed')
  assert.equal(result.attempts, 2)
  assert.deepEqual(result.cost, { usd: 0.5, tokens: { input: 2000, output: 200 } }, 'cost is per pass, every attempt counted')
  assert.match(a.prompts[1], /Attempt 2 of 3\. Your previous attempt did not leave the gauge green\./)
  assert.match(a.prompts[1], /stage "test"/)
  assert.match(a.prompts[1], /value is nearly/)
  assert.match(sh(s.repoDir, 'log', '-1', '--format=%B', BRANCH), /^Gauge: lint ✓ test ✓ \(2 attempts\)$/m)
  assertInvariant(s.repoDir, s.before, s.product)
})

test('red on the last attempt: paused in hold/, work parked with its outcome, the developer told', async () => {
  const s = setup()
  const a = agent(write('no'), write('no'), write('no'))
  const n = notifier()
  const result = await runTask(s.product, s.repo, s.task, { invoke: a.invoke, notify: n.notify })

  assert.equal(result.outcome, 'escalated')
  assert.equal(result.reason, '3 identical failures on test')
  assert.equal(result.attempts, 3)
  assert.equal(result.gauge.failedStage, 'test')
  assert.equal(result.commit, null)
  assert.equal(a.prompts.length, 3, 'no fourth attempt')
  assert.ok(existsSync(join(s.dir, 'tasks', 'hold', '0042-wallet-endpoint.md')))
  assert.ok(!existsSync(join(s.dir, 'tasks', 'todo', '0042-wallet-endpoint.md')))

  assert.equal(n.sent.length, 1)
  assert.equal(n.sent[0].outcome, 'escalated')
  assert.equal(n.sent[0].branch, BRANCH)
  assert.match(n.sent[0].message, /task 0042 \(acme-api\) is paused — escalated: 3 identical failures on test/)
  assert.match(n.sent[0].message, /move tasks\/hold\/0042-wallet-endpoint\.md back to todo\//)

  assert.equal(
    sh(s.repoDir, 'log', '-1', '--format=%B', BRANCH),
    'wip(wallet-endpoint): attempt 3, gauge red on test\n\nTask: 0042\nGauge: lint ✓ test ✗\nOutcome: escalated — 3 identical failures on test\nAgent: claude (claude-opus-5)',
  )
  assert.equal(show(s.repoDir, BRANCH, 'value.txt'), 'no')
  assertInvariant(s.repoDir, s.before, s.product)
})

test('a paused task moved back to todo/ resumes on its branch, and the agent is told', async () => {
  const s = setup()
  await runTask(s.product, s.repo, s.task, { invoke: agent(write('no'), write('no'), write('no')).invoke, notify: notifier().notify })
  const parked = sh(s.repoDir, 'rev-parse', BRANCH)
  execFileSync('mv', [join(s.dir, 'tasks', 'hold', '0042-wallet-endpoint.md'), join(s.dir, 'tasks', 'todo')])

  const [task] = readQueue(s.dir, s.product).filter((t) => t.folder === 'todo')
  const a = agent((cwd) => {
    assert.equal(readFileSync(join(cwd, 'value.txt'), 'utf8'), 'no\n', 'the parked work is in the tree')
    write('ok')(cwd)
  })
  const result = await runTask(s.product, s.repo, task, { invoke: a.invoke, notify: notifier().notify })
  assert.equal(result.outcome, 'committed')
  assert.equal(result.resumed, true)
  assert.match(a.prompts[0], /This task was paused and is being resumed/)
  assert.equal(sh(s.repoDir, 'rev-parse', `${BRANCH}~1`), parked)
  assertInvariant(s.repoDir, s.before, s.product)
})

test('an agent error pauses the task, keeps the work and says why', async () => {
  const s = setup()
  const n = notifier()
  const a = agent((cwd) => {
    write('half')(cwd)
    return answer('', { ok: false, error: 'usage limit reached', cost: { usd: 0.1, tokens: null } })
  })
  const result = await runTask(s.product, s.repo, s.task, { invoke: a.invoke, notify: n.notify })
  assert.equal(result.outcome, 'error')
  assert.equal(result.reason, 'the agent failed: usage limit reached')
  assert.equal(result.cost.usd, 0.1, 'a failed attempt still cost what it cost')
  assert.match(sh(s.repoDir, 'log', '-1', '--format=%B', BRANCH), /^Outcome: error — the agent failed: usage limit reached$/m)
  assert.equal(show(s.repoDir, BRANCH, 'value.txt'), 'half')
  assert.equal(n.sent[0].outcome, 'error')
  assertInvariant(s.repoDir, s.before, s.product)
})

test('green with nothing changed is not a pass', async () => {
  const s = setup({ gauge: { exit: [{ stage: 'test', command: 'true' }] } })
  const result = await runTask(s.product, s.repo, s.task, { invoke: agent(() => {}).invoke, notify: notifier().notify })
  assert.equal(result.outcome, 'error')
  assert.equal(result.reason, 'the gauge is green but the agent changed nothing')
  assert.equal(sh(s.repoDir, 'rev-parse', BRANCH), sh(s.repoDir, 'rev-parse', 'agent/dev'), 'no empty commit left behind')
  assertInvariant(s.repoDir, s.before, s.product)
})

test('an agent that committed its own work still gets detent\'s commit, with the trailers', async () => {
  const s = setup()
  const a = agent((cwd) => {
    write('ok')(cwd)
    sh(cwd, 'add', '.')
    sh(cwd, 'commit', '--quiet', '-m', 'my own message')
  })
  const result = await runTask(s.product, s.repo, s.task, { invoke: a.invoke, notify: notifier().notify })
  assert.equal(result.outcome, 'committed')
  assert.match(sh(s.repoDir, 'log', '-1', '--format=%B', BRANCH), /^Task: 0042$/m)
  assert.equal(sh(s.repoDir, 'log', '-1', '--format=%s', `${BRANCH}~1`), 'my own message')
})

test('an agent that commits to agent/dev has it restored, and its commits kept on a branch of their own', async () => {
  const s = setup()
  const devTip = sh(s.repoDir, 'rev-parse', 'agent/dev')
  const a = agent((cwd) => {
    sh(cwd, 'switch', '--quiet', 'agent/dev')
    write('ok')(cwd)
    sh(cwd, 'add', '.')
    sh(cwd, 'commit', '--quiet', '-m', 'straight onto integration')
  })
  const result = await runTask(s.product, s.repo, s.task, { invoke: a.invoke, notify: notifier().notify })
  assert.equal(result.outcome, 'error')
  assert.match(result.reason, /the agent committed to agent\/dev; it is restored, and those commits are kept on agent\/task-0042-wallet-endpoint-stray/)
  assert.equal(sh(s.repoDir, 'rev-parse', 'agent/dev'), devTip)
  assert.equal(sh(s.repoDir, 'log', '-1', '--format=%s', `${BRANCH}-stray`), 'straight onto integration')
  assertInvariant(s.repoDir, s.before, s.product)
})

test('an agent that moves a human branch is named, and the branch is not touched by detent', async () => {
  const s = setup()
  const a = agent((cwd) => {
    write('ok')(cwd)
    sh(cwd, 'commit', '--quiet', '-am', 'x', '--allow-empty')
    sh(cwd, 'branch', '--force', 'feature/human-work', 'HEAD')
  })
  const result = await runTask(s.product, s.repo, s.task, { invoke: a.invoke, notify: notifier().notify })
  assert.equal(result.outcome, 'error')
  assert.match(result.reason, /the agent moved refs\/heads\/feature\/human-work — detent does not write outside agent\/, so this is left for you/)
  assert.equal(sh(s.repoDir, 'log', '-1', '--format=%s', 'feature/human-work'), 'x', 'still where the agent left it: not ours to move back')
})

test('neverCommit paths are left out of the commit', async () => {
  const s = setup({ neverCommit: ['shared-docs'] })
  const a = agent((cwd) => {
    write('ok')(cwd)
    mkdirSync(join(cwd, 'shared-docs'))
    writeFileSync(join(cwd, 'shared-docs', 'pointer'), 'moved\n')
  })
  const result = await runTask(s.product, s.repo, s.task, { invoke: a.invoke, notify: notifier().notify })
  assert.equal(result.outcome, 'committed')
  assert.equal(show(s.repoDir, BRANCH, 'value.txt'), 'ok')
  assert.throws(() => show(s.repoDir, BRANCH, 'shared-docs/pointer'))
  assert.match(a.prompts[0], /Do not change "shared-docs"/)
  assertInvariant(s.repoDir, s.before, s.product)
})

test('no gauge: committed with lock absent, never called green', async () => {
  const s = setup({ gauge: undefined })
  const a = agent(write('anything'))
  const result = await runTask(s.product, s.repo, s.task, { invoke: a.invoke, notify: notifier().notify })
  assert.equal(result.outcome, 'committed')
  assert.equal(result.lock, 'absent')
  assert.match(sh(s.repoDir, 'log', '-1', '--format=%B', BRANCH), /^Gauge: no gauge declared \(1 attempt\)$/m)
  assert.match(a.prompts[0], /declares no gauge, so nothing checks your work/)
})

test('a malformed Commit: line falls back to a subject detent writes', async () => {
  const s = setup()
  const a = agent((cwd) => (write('ok')(cwd), answer('I did it.\nCommit: Fixed stuff.')))
  await runTask(s.product, s.repo, s.task, { invoke: a.invoke, notify: notifier().notify })
  assert.equal(sh(s.repoDir, 'log', '-1', '--format=%s', BRANCH), 'feat: task 0042, wallet endpoint')
})

test('a gate refusal skips the task and leaves it in todo/', async () => {
  const s = setup()
  writeFileSync(join(s.repoDir, 'scratch.txt'), 'mine')
  const a = agent()
  const result = await runTask(s.product, s.repo, s.task, { invoke: a.invoke, notify: notifier().notify })
  assert.equal(result.outcome, 'skipped')
  assert.match(result.reason, /not clean/)
  assert.equal(a.prompts.length, 0)
  assert.ok(existsSync(join(s.dir, 'tasks', 'todo', '0042-wallet-endpoint.md')))
})

// --- detent run, end to end, with a fake Claude Code on PATH -----------------

test('detent run works the queue with a real CLI process standing in for the agent', () => {
  const s = setup()
  mkdirSync(join(s.dir, 'tasks', 'hold'))
  const bin = mkdtempSync(join(tmpdir(), 'detent-bin-'))
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh
cat > /dev/null
echo ok > value.txt
printf '%s' '${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Commit: feat(wallet): from the cli', total_cost_usd: 0.3, usage: { input_tokens: 5, output_tokens: 7 }, modelUsage: { 'claude-opus-5': { outputTokens: 7 } }, session_id: 'x' })}'
`,
  )
  chmodSync(join(bin, 'claude'), 0o755)
  const out = execFileSync(process.execPath, [join(import.meta.dirname, '..', 'cli.mjs'), 'run', '--product', s.dir], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  assert.match(out, /^0042 {2}committed on agent\/task-0042-wallet-endpoint \([0-9a-f]{7}\), 1 attempt, \$0\.30$/m)
  assert.equal(sh(s.repoDir, 'log', '-1', '--format=%s', BRANCH), 'feat(wallet): from the cli')
  assertInvariant(s.repoDir, s.before, s.product)
})

test('detent run refuses to start when a repository has no implementing agent', () => {
  const s = setup({ models: undefined })
  let error
  try {
    execFileSync(process.execPath, [join(import.meta.dirname, '..', 'cli.mjs'), 'run', '--product', s.dir], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    error = e
  }
  assert.equal(error.status, 2)
  assert.match(error.stderr, /no implementing agent for acme-api — set models\.implement/)
  assert.deepEqual(snapshotRefs(s.repoDir), s.before)
})
