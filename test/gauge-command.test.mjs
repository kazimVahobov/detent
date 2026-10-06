import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cli = join(import.meta.dirname, '..', 'cli.mjs')

function product(repos) {
  const dir = mkdtempSync(join(tmpdir(), 'detent-gauge-cmd-'))
  mkdirSync(join(dir, '.detent'))
  for (const repo of repos) mkdirSync(join(dir, repo.name))
  writeFileSync(join(dir, '.detent', 'product.json'), JSON.stringify({ version: 1, product: { name: 'acme' }, repos }))
  return dir
}

function detent(dir, ...args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [cli, 'gauge', '--product', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (error) {
    return { code: error.status, out: `${error.stdout}${error.stderr}` }
  }
}

const green = { name: 'acme-api', compare: 'dev', gauge: { exit: [{ stage: 'lint', command: 'true' }, { stage: 'test', command: 'true' }] } }
const red = {
  name: 'acme-web',
  compare: 'dev',
  gauge: {
    exit: [{ stage: 'lint', command: 'true' }, { stage: 'test', command: 'echo "expected 2, got 3"; exit 1' }, { stage: 'e2e', command: 'true' }],
    merge: [{ stage: 'build', command: 'true' }],
  },
}
const bare = { name: 'acme-docs', compare: 'main' }

test('green everywhere exits 0 and lists every stage', () => {
  const { code, out } = detent(product([green]))
  assert.equal(code, 0)
  assert.match(out, /^acme-api {2}exit {2}green$/m)
  assert.match(out, /^ {2}✓ lint {2}\d+ms$/m)
  assert.match(out, /^ {2}✓ test {2}/m)
})

test('a red stage exits 1, shows what the agent would be handed, and marks what never ran', () => {
  const { code, out } = detent(product([green, red]))
  assert.equal(code, 1)
  assert.match(out, /^acme-web {2}exit {2}red$/m)
  assert.match(out, /^ {2}✗ test /m)
  assert.match(out, /^ {2}· e2e {2}not run$/m)
  assert.match(out, /exit code 1/)
  assert.match(out, /│ expected 2, got 3/)
})

test('no stages is no lock, and is not counted as green', () => {
  const { code, out } = detent(product([bare]))
  assert.equal(code, 0)
  assert.match(out, /^acme-docs {2}no exit stages declared — no lock$/m)
  assert.doesNotMatch(out, /green/)
})

test('named repositories and the merge profile', () => {
  const dir = product([green, red, bare])
  const { code, out } = detent(dir, 'acme-web', '--profile', 'merge')
  assert.equal(code, 0)
  assert.match(out, /^acme-web {2}merge {2}green$/m)
  assert.doesNotMatch(out, /acme-api/)
})

test('usage errors exit 2 in one line', () => {
  const dir = product([green])
  const unknown = detent(dir, 'acme-nope')
  assert.equal(unknown.code, 2)
  assert.match(unknown.out, /not in product\.json: acme-nope/)
  const profile = detent(dir, '--profile', 'promote')
  assert.equal(profile.code, 2)
  assert.match(profile.out, /unknown profile "promote"/)
})
