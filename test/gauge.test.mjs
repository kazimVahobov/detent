import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatGauge, runGauge } from '../core/gauge.mjs'
import { fingerprint, judge, normalise } from '../core/lock.mjs'

const node = (code) => `"${process.execPath}" -e ${JSON.stringify(code)}`

test('stages run in order, in the repository, and all green is green', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'detent-gauge-'))
  const result = await runGauge(
    [
      { stage: 'first', command: 'echo one >> order' },
      { stage: 'second', command: 'echo two >> order' },
    ],
    { cwd },
  )
  assert.equal(result.lock, 'enforced')
  assert.equal(result.green, true)
  assert.equal(result.failed, null)
  assert.equal(readFileSync(join(cwd, 'order'), 'utf8'), 'one\ntwo\n')
  assert.ok(result.stages.every((s) => s.code === 0 && typeof s.ms === 'number'))
})

test('the first red stage stops the gauge and is named exactly', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'detent-gauge-'))
  const result = await runGauge(
    [
      { stage: 'lint', command: 'true' },
      { stage: 'test', command: 'echo "2 failing tests"; exit 3' },
      { stage: 'build', command: 'touch built' },
    ],
    { cwd },
  )
  assert.equal(result.green, false)
  assert.equal(result.failed.stage, 'test')
  assert.equal(result.failed.code, 3)
  assert.match(result.failed.output, /2 failing tests/)
  assert.deepEqual(result.stages.map((s) => s.stage), ['lint', 'test'], 'build never ran')
  assert.equal(formatGauge(result), 'lint ✓ test ✗')
})

test('stdout and stderr are kept together, in the order they arrived', async () => {
  const result = await runGauge(
    [{ stage: 'mixed', command: node("process.stdout.write('a\\n'); setTimeout(() => { process.stderr.write('b\\n'); setTimeout(() => process.stdout.write('c\\n'), 30) }, 30)") }],
    { cwd: tmpdir() },
  )
  assert.equal(result.stages[0].output, 'a\nb\nc\n')
})

test('long output is capped from the front, so the end survives', async () => {
  const result = await runGauge(
    // One stream, so the order is the order of writing; across two pipes only
    // arrival order is knowable (the test above).
    [{ stage: 'noisy', command: node("for (let i = 0; i < 5000; i++) console.log('line ' + i); console.log('THE FAILURE'); process.exitCode = 1") }],
    { cwd: tmpdir(), limit: 2048 },
  )
  const { output } = result.failed
  assert.ok(output.length < 2100, `output is ${output.length} long`)
  assert.match(output, /^\[… earlier output dropped\]/)
  assert.match(output, /line 4999\nTHE FAILURE\n$/)
  assert.doesNotMatch(output, /line 0\n/)
})

test('a command that cannot run is a red stage, not a crash', async () => {
  const result = await runGauge([{ stage: 'missing', command: 'no-such-command-anywhere' }], { cwd: tmpdir() })
  assert.equal(result.green, false)
  assert.equal(result.failed.code, 127)
})

test('a stage killed by a signal is red and says so', async () => {
  const result = await runGauge([{ stage: 'killed', command: 'kill -TERM $$' }], { cwd: tmpdir() })
  assert.equal(result.green, false)
  assert.equal(result.failed.signal, 'SIGTERM')
  const verdict = judge([result], { limit: 3 })
  assert.match(verdict.feedback, /killed by SIGTERM/)
})

test('no declared stages is no lock: green is null, never invented', async () => {
  const result = await runGauge([], { cwd: tmpdir() })
  assert.deepEqual(result, { profile: 'exit', lock: 'absent', green: null, stages: [], failed: null })
  assert.equal(formatGauge(result), 'no gauge declared')
  assert.equal(judge([result], { limit: 3 }).verdict, 'unlocked')
})

// --- the lock ---------------------------------------------------------------

