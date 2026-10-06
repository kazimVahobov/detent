#!/usr/bin/env node

// detent — a detent holds a mechanism in position until it is deliberately
// released. Here, by a green gauge.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { ConfigError, loadProduct } from './core/product.mjs'
import { recover } from './core/workspace.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

const COMMANDS = {
  doctor: 'whether this product is in the shape detent expects',
  init: 'scan the workspace and write product.json',
  plan: 'discuss a task with an agent; it writes the task files',
  run: 'work the queue',
  promote: 'merge agent/dev into agent/staging behind the batch gauge',
  summary: 'pass rate, iterations, cost per pass',
  dashboard: 'a page that watches this product',
  recover: 'return repositories an interrupted run left behind',
  prune: 'delete agent/task-* branches already merged into agent/dev',
}

const BUILT = {
  recover(product) {
    const report = recover(product)
    if (report.length === 0) {
      process.stdout.write('nothing to recover: no repository is out\n')
      return 0
    }
    for (const line of report) {
      const what =
        line.action === 'returned'
          ? `returned to ${product.branches.integration}${line.aborted ? `, ${line.aborted} aborted` : ''}${line.parked ? `, work parked as ${line.parked.slice(0, 7)}` : ''}`
          : `${line.action}: ${line.reason}`
      process.stdout.write(`${line.repo}  task ${line.task}  ${what}\n`)
    }
    return report.every((line) => line.action === 'returned') ? 0 : 1
  },
}

function usage() {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length))
  return [
    `detent ${version} — autonomy bounded by a machine-checkable gauge, and measured.`,
    '',
    'Usage: detent <command> [--product DIR]',
    '',
    ...Object.entries(COMMANDS).map(([name, help]) => `  ${name.padEnd(width)}  ${help}`),
    '',
    'The agent never touches a human branch. It works on agent/task-<id> and',
    'integrates into agent/dev; moving work across that line is yours.',
    '',
  ].join('\n')
}

function main(argv) {
  const [command, ...rest] = argv

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(usage())
    return 0
  }

  if (command === '--version' || command === '-v') {
    process.stdout.write(`${version}\n`)
    return 0
  }

  if (!Object.hasOwn(COMMANDS, command)) {
    process.stderr.write(`detent: unknown command "${command}"\n\n${usage()}`)
    return 2
  }

  if (Object.hasOwn(BUILT, command)) {
    let options
    try {
      options = parseArgs({ args: rest, options: { product: { type: 'string', default: '.' } } }).values
    } catch (error) {
      process.stderr.write(`detent ${command}: ${error.message}\n`)
      return 2
    }
    try {
      return BUILT[command](loadProduct(options.product))
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error
      process.stderr.write(`detent: ${error.message}\n`)
      return 78
    }
  }

  // Each command lands here as it is built; see the build order in the design
  // notes. Until then, say so plainly rather than pretending to work.
  process.stderr.write(`detent: "${command}" is not implemented yet (${version})\n`)
  return 70
}

process.exit(main(process.argv.slice(2)))
