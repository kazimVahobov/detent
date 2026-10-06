// The queue: tasks/{todo,hold,done,failed}/NNNN-<slug>.md (DESIGN.md §4).
//
// A queue that cannot be executed is rejected before the first agent starts —
// the difference between a typo and three wasted attempts.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const FOLDERS = ['todo', 'hold', 'done', 'failed']

const FILE = /^(\d{4,})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/
const FRONTMATTER_KEYS = ['id', 'repo', 'touches_contract']

export class QueueError extends Error {
  constructor(problems) {
    super(`the queue cannot be executed:\n${problems.map((p) => `  ${p}`).join('\n')}`)
    this.name = 'QueueError'
    this.problems = problems
  }
}

// Every task in all four folders. Only todo/ is held to the full shape: it is
// what is about to run. The other folders count for identity — the counter
// and uniqueness — and are not re-judged after the fact, so a repository
// removed from product.json does not make history unreadable.
export function readQueue(productDir, product) {
  const problems = []
  const tasks = []
  const repos = new Set(product.repos.map((repo) => repo.name))

  for (const folder of FOLDERS) {
    const dir = join(productDir, 'tasks', folder)
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      const where = `tasks/${folder}/${entry.name}`
      if (!entry.isFile()) {
        problems.push(`${where}: only task files belong here`)
        continue
      }
      const match = FILE.exec(entry.name)
      if (!match) {
        problems.push(`${where}: not a task file name — expected NNNN-<slug>.md, slug in lowercase-with-dashes`)
        continue
      }

      const file = join(dir, entry.name)
      const [, id, slug] = match
      if (folder !== 'todo') {
        tasks.push({ id, slug, folder, file })
        continue
      }

      const { task, problems: found } = parseTask(readFileSync(file, 'utf8'), { id, slug })
      for (const problem of found) problems.push(`${where}: ${problem}`)
      if (!task) continue
      if (!repos.has(task.repo)) problems.push(`${where}: repo "${task.repo}" is not in product.json`)
      tasks.push({ ...task, folder, file })
    }
  }

  // The number is the key, compared as a number: 0042 and 00042 are one task.
  const byNumber = new Map()
  for (const task of tasks) {
    const n = Number(task.id)
    const first = byNumber.get(n)
    if (first) problems.push(`tasks/${task.folder}/${task.id}-${task.slug}.md: id ${task.id} is already taken by tasks/${first.folder}/${first.id}-${first.slug}.md`)
    else byNumber.set(n, task)
  }

  if (problems.length > 0) throw new QueueError(problems)
  return tasks.sort((a, b) => Number(a.id) - Number(b.id))
}

// The counter is the highest number across all four folders: there is no
// counter file, and therefore nothing that can disagree with reality.
export function nextId(tasks) {
  const highest = tasks.reduce((max, task) => Math.max(max, Number(task.id)), 0)
  return String(highest + 1).padStart(4, '0')
}

export function taskBranch(product, task) {
  return product.branches.task.replaceAll('{id}', task.id).replaceAll('{slug}', task.slug)
}

// One task file's text, judged against the identity its file name gives it.
export function parseTask(text, { id, slug }) {
  const problems = []
  const source = text.replaceAll('\r\n', '\n')

  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source)
  if (!match) return { task: null, problems: ['has no frontmatter — it must open with a --- block'] }

  const fields = {}
  match[1].split('\n').forEach((line, index) => {
    if (line.trim() === '' || line.trim().startsWith('#')) return
    const pair = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/.exec(line)
    if (!pair) return problems.push(`frontmatter line ${index + 1} is not "key: value"`)
    const [, key, value] = pair
    if (!FRONTMATTER_KEYS.includes(key)) {
      return problems.push(`frontmatter key "${key}" is unknown — expected one of ${FRONTMATTER_KEYS.join(', ')}`)
    }
    if (Object.hasOwn(fields, key)) return problems.push(`frontmatter key "${key}" appears twice`)
    fields[key] = unquote(value)
  })

  if (fields.id === undefined) problems.push('frontmatter has no id')
  else if (fields.id !== id) {
    // The number appears in both places so it is visible whichever was opened;
    // two numbers that disagree are two answers to "which task is this".
    problems.push(`frontmatter id ${fields.id || '(empty)'} disagrees with the file name's ${id}`)
  }

  if (!fields.repo) problems.push('frontmatter has no repo')

  let touchesContract = false
  if (fields.touches_contract !== undefined) {
    if (fields.touches_contract === 'true') touchesContract = true
    else if (fields.touches_contract !== 'false') problems.push('touches_contract must be true or false')
  }

  // Only the body reaches the agent: the spec written before the work is the prompt.
  const body = source.slice(match[0].length).replace(/^\n+/, '')
  const criteria = section(body, 'acceptance criteria')
    .filter((line) => /^\s*[-*]\s+\[[ xX]\]\s+\S/.test(line))
    .map((line) => line.replace(/^\s*[-*]\s+\[[ xX]\]\s+/, '').trim())
  if (criteria.length === 0) {
    problems.push('has no acceptance criteria — "# Acceptance criteria" needs at least one "- [ ] …"')
  }

  if (problems.length > 0) return { task: null, problems }
  return { task: { id, slug, repo: fields.repo, touchesContract, body, criteria }, problems }
}

// The lines under a heading, up to the next heading of the same or a higher level.
function section(body, title) {
  const lines = body.split('\n')
  const start = lines.findIndex((line) => {
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    return heading && heading[2].toLowerCase() === title
  })
  if (start === -1) return []
  const level = /^(#+)/.exec(lines[start])[1].length
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => {
    const heading = /^(#{1,6})\s/.exec(line)
    return heading && heading[1].length <= level
  })
  return end === -1 ? rest : rest.slice(0, end)
}

function unquote(value) {
  const quoted = /^"(.*)"$|^'(.*)'$/.exec(value)
  return quoted ? (quoted[1] ?? quoted[2]) : value
}
