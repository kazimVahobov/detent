// Each adapter against what its CLI really prints. The samples are taken from
// the CLIs themselves: Claude Code 2.1 run for real, Codex 0.160 and Gemini CLI
// 0.62 read from their event and formatter code. A fake binary of the same
// name stands in for the CLI and records how it was called.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { invoke } from '../core/agents.mjs'

const CLAUDE = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Added the wallet endpoint.\nCommit: feat(wallet): balance endpoint',
  session_id: '6e5219f1-effe-5323-8188-8e5f9b94ac08',
  total_cost_usd: 0.0145338,
  usage: { input_tokens: 10, cache_creation_input_tokens: 5463, cache_read_input_tokens: 23998, output_tokens: 49 },
  modelUsage: {
    'claude-opus-5': { inputTokens: 908, outputTokens: 600, costUSD: 0.012 },
    'claude-haiku-4-5-20251001': { inputTokens: 300, outputTokens: 60, costUSD: 0.002 },
  },
}

const CODEX = [
  { type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Looking at the repository' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'npm test', exit_code: 0 } },
  { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Done.\nCommit: fix(api): handle empty wallet' } },
  { type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 } },
].map((e) => JSON.stringify(e)).join('\n')

const GEMINI = {
  session_id: 'b3f1',
  response: 'All tests pass.\nCommit: test(api): cover the empty wallet',
  stats: {
    models: {
      'gemini-3-pro': { api: { totalRequests: 3 }, tokens: { prompt: 9000, candidates: 400, total: 9600, cached: 0, thoughts: 200, tool: 0 } },
      'gemini-3-flash': { api: { totalRequests: 1 }, tokens: { prompt: 500, candidates: 20, total: 520, cached: 0, thoughts: 0, tool: 0 } },
    },
  },
}

// A fake CLI: records argv and stdin, prints `output`, exits with `code`.
function fake(name, output, { code = 0, stderr = '' } = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'detent-agent-'))
  const out = join(bin, 'output')
  writeFileSync(out, output)
  writeFileSync(
    join(bin, name),
    `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a"; done > "${bin}/argv"
cat > "${bin}/stdin"
pwd > "${bin}/cwd"
cat "${out}"
printf '%s' ${JSON.stringify(stderr)} >&2
exit ${code}
`,
  )
  chmodSync(join(bin, name), 0o755)
  return {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    argv: () => readFileSync(join(bin, 'argv'), 'utf8').trim().split('\n'),
    stdin: () => readFileSync(join(bin, 'stdin'), 'utf8'),
    cwd: () => readFileSync(join(bin, 'cwd'), 'utf8').trim(),
  }
}

const cwd = mkdtempSync(join(tmpdir(), 'detent-agent-cwd-'))

