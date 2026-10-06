// .detent/product.json — the shape in DESIGN.md §11, loaded strictly.
//
// Every problem is collected rather than the first one thrown, because the
// person fixing the file wants the whole list, and each one names its path.

import { readFileSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { isAgentBranch, refNameProblem } from './refs.mjs'

export const PRODUCT_FILE = join('.detent', 'product.json')

export const DEFAULTS = Object.freeze({
  integration: 'agent/dev',
  task: 'agent/task-{id}-{slug}',
  concurrency: 1,
  attempts: 3,
})

// Specified before they are accepted (DESIGN.md §14): until the code honours a
// field, the loader refuses it by name and says when it arrives.
const NOT_YET_BRANCHES = { staging: 'agent-side staging (DESIGN.md §7) is not accepted until build step 10' }
const NOT_YET_GAUGE = { promote: 'the promote profile (DESIGN.md §7) is not accepted until build step 10' }

const ROLES = ['implement', 'accept']
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SOURCES = new Set(['scan', 'model'])

export class ConfigError extends Error {
  constructor(file, problems) {
    super(`${file} is not usable:\n${problems.map((p) => `  ${p}`).join('\n')}`)
    this.name = 'ConfigError'
    this.file = file
    this.problems = problems
  }
}

export function loadProduct(productDir) {
  const dir = resolve(productDir)
  const file = join(dir, PRODUCT_FILE)

  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new ConfigError(file, ['does not exist — `detent init` writes it'])
    throw error
  }

  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new ConfigError(file, [`is not valid JSON: ${error.message}`])
  }

  const { product, problems } = validateProduct(raw, dir)
  if (problems.length > 0) throw new ConfigError(file, problems)
  return product
}

// Pure: the parsed JSON in, a normalised product and a list of problems out.
export function validateProduct(raw, dir = '.') {
  const problems = []
  const fail = (path, message) => problems.push(`${path}: ${message}`)

  if (!isObject(raw)) {
    fail('(root)', 'must be an object')
    return { product: null, problems }
  }

  strict(raw, '(root)', ['version', 'product', 'branches', 'concurrency', 'attempts', 'notify', 'models', 'repos', 'edges'], fail)

  if (raw.version !== 1) fail('version', `must be 1, got ${JSON.stringify(raw.version)}`)

  // product
  let name = null
  let summary = null
  if (!isObject(raw.product)) {
    fail('product', 'must be an object with a name')
  } else {
    strict(raw.product, 'product', ['name', 'summary'], fail)
    name = nonEmptyString(raw.product.name, 'product.name', fail)
    if (raw.product.summary !== undefined) summary = nonEmptyString(raw.product.summary, 'product.summary', fail)
  }

  // branches — no field can name a human branch
  const branches = { integration: DEFAULTS.integration, task: DEFAULTS.task }
  if (raw.branches !== undefined) {
    if (!isObject(raw.branches)) {
      fail('branches', 'must be an object')
    } else {
      strict(raw.branches, 'branches', ['integration', 'task'], fail, NOT_YET_BRANCHES)
      if (raw.branches.integration !== undefined) {
        branches.integration = agentBranch(raw.branches.integration, 'branches.integration', fail)
      }
      if (raw.branches.task !== undefined) {
        branches.task = taskTemplate(raw.branches.task, 'branches.task', fail)
      }
    }
  }

  // repos
  const repos = []
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
    fail('repos', 'must be a non-empty array — a product has at least one repository')
  } else {
    const names = new Set()
    const paths = new Set()
    raw.repos.forEach((entry, index) => {
      const repo = validateRepo(entry, `repos[${index}]`, fail)
      if (!repo) return
      if (repo.name !== null) {
        if (names.has(repo.name)) fail(`repos[${index}].name`, `"${repo.name}" is declared twice`)
        names.add(repo.name)
      }
      if (repo.path !== null) {
        if (paths.has(repo.path)) fail(`repos[${index}].path`, `"${repo.path}" is declared twice`)
        paths.add(repo.path)
      }
      repos.push(repo)
    })
  }

  const concurrency = positiveInteger(raw.concurrency, 'concurrency', DEFAULTS.concurrency, fail)
  // One active task per repository (§8): more slots than repositories is a
  // number that can never be reached, which is a misunderstanding worth naming.
  if (concurrency !== null && repos.length > 0 && concurrency > repos.length) {
    fail('concurrency', `is ${concurrency}, but there are only ${repos.length} repositories and one task runs per repository`)
  }

  const attempts = positiveInteger(raw.attempts, 'attempts', DEFAULTS.attempts, fail)
  const notify = raw.notify === undefined ? null : nonEmptyString(raw.notify, 'notify', fail)
  const models = validateModels(raw.models, 'models', fail) ?? {}

  // edges
  const edges = []
  if (raw.edges !== undefined) {
    if (!Array.isArray(raw.edges)) {
      fail('edges', 'must be an array')
    } else {
      const known = new Set(repos.map((repo) => repo.name))
      raw.edges.forEach((edge, index) => {
        const path = `edges[${index}]`
        if (!isObject(edge)) return fail(path, 'must be an object')
        strict(edge, path, ['from', 'to', 'kind', 'source'], fail)
        const from = nonEmptyString(edge.from, `${path}.from`, fail)
        const to = nonEmptyString(edge.to, `${path}.to`, fail)
        const kind = nonEmptyString(edge.kind, `${path}.kind`, fail)
        for (const [key, value] of [['from', from], ['to', to]]) {
          if (value !== null && !known.has(value)) fail(`${path}.${key}`, `"${value}" is not a repository in repos`)
        }
        if (from !== null && from === to) fail(path, 'an edge cannot point from a repository to itself')
        if (!SOURCES.has(edge.source)) {
          fail(`${path}.source`, `must be "scan" or "model" — a guess must never look like a fact`)
        }
        edges.push({ from, to, kind, source: edge.source })
      })
    }
  }

  if (problems.length > 0) return { product: null, problems }

  const root = resolve(dir)
  return {
    product: {
      dir: root,
      version: 1,
      name,
      summary,
      branches,
      concurrency,
      attempts,
      notify,
      models,
      repos: repos.map((repo) => ({
        ...repo,
        dir: join(root, repo.path),
        // A repository overrides a role, never "the model" (§11).
        models: { ...models, ...repo.models },
      })),
      edges,
    },
    problems,
  }
}

