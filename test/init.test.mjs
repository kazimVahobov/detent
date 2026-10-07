import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateProduct } from '../core/product.mjs'
import { diffLines, mergeProposal, proposeProduct } from '../core/propose.mjs'
import { scanProduct } from '../core/scan.mjs'

const cli = join(import.meta.dirname, '..', 'cli.mjs')

function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function repo(product, name, { branch = 'main', files = {}, branches = [] } = {}) {
  const dir = join(product, name)
  mkdirSync(dir)
  sh(dir, 'init', '--quiet', `--initial-branch=${branch}`)
  sh(dir, 'config', 'user.name', 'P')
  sh(dir, 'config', 'user.email', 'p@x')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '--quiet', '--allow-empty', '-m', 'init')
  for (const b of branches) sh(dir, 'branch', b)
  return dir
}

// PATH with only the agents named, plus the system tools.
function withAgents(agents, fn) {
  const bin = mkdtempSync(join(tmpdir(), 'detent-agents-'))
  for (const agent of agents) {
    writeFileSync(join(bin, agent), '#!/bin/sh\n')
    chmodSync(join(bin, agent), 0o755)
  }
  const saved = process.env.PATH
  process.env.PATH = `${bin}:/usr/local/bin:/usr/bin:/bin`
  try {
    return fn(process.env.PATH)
  } finally {
    process.env.PATH = saved
  }
}

function shop() {
  const dir = join(mkdtempSync(join(tmpdir(), 'detent-init-')), 'shop')
  mkdirSync(dir)
  repo(dir, 'shop-api', {
    files: { 'package.json': JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest run', build: 'tsc' } }), 'pnpm-lock.yaml': '', 'test/a.test.ts': '' },
    branches: ['dev', 'agent/dev'],
  })
  repo(dir, 'shop-docs', { files: { 'README.md': '# docs' } })
  const web = repo(dir, 'shop-web', { branch: 'master', files: { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) } })
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', '../shop-docs', 'docs'], { cwd: web, stdio: 'ignore' })
  sh(web, 'commit', '--quiet', '-am', 'docs')
  repo(dir, 'shop-svc', { files: { 'go.mod': 'module svc\n' } })
  mkdirSync(join(dir, 'notes'))
  return dir
}

test('the scan reads what is there, and asks no model', () => {
  const dir = shop()
  const scan = withAgents(['codex'], () => scanProduct(dir))
  assert.deepEqual(scan.repos.map((r) => r.name), ['shop-api', 'shop-docs', 'shop-svc', 'shop-web'])
  assert.deepEqual(scan.other, ['notes'], 'a folder that is not a repository is noted, not adopted')
  assert.deepEqual(scan.agents, ['codex'])
  const api = scan.repos[0]
  assert.equal(api.packageManager, 'pnpm')
  assert.equal(api.shallow, false)
  assert.equal(api.clean, true)
  assert.equal(api.tests, true)
  assert.ok(api.branches.includes('agent/dev'))
  const web = scan.repos.find((r) => r.name === 'shop-web')
  assert.deepEqual(web.submodules.map((s) => s.path), ['docs'])
})

test('the proposal: compare from real branches, gauge from declared scripts, submodules as neverCommit and edges', () => {
  const dir = shop()
  const raw = withAgents(['claude', 'gemini'], () => proposeProduct(scanProduct(dir)))
  const byName = Object.fromEntries(raw.repos.map((r) => [r.name, r]))

  assert.equal(byName['shop-api'].compare, 'dev', 'dev before main')
  assert.equal(byName['shop-web'].compare, 'master')
  assert.deepEqual(byName['shop-api'].gauge, {
    exit: [
      { stage: 'lint', command: 'pnpm run lint' },
      { stage: 'typecheck', command: 'pnpm run typecheck' },
      { stage: 'test', command: 'pnpm run test' },
    ],
    merge: [{ stage: 'build', command: 'pnpm run build' }],
  })
  assert.equal(byName['shop-web'].gauge, undefined, "npm init's placeholder test checks nothing and is not proposed")
  assert.equal(byName['shop-docs'].gauge, undefined, 'nothing is guessed for a repository with no scripts')
  assert.deepEqual(byName['shop-svc'].gauge, { exit: [{ stage: 'vet', command: 'go vet ./...' }, { stage: 'test', command: 'go test ./...' }] })
  assert.deepEqual(byName['shop-svc'].stack, ['go'])
  assert.deepEqual(byName['shop-web'].neverCommit, ['docs'])
  assert.deepEqual(raw.edges, [{ from: 'shop-web', to: 'shop-docs', kind: 'submodule', source: 'scan' }])
  assert.deepEqual(raw.models, { implement: { agent: 'claude' }, accept: { agent: 'gemini' } }, 'two agents installed: two different agents')
  assert.deepEqual(validateProduct(raw, dir).problems, [])
})