test('claude: unattended print mode, prompt on stdin, cost and model as reported', async () => {
  const cli = fake('claude', JSON.stringify(CLAUDE))
  const result = await invoke({ agent: 'claude', model: 'claude-opus-5' }, { cwd, prompt: '# Goal\n\nwallet', env: cli.env })
  assert.deepEqual(cli.argv(), ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--model', 'claude-opus-5'])
  assert.equal(cli.stdin(), '# Goal\n\nwallet')
  assert.equal(cli.cwd(), cwd)
  assert.equal(result.ok, true)
  assert.equal(result.agent, 'claude')
  assert.match(result.message, /^Commit: feat\(wallet\)/m)
  assert.deepEqual(result.model, { requested: 'claude-opus-5', actual: 'claude-opus-5' }, 'the subagent model is not the model that ran')
  assert.deepEqual(result.cost, { usd: 0.0145338, tokens: { input: 29471, output: 49 } })
  assert.equal(result.session, CLAUDE.session_id)
  assert.equal(result.error, null)
})

test('claude: no model requested passes no --model, and the actual one is still reported', async () => {
  const cli = fake('claude', JSON.stringify(CLAUDE))
  const result = await invoke({ agent: 'claude' }, { cwd, prompt: 'x', env: cli.env })
  assert.ok(!cli.argv().includes('--model'))
  assert.deepEqual(result.model, { requested: null, actual: 'claude-opus-5' })
})

test('claude: an error result is not ok, and says why', async () => {
  const cli = fake('claude', JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Credit balance is too low', api_error_status: 400 }), { code: 1 })
  const result = await invoke({ agent: 'claude' }, { cwd, prompt: 'x', env: cli.env })
  assert.equal(result.ok, false)
  assert.match(result.error, /error_during_execution \(400\): Credit balance is too low/)
})

test('codex: exec with JSONL events, prompt on stdin, tokens summed, model not invented', async () => {
  const cli = fake('codex', `${CODEX}\n`)
  const result = await invoke({ agent: 'codex', model: 'gpt-5-codex' }, { cwd, prompt: 'the task', env: cli.env })
  assert.deepEqual(cli.argv(), ['exec', '--json', '--sandbox', 'workspace-write', '--color', 'never', '--model', 'gpt-5-codex', '-'])
  assert.equal(cli.stdin(), 'the task')
  assert.equal(result.ok, true)
  assert.equal(result.message, 'Done.\nCommit: fix(api): handle empty wallet', 'the last agent message, not the reasoning')
  assert.deepEqual(result.model, { requested: 'gpt-5-codex', actual: null })
  assert.deepEqual(result.cost, { usd: null, tokens: { input: 49211, output: 122 } })
  assert.equal(result.session, '0199a213-81c0-7800-8aa1-bbab2a035a53')
})

test('codex: a failed turn is not ok', async () => {
  const events = [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message: 'usage limit reached' } }]
  const cli = fake('codex', events.map((e) => JSON.stringify(e)).join('\n'), { code: 1 })
  const result = await invoke({ agent: 'codex' }, { cwd, prompt: 'x', env: cli.env })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'usage limit reached')
})

test('gemini: headless JSON, yolo, prompt on stdin, the busiest model reported', async () => {
  const cli = fake('gemini', JSON.stringify(GEMINI))
  const result = await invoke({ agent: 'gemini', model: 'gemini-3-pro' }, { cwd, prompt: 'the task', env: cli.env })
  const argv = cli.argv()
  assert.deepEqual(argv.slice(0, 5), ['--output-format', 'json', '--approval-mode', 'yolo', '--skip-trust'])
  assert.deepEqual(argv.slice(5, 7), ['--model', 'gemini-3-pro'])
  assert.equal(argv[7], '--prompt')
  assert.equal(cli.stdin(), 'the task')
  assert.equal(result.ok, true)
  assert.match(result.message, /^Commit: test\(api\)/m)
  assert.deepEqual(result.model, { requested: 'gemini-3-pro', actual: 'gemini-3-pro' })
  assert.deepEqual(result.cost, { usd: null, tokens: { input: 9500, output: 420 } })
})

test('gemini: an error object is not ok', async () => {
  const cli = fake('gemini', JSON.stringify({ error: { type: 'FatalAuthenticationError', message: 'not logged in', code: 41 } }), { code: 41 })
  const result = await invoke({ agent: 'gemini' }, { cwd, prompt: 'x', env: cli.env })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'not logged in')
})

test('an agent that is not installed resolves with the reason, not a throw', async () => {
  const result = await invoke({ agent: 'codex' }, { cwd, prompt: 'x', env: { ...process.env, PATH: mkdtempSync(join(tmpdir(), 'empty-')) } })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'codex is not installed, or not on PATH')
  assert.deepEqual(result.cost, { usd: null, tokens: null })
})

test('output nobody can read, or a non-zero exit, is not ok', async () => {
  const garbage = fake('claude', 'Segmentation fault', { code: 139, stderr: 'core dumped' })
  const one = await invoke({ agent: 'claude' }, { cwd, prompt: 'x', env: garbage.env })
  assert.equal(one.ok, false)
  assert.match(one.error, /claude printed nothing detent can read \(exit code 139\): core dumped/)

  const exited = fake('claude', JSON.stringify(CLAUDE), { code: 2 })
  const two = await invoke({ agent: 'claude' }, { cwd, prompt: 'x', env: exited.env })
  assert.equal(two.ok, false)
  assert.match(two.error, /claude finished with exit code 2/)
  assert.equal(two.cost.usd, 0.0145338, 'what it cost is kept even when it failed')
})

test('an unknown agent is a programming error', () => {
  assert.throws(() => invoke({ agent: 'cursor' }, { cwd, prompt: 'x' }), /unknown agent "cursor"/)
})
