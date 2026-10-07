// detent init — scan the product folder and write product.json (DESIGN.md §12):
// the deterministic scan, a model pass for what the scan cannot see, and a
// check of the model's answer against the scan. Re-running it proposes a diff
// rather than overwriting what a person wrote.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { PRODUCT_FILE, validateProduct } from '../product.mjs'
import { diffLines, hunks, mergeProposal, proposeProduct } from '../propose.mjs'
import { invoke as defaultInvoke } from '../agents.mjs'
import { modelPass } from '../model-pass.mjs'
import { scanProduct } from '../scan.mjs'
import { UsageError } from './usage.mjs'

export const options = { 'no-agent': { type: 'boolean', default: false } }
export const needsProduct = false

export const PROPOSED_FILE = join('.detent', 'product.proposed.json')

export async function run(dir, _positionals = [], values = {}, { invoke = defaultInvoke } = {}) {
  const root = resolve(dir)
  if (!existsSync(root)) throw new UsageError(`${root} does not exist`)
  const scan = scanProduct(root)
  if (scan.repos.length === 0) {
    process.stderr.write(`detent init: no git repository directly inside ${root} — a product is a folder of repositories side by side\n`)
    return 1
  }

  const file = join(root, PRODUCT_FILE)
  const exists = existsSync(file)
  const existing = exists ? JSON.parse(readFileSync(file, 'utf8')) : null

  // Pass 1, the scan; then passes 2 and 3 unless asked not to, or unless there
  // is no agent to ask — the tool has to work for someone without one.
  let pass = proposeProduct(scan)
  const role = existing?.models?.implement ?? pass.models?.implement
  const passNotes = []
  if (values['no-agent']) {
    passNotes.push('--no-agent: the scan only — roles and relations are left for you to fill')
  } else if (!role) {
    passNotes.push('no agent CLI to ask: the scan only — roles and relations are left for you to fill')
  } else {
    process.stdout.write(`scanned ${scan.repos.length} ${scan.repos.length === 1 ? 'repository' : 'repositories'}; asking ${role.agent} what the scan cannot see…\n`)
    const { proposal: enriched, report } = await modelPass(scan, pass, { invoke, role })
    pass = enriched
    if (report.error) passNotes.push(`the model pass gave nothing usable (${report.error}) — the scan alone was written`)
    for (const item of report.fromModel) passNotes.push(`from the model: ${item}`)
    for (const item of report.dropped) passNotes.push(`dropped, not written: ${item}`)
    const cost = report.cost.usd !== null ? `$${report.cost.usd.toFixed(2)}` : report.cost.tokens ? `${report.cost.tokens.input + report.cost.tokens.output} tokens` : null
    if (!report.error) passNotes.push(`model pass: ${role.agent}, ${report.attempts} ${report.attempts === 1 ? 'attempt' : 'attempts'}${cost ? `, ${cost}` : ''}`)
  }
  const proposal = existing ? mergeProposal(existing, pass) : pass
  const text = `${JSON.stringify(proposal, null, 2)}\n`

  const { problems } = validateProduct(proposal, root)

  if (!exists) {
    mkdirSync(join(root, '.detent'), { recursive: true })
    writeFileSync(file, text)
    process.stdout.write(`wrote ${PRODUCT_FILE} — ${scan.repos.length} ${scan.repos.length === 1 ? 'repository' : 'repositories'}: ${scan.repos.map((r) => r.name).join(', ')}\n`)
  } else {
    const before = `${JSON.stringify(existing, null, 2)}\n`
    if (before === text) {
      process.stdout.write(`${PRODUCT_FILE} already says everything the scan found\n`)
      return problems.length ? report(problems) : 0
    }
    writeFileSync(join(root, PROPOSED_FILE), text)
    process.stdout.write(`${PRODUCT_FILE} exists, so nothing was overwritten. The scan proposes:\n\n`)
    process.stdout.write(`${hunks(diffLines(before.trimEnd(), text.trimEnd())).join('\n')}\n\n`)
    process.stdout.write(`The whole proposal is in ${PROPOSED_FILE}; move it over ${PRODUCT_FILE} to accept it.\n`)
  }

  const notes = [...passNotes]
  if (!proposal.models?.implement) notes.push('no agent CLI found on PATH — set models.implement by hand (claude, codex or gemini)')
  else if (!proposal.models?.accept) notes.push(`only ${proposal.models.implement.agent} is installed — set models.accept to a different model, or there is no acceptance pass`)
  for (const repo of proposal.repos) {
    if (!repo.gauge?.exit?.length) notes.push(`${repo.name}: no gauge stages — without them it has no lock`)
  }
  notes.push('read the gauge stages before an agent is held to them: detent gauge')
  process.stdout.write(`${notes.map((n) => `  ${n}`).join('\n')}\n`)
  return problems.length ? report(problems) : 0
}

function report(problems) {
  process.stdout.write(`\nthe file is not usable yet:\n${problems.map((p) => `  ${p}`).join('\n')}\n`)
  return 1
}
