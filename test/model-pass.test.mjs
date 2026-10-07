// init passes 2 and 3, with the model scripted: what it is asked, how its
// answer is held to the schema, and what the scan lets through.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modelPass, parseAnswer } from '../core/model-pass.mjs'
import { proposeProduct } from '../core/propose.mjs'
import { scanProduct } from '../core/scan.mjs'
import { validateProduct } from '../core/product.mjs'
import { run as init } from '../core/commands/init.mjs'

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

function repo(dir, name, files) {
  const path = join(dir, name)
  mkdirSync(path)
  sh(path, 'init', '--quiet', '--initial-branch=main')
  sh(path, 'config', 'user.name', 'P')
  sh(path, 'config', 'user.email', 'p@x')
  for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text)
  sh(path, 'add', '-A')
  sh(path, 'commit', '--quiet', '-m', 'init')
}

function shop() {
  const dir = join(mkdtempSync(join(tmpdir(), 'detent-model-')), 'shop')
  mkdirSync(dir)
  repo(dir, 'shop-api', { 'package.json': JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }), 'README.md': '# shop-api\n\nThe REST API. Owns the orders database.\n' })
  repo(dir, 'shop-web', { 'package.json': JSON.stringify({ scripts: { e2e: 'playwright test', check: 'vitest' } }), 'README.md': '# shop-web\n\nThe storefront. Calls shop-api.\n' })
  repo(dir, 'shop-infra', { 'Makefile': 'plan:\n\tterraform plan\n', 'README.md': '# infra\n' })
  return dir
}

const scanOf = (dir) => ({ ...scanProduct(dir), agents: ['claude', 'codex'] })

function reply(message, extra = {}) {
  return { ok: true, message, model: { requested: null, actual: null }, cost: { usd: 0.02, tokens: { input: 100, output: 10 } }, session: null, error: null, ms: 1, ...extra }
}

function scripted(...messages) {
  const calls = []
  return {
    calls,
    invoke: async (role, options) => {
      calls.push({ role, ...options })
      const next = messages[calls.length - 1]
      if (next === undefined) throw new Error('no more answers')
      return typeof next === 'string' ? reply(next) : next
    },
  }
}

const GOOD = {
  repos: [
    { name: 'shop-api', role: 'The REST API; owns the orders database.', gauge: { exit: [{ stage: 'test', command: 'npm run nope' }] } },
    { name: 'shop-web', role: 'The storefront.', gauge: { exit: [{ stage: 'unit', command: 'npm run check' }, { stage: 'invented', command: 'npm run typecheck' }], merge: [{ stage: 'e2e', command: 'npm run e2e' }] } },
    { name: 'shop-infra', role: 'Terraform for the shop.', gauge: { exit: [{ stage: 'plan', command: 'make plan' }, { stage: 'fmt', command: 'make fmt' }] } },
    { name: 'shop-admin', role: 'An admin panel nobody wrote.' },
  ],
  edges: [
    { from: 'shop-web', to: 'shop-api', kind: 'api-contract' },
    { from: 'shop-web', to: 'shop-mobile', kind: 'shared-library' },
    { from: 'shop-api', to: 'shop-api', kind: 'self' },
  ],
}

test('the model is asked read-only, with the scan and the READMEs, for one JSON object', async () => {
  const dir = shop()
  const scan = scanOf(dir)
  const model = scripted(`Here it is:\n\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\``)
  await modelPass(scan, proposeProduct(scan), { invoke: model.invoke, role: { agent: 'claude' } })
  const [call] = model.calls
  assert.equal(call.readOnly, true)
  assert.equal(call.cwd, dir)
  assert.match(call.prompt, /"name": "shop-web"/)
  assert.match(call.prompt, /"scripts": \[\s*"e2e",\s*"check"\s*\]/)
  assert.match(call.prompt, /The storefront\. Calls shop-api\./, 'the README is in the prompt')
  assert.match(call.prompt, /Name only repositories that are in the scan/)
})

test('pass 3: inventions are dropped, facts beat guesses, the rest is written with its source', async () => {
  const dir = shop()
  const scan = scanOf(dir)
  const pass1 = proposeProduct(scan)
  const { proposal, report } = await modelPass(scan, pass1, { invoke: scripted(JSON.stringify(GOOD)).invoke, role: { agent: 'claude' } })
  const byName = Object.fromEntries(proposal.repos.map((r) => [r.name, r]))

  assert.equal(byName['shop-api'].role, 'The REST API; owns the orders database.')
  assert.deepEqual(byName['shop-api'].gauge, pass1.repos.find((r) => r.name === 'shop-api').gauge, 'a gauge from declared scripts is not replaced')
  assert.deepEqual(byName['shop-web'].gauge, { exit: [{ stage: 'unit', command: 'npm run check' }], merge: [{ stage: 'e2e', command: 'npm run e2e' }] })
  assert.deepEqual(byName['shop-infra'].gauge, { exit: [{ stage: 'plan', command: 'make plan' }] })
  assert.ok(!byName['shop-admin'], 'an invented repository is never written')
  assert.deepEqual(proposal.edges, [{ from: 'shop-web', to: 'shop-api', kind: 'api-contract', source: 'model' }])

  const dropped = report.dropped.join('\n')
  assert.match(dropped, /repository "shop-admin" — the scan found no such repository/)
  assert.match(dropped, /shop-web: exit stage "invented" — runs script "typecheck", which shop-web does not declare/)
  assert.match(dropped, /shop-infra: exit stage "fmt" — runs make target "fmt"/)
  assert.match(dropped, /edge shop-web → shop-mobile/)
  assert.match(dropped, /edge shop-api → shop-api — a repository does not depend on itself/)
  assert.ok(report.fromModel.includes('edge shop-web → shop-api (api-contract)'))
  assert.deepEqual(validateProduct(proposal, dir).problems, [])
})