function validateRepo(entry, path, fail) {
  if (!isObject(entry)) {
    fail(path, 'must be an object')
    return null
  }
  strict(entry, path, ['name', 'path', 'role', 'stack', 'compare', 'gauge', 'models', 'neverCommit'], fail)

  let name = nonEmptyString(entry.name, `${path}.name`, fail)
  if (name !== null && !NAME.test(name)) {
    fail(`${path}.name`, `"${name}" must be letters, digits, ".", "_" or "-"`)
    name = null
  }

  const dirPath = entry.path === undefined ? name : relativePath(entry.path, `${path}.path`, fail)

  let role = null
  if (entry.role !== undefined) role = nonEmptyString(entry.role, `${path}.role`, fail)

  let stack = []
  if (entry.stack !== undefined) stack = stringArray(entry.stack, `${path}.stack`, fail) ?? []

  // compare is the one branch value that names a human branch, and it is only
  // ever read: it says what agent/dev is reported against (§2).
  let compare = null
  if (entry.compare === undefined) {
    fail(`${path}.compare`, 'is required — name the human branch agent/dev is reported against')
  } else if (typeof entry.compare !== 'string') {
    fail(`${path}.compare`, 'must be a branch name')
  } else {
    const problem = refNameProblem(entry.compare)
    if (problem) fail(`${path}.compare`, `"${entry.compare}" ${problem}`)
    else if (isAgentBranch(entry.compare) || entry.compare === 'agent') {
      fail(`${path}.compare`, `"${entry.compare}" is in the agent namespace — compare names a human branch`)
    } else compare = entry.compare
  }

  const gauge = validateGauge(entry.gauge, `${path}.gauge`, fail)
  const models = validateModels(entry.models, `${path}.models`, fail) ?? {}

  let neverCommit = []
  if (entry.neverCommit !== undefined) {
    if (!Array.isArray(entry.neverCommit)) fail(`${path}.neverCommit`, 'must be an array of paths')
    else neverCommit = entry.neverCommit.map((p, i) => relativePath(p, `${path}.neverCommit[${i}]`, fail))
  }

  return { name, path: dirPath, role, stack, compare, gauge, models, neverCommit }
}

