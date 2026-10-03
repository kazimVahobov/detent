// Zero dependencies is a claim this project makes in its README, so it is
// checked on every run of the gauge rather than merely intended.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import process from 'node:process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies']

const offenders = FIELDS.flatMap((field) => Object.keys(pkg[field] ?? {}).map((name) => `${field}: ${name}`))

if (offenders.length > 0) {
  process.stderr.write(`zero dependencies is part of the definition of done, and it is broken:\n`)
  for (const line of offenders) process.stderr.write(`  ${line}\n`)
  process.exit(1)
}

process.stdout.write('no dependencies\n')
