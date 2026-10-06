// Who runs when (DESIGN.md §8). Two rules, and no others:
//
// 1. One active task per repository. The exclusion key is the repository name;
//    there are no zones, because zones need separate working copies (ADR 0002).
// 2. A barrier runs alone, and nothing starts past it. The pool drains, the
//    barrier runs by itself, and only then does anything after it begin: a
//    task queued behind a contract change must not begin against the contract
//    that change is about to replace.
//
// And one consequence: a barrier that does not pass ends the run there. The
// tasks behind it were written for a contract that was not replaced.

export async function schedule(tasks, { concurrency, runOne, onStart = () => {}, onFinish = () => {} }) {
  const queue = [...tasks].sort((a, b) => Number(a.id) - Number(b.id))
  const busy = new Set()
  const running = new Set()
  const results = []
  let stoppedAt = null

  const start = (task) => {
    busy.add(task.repo)
    onStart(task)
    const promise = Promise.resolve()
      .then(() => runOne(task))
      // One task failing to run is that task's outcome, not the end of the pool.
      .catch((error) => ({ outcome: 'error', reason: `the run failed: ${error.message}` }))
      .then((result) => {
        results.push({ task, result })
        onFinish(task, result)
        return result
      })
      .finally(() => {
        busy.delete(task.repo)
        running.delete(promise)
      })
    running.add(promise)
    return promise
  }

  while (queue.length > 0) {
    const barrier = queue.findIndex((t) => t.touchesContract)
    if (barrier === 0) {
      // Drain, then run it alone.
      if (running.size > 0) {
        await Promise.race(running)
        continue
      }
      const task = queue.shift()
      const result = await start(task)
      if (result.outcome !== 'passed') {
        stoppedAt = { task, result, left: queue.splice(0) }
      }
      continue
    }

    // Only what stands before the next barrier is eligible.
    const window = barrier === -1 ? queue : queue.slice(0, barrier)
    const next = running.size < concurrency ? window.find((t) => !busy.has(t.repo)) : undefined
    if (next) {
      queue.splice(queue.indexOf(next), 1)
      start(next)
      continue
    }
    await Promise.race(running)
  }
  await Promise.all(running)
  return { results, stoppedAt }
}
