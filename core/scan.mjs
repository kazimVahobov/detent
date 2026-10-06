// The deterministic scan: what is in a product folder, read from files and git
// and nothing else (DESIGN.md §12, init pass 1). `init` writes product.json
// from it; `doctor` checks the nine conditions with it. Facts should not be
// guessed at by something that can be wrong, so nothing here asks a model.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import process from 'node:process'
import { isAgentBranch } from './refs.mjs'

export const AGENT_COMMANDS = { claude: 'claude', codex: 'codex', gemini: 'gemini' }

// Human branches a repository is commonly reported against, in order of
// preference: the integration branch before the released one.
const COMPARE_CANDIDATES = ['dev', 'develop', 'development', 'main', 'master', 'trunk']

const LOCKFILES = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
  'package-lock.json': 'npm',
  'Cargo.lock': 'cargo',
  'go.sum': 'go',
  'poetry.lock': 'poetry',
  'uv.lock': 'uv',
}

const MANIFESTS = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Makefile', 'Gemfile', 'pom.xml', 'build.gradle', 'composer.json']

const SKIP = new Set(['.detent', 'tasks', 'runs', 'node_modules', '.git'])

export function scanProduct(dir) {
  const repos = []
  const other = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (isGitRoot(path)) repos.push(scanRepo(path, entry.name))
    else other.push(entry.name)
  }
  return { dir, repos, other, agents: installedAgents(), platform: process.platform, node: process.versions.node }
}

export function scanRepo(dir, name = basename(dir)) {
  const branches = lines(git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']))
  const scripts = packageScripts(dir)
  const lockfiles = Object.keys(LOCKFILES).filter((file) => existsSync(join(dir, file)))
  return {
    name,
    path: name,
    shallow: git(dir, ['rev-parse', '--is-shallow-repository']) === 'true',
    current: git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null,
    clean: git(dir, ['status', '--porcelain=v1', '--untracked-files=all']) === '',
    branches,
    remotes: remotes(dir),
    upstreams: upstreams(dir),
    submodules: submodules(dir),
    manifests: MANIFESTS.filter((file) => existsSync(join(dir, file))),
    lockfiles,
    packageManager: lockfiles.map((file) => LOCKFILES[file])[0] ?? (scripts ? 'npm' : null),
    scripts: scripts ?? {},
    makeTargets: makeTargets(dir),
    tests: hasTests(dir),
  }
}

// --- what the scan proposes ---------------------------------------------------

export function proposeCompare(repo) {
  return COMPARE_CANDIDATES.find((name) => repo.branches.includes(name)) ?? repo.branches.find((b) => !isAgentBranch(b) && b !== 'agent') ?? null
}

// Stages from scripts a repository already declares (ADR 0003: discovery is
// good enough to propose, where a person reviews the result, and not to run
// unattended). Nothing is invented for a repository that declares nothing.
export function proposeGauge(repo) {
  const exit = []
  const merge = []
  const run = (script) => runScript(repo.packageManager, script)
  const scripts = repo.scripts

  const pick = (names) => names.find((n) => typeof scripts[n] === 'string' && !isPlaceholder(scripts[n]))
  const lint = pick(['lint'])
  const typecheck = pick(['typecheck', 'type-check', 'types', 'tsc'])
  const test = pick(['test', 'test:unit'])
  const build = pick(['build'])
  if (lint) exit.push({ stage: 'lint', command: run(lint) })
  if (typecheck) exit.push({ stage: 'typecheck', command: run(typecheck) })
  if (test) exit.push({ stage: 'test', command: run(test) })
  if (build) merge.push({ stage: 'build', command: run(build) })

  if (exit.length === 0) {
    if (repo.manifests.includes('Cargo.toml')) exit.push({ stage: 'test', command: 'cargo test' })
    else if (repo.manifests.includes('go.mod')) exit.push({ stage: 'vet', command: 'go vet ./...' }, { stage: 'test', command: 'go test ./...' })
    else if (repo.makeTargets.includes('test')) {
      if (repo.makeTargets.includes('lint')) exit.push({ stage: 'lint', command: 'make lint' })
      exit.push({ stage: 'test', command: 'make test' })
    }
  }

  const gauge = {}
  if (exit.length) gauge.exit = exit
  if (merge.length) gauge.merge = merge
  return gauge
}

// Agents for the two roles from the CLIs that are installed: a different agent
// for the review when there is one, since the reviewer must differ (ADR 0004).
// With one CLI only, the review is left out rather than given a guessed model.
export function proposeModels(agents) {
  const [implement, accept] = agents
  if (!implement) return undefined
  return accept ? { implement: { agent: implement }, accept: { agent: accept } } : { implement: { agent: implement } }
}

// --- reading -------------------------------------------------------------------

function installedAgents() {
  return Object.entries(AGENT_COMMANDS)
    .filter(([, command]) => spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0)
    .map(([agent]) => agent)
}

function isGitRoot(dir) {
  // The folder itself, not a folder inside some other repository.
  return existsSync(join(dir, '.git')) && git(dir, ['rev-parse', '--show-prefix']) === ''
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

function lines(text) {
  return text.split('\n').filter(Boolean)
}

function remotes(dir) {
  return lines(git(dir, ['remote', '-v']))
    .filter((line) => line.endsWith('(fetch)'))
    .map((line) => {
      const [name, url] = line.split(/\s+/)
      return { name, url }
    })
}

// Which local branches track a remote, as { branch: remote }.
function upstreams(dir) {
  const result = {}
  for (const line of lines(git(dir, ['config', '--get-regexp', '^branch\\..*\\.remote$']))) {
    const [key, remote] = line.split(' ')
    result[key.slice('branch.'.length, -'.remote'.length)] = remote
  }
  return result
}

function submodules(dir) {
  if (!existsSync(join(dir, '.gitmodules'))) return []
  const out = git(dir, ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url)$'])
  const byName = {}
  for (const line of lines(out)) {
    const [key, value] = [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]
    const match = /^submodule\.(.+)\.(path|url)$/.exec(key)
    if (!match) continue
    byName[match[1]] ??= {}
    byName[match[1]][match[2]] = value
  }
  return Object.values(byName).filter((s) => s.path)
}

function packageScripts(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts : {}
  } catch {
    return null
  }
}

function makeTargets(dir) {
  try {
    const text = readFileSync(join(dir, 'Makefile'), 'utf8')
    return [...text.matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)/gm)].map((m) => m[1])
  } catch {
    return []
  }
}

function hasTests(dir) {
  for (const name of ['test', 'tests', '__tests__', 'spec']) {
    try {
      if (statSync(join(dir, name)).isDirectory()) return true
    } catch {}
  }
  const tracked = lines(git(dir, ['ls-files']))
  return tracked.some((file) => /(^|\/)(test_[^/]*\.py|[^/]*_test\.(go|py)|[^/]*\.(test|spec)\.[cm]?[jt]sx?)$/.test(file))
}

// `npm init` writes a test script that only fails; it checks nothing.
function isPlaceholder(command) {
  return /no test specified/i.test(command)
}

function runScript(manager, script) {
  switch (manager) {
    case 'pnpm':
      return `pnpm run ${script}`
    case 'yarn':
      return `yarn ${script}`
    case 'bun':
      return `bun run ${script}`
    default:
      return script === 'test' ? 'npm test' : `npm run ${script}`
  }
}
