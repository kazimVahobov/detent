// init passes 2 and 3 (DESIGN.md §12): a model answers what the scan cannot —
// what each repository is for, which relations are real, what a repository
// with nothing declared should be checked with — forced to a schema; then its
// answer is checked against the scan, and what it invented is dropped rather
// than written, because a gap is visible and an invention is not.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const ATTEMPTS = 3
const README_LIMIT = 4000
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// Pass 2 and 3 over a pass-1 proposal. Returns the enriched proposal and an
// account of what came from the model and what was dropped. Never throws for
// anything the model does: a model that cannot be understood leaves pass 1.
export async function modelPass(scan, proposal, { invoke, role, timeoutMs = 10 * 60_000 }) {
  const report = { agent: role.agent, attempts: 0, fromModel: [], dropped: [], error: null, cost: { usd: null, tokens: null } }
  const prompt = modelPrompt(scan, proposal)
  let feedback = null

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    report.attempts = attempt
    const answer = await invoke(role, {
      cwd: scan.dir,
      readOnly: true,
      timeoutMs,
      prompt: feedback ? `${prompt}\n\nYour previous answer did not match the schema:\n${feedback.map((p) => `- ${p}`).join('\n')}\n\nAnswer again with one JSON object that does.\n` : prompt,
    })
    addCost(report.cost, answer.cost)
    if (!answer.ok) {
      report.error = `${role.agent} failed: ${answer.error}`
      return { proposal, report }
    }
    const { value, problems } = parseAnswer(answer.message)
    if (problems.length === 0) return { proposal: apply(scan, proposal, value, report), report }
    feedback = problems
  }
  report.error = `the model's answer did not match the schema after ${ATTEMPTS} attempts: ${feedback.join('; ')}`
  return { proposal, report }
}

export function modelPrompt(scan, proposal) {
  const skeleton = scan.repos.map((repo) => {
    const proposed = proposal.repos.find((r) => r.name === repo.name)
    return {
      name: repo.name,
      manifests: repo.manifests,
      packageManager: repo.packageManager,
      scripts: Object.keys(repo.scripts),
      makeTargets: repo.makeTargets,
      hasTests: repo.tests,
      submodules: repo.submodules.map((s) => s.path),
      gaugeFromScripts: proposed?.gauge ?? null,
    }
  })
  const readmes = scan.repos
    .map((repo) => {
      const text = readme(join(scan.dir, repo.path))
      return text ? `### ${repo.name}/README\n\n${text}` : `### ${repo.name}\n\n(no README)`
    })
    .join('\n\n')

  return `You are helping describe a software product made of several git repositories that sit side by side in this folder. A deterministic scan has already read the facts below. Answer only what a scan cannot know. You may read the repositories, but do not change anything.

The scan:

\`\`\`json
${JSON.stringify({ product: proposal.product.name, repos: skeleton, edgesFromScan: proposal.edges }, null, 2)}
\`\`\`

${readmes}

Answer with exactly one JSON object, and nothing after it, of this shape:

{
  "repos": [
    {
      "name": "<a repository name from the scan>",
      "role": "<one sentence: what this repository is for>",
      "gauge": { "exit": [{ "stage": "<name>", "command": "<shell command>" }], "merge": [] }
    }
  ],
  "edges": [{ "from": "<repository>", "to": "<repository>", "kind": "<e.g. api-contract, shared-library, deploys>" }]
}

Rules:
- Name only repositories that are in the scan.
- "gauge" only for a repository whose gaugeFromScripts is null, and only with commands that already work there — scripts and make targets it declares, or its language's standard test command. Fast checks go in "exit", slow ones in "merge". Leave "gauge" out rather than guess.
- An edge says one repository depends on another in a way a change can break: a client calling an API, a library used by an app. Leave out what the scan already lists.
`
}

// The answer is the last JSON object in the message, fenced or not.
export function parseAnswer(message) {
  const problems = []
  const text = message ?? ''
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1])
  const candidates = fenced.length ? fenced.reverse() : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]
  let value = null
  for (const candidate of candidates) {
    try {
      value = JSON.parse(candidate)
      break
    } catch {}
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { value: null, problems: ['the answer is not one JSON object'] }
  }

  for (const key of Object.keys(value)) if (key !== 'repos' && key !== 'edges') problems.push(`unknown key "${key}"`)
  if (!Array.isArray(value.repos)) problems.push('"repos" must be an array')
  else {
    value.repos.forEach((repo, i) => {
      const at = `repos[${i}]`
      if (!repo || typeof repo !== 'object') return problems.push(`${at} must be an object`)
      for (const key of Object.keys(repo)) if (!['name', 'role', 'gauge'].includes(key)) problems.push(`${at}: unknown key "${key}"`)
      if (typeof repo.name !== 'string' || !repo.name) problems.push(`${at}.name must be a string`)
      if (repo.role !== undefined && (typeof repo.role !== 'string' || !repo.role.trim())) problems.push(`${at}.role must be a non-empty string`)
      if (repo.gauge !== undefined) {
        if (!repo.gauge || typeof repo.gauge !== 'object' || Array.isArray(repo.gauge)) return problems.push(`${at}.gauge must be an object`)
        for (const profile of Object.keys(repo.gauge)) {
          if (!['exit', 'merge'].includes(profile)) problems.push(`${at}.gauge: unknown profile "${profile}"`)
          else if (!Array.isArray(repo.gauge[profile])) problems.push(`${at}.gauge.${profile} must be an array`)
          else {
            repo.gauge[profile].forEach((s, j) => {
              if (!s || typeof s.stage !== 'string' || !NAME.test(s.stage) || typeof s.command !== 'string' || !s.command.trim()) {
                problems.push(`${at}.gauge.${profile}[${j}] must be { "stage": letters, digits, ".", "_" or "-", "command": a shell command }`)
              }
            })
          }
        }
      }
    })
  }
  if (value.edges !== undefined) {
    if (!Array.isArray(value.edges)) problems.push('"edges" must be an array')
    else {
      value.edges.forEach((e, i) => {
        if (!e || typeof e.from !== 'string' || typeof e.to !== 'string' || typeof e.kind !== 'string' || !e.kind.trim()) {
          problems.push(`edges[${i}] must be { "from", "to", "kind" }, all strings`)
        }
      })
    }
  }
  return { value: problems.length ? null : value, problems }
}

