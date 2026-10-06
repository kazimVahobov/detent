// A product folder with one repository holding a human history — dev, a
// feature branch, a tag — and agent/dev made from dev, as a person would.
// Not a test file; node --test loads it and finds nothing to run.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentBranch, git, isClean, operationInProgress, snapshotRefs } from '../../core/git.mjs'
import { validateProduct } from '../../core/product.mjs'
import { readState } from '../../core/state.mjs'

export function sh(cwd, ...args) {
  return git(cwd, args)
}

export function gitProduct(repoOverrides = {}, productOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'detent-product-'))
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

  const raw = { version: 1, product: { name: 'acme' }, repos: [{ name: 'acme-api', compare: 'dev', ...repoOverrides }], ...productOverrides }
  mkdirSync(join(dir, '.detent'))
  writeFileSync(join(dir, '.detent', 'product.json'), JSON.stringify(raw))
  const { product, problems } = validateProduct(raw, dir)
  assert.deepEqual(problems, [])
  return { dir, repoDir, product, repo: product.repos[0] }
}

// The invariant of DESIGN.md §2, as one assertion over every ref.
export function assertInvariant(repoDir, before, product) {
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

export function show(repoDir, rev, path) {
  return sh(repoDir, 'show', `${rev}:${path}`)
}
