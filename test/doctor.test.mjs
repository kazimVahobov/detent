import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAIL, INFO, LOOK, OK, diagnose, failed } from '../core/doctor.mjs'
import { scanProduct } from '../core/scan.mjs'

const cli = join(import.meta.dirname, '..', 'cli.mjs')
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

function repo(dir, name, { branches = ['agent/dev'], files = { 'a.txt': 'a\n' } } = {}) {
  const path = join(dir, name)
  mkdirSync(path)
  sh(path, 'init', '--quiet', '--initial-branch=dev')
  sh(path, 'config', 'user.name', 'P')
  sh(path, 'config', 'user.email', 'p@x')
  for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text)
  sh(path, 'add', '-A')
  sh(path, 'commit', '--quiet', '-m', 'init')
  for (const b of branches) sh(path, 'branch', b)
  return path
}

function product(raw, build) {
  const dir = mkdtempSync(join(tmpdir(), 'detent-doctor-'))
  build?.(dir)
  if (raw) {
    mkdirSync(join(dir, '.detent'))
    writeFileSync(join(dir, '.detent', 'product.json'), typeof raw === 'string' ? raw : JSON.stringify(raw))
  }
  return dir
}

// A scan as if the given agents were installed, on this machine.
function scan(dir, agents = ['claude', 'codex']) {
  return { ...scanProduct(dir), agents }
}

const healthy = {
  version: 1,
  product: { name: 'acme' },
  models: { implement: { agent: 'claude' }, accept: { agent: 'codex' } },
  repos: [{ name: 'api', compare: 'dev', gauge: { exit: [{ stage: 'test', command: 'true' }] } }],
}

function find(checks, pattern) {
  return checks.find((c) => pattern.test(c.text))
}

test('a product in shape: nothing fails', () => {
  const dir = product(healthy, (d) => repo(d, 'api'))
  const report = diagnose(dir, scan(dir))
  assert.equal(failed(report), 0)
  const api = report.repos.api
  for (const condition of [1, 3, 4, 5, 7]) assert.equal(api.find((c) => c.condition === condition)?.status, OK, `condition ${condition}`)
  assert.equal(report.product.find((c) => c.condition === 9).status, OK)
  assert.equal(report.product.find((c) => c.condition === 8).status, INFO, 'one person per workspace cannot be checked, and says so')
  assert.equal(report.product.filter((c) => c.condition === 6).every((c) => c.status === OK), true)
})

test('no agent/dev: the command to create it, from the compare branch, and nothing more', () => {
  const dir = product(healthy, (d) => repo(d, 'api', { branches: [] }))
  const check = find(diagnose(dir, scan(dir)).repos.api, /agent\/dev does not exist/)
  assert.equal(check.status, FAIL)
  assert.equal(check.fix, `git -C ${join(dir, 'api')} branch agent/dev dev`)
  assert.deepEqual(sh(join(dir, 'api'), 'branch', '--list', 'agent/*'), '', 'doctor created nothing')
})

test('a branch named exactly agent fails', () => {
  const dir = product(healthy, (d) => {
    const path = repo(d, 'api', { branches: [] })
    sh(path, 'branch', 'agent')
  })
  assert.equal(find(diagnose(dir, scan(dir)).repos.api, /named exactly "agent"/).status, FAIL)
})

test('a shallow clone, a dirty tree and a merge in progress fail', () => {
  const dir = product(
    { ...healthy, repos: [...healthy.repos, { name: 'web', compare: 'dev' }, { name: 'mid', compare: 'dev' }] },
    (d) => {
      const origin = repo(d, 'origin', { files: { 'a.txt': '1\n' } })
      writeFileSync(join(origin, 'a.txt'), '2\n')
      sh(origin, 'commit', '--quiet', '-am', 'two')
      execFileSync('git', ['clone', '--quiet', '--depth=1', `file://${origin}`, join(d, 'api')])
      execFileSync('git', ['-C', join(d, 'api'), 'branch', 'agent/dev'])
      const web = repo(d, 'web')
      writeFileSync(join(web, 'scratch.txt'), 'mine')
      const mid = repo(d, 'mid', { files: { 'f.txt': 'base\n' } })
      sh(mid, 'switch', '--quiet', '-c', 'other')
      writeFileSync(join(mid, 'f.txt'), 'other\n')
      sh(mid, 'commit', '--quiet', '-am', 'other')
      sh(mid, 'switch', '--quiet', 'dev')
      writeFileSync(join(mid, 'f.txt'), 'dev\n')
      sh(mid, 'commit', '--quiet', '-am', 'dev')
      assert.throws(() => sh(mid, 'merge', 'other'))
    },
  )
  const report = diagnose(dir, scan(dir))
  assert.equal(report.repos.api.find((c) => c.condition === 1).status, FAIL)
  assert.match(report.repos.api.find((c) => c.condition === 1).fix, /fetch --unshallow/)
  assert.equal(report.repos.web.find((c) => c.condition === 5).status, FAIL)
  assert.match(report.repos.mid.find((c) => c.condition === 5).text, /a merge is in progress/)
  assert.ok(find(report.product, /origin is a repository in this folder and not in/), 'an undeclared repository is worth a look')
})