// Pass 3: what the scan does not support is dropped; what it does fills only
// what pass 1 left empty. Facts beat guesses.
function apply(scan, proposal, answer, report) {
  const byName = new Map(scan.repos.map((r) => [r.name, r]))
  const result = structuredClone(proposal)

  for (const proposed of answer.repos) {
    const facts = byName.get(proposed.name)
    if (!facts) {
      report.dropped.push(`repository "${proposed.name}" — the scan found no such repository`)
      continue
    }
    const entry = result.repos.find((r) => r.name === proposed.name)
    if (proposed.role && !entry.role) {
      entry.role = proposed.role.trim().slice(0, 300)
      report.fromModel.push(`${entry.name}: role`)
    }
    if (proposed.gauge && !entry.gauge) {
      const gauge = {}
      for (const profile of ['exit', 'merge']) {
        const kept = []
        const seen = new Set()
        for (const stage of proposed.gauge[profile] ?? []) {
          const invented = inventedTarget(stage.command, facts)
          if (invented) report.dropped.push(`${entry.name}: ${profile} stage "${stage.stage}" — ${invented}`)
          else if (seen.has(stage.stage)) report.dropped.push(`${entry.name}: ${profile} stage "${stage.stage}" — named twice`)
          else {
            seen.add(stage.stage)
            kept.push({ stage: stage.stage, command: stage.command.trim() })
          }
        }
        if (kept.length) gauge[profile] = kept
      }
      if (Object.keys(gauge).length) {
        entry.gauge = gauge
        report.fromModel.push(`${entry.name}: gauge ${[...(gauge.exit ?? []), ...(gauge.merge ?? [])].map((s) => s.stage).join(', ')}`)
      }
    }
  }

  const key = (e) => `${e.from}\u0000${e.to}`
  const known = new Set(result.edges.map(key))
  for (const edge of answer.edges ?? []) {
    if (!byName.has(edge.from) || !byName.has(edge.to)) {
      report.dropped.push(`edge ${edge.from} → ${edge.to} — the scan found no such repository`)
    } else if (edge.from === edge.to) {
      report.dropped.push(`edge ${edge.from} → ${edge.to} — a repository does not depend on itself`)
    } else if (!known.has(key(edge))) {
      known.add(key(edge))
      // Labelled with where it came from, so a guess never looks like a fact.
      result.edges.push({ from: edge.from, to: edge.to, kind: edge.kind.trim(), source: 'model' })
      report.fromModel.push(`edge ${edge.from} → ${edge.to} (${edge.kind.trim()})`)
    }
  }
  return result
}

// A command that runs a script or make target the repository does not declare
// is an invention the scan can prove; anything else is left for a person.
function inventedTarget(command, facts) {
  const script = /^(?:npm\s+run|npm|pnpm\s+run|pnpm|yarn\s+run|yarn|bun\s+run)\s+([\w:.-]+)/.exec(command.trim())
  const builtin = ['install', 'i', 'ci', 'exec', 'dlx', 'x', 'add']
  if (script && !builtin.includes(script[1]) && !Object.hasOwn(facts.scripts, script[1])) {
    return `runs script "${script[1]}", which ${facts.name} does not declare`
  }
  const make = /^make\s+([\w.-]+)/.exec(command.trim())
  if (make && !facts.makeTargets.includes(make[1])) return `runs make target "${make[1]}", which ${facts.name} does not declare`
  return null
}

function readme(dir) {
  for (const name of ['README.md', 'README', 'readme.md', 'Readme.md']) {
    try {
      const text = readFileSync(join(dir, name), 'utf8')
      return text.length > README_LIMIT ? `${text.slice(0, README_LIMIT)}\n[…]` : text
    } catch {}
  }
  return null
}

function addCost(total, cost) {
  if (!cost) return
  if (typeof cost.usd === 'number') total.usd = Math.round(((total.usd ?? 0) + cost.usd) * 1e6) / 1e6
  if (cost.tokens) total.tokens = { input: (total.tokens?.input ?? 0) + cost.tokens.input, output: (total.tokens?.output ?? 0) + cost.tokens.output }
}
