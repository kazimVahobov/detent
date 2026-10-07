// detent plan — a conversation with an agent about what to build next, which
// ends in task files (DESIGN.md §4, §12). The spec written before the work is
// the prompt for the work, so this is where most of a run's quality is decided:
// a task with checkable criteria and a stated scope is one an acceptance pass
// can hold to account.
//
// The conversation is the agent's own interactive session, in this terminal.
// What detent adds is the opening — the format, the repositories, the numbers,
// the rules — and the check afterwards of everything that changed.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { git, snapshotRefs } from './git.mjs'
import { PRODUCT_FILE } from './product.mjs'
import { FOLDERS, nextId, readQueue } from './task.mjs'

// How each CLI is opened for a conversation that starts with our text. Edits
// are accepted without asking, because writing task files is the whole job;
// commands still ask.
export const INTERACTIVE = {
  claude: ({ model, prompt }) => ['claude', ['--permission-mode', 'acceptEdits', ...(model ? ['--model', model] : []), prompt]],
  codex: ({ model, prompt }) => ['codex', ['--sandbox', 'workspace-write', ...(model ? ['--model', model] : []), prompt]],
  gemini: ({ model, prompt }) => ['gemini', ['--approval-mode', 'auto_edit', ...(model ? ['--model', model] : []), '--prompt-interactive', prompt]],
}

export function planPrompt(product, { next, brief }) {
  const repos = product.repos
    .map((r) => `- ${r.name}${r.role ? ` — ${r.role}` : ''}${r.stack.length ? ` [${r.stack.join(', ')}]` : ''}`)
    .join('\n')
  const edges = product.edges.length ? `\nHow they relate:\n${product.edges.map((e) => `- ${e.from} → ${e.to}: ${e.kind}${e.source === 'model' ? ' (proposed, unconfirmed)' : ''}`).join('\n')}\n` : ''

  return `We are planning work for the product "${product.name}"${product.summary ? ` — ${product.summary}` : ''}. Talk it through with me first: ask what you need to know, point out what is unclear or too big, and propose how to split it. When we agree, write the task files. Coding agents will implement each task unattended, held to the repository's checks, and a second model will read each result against its acceptance criteria — so a task is only as good as what it says.

The repositories, each in its own folder here:
${repos}
${edges}
A task is one file in tasks/todo/, named NNNN-<slug>.md — four digits, then a short lowercase slug with dashes. The next free numbers are ${next.join(', ')}, and so on. Exactly this shape:

---
id: NNNN
repo: <one repository name from the list>
touches_contract: false
---

# Goal

One paragraph: what must work when this is done.

# Acceptance criteria

- [ ] a statement someone can check, without asking you what you meant
- [ ] another one

# Out of scope

What not to do while in there.

Rules:
- One task, one repository. Work that spans repositories is several tasks.
- touches_contract: true only when the task changes something other repositories depend on — an API, a schema, a shared type. Such a task runs alone, and nothing queued after it starts until it has landed.
- Every acceptance criterion must be checkable by reading the diff or running the code. "Works well" is not one.
- Write only files in tasks/todo/. Do not change the repositories, .detent/, runs/, or any other task.
- Only the body below the frontmatter reaches the implementing agent, so the Goal must stand on its own.
${brief ? `\nWhat I want to start from:\n\n${brief}\n` : ''}`
}

// Everything plan must not touch, and the queue it may write to, before the
// conversation — so that afterwards the difference can be named exactly.
export function before(product) {
  return {
    tasks: taskFiles(product.dir),
    productFile: hash(join(product.dir, PRODUCT_FILE)),
    repos: Object.fromEntries(product.repos.map((r) => [r.name, repoState(r.dir)])),
  }
}

export function after(product, was) {
  const now = taskFiles(product.dir)
  const added = []
  const changed = []
  const outside = []
  for (const [file, digest] of Object.entries(now)) {
    const inTodo = file.startsWith('tasks/todo/')
    if (!(file in was.tasks)) (inTodo ? added : outside).push(file)
    else if (was.tasks[file] !== digest) (inTodo ? changed : outside).push(file)
  }
  for (const file of Object.keys(was.tasks)) if (!(file in now)) outside.push(file)

  const breaches = []
  if (hash(join(product.dir, PRODUCT_FILE)) !== was.productFile) breaches.push(`${PRODUCT_FILE} changed`)
  for (const file of outside) breaches.push(`${file} changed — plan writes only new or revised tasks in tasks/todo/`)
  for (const repo of product.repos) {
    const state = repoState(repo.dir)
    const old = was.repos[repo.name]
    if (state.refs !== old.refs) breaches.push(`a ref moved in ${repo.name}`)
    if (state.clean !== old.clean) breaches.push(`${repo.name}'s working tree changed`)
  }

  let problems = []
  let tasks = []
  try {
    tasks = readQueue(product.dir, product)
  } catch (error) {
    problems = error.problems ?? [error.message]
  }
  return { added, changed, breaches, problems, queued: tasks.filter((t) => t.folder === 'todo') }
}

export function nextIds(product, count = 3) {
  let tasks = []
  try {
    tasks = readQueue(product.dir, product)
  } catch {
    // A broken queue still has numbers in its file names.
    tasks = Object.keys(taskFiles(product.dir))
      .map((f) => /\/(\d+)-/.exec(f)?.[1])
      .filter(Boolean)
      .map((id) => ({ id }))
  }
  const first = Number(nextId(tasks))
  return Array.from({ length: count }, (_, i) => String(first + i).padStart(4, '0'))
}

function taskFiles(dir) {
  const files = {}
  for (const folder of FOLDERS) {
    let entries = []
    try {
      entries = readdirSync(join(dir, 'tasks', folder), { withFileTypes: true })
    } catch {}
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const path = join(dir, 'tasks', folder, entry.name)
      files[relative(dir, path)] = hash(path)
    }
  }
  return files
}

function repoState(dir) {
  try {
    // The whole status, not only clean or not: a tree that was dirty before
    // and is dirty differently after was still touched.
    return { refs: [...snapshotRefs(dir)].map((e) => e.join(' ')).join('\n'), clean: git(dir, ['status', '--porcelain=v1', '--untracked-files=all']) }
  } catch {
    return { refs: null, clean: null }
  }
}

function hash(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}
