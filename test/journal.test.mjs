import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendJournal, byModel, byRepo, readJournal, summarise } from '../core/journal.mjs'

const cli = join(import.meta.dirname, '..', 'cli.mjs')

function line(overrides = {}) {
  return {
    kind: 'task',
    task: '0001',
    repo: 'acme-api',
    outcome: 'passed',
    attempts: 1,
    lock: 'enforced',
    models: { implement: { agent: 'claude', requested: 'claude-opus-5', actual: 'claude-opus-5' } },
    cost: { usd: 0.4, tokens: { input: 1000, output: 100 } },
    ...overrides,
  }
}

function product(lines, raw = '') {
  const dir = mkdtempSync(join(tmpdir(), 'detent-journal-'))
  mkdirSync(join(dir, '.detent'))
  writeFileSync(join(dir, '.detent', 'product.json'), JSON.stringify({ version: 1, product: { name: 'acme' }, repos: [{ name: 'acme-api', compare: 'dev' }, { name: 'acme-web', compare: 'dev' }] }))
  for (const l of lines) appendJournal(dir, l)
  if (raw) appendFileSync(join(dir, 'runs', 'journal.jsonl'), raw)
  return dir
}

function summary(dir, ...args) {
  return execFileSync(process.execPath, [cli, 'summary', '--product', dir, ...args], { encoding: 'utf8' })
}

test('appending writes one line per run, and never touches the lines before it', () => {
  const dir = product([line({ task: '0001' })])
  const first = readFileSync(join(dir, 'runs', 'journal.jsonl'), 'utf8')
  appendJournal(dir, line({ task: '0002' }))
  const both = readFileSync(join(dir, 'runs', 'journal.jsonl'), 'utf8')
  assert.ok(both.startsWith(first))
  assert.equal(both.split('\n').filter(Boolean).length, 2)
  assert.deepEqual(readJournal(dir).lines.map((l) => l.task), ['0001', '0002'])
})

test('kind is never defaulted', () => {
  const dir = product([])
  assert.throws(() => appendJournal(dir, line({ kind: undefined })), /needs a kind/)
})

test('lines that cannot be read are counted, not fatal', () => {
  const dir = product([line()], '{"kind":"task"\nnot json\n{"no":"kind"}\n\n')
  const { lines, unreadable } = readJournal(dir)
  assert.equal(lines.length, 1)
  assert.equal(unreadable, 3)
  assert.match(summary(dir), /3 journal lines could not be read/)
})

test('pass rate, attempts per run and cost per pass — every attempt of every run counted', () => {
  const [api] = summarise(
    [
      line({ outcome: 'passed', attempts: 1, cost: { usd: 0.4, tokens: null } }),
      line({ outcome: 'passed', attempts: 2, cost: { usd: 0.8, tokens: null } }),
      line({ outcome: 'escalated', attempts: 3, cost: { usd: 1.2, tokens: null } }),
      line({ outcome: 'skipped', attempts: 0, cost: { usd: null, tokens: null } }),
    ],
    byRepo,
  )
  assert.equal(api.runs, 3, 'a skipped run is not a run')
  assert.equal(api.passed, 2)
  assert.equal(api.passRate, 2 / 3)
  assert.equal(api.attemptsPerRun, 2)
  assert.ok(Math.abs(api.costPerPass.usd - 1.2) < 1e-9, 'the failed run is paid for by the passes')
  assert.deepEqual(api.outcomes, { escalated: 1 })
})

test('no gauge: no pass rate', () => {
  const [row] = summarise([line({ lock: 'absent' }), line()], byRepo)
  assert.equal(row.passRate, null)
})

test('dollars only where every run reported them; tokens otherwise', () => {
  const [mixed] = summarise([line(), line({ cost: { usd: null, tokens: { input: 900, output: 100 } } })], byRepo)
  assert.deepEqual(mixed.costPerPass, { tokens: 1050 })
  const [none] = summarise([line({ cost: { usd: null, tokens: null } })], byRepo)
  assert.equal(none.costPerPass, null)
})

test('grouped by agent and the model that actually ran', () => {
  const rows = summarise(
    [
      line(),
      line({ models: { implement: { agent: 'codex', requested: 'gpt-5-codex', actual: null } } }),
      line({ models: { implement: { agent: 'gemini', requested: null, actual: 'gemini-3-pro' } } }),
    ],
    byModel,
  )
  assert.deepEqual(rows.map((r) => r.name).sort(), ['claude claude-opus-5', 'codex gpt-5-codex', 'gemini gemini-3-pro'])
})

test('detent summary prints both tables and says what it left out', () => {
  const dir = product([
    line({ repo: 'acme-api', outcome: 'passed', attempts: 1 }),
    line({ repo: 'acme-api', outcome: 'escalated', attempts: 3, cost: { usd: 1.2, tokens: null } }),
    line({ repo: 'acme-web', outcome: 'passed', attempts: 2, lock: 'absent', models: { implement: { agent: 'codex', requested: null, actual: null } }, cost: { usd: null, tokens: { input: 4000, output: 1000 } } }),
    line({ repo: 'acme-web', outcome: 'skipped', attempts: 0 }),
    { kind: 'promote', repo: 'acme-api', outcome: 'passed' },
  ])
  const out = summary(dir)
  assert.match(out, /^repository +runs +passed +pass rate +attempts\/run +cost\/pass +not passed$/m)
  assert.match(out, /^acme-api +2 +1 +50% +2\.0 +\$1\.60 +escalated 1$/m)
  assert.match(out, /^acme-web +1 +1 +— +2\.0 +5,000 tok +—$/m)
  assert.match(out, /^claude claude-opus-5 +2 +1 +50%/m)
  assert.match(out, /^codex \(default\) +1 +1 +—/m)
  assert.match(out, /1 run was skipped by the gate, and not counted/)
  assert.match(out, /1 promotion line is not summarised yet \(build step 10\)/)

  const one = summary(dir, '--repo', 'acme-web')
  assert.doesNotMatch(one, /acme-api/)
})

test('an empty journal says so', () => {
  assert.equal(summary(product([])), "no task runs in acme's journal yet\n")
})
