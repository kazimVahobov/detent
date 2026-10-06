// The dashboard page: one file, nothing loaded from outside, every value set
// as text so a task title or a reviewer's doubt can never become markup.
// Status always reads as an icon and a word; colour only repeats it.

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>detent</title>
<style>
:root {
  color-scheme: light;
  --surface: #fcfcfb; --raised: #ffffff; --line: #e4e3df;
  --text: #0b0b0b; --text-2: #52514e; --muted: #7a7974;
  --good: #0ca30c; --warning: #fab219; --serious: #ec835a; --critical: #d03b3b; --accent: #2a78d6;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --surface: #1a1a19; --raised: #232322; --line: #34332f;
    --text: #ffffff; --text-2: #c3c2b7; --muted: #8f8e86; --accent: #3987e5;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --surface: #1a1a19; --raised: #232322; --line: #34332f;
  --text: #ffffff; --text-2: #c3c2b7; --muted: #8f8e86; --accent: #3987e5;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; margin-bottom: 24px; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--text-2); margin: 32px 0 8px; }
.sub { color: var(--text-2); }
.muted { color: var(--muted); }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border: 1px solid var(--line); border-radius: 999px; font-size: 13px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.running .dot { background: var(--good); }
.figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.tile { background: var(--raised); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
.tile .label { color: var(--text-2); font-size: 13px; }
.tile .value { font-size: 24px; font-weight: 600; margin-top: 2px; }
.tile .note { color: var(--muted); font-size: 12px; margin-top: 2px; }
.hero { grid-column: span 2; }
.hero .value { font-size: 52px; line-height: 1.05; }
@media (max-width: 520px) { .hero { grid-column: auto; } }
.scroll { overflow-x: auto; background: var(--raised); border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; color: var(--text-2); font-size: 12px; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.status { display: inline-flex; gap: 6px; align-items: baseline; white-space: nowrap; }
.status .icon { font-weight: 700; }
div.status { white-space: normal; }
.passed .icon { color: var(--good); }
.escalated .icon, .look .icon { color: var(--warning); }
.rejected .icon { color: var(--serious); }
.error .icon { color: var(--critical); }
.skipped .icon, .info .icon { color: var(--muted); }
ul.doubts { margin: 4px 0 0; padding-left: 18px; color: var(--text-2); }
.empty { padding: 12px; color: var(--muted); }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 0 24px; }
code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
footer { margin-top: 32px; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<main>
  <header>
    <h1 id="name">detent</h1>
    <span id="state" class="chip"><span class="dot"></span><span id="state-text">loading</span></span>
    <span id="summary" class="sub"></span>
  </header>
  <section class="figures" id="figures"></section>
  <h2>Repositories</h2>
  <div class="scroll"><table id="repos"></table></div>
  <div class="grid2">
    <div><h2>Queue</h2><div class="scroll"><table id="todo"></table></div></div>
    <div><h2>Paused — waiting for you</h2><div class="scroll"><table id="hold"></table></div></div>
  </div>
  <h2>Agents</h2>
  <div class="scroll"><table id="agents"></table></div>
  <h2>Recent runs</h2>
  <div class="scroll"><table id="recent"></table></div>
  <footer id="footer"></footer>
</main>
<script>
const OUTCOME = {
  passed: ['✓', 'passed'], rejected: ['⚑', 'rejected'], escalated: ['▲', 'escalated'],
  error: ['✕', 'error'], skipped: ['–', 'skipped'],
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v)
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function status(outcome) {
  const [icon, label] = OUTCOME[outcome] || ['·', outcome || '—']
  return el('span', { class: 'status ' + (outcome || 'info') }, el('span', { class: 'icon', 'aria-hidden': 'true' }, icon), label)
}

function table(node, head, rows, empty) {
  node.replaceChildren()
  if (!rows.length) { node.append(el('tr', {}, el('td', { class: 'empty' }, empty))); return }
  node.append(el('thead', {}, el('tr', {}, head.map(([label, cls]) => el('th', cls ? { class: cls } : {}, label)))))
  node.append(el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((c, i) => el('td', head[i][1] ? { class: head[i][1] } : {}, c))))))
}

const pct = (x) => x === null || x === undefined ? '—' : Math.round(x * 100) + '%'
function cost(c) {
  if (!c) return '—'
  if (c.usd !== undefined) return '$' + c.usd.toFixed(2)
  return Math.round(c.tokens).toLocaleString('en-US') + ' tok'
}
function runCost(c) {
  if (!c) return '—'
  if (typeof c.usd === 'number') return '$' + c.usd.toFixed(2)
  if (c.tokens) return (c.tokens.input + c.tokens.output).toLocaleString('en-US') + ' tok'
  return '—'
}
const when = (iso) => iso ? new Date(iso).toLocaleString() : '—'
const agent = (r) => r ? r.agent + (r.model ? ' ' + r.model : '') : '—'

function tile(label, value, note, cls) {
  return el('div', { class: 'tile' + (cls ? ' ' + cls : '') }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value), note ? el('div', { class: 'note' }, note) : null)
}