test('one agent installed: no reviewer is invented; none installed: no models', () => {
  const dir = shop()
  assert.deepEqual(withAgents(['codex'], () => proposeProduct(scanProduct(dir))).models, { implement: { agent: 'codex' } })
  assert.equal(withAgents([], () => proposeProduct(scanProduct(dir))).models, undefined)
})

test('what a person wrote wins; the scan only adds', () => {
  const existing = {
    version: 1,
    product: { name: 'shop', summary: 'mine' },
    models: { implement: { agent: 'claude', model: 'x' } },
    repos: [{ name: 'shop-api', compare: 'main', role: 'the API', gauge: { exit: [{ stage: 'test', command: 'make check' }] } }, { name: 'gone', compare: 'main' }],
    edges: [],
  }
  const proposed = {
    version: 1,
    product: { name: 'shop' },
    models: { implement: { agent: 'codex' } },
    repos: [{ name: 'shop-api', compare: 'dev', stack: ['node'] }, { name: 'shop-web', compare: 'main' }],
    edges: [{ from: 'shop-web', to: 'shop-api', kind: 'submodule', source: 'scan' }],
  }
  const merged = mergeProposal(existing, proposed)
  assert.deepEqual(merged.product, { name: 'shop', summary: 'mine' })
  assert.deepEqual(merged.models, existing.models)
  assert.deepEqual(merged.repos[0], { name: 'shop-api', compare: 'main', stack: ['node'], role: 'the API', gauge: existing.repos[0].gauge })
  assert.deepEqual(merged.repos.map((r) => r.name), ['shop-api', 'gone', 'shop-web'], 'a repository the person declared is not dropped by the scan')
  assert.equal(merged.edges.length, 1)
})

test('diffLines marks what was added and removed', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nc\nd'), ['  a', '- b', '  c', '+ d'])
})

test('detent init writes product.json, then proposes rather than overwrites', () => {
  const dir = shop()
  const env = withAgents(['claude', 'codex'], (path) => ({ ...process.env, PATH: `${path}:${process.execPath.replace(/\/node$/, '')}` }))
  const init = () => execFileSync(process.execPath, [cli, 'init', '--product', dir], { encoding: 'utf8', env })

  const first = init()
  assert.match(first, /^wrote \.detent\/product\.json — 4 repositories: shop-api, shop-docs, shop-svc, shop-web$/m)
  assert.match(first, /shop-web: no gauge stages — /)
  const written = JSON.parse(readFileSync(join(dir, '.detent', 'product.json'), 'utf8'))
  assert.equal(written.repos.length, 4)

  const again = init()
  assert.match(again, /already says everything the scan found/)

  written.repos[0].role = 'the API, by hand'
  writeFileSync(join(dir, '.detent', 'product.json'), JSON.stringify(written, null, 2))
  repo(dir, 'shop-admin', { files: { Makefile: 'test:\n\tgo test ./...\n' } })
  const third = init()
  assert.match(third, /exists, so nothing was overwritten/)
  assert.match(third, /^\+ +"name": "shop-admin",$/m)
  assert.doesNotMatch(third, /^- /m, 'nothing the person wrote is proposed for removal')
  assert.equal(JSON.parse(readFileSync(join(dir, '.detent', 'product.json'), 'utf8')).repos[0].role, 'the API, by hand', 'product.json untouched')
  const proposal = JSON.parse(readFileSync(join(dir, '.detent', 'product.proposed.json'), 'utf8'))
  assert.equal(proposal.repos[0].role, 'the API, by hand')
  assert.ok(proposal.repos.some((r) => r.name === 'shop-admin'))
})

test('detent init in a folder with no repositories says what a product is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'detent-empty-'))
  let error
  try {
    execFileSync(process.execPath, [cli, 'init', '--product', dir], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    error = e
  }
  assert.equal(error.status, 1)
  assert.match(error.stderr, /no git repository directly inside/)
  assert.ok(!existsSync(join(dir, '.detent')))
})