function red(stage, output, code = 1) {
  return { profile: 'exit', lock: 'enforced', green: false, stages: [], failed: { stage, command: `npm run ${stage}`, code, signal: null, output } }
}
const green = { profile: 'exit', lock: 'enforced', green: true, stages: [], failed: null }

test('green lets the agent leave', () => {
  assert.deepEqual(judge([red('test', 'x'), green], { limit: 3 }), { verdict: 'leave', attempts: 2 })
})

test('red keeps the agent in, handing it the stage, the command and the output', () => {
  const verdict = judge([red('typecheck', "src/a.ts(3,1): error TS2304: Cannot find name 'x'.")], { limit: 3 })
  assert.equal(verdict.verdict, 'retry')
  assert.equal(verdict.stage, 'typecheck')
  assert.match(verdict.feedback, /stage "typecheck"/)
  assert.match(verdict.feedback, /`npm run typecheck` finished with exit code 1/)
  assert.match(verdict.feedback, /Cannot find name 'x'/)
})

test('limit identical failures in a row on one stage escalate — no further attempt', () => {
  const same = () => red('test', '1 failing test: wallet balance')
  assert.equal(judge([same(), same()], { limit: 3 }).verdict, 'retry')
  const verdict = judge([same(), same(), same()], { limit: 3 })
  assert.equal(verdict.verdict, 'escalate')
  assert.equal(verdict.reason, '3 identical failures on test')
  assert.equal(judge([same()], { limit: 1 }).verdict, 'escalate')
})

test('failures that change are not identical, and the count restarts', () => {
  assert.equal(judge([red('test', '3 failing'), red('test', '2 failing'), red('test', '1 failing')], { limit: 3 }).verdict, 'retry')
  assert.equal(judge([red('lint', 'x'), red('test', 'x'), red('test', 'x')], { limit: 3 }).verdict, 'retry')
  assert.equal(judge([red('test', 'x'), red('test', 'x', 2), red('test', 'x')], { limit: 3 }).verdict, 'retry')
  const progress = [red('test', 'x'), red('test', 'x'), red('test', 'y'), red('test', 'y')]
  assert.equal(judge(progress, { limit: 3 }).verdict, 'retry')
  assert.equal(judge([...progress, red('test', 'y')], { limit: 3 }).verdict, 'escalate')
})

test('timings, timestamps and colour codes do not make a failure different', () => {
  const a = red('test', '\x1b[31m✗ wallet balance\x1b[0m (12ms)\n2026-10-07T09:12:03.120Z done in 1.24s')
  const b = red('test', '✗ wallet balance (340ms)\n2026-10-07T09:14:41.007Z done in 3.9s')
  assert.equal(fingerprint(a), fingerprint(b))
  assert.equal(judge([a, b, a], { limit: 3 }).verdict, 'escalate')
  assert.equal(normalise('3 failing tests'), '3 failing tests', 'counts are not durations')
})

test('the lock needs something to judge', () => {
  assert.throws(() => judge([], { limit: 3 }))
})

test('the gauge runs on this repository the way detent will run it', async () => {
  // The repository's own exit profile, as declared for detent in CONTRIBUTING.md,
  // minus the test stage — which is the run this test is part of.
  const root = join(import.meta.dirname, '..')
  const result = await runGauge(
    [
      { stage: 'deps', command: 'node scripts/check-no-deps.mjs' },
      { stage: 'progress', command: 'node scripts/check-progress.mjs' },
    ],
    { cwd: root },
  )
  assert.equal(result.green, true, result.failed?.output)
  assert.equal(formatGauge(result), 'deps ✓ progress ✓')
})

test('a gauge stage sees only its own working directory', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'detent-gauge-'))
  writeFileSync(join(cwd, 'marker'), 'here')
  const result = await runGauge([{ stage: 'where', command: 'cat marker' }], { cwd })
  assert.equal(result.stages[0].output, 'here')
})
