// detent plan, with the agent's interactive session replaced by a script that
// does what a session might: write task files, good or bad, or stray.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../core/commands/plan.mjs'
import { INTERACTIVE, planPrompt } from '../core/plan.mjs'
import { validateProduct } from '../core/product.mjs'
import { gitProduct, sh } from './support/product.mjs'

function setup() {
  const s = gitProduct({ role: 'REST API backend', stack: ['node'] }, { models: { implement: { agent: 'claude', model: 'claude-opus-5' } } })
  mkdirSync(join(s.dir, 'tasks', 'done'), { recursive: true })
  writeFileSync(join(s.dir, 'tasks', 'done', '0007-old.md'), 'landed long ago')
  return s
}

const TASK = (id, repo = 'acme-api', criteria = '- [ ] GET /wallet returns the balance') =>
  `---\nid: ${id}\nrepo: ${repo}\ntouches_contract: false\n---\n\n# Goal\n\nA wallet balance endpoint.\n\n# Acceptance criteria\n\n${criteria}\n\n# Out of scope\n\nPayments.\n`

async function plan(s, words, values, session) {
  const calls = []
  const out = []
  const write = process.stdout.write
  process.stdout.write = (chunk) => (out.push(String(chunk)), true)
  try {
    const code = await run(s.product, words, values, {
      spawnAgent: async (command, args, cwd) => {
        calls.push({ command, args, cwd })
        await session?.(cwd)
        return 0
      },
    })
    return { code, out: out.join(''), calls }
  } finally {
    process.stdout.write = write
  }
}

test('the opening: format, repositories with roles, the next free numbers, the rules, and the brief first', async () => {
  const s = setup()
  const { calls } = await plan(s, ['a', 'wallet', 'balance', 'endpoint'], {})
  const [call] = calls
  assert.equal(call.command, 'claude')
  assert.equal(call.cwd, s.dir)
  assert.deepEqual(call.args.slice(0, 4), ['--permission-mode', 'acceptEdits', '--model', 'claude-opus-5'])
  const prompt = call.args.at(-1)
  assert.match(prompt, /- acme-api — REST API backend \[node\]/)
  assert.match(prompt, /The next free numbers are 0008, 0009, 0010/, 'one past the highest in any folder')
  assert.match(prompt, /# Acceptance criteria/)
  assert.match(prompt, /touches_contract: true only when/)
  assert.match(prompt, /Write only files in tasks\/todo\//)
  assert.match(prompt, /What I want to start from:\n\na wallet balance endpoint/)
})

test('--agent picks another CLI, opened its own interactive way', async () => {
  const s = setup()
  assert.equal((await plan(s, [], { agent: 'gemini' })).calls[0].command, 'gemini')
  assert.equal(INTERACTIVE.gemini({ prompt: 'x' })[1].at(-2), '--prompt-interactive')
  assert.equal(INTERACTIVE.codex({ prompt: 'x' })[1].at(-1), 'x')
})

test('new tasks are listed, and the queue is checked as run will check it', async () => {
  const s = setup()
  const { code, out } = await plan(s, [], {}, (cwd) => {
    mkdirSync(join(cwd, 'tasks', 'todo'), { recursive: true })
    writeFileSync(join(cwd, 'tasks', 'todo', '0008-wallet-endpoint.md'), TASK('0008'))
    writeFileSync(join(cwd, 'tasks', 'todo', '0009-wallet-page.md'), TASK('0009'))
  })
  assert.equal(code, 0, out)
  assert.match(out, /^new {6}tasks\/todo\/0008-wallet-endpoint\.md$/m)
  assert.match(out, /the queue is valid: 2 tasks in todo\//)
})

test('a task that would not run is reported with its problems, and kept', async () => {
  const s = setup()
  const { code, out } = await plan(s, [], {}, (cwd) => {
    mkdirSync(join(cwd, 'tasks', 'todo'), { recursive: true })
    writeFileSync(join(cwd, 'tasks', 'todo', '0008-a.md'), TASK('0008', 'acme-web'))
    writeFileSync(join(cwd, 'tasks', 'todo', '0007-dup.md'), TASK('0007', 'acme-api', 'Works well.'))
  })
  assert.equal(code, 1)
  assert.match(out, /the queue would not run/)
  assert.match(out, /repo "acme-web" is not in product\.json/)
  assert.match(out, /has no acceptance criteria/)
  assert.match(out, /id 0007 is already taken/)
})

test('anything written besides task files in todo/ is named', async () => {
  const s = setup()
  const { code, out } = await plan(s, [], {}, (cwd) => {
    writeFileSync(join(cwd, 'acme-api', 'app.js'), 'export const a = 2\n')
    writeFileSync(join(cwd, '.detent', 'product.json'), '{}')
    writeFileSync(join(cwd, 'tasks', 'done', '0007-old.md'), 'rewritten')
  })
  assert.equal(code, 1)
  assert.match(out, /no task was written/)
  assert.match(out, /\.detent\/product\.json changed/)
  assert.match(out, /tasks\/done\/0007-old\.md changed — plan writes only/)
  assert.match(out, /acme-api's working tree changed/)
})

test('a moved ref is named', async () => {
  const s = setup()
  const { out } = await plan(s, [], {}, (cwd) => sh(join(cwd, 'acme-api'), 'branch', 'agent/sneaky'))
  assert.match(out, /a ref moved in acme-api/)
})

test('no agent to plan with is a usage error', async () => {
  const s = gitProduct()
  await assert.rejects(run(s.product, [], {}), /no agent to plan with/)
})

test('the prompt names edges and marks the proposed ones', () => {
  const { product } = validateProduct(
    {
      version: 1,
      product: { name: 'shop' },
      repos: [{ name: 'web', compare: 'main' }, { name: 'api', compare: 'main' }],
      edges: [{ from: 'web', to: 'api', kind: 'api-contract', source: 'model' }],
    },
    '/x',
  )
  assert.match(planPrompt(product, { next: ['0001'], brief: null }), /- web → api: api-contract \(proposed, unconfirmed\)/)
})
