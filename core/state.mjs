// .detent/state.json — per repository: the active task, its attempt, when it
// started, and the process running it (DESIGN.md §11).
//
// It exists for the case nothing else can handle: a run that died without
// running its own cleanup. Whatever is listed here is a repository a run may
// have left behind, and `detent recover` reads it to put them back.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

export const STATE_FILE = join('.detent', 'state.json')

export function readState(productDir) {
  let text
  try {
    text = readFileSync(join(productDir, STATE_FILE), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, repos: {} }
    throw error
  }
  const state = JSON.parse(text)
  if (state?.version !== 1 || typeof state.repos !== 'object' || state.repos === null) {
    throw new Error(`${join(productDir, STATE_FILE)} is not a state file this version of detent understands`)
  }
  return state
}

// Written whole and renamed into place, so a crash mid-write leaves the old
// file rather than half of a new one.
function writeState(productDir, state) {
  const file = join(productDir, STATE_FILE)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(temporary, file)
}

export function claim(productDir, repo, { task, branch }) {
  const state = readState(productDir)
  if (state.repos[repo]) throw new Error(`${repo} is already claimed by task ${state.repos[repo].task}`)
  state.repos[repo] = { task, branch, attempt: 0, started: new Date().toISOString(), pid: process.pid }
  writeState(productDir, state)
  return state.repos[repo]
}

export function setAttempt(productDir, repo, attempt) {
  const state = readState(productDir)
  if (!state.repos[repo]) throw new Error(`${repo} is not claimed`)
  state.repos[repo].attempt = attempt
  writeState(productDir, state)
}

export function release(productDir, repo) {
  const state = readState(productDir)
  if (!state.repos[repo]) return
  delete state.repos[repo]
  writeState(productDir, state)
}

// Whether the process that claimed an entry is still running. A live run's
// repositories are not anyone else's to return.
export function isAlive(pid) {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
