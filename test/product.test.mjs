import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, loadProduct, validateProduct } from '../core/product.mjs'

function minimal(overrides = {}) {
  return {
    version: 1,
    product: { name: 'acme' },
    repos: [{ name: 'acme-api', compare: 'dev' }],
    ...overrides,
  }
}

function problemsOf(raw) {
  return validateProduct(raw).problems
}

function assertProblem(raw, pattern) {
  const problems = problemsOf(raw)
  assert.ok(problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}, got:\n${problems.join('\n')}`)
}

test('the shape in DESIGN.md §11, minus what is not accepted yet, loads', () => {
  const { product, problems } = validateProduct(
    {
      version: 1,
      product: { name: 'acme', summary: 'freight marketplace' },
      branches: { integration: 'agent/dev', task: 'agent/task-{id}-{slug}' },
      concurrency: 2,
      attempts: 3,
      models: { implement: 'claude-sonnet-5', accept: 'claude-opus-5' },
      repos: [
        {
          name: 'acme-api',
          path: 'acme-api',
          role: 'REST API backend, owns the database schema',
          stack: ['node', 'nestjs', 'postgres'],
          compare: 'dev',
          gauge: { exit: [{ stage: 'test', command: 'npm test' }], merge: [{ stage: 'build', command: 'npm run build' }] },
          models: { implement: 'claude-opus-5' },
          neverCommit: ['shared-docs'],
        },
        { name: 'acme-web', compare: 'main' },
      ],
      edges: [{ from: 'acme-web', to: 'acme-api', kind: 'api-contract', source: 'model' }],
    },
    '/products/acme',
  )
  assert.deepEqual(problems, [])
  assert.equal(product.repos[0].dir, '/products/acme/acme-api')
  assert.deepEqual(product.repos[0].gauge.exit, [{ stage: 'test', command: 'npm test' }])
})

test('defaults fill what a minimal file leaves out', () => {
  const { product } = validateProduct(minimal(), '/p')
  assert.deepEqual(product.branches, { integration: 'agent/dev', task: 'agent/task-{id}-{slug}' })
  assert.equal(product.concurrency, 1)
  assert.equal(product.attempts, 3)
  assert.equal(product.repos[0].path, 'acme-api', 'path defaults to the name')
  assert.deepEqual(product.repos[0].gauge, { exit: [], merge: [] }, 'no gauge is carried as empty, not refused')
})

test('a repository overrides a role, never the model as a whole', () => {
  const { product } = validateProduct(
    minimal({
      models: { implement: 'cheap', accept: 'reviewer' },
      repos: [{ name: 'acme-api', compare: 'dev', models: { implement: 'expensive' } }],
    }),
  )
  assert.deepEqual(product.repos[0].models, { implement: 'expensive', accept: 'reviewer' })
  assertProblem(minimal({ repos: [{ name: 'a', compare: 'dev', models: { review: 'x' } }] }), /repos\[0\]\.models\.review: unknown key/)
})

test('an unknown key is an error, at any depth, naming its path', () => {
  assertProblem(minimal({ concurency: 3 }), /^concurency: unknown key/)
  assertProblem(minimal({ product: { name: 'acme', owner: 'me' } }), /^product\.owner: unknown key/)
  assertProblem(minimal({ repos: [{ name: 'a', compare: 'dev', gauge: { exit: [{ stage: 't', command: 'x', timeout: 5 }] } }] }), /^repos\[0\]\.gauge\.exit\[0\]\.timeout: unknown key/)
})

test('no field in branches can name a human branch', () => {
  assertProblem(minimal({ branches: { integration: 'dev' } }), /^branches\.integration: "dev" is outside agent\//)
  assertProblem(minimal({ branches: { integration: 'agent' } }), /^branches\.integration: "agent" is outside agent\//)
  assertProblem(minimal({ branches: { integration: 'agent/' } }), /^branches\.integration: "agent\/" cannot begin or end/)
  assertProblem(minimal({ branches: { integration: 'agentdev' } }), /outside agent\//)
  assertProblem(minimal({ branches: { task: 'task-{id}-{slug}' } }), /^branches\.task: .* outside agent\//)
})

test('branch values are checked as git ref names', () => {
  for (const bad of ['agent/de v', 'agent/..', 'agent/x.lock', 'agent/a~b', 'agent//dev', 'agent/.hidden', 'agent/x@{1}']) {
    assertProblem(minimal({ branches: { integration: bad } }), /^branches\.integration: /)
  }
})

test('the task template needs {id} and knows no other placeholder', () => {
  assertProblem(minimal({ branches: { task: 'agent/task-{slug}' } }), /must contain \{id\}/)
  assertProblem(minimal({ branches: { task: 'agent/task-{id}-{name}' } }), /unknown placeholder \{name\}/)
  assert.deepEqual(problemsOf(minimal({ branches: { task: 'agent/t/{id}' } })), [])
})

test('branches.staging and gauge.promote are refused by name, pointing at step 10', () => {
  assertProblem(minimal({ branches: { staging: 'agent/staging' } }), /^branches\.staging: .*build step 10/)
  assertProblem(minimal({ repos: [{ name: 'a', compare: 'dev', gauge: { promote: [] } }] }), /^repos\[0\]\.gauge\.promote: .*build step 10/)
})

test('compare is required, and names a human branch', () => {
  assertProblem(minimal({ repos: [{ name: 'a' }] }), /^repos\[0\]\.compare: is required/)
  assertProblem(minimal({ repos: [{ name: 'a', compare: 'agent/dev' }] }), /in the agent namespace/)
  assert.deepEqual(problemsOf(minimal({ repos: [{ name: 'a', compare: 'release/2026' }] })), [])
})

test('repositories are unique by name and by path, and stay inside the product', () => {
  assertProblem(minimal({ repos: [{ name: 'a', compare: 'dev' }, { name: 'a', path: 'b', compare: 'dev' }] }), /"a" is declared twice/)
  assertProblem(minimal({ repos: [{ name: 'a', compare: 'dev' }, { name: 'b', path: 'a', compare: 'dev' }] }), /repos\[1\]\.path: "a" is declared twice/)
  assertProblem(minimal({ repos: [{ name: 'a', path: '../elsewhere', compare: 'dev' }] }), /must stay inside the product folder/)
  assertProblem(minimal({ repos: [{ name: 'a', path: '/abs', compare: 'dev' }] }), /must stay inside the product folder/)
  assertProblem(minimal({ repos: [{ name: 'has space', compare: 'dev' }] }), /repos\[0\]\.name/)
  assertProblem(minimal({ repos: [] }), /^repos: must be a non-empty array/)
})

test('gauge stages are named, unique within a profile, and carry a command', () => {
  const gauge = (exit) => minimal({ repos: [{ name: 'a', compare: 'dev', gauge: { exit } }] })
  assertProblem(gauge([{ stage: 'test', command: 'a' }, { stage: 'test', command: 'b' }]), /"test" appears twice in exit/)
  assertProblem(gauge([{ stage: 'test' }]), /exit\[0\]\.command: must be a non-empty string/)
  assertProblem(gauge([{ stage: 'unit tests', command: 'x' }]), /exit\[0\]\.stage: "unit tests"/)
  assertProblem(gauge('npm test'), /gauge\.exit: must be an array/)
})

test('concurrency cannot exceed the number of repositories', () => {
  assertProblem(minimal({ concurrency: 2 }), /^concurrency: is 2, but there are only 1 repositories/)
  assertProblem(minimal({ concurrency: 0 }), /^concurrency: must be a positive integer/)
  assertProblem(minimal({ attempts: 2.5 }), /^attempts: must be a positive integer/)
})

test('every edge names known repositories and says where it came from', () => {
  const two = [{ name: 'a', compare: 'dev' }, { name: 'b', compare: 'dev' }]
  assertProblem(minimal({ repos: two, edges: [{ from: 'a', to: 'c', kind: 'x', source: 'scan' }] }), /edges\[0\]\.to: "c" is not a repository/)
  assertProblem(minimal({ repos: two, edges: [{ from: 'a', to: 'b', kind: 'x' }] }), /edges\[0\]\.source: must be "scan" or "model"/)
  assertProblem(minimal({ repos: two, edges: [{ from: 'a', to: 'a', kind: 'x', source: 'scan' }] }), /from a repository to itself/)
})

test('every problem is reported, not just the first', () => {
  const problems = problemsOf({ version: 2, product: {}, repos: [{ name: 'a' }], extra: true })
  assert.ok(problems.length >= 4, problems.join('\n'))
})

test('loadProduct reads .detent/product.json and throws a ConfigError naming the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'detent-product-'))
  assert.throws(() => loadProduct(dir), (error) => error instanceof ConfigError && /does not exist/.test(error.problems[0]))

  mkdirSync(join(dir, '.detent'))
  writeFileSync(join(dir, '.detent', 'product.json'), '{ not json')
  assert.throws(() => loadProduct(dir), (error) => error instanceof ConfigError && /not valid JSON/.test(error.problems[0]))

  writeFileSync(join(dir, '.detent', 'product.json'), JSON.stringify(minimal({ branches: { integration: 'dev' } })))
  assert.throws(() => loadProduct(dir), (error) => error.file.endsWith(join('.detent', 'product.json')) && /branches\.integration/.test(error.message))

  writeFileSync(join(dir, '.detent', 'product.json'), JSON.stringify(minimal()))
  assert.equal(loadProduct(dir).repos[0].dir, join(dir, 'acme-api'))
})