// A repository that declares no gauge gets no lock (§6). It is not refused —
// the absence is carried forward so the journal can say so.
function validateGauge(gauge, path, fail) {
  const result = { exit: [], merge: [] }
  if (gauge === undefined) return result
  if (!isObject(gauge)) {
    fail(path, 'must be an object of profiles')
    return result
  }
  strict(gauge, path, ['exit', 'merge'], fail, NOT_YET_GAUGE)
  for (const profile of ['exit', 'merge']) {
    const stages = gauge[profile]
    if (stages === undefined) continue
    if (!Array.isArray(stages)) {
      fail(`${path}.${profile}`, 'must be an array of { stage, command }')
      continue
    }
    const seen = new Set()
    stages.forEach((entry, index) => {
      const at = `${path}.${profile}[${index}]`
      if (!isObject(entry)) return fail(at, 'must be { stage, command }')
      strict(entry, at, ['stage', 'command'], fail)
      const stage = nonEmptyString(entry.stage, `${at}.stage`, fail)
      const command = nonEmptyString(entry.command, `${at}.command`, fail)
      if (stage !== null && !NAME.test(stage)) {
        // The stage name goes into commit trailers and the journal verbatim.
        return fail(`${at}.stage`, `"${stage}" must be letters, digits, ".", "_" or "-"`)
      }
      if (stage !== null && seen.has(stage)) return fail(`${at}.stage`, `"${stage}" appears twice in ${profile}`)
      if (stage !== null) seen.add(stage)
      if (stage !== null && command !== null) result[profile].push({ stage, command })
    })
  }
  return result
}

function validateModels(models, path, fail) {
  if (models === undefined) return null
  if (!isObject(models)) {
    fail(path, `must be an object of roles: ${ROLES.join(', ')}`)
    return null
  }
  strict(models, path, ROLES, fail)
  const result = {}
  for (const role of ROLES) {
    if (models[role] === undefined) continue
    const model = nonEmptyString(models[role], `${path}.${role}`, fail)
    if (model !== null) result[role] = model
  }
  return result
}

function agentBranch(value, path, fail) {
  if (typeof value !== 'string') {
    fail(path, 'must be a branch name')
    return null
  }
  const problem = refNameProblem(value)
  if (problem) {
    fail(path, `"${value}" ${problem}`)
    return null
  }
  if (!isAgentBranch(value)) {
    fail(path, `"${value}" is outside agent/ — no field in branches can name a human branch`)
    return null
  }
  return value
}

function taskTemplate(value, path, fail) {
  if (typeof value !== 'string') {
    fail(path, 'must be a branch name template')
    return null
  }
  const unknown = [...value.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).filter((key) => key !== 'id' && key !== 'slug')
  if (unknown.length > 0) {
    fail(path, `unknown placeholder ${unknown.map((k) => `{${k}}`).join(', ')} — only {id} and {slug} exist`)
    return null
  }
  if (!value.includes('{id}')) {
    // The number is the key (§4); without it two tasks with one slug collide.
    fail(path, 'must contain {id}')
    return null
  }
  // Checked as the branch it produces, since that is what git will see.
  const sample = value.replaceAll('{id}', '0001').replaceAll('{slug}', 'sample')
  const problem = refNameProblem(sample)
  if (problem) {
    fail(path, `"${value}" ${problem}`)
    return null
  }
  if (!isAgentBranch(sample)) {
    fail(path, `"${value}" is outside agent/ — no field in branches can name a human branch`)
    return null
  }
  return value
}

function relativePath(value, path, fail) {
  if (typeof value !== 'string' || value === '') {
    fail(path, 'must be a relative path')
    return null
  }
  const clean = normalize(value).split(sep).join('/').replace(/\/$/, '')
  if (isAbsolute(value) || clean === '.' || clean === '..' || clean.startsWith('../')) {
    fail(path, `"${value}" must stay inside the product folder`)
    return null
  }
  return clean
}

function strict(object, path, allowed, fail, notYet = {}) {
  for (const key of Object.keys(object)) {
    if (allowed.includes(key)) continue
    const field = `${path === '(root)' ? '' : `${path}.`}${key}`
    if (Object.hasOwn(notYet, key)) fail(field, notYet[key])
    else fail(field, `unknown key — expected one of ${allowed.join(', ')}`)
  }
}

function nonEmptyString(value, path, fail) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(path, 'must be a non-empty string')
    return null
  }
  return value
}

function stringArray(value, path, fail) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    fail(path, 'must be an array of non-empty strings')
    return null
  }
  return value
}

function positiveInteger(value, path, fallback, fail) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    fail(path, `must be a positive integer, got ${JSON.stringify(value)}`)
    return null
  }
  return value
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
