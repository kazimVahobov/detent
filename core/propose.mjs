// From a scan to a product.json a person can review — and, when one already
// exists, to a proposal that keeps everything the person wrote and adds only
// what the scan found that is not there yet. The machine proposes; a person
// accepts (DESIGN.md §12).

import { basename } from 'node:path'
import { proposeCompare, proposeGauge, proposeModels } from './scan.mjs'

const STACKS = {
  'package.json': 'node',
  'Cargo.toml': 'rust',
  'go.mod': 'go',
  'pyproject.toml': 'python',
  'requirements.txt': 'python',
  'Gemfile': 'ruby',
  'pom.xml': 'java',
  'build.gradle': 'java',
  'composer.json': 'php',
}

export function proposeProduct(scan) {
  const names = new Set(scan.repos.map((r) => r.name))
  const raw = { version: 1, product: { name: basename(scan.dir) } }
  const models = proposeModels(scan.agents)
  if (models) raw.models = models

  raw.repos = scan.repos.map((repo) => {
    const entry = { name: repo.name }
    const stack = [...new Set(repo.manifests.map((m) => STACKS[m]).filter(Boolean))]
    if (stack.length) entry.stack = stack
    entry.compare = proposeCompare(repo)
    const gauge = proposeGauge(repo)
    if (Object.keys(gauge).length) entry.gauge = gauge
    // A submodule pointer moved without the submodule pushed is a reference
    // to nowhere (§13), so every submodule path starts out as neverCommit.
    if (repo.submodules.length) entry.neverCommit = repo.submodules.map((s) => s.path)
    return entry
  })

  raw.edges = scan.repos.flatMap((repo) =>
    repo.submodules
      .map((s) => basename(s.url ?? s.path).replace(/\.git$/, ''))
      .filter((target) => target !== repo.name && names.has(target))
      .map((to) => ({ from: repo.name, to, kind: 'submodule', source: 'scan' })),
  )
  return raw
}

// What a person wrote wins, field by field; the scan adds repositories and
// edges that are not there yet. A repository the person declared and the scan
// no longer finds is kept — doctor reports it, and removing it is a decision.
export function mergeProposal(existing, proposed) {
  const merged = { ...proposed, ...existing }
  const known = new Map((existing.repos ?? []).map((r) => [r.name, r]))
  merged.repos = [
    ...(existing.repos ?? []).map((repo) => ({ ...(proposed.repos.find((p) => p.name === repo.name) ?? {}), ...repo })),
    ...proposed.repos.filter((repo) => !known.has(repo.name)),
  ]
  const key = (e) => `${e.from}\u0000${e.to}\u0000${e.kind}`
  const edges = new Set((existing.edges ?? []).map(key))
  merged.edges = [...(existing.edges ?? []), ...proposed.edges.filter((e) => !edges.has(key(e)))]
  return merged
}

// Only the changed lines and `context` lines around them, gaps marked.
export function hunks(diff, context = 2) {
  const keep = diff.map((line, i) => diff.slice(Math.max(0, i - context), i + context + 1).some((l) => !l.startsWith('  ')))
  const out = []
  diff.forEach((line, i) => {
    if (keep[i]) out.push(line)
    else if (out.at(-1) !== '  …') out.push('  …')
  })
  return out
}

// A line diff of two JSON documents, for a person to read before accepting.
export function diffLines(before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`)
      i += 1
      j += 1
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push(`+ ${b[j]}`)
      j += 1
    } else {
      out.push(`- ${a[i]}`)
      i += 1
    }
  }
  return out
}
