// What the implementing agent is told. The task body is the spec, written
// before the work, and it is the prompt (DESIGN.md §4); around it go only the
// rules of the territory and, on a retry, what the gauge said.

export function implementPrompt({ task, repo, branch, attempt, limit, resumed, feedback }) {
  const parts = []

  parts.push(
    [
      `You are working on task ${task.id} in the repository "${repo.name}"${repo.role ? ` — ${repo.role}` : ''}.`,
      `The branch ${branch} is checked out in this directory.`,
    ].join('\n'),
  )

  const gauge = repo.gauge.exit
  const rules = [
    'Work only in this directory, on this branch. Do not switch branches, commit, merge, rebase, stash or push: detent commits your work when the gauge is green.',
    gauge.length > 0
      ? `You are done when the gauge is green, not when you say so. The gauge runs these commands in order, and every one must exit 0:\n${gauge.map((s) => `    ${s.stage}: ${s.command}`).join('\n')}\n  Run them yourself before you finish.`
      : 'This repository declares no gauge, so nothing checks your work automatically. Check it yourself against the acceptance criteria.',
  ]
  if (repo.neverCommit.length > 0) {
    rules.push(`Do not change ${repo.neverCommit.map((p) => `"${p}"`).join(', ')}: changes there are never committed and will be lost.`)
  }
  rules.push(
    'End your last message with one line describing the change as a conventional commit subject, for example:\n    Commit: feat(wallet): driver wallet balance endpoint',
  )
  parts.push(`Rules:\n${rules.map((r) => `- ${r}`).join('\n')}`)

  parts.push(`---\n\n${task.body.trim()}\n\n---`)

  if (resumed && attempt === 1) {
    parts.push(
      'This task was paused and is being resumed. Earlier work on it is already on this branch — build on it rather than starting again. Read the task above again: the developer may have changed it.',
    )
  }

  if (feedback) {
    parts.push(`Attempt ${attempt} of ${limit}. Your previous attempt did not leave the gauge green.\n\n${feedback}`)
  }

  return `${parts.join('\n\n')}\n`
}

const SUBJECT = /^[a-z]+(?:\([^()\s]+\))?!?: \S.{0,98}$/

// The agent's own description of its change, if it gave a usable one; detent's
// otherwise. The subject is the only part the agent writes.
export function commitSubject(message, task) {
  const lines = (message ?? '').split('\n').map((line) => line.trim())
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = /^\**commit:\**\s*`?(.+?)`?$/i.exec(lines[i])
    if (match && SUBJECT.test(match[1])) return match[1]
  }
  return `feat: task ${task.id}, ${task.slug.replaceAll('-', ' ')}`
}
