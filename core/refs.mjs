// The one predicate the whole boundary rests on (DESIGN.md §2, ADR 0001): a
// branch detent may write either lives under agent/ or writing it is a bug.

export const NAMESPACE = 'agent/'

export function isAgentBranch(name) {
  return typeof name === 'string' && name.startsWith(NAMESPACE) && name.length > NAMESPACE.length
}

// The rules of `git check-ref-format --branch`, written out so that a bad name
// in product.json is caught on load rather than by git halfway through a run.
// Returns the reason a name is not a usable branch name, or null.
export function refNameProblem(name) {
  if (typeof name !== 'string' || name === '') return 'is empty'
  if (name === '@') return 'cannot be "@"'
  if (name.startsWith('-')) return 'cannot begin with "-"'
  if (name.startsWith('/') || name.endsWith('/')) return 'cannot begin or end with "/"'
  if (name.endsWith('.')) return 'cannot end with "."'
  if (name.includes('//')) return 'cannot contain "//"'
  if (name.includes('..')) return 'cannot contain ".."'
  if (name.includes('@{')) return 'cannot contain "@{"'
  // Control characters, space, and the characters git reserves for revision syntax.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return 'cannot contain spaces, control characters or any of ~^:?*[\\'
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return 'cannot have a component beginning with "."'
    if (part.endsWith('.lock')) return 'cannot have a component ending in ".lock"'
  }
  return null
}
