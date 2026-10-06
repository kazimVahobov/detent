// Whether a product is in the shape detent expects (DESIGN.md §3, §12): the
// nine conditions and the checks beyond them, from the same scan init uses.
// Every finding says what to change. Nothing is changed here — the product
// is not bent into shape by detent, it is told what does not match.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { operationInProgress } from './git.mjs'
import { PRODUCT_FILE, validateProduct } from './product.mjs'

export const OK = 'ok'
export const FAIL = 'fail'
export const LOOK = 'look'
export const INFO = 'info'

export function diagnose(dir, scan) {
  const product = []
  const repos = {}
  const say = (list, status, condition, text, fix) => list.push({ status, condition, text, ...(fix ? { fix } : {}) })

  // 9 — the machine
  const major = Number(scan.node.split('.')[0])
  const platformOk = scan.platform === 'darwin' || scan.platform === 'linux'
  say(product, platformOk && major >= 22 ? OK : FAIL, 9, `${scan.platform}, Node ${scan.node}`, platformOk ? (major >= 22 ? null : 'install Node 22 or newer') : 'detent runs on macOS or Linux')

  // The file everything else is read from.
  const file = join(dir, PRODUCT_FILE)
  if (!existsSync(file)) {
    say(product, FAIL, null, `no ${PRODUCT_FILE}`, `detent init --product ${dir}`)
    return { product, repos, loaded: false }
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    say(product, FAIL, null, `${PRODUCT_FILE} is not valid JSON: ${error.message}`)
    return { product, repos, loaded: false }
  }
  const { product: config, problems } = validateProduct(raw, dir)
  if (!config) {
    for (const problem of problems) say(product, FAIL, null, `${PRODUCT_FILE}: ${problem}`)
    return { product, repos, loaded: false }
  }
  say(product, OK, null, `${PRODUCT_FILE} is valid — every branch in it is under agent/`)

  // 6 — an agent CLI installed (and authenticated, which only a call can show)
  const roles = new Map()
  for (const repo of config.repos) {
    for (const [role, value] of Object.entries(repo.models)) roles.set(`${role}:${value.agent}`, { role, agent: value.agent })
  }
  if (![...roles.values()].some((r) => r.role === 'implement')) {
    say(product, FAIL, 6, 'no implementing agent — models.implement is not set', 'set models.implement to { "agent": "claude" | "codex" | "gemini" }')
  }
  for (const { role, agent } of roles.values()) {
    const installed = scan.agents.includes(agent)
    say(product, installed ? OK : FAIL, 6, `${agent} ${installed ? 'is installed' : 'is not on PATH'} (${role}) — whether it is signed in shows only when it runs`, installed ? null : `install ${agent}, or choose another agent for ${role}`)
  }
  for (const repo of config.repos) {
    if (repo.models.implement && !repo.models.accept) {
      say(product, LOOK, null, `${repo.name} has no acceptance pass — a green gauge will land without a second model reading the diff`, 'set models.accept to a different model')
    }
  }

  // 8 — one person per workspace: a convention, not a fact a scan can see
  say(product, INFO, 8, 'one person per workspace — detent cannot check this; it assumes it')

  // 2 — the repositories side by side in one folder
  const declared = new Set(config.repos.map((r) => r.path))
  for (const name of scan.repos.map((r) => r.name).filter((n) => !declared.has(n))) {
    say(product, LOOK, 2, `${name} is a repository in this folder and not in ${PRODUCT_FILE}`, `detent init --product ${dir} proposes it`)
  }

  for (const repo of config.repos) {
    const checks = (repos[repo.name] = [])
    const found = scan.repos.find((r) => r.path === repo.path)
    if (!found) {
      say(checks, FAIL, 2, `${repo.path} is not a git repository directly in the product folder`)
      continue
    }

    // 1 — git, not a shallow clone
    say(checks, found.shallow ? FAIL : OK, 1, found.shallow ? 'a shallow clone — history detent merges against is missing' : 'a full clone', found.shallow ? `git -C ${repo.dir} fetch --unshallow` : null)

    // The namespace (§2, §12)
    if (found.branches.includes('agent')) {
      say(checks, FAIL, null, 'a branch named exactly "agent" makes refs/heads/agent/ impossible to create', `git -C ${repo.dir} branch -m agent <another name>`)
    }
    const integration = config.branches.integration
    if (found.branches.includes(integration)) say(checks, OK, null, `${integration} exists`)
    else {
      // Creating it means naming a start point, and the start point is a
      // human branch: the command is printed, and that is as far as it goes.
      say(checks, FAIL, null, `${integration} does not exist — detent never creates it, because its start point is your branch`, `git -C ${repo.dir} branch ${integration} ${repo.compare}`)
    }

    // 3 — one human branch to be compared against
    say(checks, found.branches.includes(repo.compare) ? OK : LOOK, 3, found.branches.includes(repo.compare) ? `reported against ${repo.compare}` : `compare branch ${repo.compare} does not exist here`, found.branches.includes(repo.compare) ? null : 'set compare to a branch that exists')

    // 4 — the gauge, declared as stages
    if (repo.gauge.exit.length) say(checks, OK, 4, `gauge: ${repo.gauge.exit.map((s) => s.stage).join(', ')}${repo.gauge.merge.length ? `; merge: ${repo.gauge.merge.map((s) => s.stage).join(', ')}` : ''}`)
    else say(checks, LOOK, 4, 'no exit stages — no lock: the agent may stop whenever it likes, and the summary shows a dash', `declare gauge.exit stages, then try them with detent gauge ${repo.name}`)

    // 5 — a clean tree
    const operation = operationInProgress(repo.dir)
    if (operation) say(checks, FAIL, 5, `a ${operation} is in progress — a run skips this repository`, `finish or abort the ${operation}`)
    else say(checks, found.clean ? OK : FAIL, 5, found.clean ? 'clean tree' : 'the working tree is not clean — a run skips this repository', found.clean ? null : 'commit or discard your changes; detent never stashes them')

    // 7 — the integration branch is not deployed; pushing is by hand
    const remote = found.upstreams[integration]
    if (!found.branches.includes(integration)) {
      // Nothing to say about a branch that is not there yet.
    } else if (remote) say(checks, LOOK, 7, `${integration} tracks ${remote} — detent never pushes, so make sure nothing deploys from it`)
    else say(checks, OK, 7, `${integration} tracks no remote`)

    // Submodule pointers are never committed (§13)
    const unguarded = found.submodules.map((s) => s.path).filter((p) => !repo.neverCommit.includes(p))
    if (unguarded.length) {
      say(checks, LOOK, null, `submodule ${unguarded.join(', ')} is not in neverCommit — a moved pointer would be committed`, `add ${unguarded.map((p) => `"${p}"`).join(', ')} to neverCommit`)
    }
  }

  return { product, repos, loaded: true }
}

export function failed(report) {
  return [report.product, ...Object.values(report.repos)].flat().filter((c) => c.status === FAIL).length
}
