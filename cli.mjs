#!/usr/bin/env node

// detent — a detent holds a mechanism in position until it is deliberately
// released. Here, by a green gauge.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { ConfigError, loadProduct } from './core/product.mjs'
import * as gauge from './core/commands/gauge.mjs'
import * as init from './core/commands/init.mjs'
import * as recover from './core/commands/recover.mjs'
import * as runCommand from './core/commands/run.mjs'
import * as summary from './core/commands/summary.mjs'
import { UsageError } from './core/commands/usage.mjs'

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
  gauge: "run a repository's gauge by hand: [repo…] [--profile exit|merge]",
  recover: 'return repositories an interrupted run left behind',
  prune: 'delete agent/task-* branches already merged into agent/dev',
}

// Commands that exist, each a module: { options, run(product, positionals, values) }.
const BUILT = { gauge, init, recover, run: runCommand, summary }

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

async function main(argv) {
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
    const module = BUILT[command]
    let parsed
    try {
      parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { product: { type: 'string', default: '.' }, ...module.options },
      })
    } catch (error) {
      process.stderr.write(`detent ${command}: ${error.message}\n`)
      return 2
    }
    try {
      // A command that makes or checks product.json works without one.
      const target = module.needsProduct === false ? parsed.values.product : loadProduct(parsed.values.product)
      return await module.run(target, parsed.positionals, parsed.values)
    } catch (error) {
      if (error instanceof UsageError) {
        process.stderr.write(`detent ${command}: ${error.message}\n`)
        return 2
      }
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

process.exitCode = await main(process.argv.slice(2))