test('an answer that does not match the schema is sent back with the problems', async () => {
  const dir = shop()
  const scan = scanOf(dir)
  const model = scripted('I think shop-api is an API.', JSON.stringify({ repos: [{ name: 'shop-api', role: '' }], notes: 'x' }), JSON.stringify({ repos: [{ name: 'shop-api', role: 'The API.' }] }))
  const { proposal, report } = await modelPass(scan, proposeProduct(scan), { invoke: model.invoke, role: { agent: 'claude' } })
  assert.equal(report.attempts, 3)
  assert.equal(report.error, null)
  assert.match(model.calls[1].prompt, /did not match the schema:\n- the answer is not one JSON object/)
  assert.match(model.calls[2].prompt, /unknown key "notes"/)
  assert.match(model.calls[2].prompt, /repos\[0\]\.role must be a non-empty string/)
  assert.equal(proposal.repos.find((r) => r.name === 'shop-api').role, 'The API.')
  assert.deepEqual(report.cost, { usd: 0.06, tokens: { input: 300, output: 30 } })
})

test('three mismatches, or a failing agent, leave pass 1 untouched', async () => {
  const dir = shop()
  const scan = scanOf(dir)
  const pass1 = proposeProduct(scan)
  const stubborn = await modelPass(scan, pass1, { invoke: scripted('no', 'no', 'no').invoke, role: { agent: 'claude' } })
  assert.deepEqual(stubborn.proposal, pass1)
  assert.match(stubborn.report.error, /did not match the schema after 3 attempts/)

  const broken = await modelPass(scan, pass1, { invoke: scripted(reply('', { ok: false, error: 'not logged in' })).invoke, role: { agent: 'gemini' } })
  assert.deepEqual(broken.proposal, pass1)
  assert.equal(broken.report.error, 'gemini failed: not logged in')
})

test('parseAnswer reads the last fenced block, or the outermost object', () => {
  assert.deepEqual(parseAnswer('x\n```json\n{"repos":[]}\n```').problems, [])
  assert.deepEqual(parseAnswer('prose {"repos": []} more').problems, [])
  assert.match(parseAnswer('{"repos": [{"name": "a", "gauge": {"nightly": []}}]}').problems.join(), /unknown profile "nightly"/)
  assert.match(parseAnswer('{"repos": [{"name": "a", "gauge": {"exit": [{"stage": "two words", "command": "x"}]}}]}').problems.join(), /exit\[0\]/)
})

// --- detent init with the model pass ----------------------------------------------

async function quietly(fn) {
  const out = []
  const write = process.stdout.write
  process.stdout.write = (chunk) => (out.push(String(chunk)), true)
  try {
    return { code: await fn(), out: out.join('') }
  } finally {
    process.stdout.write = write
  }
}

test('detent init writes what the model added, says where each field came from, and what it dropped', async () => {
  const dir = shop()
  mkdirSync(join(dir, '.detent'))
  const model = scripted(JSON.stringify(GOOD))
  writeFileSync(join(dir, '.detent', 'product.json'), JSON.stringify({ version: 1, product: { name: 'shop' }, models: { implement: { agent: 'claude' } }, repos: [{ name: 'shop-api', compare: 'main', role: 'Written by a person.' }] }, null, 2))
  const { out } = await quietly(() => init(dir, [], {}, { invoke: model.invoke }))
  assert.match(out, /asking claude what the scan cannot see/)
  assert.match(out, /from the model: shop-web: role/)
  assert.match(out, /dropped, not written: repository "shop-admin"/)
  const proposed = JSON.parse(readFileSync(join(dir, '.detent', 'product.proposed.json'), 'utf8'))
  assert.equal(proposed.repos.find((r) => r.name === 'shop-api').role, 'Written by a person.', 'a field a person wrote is never touched')
  assert.equal(proposed.repos.find((r) => r.name === 'shop-web').role, 'The storefront.')
  assert.ok(proposed.edges.some((e) => e.source === 'model'))
})

test('--no-agent stops after the scan, and asks nobody', async () => {
  const dir = shop()
  mkdirSync(join(dir, '.detent'))
  writeFileSync(join(dir, '.detent', 'product.json'), JSON.stringify({ version: 1, product: { name: 'shop' }, models: { implement: { agent: 'claude' } }, repos: [] }))
  const model = scripted()
  const { out } = await quietly(() => init(dir, [], { 'no-agent': true }, { invoke: model.invoke }))
  assert.equal(model.calls.length, 0)
  assert.match(out, /--no-agent: the scan only/)
  const proposed = JSON.parse(readFileSync(join(dir, '.detent', 'product.proposed.json'), 'utf8'))
  assert.ok(proposed.repos.every((r) => !r.role || r.name === undefined))
  assert.equal(proposed.edges.filter((e) => e.source === 'model').length, 0)
})
