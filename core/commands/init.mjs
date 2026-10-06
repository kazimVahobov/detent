// detent init — scan the product folder and write product.json (pass 1 of
// DESIGN.md §12; the model pass is build step 12). Re-running it proposes a
// diff rather than overwriting what a person wrote.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { PRODUCT_FILE, validateProduct } from '../product.mjs'
import { diffLines, hunks, mergeProposal, proposeProduct } from '../propose.mjs'
import { scanProduct } from '../scan.mjs'
import { UsageError } from './usage.mjs'

export const options = {}
export const needsProduct = false

export const PROPOSED_FILE = join('.detent', 'product.proposed.json')

export function run(dir) {
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
  const proposal = existing ? mergeProposal(existing, proposeProduct(scan)) : proposeProduct(scan)
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

  const notes = []
  if (!proposal.models?.implement) notes.push('no agent CLI found on PATH — set models.implement by hand (claude, codex or gemini)')
  else if (!proposal.models?.accept) notes.push(`only ${proposal.models.implement.agent} is installed — set models.accept to a different model, or there is no acceptance pass`)
  for (const repo of proposal.repos) {
    if (!repo.gauge?.exit?.length) notes.push(`${repo.name}: no gauge stages found in its scripts — without them it has no lock`)
  }
  notes.push('gauge stages are proposed from scripts the repositories declare: read them before an agent is held to them (detent gauge)')
  process.stdout.write(`${notes.map((n) => `  ${n}`).join('\n')}\n`)
  return problems.length ? report(problems) : 0
}

function report(problems) {
  process.stdout.write(`\nthe file is not usable yet:\n${problems.map((p) => `  ${p}`).join('\n')}\n`)
  return 1
}