test('worth a look: no gauge, no reviewer, a submodule outside neverCommit, agent/dev tracking a remote', () => {
  const dir = product(
    { ...healthy, models: { implement: { agent: 'claude' } }, repos: [{ name: 'api', compare: 'dev' }] },
    (d) => {
      repo(d, 'docs')
      const api = repo(d, 'api')
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', '../docs', 'docs'], { cwd: api, stdio: 'ignore' })
      sh(api, 'commit', '--quiet', '-m', 'docs')
      sh(api, 'remote', 'add', 'origin', 'https://example.com/api.git')
      sh(api, 'config', 'branch.agent/dev.remote', 'origin')
    },
  )
  const report = diagnose(dir, scan(dir))
  const api = report.repos.api
  assert.equal(api.find((c) => c.condition === 4).status, LOOK)
  assert.equal(find(api, /submodule docs is not in neverCommit/).status, LOOK)
  assert.equal(api.find((c) => c.condition === 7).status, LOOK)
  assert.equal(find(report.product, /api has no acceptance pass/).status, LOOK)
  assert.equal(failed(report), 0, 'none of these stops a run')
})

test('an agent that is not installed fails condition 6', () => {
  const dir = product(healthy, (d) => repo(d, 'api'))
  const report = diagnose(dir, scan(dir, ['claude']))
  const codex = report.product.find((c) => c.condition === 6 && /codex/.test(c.text))
  assert.equal(codex.status, FAIL)
})

test('no product.json, or a broken one, is reported with the way out', () => {
  const none = product(null, (d) => repo(d, 'api'))
  const missing = diagnose(none, scan(none))
  assert.equal(missing.loaded, false)
  assert.equal(find(missing.product, /no \.detent\/product\.json/).fix, `detent init --product ${none}`)

  const broken = product({ ...healthy, branches: { integration: 'dev' } }, (d) => repo(d, 'api'))
  assert.match(find(diagnose(broken, scan(broken)).product, /branches\.integration/).text, /outside agent\//)
})

test('detent doctor exits 1 on a failure, 0 when ready, and writes nothing', () => {
  const dir = product(healthy, (d) => repo(d, 'api', { branches: [] }))
  const bin = mkdtempSync(join(tmpdir(), 'detent-agents-'))
  for (const agent of ['claude', 'codex']) {
    writeFileSync(join(bin, agent), '#!/bin/sh\n')
    chmodSync(join(bin, agent), 0o755)
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
  const before = readdirSync(dir).map((f) => `${f}:${statSync(join(dir, f)).mtimeMs}`)
  let error
  try {
    execFileSync(process.execPath, [cli, 'doctor', '--product', dir], { encoding: 'utf8', stdio: 'pipe', env })
  } catch (e) {
    error = e
  }
  assert.equal(error.status, 1)
  assert.match(error.stdout, /^ {2}✗ +agent\/dev does not exist/m)
  assert.match(error.stdout, /^ +→ git -C .* branch agent\/dev dev$/m)
  assert.match(error.stdout, /1 to change/)
  assert.deepEqual(readdirSync(dir).map((f) => `${f}:${statSync(join(dir, f)).mtimeMs}`), before)

  sh(join(dir, 'api'), 'branch', 'agent/dev')
  const out = execFileSync(process.execPath, [cli, 'doctor', '--product', dir], { encoding: 'utf8', env })
  assert.match(out, /^ready/m)
})

test('staging: a promote gauge with no staging fails, a declared staging must exist', () => {
  const promote = { exit: [{ stage: 'test', command: 'true' }], promote: [{ stage: 'e2e', command: 'true' }] }
  const orphan = product({ ...healthy, repos: [{ name: 'api', compare: 'dev', gauge: promote }] }, (d) => repo(d, 'api'))
  assert.equal(find(diagnose(orphan, scan(orphan)).repos.api, /gauge\.promote is declared but there is no branches\.staging/).status, FAIL)

  const missing = product({ ...healthy, branches: { staging: 'agent/staging' }, repos: [{ name: 'api', compare: 'dev', gauge: promote }] }, (d) => repo(d, 'api'))
  const check = find(diagnose(missing, scan(missing)).repos.api, /agent\/staging does not exist/)
  assert.equal(check.status, FAIL)
  assert.equal(check.fix, `git -C ${join(missing, 'api')} branch agent/staging agent/dev`)

  const ready = product({ ...healthy, branches: { staging: 'agent/staging' }, repos: [{ name: 'api', compare: 'dev', gauge: promote }] }, (d) => repo(d, 'api', { branches: ['agent/dev', 'agent/staging'] }))
  const report = diagnose(ready, scan(ready))
  assert.equal(failed(report), 0)
  assert.match(find(report.repos.api, /agent\/staging exists/).text, /promote: e2e/)
})