function standing(r) {
  if (r.missing) return el('span', { class: 'status error' }, el('span', { class: 'icon' }, '✕'), 'not a git repository')
  if (!r.integration) return el('span', { class: 'status error' }, el('span', { class: 'icon' }, '✕'), 'no agent/dev — create it from ' + r.compare)
  if (!r.divergence) return el('span', { class: 'status look' }, el('span', { class: 'icon' }, '!'), r.compare + ' does not exist here')
  const d = r.divergence
  const parts = []
  if (d.ahead === 0 && d.behind === 0) return el('span', { class: 'status passed' }, el('span', { class: 'icon' }, '≡'), 'agent/dev ≡ ' + r.compare)
  if (d.tasksAhead > 0) parts.push(el('div', { class: 'status info' }, el('span', { class: 'icon' }, '→'), d.tasksAhead + (d.tasksAhead === 1 ? ' task' : ' tasks') + ' ahead of ' + r.compare + ' — waiting for your review'))
  else if (d.ahead > 0) parts.push(el('div', { class: 'status info' }, el('span', { class: 'icon' }, '→'), d.ahead + ' commits ahead of ' + r.compare))
  if (d.behind > 0) parts.push(el('div', { class: 'status look' }, el('span', { class: 'icon' }, '▲'), d.behind + (d.behind === 1 ? ' commit' : ' commits') + ' behind ' + r.compare + ' — agents cannot see your work'))
  return el('div', {}, parts)
}

function render(s) {
  document.title = 'detent — ' + s.product.name
  document.getElementById('name').textContent = s.product.name
  document.getElementById('summary').textContent = s.product.summary || ''
  const state = document.getElementById('state')
  state.className = 'chip' + (s.running ? ' running' : '')
  document.getElementById('state-text').textContent = s.running
    ? 'running — ' + s.active.filter((a) => a.alive).map((a) => a.repo + ' · task ' + a.task).join(', ') + ' (read-only while a run is active)'
    : 'idle'

  const n = s.numbers
  const all = n.all
  const figures = document.getElementById('figures')
  figures.replaceChildren(
    tile('Pass rate', all ? pct(all.passRate) : '—', all ? all.passed + ' of ' + all.runs + ' runs passed' : 'no runs yet', 'hero'),
    tile('Cost per pass', all ? cost(all.costPerPass) : '—', 'every attempt of every run counted'),
    tile('Attempts per run', all ? all.attemptsPerRun.toFixed(1) : '—', 'the gauge sent the agent back'),
    tile('Green but not done', n.blindSpot.read ? pct(n.blindSpot.rejected / n.blindSpot.read) : '—', n.blindSpot.read ? n.blindSpot.rejected + ' of ' + n.blindSpot.read + ' green runs the reviewer read' : 'no run reviewed yet'),
    tile('Paused', String(s.queue.hold.length), s.queue.hold.length ? 'waiting for you' : 'nothing waiting'),
  )
  if (n.batches.checked) {
    figures.append(tile('Red batch', pct(n.batches.red / n.batches.checked), n.batches.red + ' of ' + n.batches.checked + ' batches red with every task green'))
  }

  table(document.getElementById('repos'), [['Repository'], ['agent/dev'], ['Lock'], ['Now'], ['Agents']], s.repos.map((r) => [
    el('strong', {}, r.name),
    standing(r),
    r.lock === 'enforced' ? el('span', {}, el('code', {}, r.gauge.join(' · '))) : el('span', { class: 'status look' }, el('span', { class: 'icon' }, '!'), 'no gauge'),
    r.active ? 'task ' + r.active.task + ', attempt ' + r.active.attempt + (r.active.alive ? '' : ' — run gone, detent recover') : el('span', { class: 'muted' }, r.clean === false ? 'tree not clean' : 'idle'),
    el('span', {}, 'implement ' + agent(r.implement), el('br'), el('span', { class: 'muted' }, 'review ' + (r.accept ? agent(r.accept) : 'none'))),
  ]), 'no repositories')

  table(document.getElementById('todo'), [['Task'], ['Repository']], s.queue.todo.map((t) => [t.id + ' ' + t.slug, t.repo || '—']), 'tasks/todo/ is empty')
  table(document.getElementById('hold'), [['Task'], ['Why']], s.queue.hold.map((t) => [
    el('div', {}, el('strong', {}, t.id + ' ' + t.slug), el('div', { class: 'muted' }, t.branch ? el('code', {}, t.branch) : '')),
    el('div', {}, t.outcome ? status(t.outcome) : el('span', { class: 'muted' }, 'parked by hand'), t.reason && !t.doubts.length ? el('div', { class: 'muted' }, t.reason) : null,
      t.doubts.length ? el('ul', { class: 'doubts' }, t.doubts.map((d) => el('li', {}, d))) : null),
  ]), 'nothing paused')

  table(document.getElementById('agents'), [['Agent and model'], ['Runs', 'num'], ['Passed', 'num'], ['Pass rate', 'num'], ['Attempts/run', 'num'], ['Cost/pass', 'num']],
    n.byModel.map((r) => [r.name, r.runs, r.passed, pct(r.passRate), r.attemptsPerRun.toFixed(1), cost(r.costPerPass)]), 'no runs yet')

  table(document.getElementById('recent'), [['Finished'], ['Task'], ['Repository'], ['Outcome'], ['Attempts', 'num'], ['Cost', 'num']],
    s.recent.map((r) => [when(r.finished), r.task + ' ' + r.slug, r.repo, status(r.outcome), r.attempts, runCost(r.cost)]), 'no runs yet')

  const notes = ['read at ' + new Date(s.generated).toLocaleTimeString(), s.product.dir]
  if (n.skipped) notes.push(n.skipped + ' skipped runs not counted')
  if (n.unreadable) notes.push(n.unreadable + ' journal lines unreadable')
  if (s.queueProblems.length) notes.push('the queue has problems: ' + s.queueProblems.join('; '))
  document.getElementById('footer').textContent = notes.join(' · ')
}

async function refresh() {
  try {
    const response = await fetch('state.json', { cache: 'no-store' })
    if (!response.ok) throw new Error(response.status + ' ' + (await response.text()))
    render(await response.json())
  } catch (error) {
    document.getElementById('state-text').textContent = 'cannot read the product: ' + error.message
  }
}
refresh()
setInterval(refresh, 3000)
</script>
</body>
</html>
`
