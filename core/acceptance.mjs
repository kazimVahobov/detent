// The acceptance pass: a different model reads the diff against the task, and
// may demote, never approve (DESIGN.md §9, ADR 0004).
//
// Green has already been granted by the machine checks. What the reviewer is
// for is the case those checks cannot see — the criterion that was not met, the
// thing the task put out of scope and the agent did anyway, the test that was
// weakened or the file that was created just to turn a stage green.

import { git } from './git.mjs'

export const DIFF_LIMIT = 100 * 1024

export function acceptancePrompt({ task, repo, branch, base, diff, truncated }) {
  return `You are reviewing work another agent did on task ${task.id} in the repository "${repo.name}". The branch ${branch} is checked out in this directory; the work is the difference from ${base}.

You cannot approve it. The project's checks have already passed; that is not your question. Your only job is to find reasons the task is NOT done:
- an acceptance criterion that is not met, or met only on paper
- something the task puts out of scope that was done anyway
- a check satisfied by gaming it: a test changed or weakened, an assertion removed, a file created only so a check would pass, a forbidden file touched

Do not change anything. Read the repository if you need more than the diff.

---

${task.body.trim()}

---

The change (git diff ${base}...${branch})${truncated ? ' — cut short; run git diff yourself for the rest' : ''}:

\`\`\`diff
${diff}
\`\`\`

End your answer with the verdict, exactly one of:

VERDICT: NO DOUBTS

VERDICT: DOUBTS
- one line per doubt, naming the criterion or file it is about
`
}

// The verdict, read strictly. The last VERDICT line counts; doubts are the
// "- " lines after it. A message with no verdict line is not a pass: a reviewer
// that said nothing readable has not raised no doubt, it has said nothing.
export function parseVerdict(message) {
  const lines = (message ?? '').split('\n').map((line) => line.trim())
  let at = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\**VERDICT:\s*(NO DOUBTS|DOUBTS)\**\s*$/i.test(lines[i])) {
      at = i
      break
    }
  }
  if (at === -1) return { verdict: null, doubts: [] }
  if (/NO DOUBTS/i.test(lines[at])) return { verdict: 'accepted', doubts: [] }
  const doubts = lines
    .slice(at + 1)
    .filter((line) => /^[-*]\s+\S/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, ''))
  return { verdict: 'rejected', doubts: doubts.length > 0 ? doubts : ['the reviewer raised a doubt and gave no reason'] }
}

export function taskDiff(cwd, base, branch, limit = DIFF_LIMIT) {
  const diff = git(cwd, ['diff', '--stat', '--patch', '--no-color', `${base}...refs/heads/${branch}`])
  if (diff.length <= limit) return { diff, truncated: false }
  return { diff: `${diff.slice(0, limit)}\n[… cut short]`, truncated: true }
}
