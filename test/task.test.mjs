import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateProduct } from '../core/product.mjs'
import { QueueError, moveTask, nextId, parseTask, readQueue, taskBranch } from '../core/task.mjs'

const { product } = validateProduct({ version: 1, product: { name: 'acme' }, repos: [{ name: 'acme-api', compare: 'dev' }] })

function task({ id = '0042', repo = 'acme-api', extra = '', criteria = '- [ ] a checkable statement' } = {}) {
  return `---
id: ${id}
repo: ${repo}
touches_contract: false
${extra}---

# Goal

One paragraph: what must work when this is done.

# Acceptance criteria

${criteria}

# Out of scope

What not to do while you are in there.
`
}

function queue(files) {
  const dir = mkdtempSync(join(tmpdir(), 'detent-queue-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, 'tasks', path, '..'), { recursive: true })
    writeFileSync(join(dir, 'tasks', path), text)
  }
  return dir
}

function queueProblems(files) {
  try {
    readQueue(queue(files), product)
  } catch (error) {
    assert.ok(error instanceof QueueError)
    return error.problems
  }
  return []
}

test('the shape in DESIGN.md §4 parses, and only the body reaches the agent', () => {
  const { task: parsed, problems } = parseTask(task(), { id: '0042', slug: 'wallet-endpoint' })
  assert.deepEqual(problems, [])
  assert.equal(parsed.repo, 'acme-api')
  assert.equal(parsed.touchesContract, false)
  assert.deepEqual(parsed.criteria, ['a checkable statement'])
  assert.match(parsed.body, /^# Goal/)
  assert.doesNotMatch(parsed.body, /repo: acme-api/)
})

test('touches_contract makes a barrier, and only true or false are accepted', () => {
  const yes = parseTask(task().replace('touches_contract: false', 'touches_contract: true'), { id: '0042', slug: 's' })
  assert.equal(yes.task.touchesContract, true)
  const odd = parseTask(task().replace('touches_contract: false', 'touches_contract: yes'), { id: '0042', slug: 's' })
  assert.match(odd.problems.join('\n'), /touches_contract must be true or false/)
})

test('the id in the file name and in the frontmatter must agree', () => {
  const { problems } = parseTask(task({ id: '0043' }), { id: '0042', slug: 's' })
  assert.match(problems.join('\n'), /frontmatter id 0043 disagrees with the file name's 0042/)
})

test('frontmatter is strict and must exist', () => {
  assert.match(parseTask(task({ extra: 'priority: high\n' }), { id: '0042', slug: 's' }).problems.join('\n'), /"priority" is unknown/)
  assert.match(parseTask('# Goal\n', { id: '0042', slug: 's' }).problems.join('\n'), /has no frontmatter/)
  assert.match(parseTask(task({ extra: 'id: 0042\n' }), { id: '0042', slug: 's' }).problems.join('\n'), /"id" appears twice/)
})

test('acceptance criteria must be non-empty', () => {
  for (const criteria of ['', 'Something prose, not a checklist.', '- a bullet without a box']) {
    const { problems } = parseTask(task({ criteria }), { id: '0042', slug: 's' })
    assert.match(problems.join('\n'), /has no acceptance criteria/, `criteria: ${JSON.stringify(criteria)}`)
  }
  const later = `---\nid: 0042\nrepo: acme-api\n---\n\n# Acceptance criteria\n\n# Notes\n\n- [ ] not under the heading\n`
  assert.match(parseTask(later, { id: '0042', slug: 's' }).problems.join('\n'), /has no acceptance criteria/)
})

test('CRLF files read the same as LF ones', () => {
  const { problems } = parseTask(task().replaceAll('\n', '\r\n'), { id: '0042', slug: 's' })
  assert.deepEqual(problems, [])
})

test('a todo task whose repo is not in product.json is rejected', () => {
  const problems = queueProblems({ 'todo/0001-a.md': task({ id: '0001', repo: 'acme-web' }) })
  assert.match(problems.join('\n'), /tasks\/todo\/0001-a\.md: repo "acme-web" is not in product\.json/)
})

test('an id repeated across the four folders is rejected, compared as a number', () => {
  const problems = queueProblems({
    'done/0042-old.md': 'anything — finished tasks are not re-judged',
    'todo/00042-new.md': task({ id: '00042' }),
  })
  assert.match(problems.join('\n'), /id 0042 is already taken by tasks\/todo\/00042-new\.md/)
})

test('a file that is not named like a task is reported, not skipped', () => {
  const problems = queueProblems({ 'todo/wallet.md': 'x', 'hold/42-short.md': 'x', 'todo/0001-Upper.md': 'x' })
  assert.equal(problems.length, 3, problems.join('\n'))
})

test('the queue reads all four folders, in id order, and dotfiles are ignored', () => {
  const dir = queue({
    'todo/0003-c.md': task({ id: '0003' }),
    'hold/0002-b.md': 'parked',
    'failed/0007-g.md': 'gave up',
    'done/0001-a.md': 'landed',
    'todo/.DS_Store': '',
  })
  const tasks = readQueue(dir, product)
  assert.deepEqual(tasks.map((t) => `${t.folder}/${t.id}`), ['done/0001', 'hold/0002', 'todo/0003', 'failed/0007'])
  assert.equal(nextId(tasks), '0008', 'the counter is the highest across all four folders')
})

test('an empty or missing queue starts at 0001', () => {
  assert.equal(nextId(readQueue(queue({}), product)), '0001')
})

test('every problem in the queue is reported at once', () => {
  const problems = queueProblems({
    'todo/0001-a.md': task({ id: '0001', criteria: '' }),
    'todo/0002-b.md': task({ id: '0009' }),
  })
  assert.equal(problems.length, 2, problems.join('\n'))
})

test('the task branch comes from the template', () => {
  assert.equal(taskBranch(product, { id: '0042', slug: 'wallet-endpoint' }), 'agent/task-0042-wallet-endpoint')
})

test('a task moves between folders and keeps its name, and never overwrites', () => {
  const dir = queue({ 'todo/0001-a.md': task({ id: '0001' }), 'hold/0002-b.md': 'parked' })
  const [first] = readQueue(dir, product)
  const held = moveTask(dir, first, 'hold')
  assert.equal(held.folder, 'hold')
  assert.ok(existsSync(join(dir, 'tasks', 'hold', '0001-a.md')))
  assert.ok(!existsSync(join(dir, 'tasks', 'todo', '0001-a.md')))
  assert.match(readFileSync(held.file, 'utf8'), /id: 0001/)

  mkdirSync(join(dir, 'tasks', 'done'))
  writeFileSync(join(dir, 'tasks', 'done', '0001-a.md'), 'someone else')
  assert.throws(() => moveTask(dir, held, 'done'), /tasks\/done\/0001-a\.md already exists/)
  assert.ok(existsSync(held.file), 'a refused move leaves the task where it was')
  assert.throws(() => moveTask(dir, held, 'archive'), /not one of/)
})
