import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, resultText, type AppCaller, type AppRef } from '../packages/agent-host/src/apps/external/runtime.js'
import { buildViewCsp } from '../packages/agent-host/src/views/csp.js'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { ALLOWED, decisionSummary, renderInline, renderMarkdown } from '../.centralu/apps/project-board/markdown.mjs'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { ANSWERS_MAX, answerFor, commentIdOf, markRecorded, saveAnswer, unrecorded } from '../.centralu/apps/project-board/answers.mjs'

describe("the owner's saved answers", () => {
  const save = (list: unknown[], number: number, text = 'x') => saveAnswer(list, { repository: 'o/r', number, text, now: `t${number}` }).list
  it('keeps every answer waiting when the list is full, and lets the oldest recorded ones go', () => {
    let list: unknown[] = []
    for (let n = 1; n <= ANSWERS_MAX; n++) list = markRecorded(save(list, n), 'o/r', n, `u${n}`, 'r').list
    list = save(list, ANSWERS_MAX + 1)
    expect(list).toHaveLength(ANSWERS_MAX)
    expect(answerFor(list, 'o/r', 1)).toBeNull()
    expect(unrecorded(list)).toEqual([expect.objectContaining({ number: ANSWERS_MAX + 1 })])
  })

  it('reads a comment address only for the same item', () => {
    expect(commentIdOf('https://github.com/O/R/issues/5#issuecomment-77', 'o/r', 5)).toEqual({ id: '77' })
    expect(commentIdOf('https://github.com/o/r/pull/5#issuecomment-77', 'o/r', 5)).toEqual({ id: '77' })
    expect(commentIdOf('https://github.com/o/r/issues/6#issuecomment-77', 'o/r', 5).problem).toMatch(/not on o\/r#5/)
    expect(commentIdOf('https://example.com/o/r/issues/5#issuecomment-77', 'o/r', 5).problem).toMatch(/is not the address of a comment/)
  })
})

/**
 * The board's reader (an issue or pull request read in the view, and a "Needs decision" item answered
 * from it). First the Markdown renderer, whose output the view sets as HTML: it must never let a
 * tag or attribute through that it did not write itself. Then the app, run by the real external-app
 * runtime against a fake `gh` that keeps threads in a JSON file and logs every call, so no real
 * issue is ever read or commented on here.
 */

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const allowed = ALLOWED as Record<string, string[]>
const md = (s: string, opts: Record<string, string> = { repo: 'ijun17/centralu', base: 'https://github.com/ijun17/centralu/issues/1' }) => renderMarkdown(s, opts) as string

/**
 * Every tag in `html`, and what is left when they are taken out. A `<` left over would be markup the
 * renderer did not write as a tag; text must carry it as `&lt;`.
 */
function tagsOf(html: string) {
  const tags: { name: string; closing: boolean; attrs: [string, string | null][] }[] = []
  const rest = html.replace(/<(\/?)([a-z0-9]+)((?:\s+[a-z-]+(?:="[^"<>]*")?)*)\s*>/g, (_, closing: string, name: string, attrs: string) => {
    tags.push({ name, closing: closing === '/', attrs: [...attrs.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)].map((m) => [m[1]!, m[2] ?? null]) })
    return ''
  })
  return { tags, rest }
}

/** Holds rendered HTML to the renderer's own list: tags, attributes, link schemes and image hosts. */
function expectSafe(html: string) {
  const { tags, rest } = tagsOf(html)
  expect(rest, `markup outside the renderer's tags in: ${html}`).not.toMatch(/[<>]/)
  for (const t of tags) {
    expect(Object.keys(allowed), `<${t.name}> in ${html}`).toContain(t.name)
    for (const [name, value] of t.attrs) {
      expect(allowed[t.name], `${name} on <${t.name}> in ${html}`).toContain(name)
      if (name === 'href') expect(value).toMatch(/^(https?:|mailto:)/)
      if (name === 'src') expect(value).toMatch(/^https:\/\/(github\.com|[a-z0-9-]+\.githubusercontent\.com)\//)
    }
  }
}

describe('the reader renders GitHub Markdown', () => {
  it('as GitHub shows a comment: headings, a newline as a line break, emphasis, code, links and references', () => {
    expect(md('## Decision needed\n**Question:** fold *it* into #406?\n**Recommendation:** ~~B~~ A, see owner/repo#12 and @someone')).toBe(
      [
        '<h2>Decision needed</h2>',
        '<p><strong>Question:</strong> fold <em>it</em> into <a href="https://github.com/ijun17/centralu/issues/406" class="ref" data-item="ijun17/centralu#406">#406</a>?<br>',
        '<strong>Recommendation:</strong> <del>B</del> A, see <a href="https://github.com/owner/repo/issues/12" class="ref" data-item="owner/repo#12">owner/repo#12</a> and <a href="https://github.com/someone" class="mention">@someone</a></p>',
      ].join('\n'),
    )
    expect(md('Use `a <b> c` and snake_case_name, https://example.com/a_(b).')).toBe(
      '<p>Use <code>a &lt;b&gt; c</code> and snake_case_name, <a href="https://example.com/a_(b)">https://example.com/a_(b)</a>.</p>',
    )
  })

  it('tables with alignment, task lists, nested lists, fenced code and quotes', () => {
    expect(md('| Left | Right |\n|:--|--:|\n| `a\\|b` | **x** |')).toBe(
      '<table><thead><tr><th class="align-left">Left</th><th class="align-right">Right</th></tr></thead><tbody><tr><td class="align-left"><code>a|b</code></td><td class="align-right"><strong>x</strong></td></tr></tbody></table>',
    )
    expect(md('- [x] done\n- [ ] open\n  - nested')).toBe(
      '<ul class="tasks"><li class="task-item"><input type="checkbox" disabled checked> done</li><li class="task-item"><input type="checkbox" disabled> open\n<ul><li>nested</li></ul></li></ul>',
    )
    expect(md('3. three\n4. four')).toBe('<ol start="3"><li>three</li><li>four</li></ol>')
    expect(md('```ts\nconst a = "<b>"\n```')).toBe('<pre><code class="language-ts">const a = &quot;&lt;b&gt;&quot;</code></pre>')
    expect(md('> quoted\n> on two lines')).toBe('<blockquote><p>quoted<br>\non two lines</p></blockquote>')
  })

  it('hides HTML comments as GitHub does (the templates are full of them), but not inside code', () => {
    expect(md('## Why\n\n<!-- The problem,\n in a sentence. -->\nBecause.\n\n```\n<!-- kept -->\n```')).toBe(
      '<h2>Why</h2>\n<p>Because.</p>\n<pre><code>&lt;!-- kept --&gt;</code></pre>',
    )
  })

  it('shows images only from GitHub, and any other image as a link', () => {
    expect(md('![shot](https://github.com/user-attachments/assets/abc)')).toBe(
      '<p><img src="https://github.com/user-attachments/assets/abc" alt="shot" loading="lazy" referrerpolicy="no-referrer"></p>',
    )
    expect(md('<img width="320" alt="x" src="https://user-images.githubusercontent.com/1/a.png">')).toBe(
      '<p><img src="https://user-images.githubusercontent.com/1/a.png" alt="x" width="320" loading="lazy" referrerpolicy="no-referrer"></p>',
    )
    // Another host would be the view asking a server it has no business with
    expect(md('![t](https://tracker.example/pixel.gif)')).toBe('<p><a href="https://tracker.example/pixel.gif" class="image-link">Image: t</a></p>')
    expect(md('![t](http://github.com/a.png)')).toBe('<p><a href="http://github.com/a.png" class="image-link">Image: t</a></p>')
  })

  // Each line below was written to get a script, a handler or a foreign load through
  const HOSTILE = [
    '<script>alert(1)</script>',
    '<SCRIPT SRC=https://evil.example/x.js></SCRIPT>',
    '<img src=x onerror=alert(1)>',
    '<img src="https://github.com/a.png" onerror="alert(1)">',
    '<img src="https://github.com/a.png"onerror="alert(1)">',
    '<img src="javascript:alert(1)">',
    '<svg onload=alert(1)><circle/></svg>',
    '<iframe src="https://evil.example"></iframe>',
    '<style>body{display:none}</style>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="jav&#x61;script:alert(1)">x</a>',
    '<a href=" javascript:alert(1)">x</a>',
    '<a href="java\tscript:alert(1)">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<a href="https://ok.example" onclick="alert(1)">x</a>',
    '<b onclick=alert(1)>bold</b>',
    '<details open ontoggle=alert(1)><summary>s</summary>x</details>',
    '[x](javascript:alert(1))',
    '[x](JAVASCRIPT:alert(1))',
    '[x](  javascript:alert(1) "t")',
    '[x](vbscript:msgbox)',
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
    '[x](https://ok.example "a\\" onmouseover=\\"alert(1)")',
    '[x](https://ok.example/"onmouseover="alert(1))',
    '![x](javascript:alert(1))',
    '![x" onerror="alert(1)](https://github.com/a.png)',
    '![x](https://github.com/a.png "t\\" onerror=\\"alert(1)")',
    '<https://ok.example/"onmouseover="alert(1)>',
    'https://ok.example/<script>',
    '<a href="https://ok.example">unclosed <b>bold',
    '</a></b></details></table></ul><script>',
    '0 forged placeholder 999',
    '&lt;script&gt; &#60;script&#62; &#x3C;img src=x onerror=alert(1)&#x3E;',
    '`` ` <script> ` ``',
    '| a | <script> |\n|---|---|\n| <img src=x onerror=alert(1)> | [x](javascript:1) |',
    '- [x] <img src=x onerror=alert(1)>\n  > <script>',
    '<!-- <script>alert(1)</script> --><script>alert(2)</script>',
    '<!--\n-->\n<img src=x onerror=alert(1)>',
    '<p align="center"><img src="https://github.com/a.png" onload="alert(1)"></p>',
  ]

  it.each(HOSTILE)('writes only its own tags and attributes for %j', (input) => {
    const html = md(input)
    expectSafe(html)
    // A handler written out as text (`onerror=` escaped in a paragraph or an alt) is only text; expectSafe holds the tags
    expect(html).not.toMatch(/<(script|svg|iframe|style)/i)
    expect(html).not.toMatch(/href="(?!https?:|mailto:)/)
    expectSafe(renderInline(input, { repo: 'ijun17/centralu' }))
  })

  /*
   * A sweep rather than a list: fragments of Markdown and HTML, joined at random in their thousands,
   * each output held to the list. A seeded generator, so a failure names an input that fails again.
   */
  it('writes only its own tags and attributes for 3,000 random mixtures of Markdown and HTML', () => {
    const parts = [
      '<', '>', '"', "'", '`', '``', '[', ']', '(', ')', '!', '*', '_', '~~', '#', '#12', '@a', '\\', '\n', '\n\n', ' ', '|', '---', '> ', '- ', '1. ',
      '- [ ] ', '```', '    ', 'javascript:', 'https://github.com/a.png', 'https://x.example/', 'data:', '<img', ' src=', ' onerror=', 'alert(1)', '<a href=',
      '</a>', '<b>', '</b>', '<script>', '<details>', '</details>', '<summary>', '<!--', '-->', '&', '&#', ';', 'x', 'word', '', '', '\0', '\t',
    ]
    let seed = 0x2f6e
    const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed)
    for (let n = 0; n < 3000; n++) {
      const len = 1 + (next() % 40)
      const input = Array.from({ length: len }, () => parts[next() % parts.length]).join('')
      expectSafe(md(input))
    }
  })

  /*
   * A thread is read whole and rendered in the app's one process: a comment built to be slow must
   * not stall it. Before the scanner stopped copying the rest of the text per character and links
   * found their brackets in one pass, 50,000 `[` took a quarter of a second.
   */
  it.each([
    ['[', 50_000],
    ['[a ', 30_000],
    ['`a', 30_000],
    ['*a ', 30_000],
    ['_a ', 30_000],
    ['<a ', 20_000],
    ['![a](b ', 20_000],
    ['> ', 5_000],
    ['- ', 5_000],
    ['| a ', 20_000],
    ['line\n', 50_000],
  ] as const)('renders %j repeated %i times in bounded time', (unit, times) => {
    const started = performance.now()
    const html = md(unit.repeat(times))
    // Generous for a loaded machine; the measured times are 2–80 ms
    expect(performance.now() - started).toBeLessThan(2_000)
    expectSafe(html)
  })

  it('finds the latest decision summary and whether the owner answered after it', () => {
    const summary = (date: string, q: string) => ({ body: `## Decision needed (summary, ${date})\n**Question:** ${q}\n**Options:** A · B\n**Recommendation:** A, because\nit is smaller.`, url: `u-${date}` })
    expect(decisionSummary([{ body: 'unrelated' }])).toBeNull()
    expect(decisionSummary([summary('2026-10-01', 'old?'), { body: 'chatter' }, summary('2026-10-12', 'new?')])).toEqual({
      date: '2026-10-12',
      question: 'new?',
      options: 'A · B',
      recommendation: 'A, because\nit is smaller.',
      url: 'u-2026-10-12',
      answered: null,
    })
    const answered = decisionSummary([summary('2026-10-12', 'q?'), { body: '**Decision (owner, 2026-10-12):** A.', createdAt: '2026-10-12T09:00:00Z' }])
    expect(answered.answered).toBe('2026-10-12T09:00:00Z')
    // An answer before the latest summary does not count for it
    expect(decisionSummary([{ body: 'Decision (owner, 2026-10-01): B' }, summary('2026-10-12', 'q?')]).answered).toBeNull()
  })
})

// --- The app, against a fake gh ---------------------------------------------------------------------

const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const stdin = args.includes('--input') ? fs.readFileSync(0, 'utf8') : null
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, stdin }) + '\n')
const st = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'))
const save = () => fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(st))
const fail = (stderr, code = 1, stdout = '') => { process.stdout.write(stdout); process.stderr.write(stderr); process.exit(code) }
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
if (st.mode === 'offline') fail('error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n')
const out = (data) => process.stdout.write(JSON.stringify({ data }))
if (args[0] === 'api' && args[1] === '-X' && args[2] === 'POST') {
  const m = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(args[3])
  const t = m && st.threads[m[1] + '#' + m[2]]
  if (!t) fail('gh: Not Found (HTTP 404)\n', 1, JSON.stringify({ message: 'Not Found' }))
  if (st.lockedPost) fail('gh: Unable to create comment because issue is locked. (HTTP 403)\n', 1, '{}')
  const { body } = JSON.parse(stdin)
  const n = t.comments.length + 1
  const c = { id: 'IC_new' + n, restId: 9000 + n, url: t.url + '#issuecomment-' + (9000 + n), body, createdAt: '2026-10-12T10:00:0' + (n % 10) + 'Z', author: { login: 'owner' } }
  t.comments.push(c)
  save()
  process.stdout.write(JSON.stringify({ id: c.restId, node_id: c.id, html_url: c.url, body, created_at: c.createdAt, user: { login: 'owner' } }))
  process.exit(0)
}
// One comment by its id, as GET repos/{repo}/issues/comments/{id} answers it
const one = args[0] === 'api' && /^repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/.exec(args[1])
if (one) {
  for (const [key, t] of Object.entries(st.threads)) {
    const c = t.comments.find((x) => String(x.restId) === one[2])
    if (c) {
      process.stdout.write(JSON.stringify({ id: c.restId, issue_url: 'https://api.github.com/repos/' + key.replace('#', '/issues/'), html_url: c.url, body: c.body, user: c.author }))
      process.exit(0)
    }
  }
  fail('gh: Not Found (HTTP 404)\n', 1, JSON.stringify({ message: 'Not Found' }))
}
const v = {}
let query = ''
for (let i = 2; i < args.length; i += 2) {
  const [k, ...rest] = args[i + 1].split('=')
  if (k === 'query') query = rest.join('=')
  else v[k] = args[i] === '-F' ? Number(rest.join('=')) : rest.join('=')
}
if (query.includes('comments(last:')) {
  const t = st.threads[v.owner + '/' + v.name + '#' + v.number]
  if (!t) fail('gh: Could not resolve to an issue or pull request with the number of ' + v.number + '.\n', 1, JSON.stringify({ data: { repository: { issueOrPullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to an issue or pull request with the number of ' + v.number + '.' }] }))
  // threadDelayMs: a slow read, answered with the thread as it was when the read began
  if (st.threadDelayMs) sleep(st.threadDelayMs)
  const end = v.before ? Number(v.before) : t.comments.length
  const start = Math.max(0, end - 100)
  const { comments, ...rest } = t
  out({ repository: { issueOrPullRequest: { ...rest, comments: { totalCount: comments.length, pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) }, nodes: comments.slice(start, end) } } } })
} else if (query.includes('projectV2(number')) {
  out({ repositoryOwner: { projectV2: {
    id: 'PVT_test', title: 'Centralu', url: 'https://github.com/users/ijun17/projects/1',
    fields: { nodes: st.fields },
    items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: st.items.map((i) => ({ id: i.id, isArchived: false, content: i.content, fieldValues: { nodes: Object.entries(i.values).map(([f, name]) => ({ name, field: { name: f } })) } })) },
  } } })
} else fail('fake gh: unexpected call ' + JSON.stringify(args) + '\n')
`

const opt = (prefix: string, names: string[]) => names.map((name, n) => ({ id: `${prefix}${n}`, name }))
const content = (number: number, title: string) => ({
  __typename: 'Issue',
  id: `I_${number}`,
  number,
  title,
  url: `https://github.com/ijun17/centralu/issues/${number}`,
  state: 'OPEN',
  repository: { nameWithOwner: 'ijun17/centralu' },
})
const comment = (n: number, body = `Comment ${n}`) => ({ id: `IC_${n}`, url: `https://github.com/ijun17/centralu/issues/113#issuecomment-${n}`, body, createdAt: `2026-10-0${1 + (n % 9)}T08:00:00Z`, author: { login: n % 2 ? 'coordinator' : 'someone' } })
const thread = (number: number, title: string, comments: unknown[], extra: Record<string, unknown> = {}) => ({
  __typename: 'Issue',
  number,
  title,
  url: `https://github.com/ijun17/centralu/issues/${number}`,
  state: 'OPEN',
  stateReason: null,
  body: `Body of #${number}\n\n| a | b |\n|---|---|\n| 1 | 2 |`,
  createdAt: '2026-09-30T08:00:00Z',
  author: { login: 'ijun17' },
  labels: { nodes: [{ name: 'enhancement' }, { name: 'ui' }] },
  comments,
  ...extra,
})
const SUMMARY = '## Decision needed (summary, 2026-10-12)\n**Question:** fold it into #406?\n**Options:** A · B\n**Recommendation:** A.'

function state() {
  return {
    mode: 'ok',
    fields: [
      { id: 'F_status', name: 'Status', options: opt('s', ['Needs decision', 'Ready', 'Done']) },
      { id: 'F_priority', name: 'Priority', options: opt('p', ['High', 'Medium', 'Low']) },
      { id: 'F_area', name: 'Area', options: opt('a', ['UI', 'Host']) },
    ],
    items: [
      { id: 'item-113', content: content(113, 'Narrow-window reading'), values: { Status: 'Needs decision', Priority: 'Medium', Area: 'UI' } },
      { id: 'item-101', content: content(101, 'Worktree management'), values: { Status: 'Needs decision', Priority: 'High', Area: 'Host' } },
      { id: 'item-8', content: content(8, 'Polish the design'), values: { Status: 'Ready', Priority: 'Low', Area: 'UI' } },
    ],
    threads: {
      'ijun17/centralu#113': thread(113, 'Narrow-window reading', [comment(1), comment(2, SUMMARY), comment(3)]),
      'ijun17/centralu#101': thread(101, 'Worktree management', [comment(1, SUMMARY), comment(2, '**Decision (owner, 2026-10-12):** A.')]),
      'ijun17/centralu#8': thread(8, 'Polish the design', []),
    } as Record<string, ReturnType<typeof thread>>,
  }
}

const ref: AppRef = { projectId: 'p1', appId: 'project-board' }
const screen: AppCaller = { kind: 'view' }
let root = ''
let rt: ExternalApps | null = null
let statePath = ''
let logPath = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-project-board-reader-')))
  mkdirSync(join(root, 'bin'))
  mkdirSync(join(root, 'data'))
  mkdirSync(join(root, 'node'))
  symlinkSync(process.execPath, join(root, 'node', 'node'))
  writeFileSync(join(root, 'bin', 'gh'), FAKE_GH)
  chmodSync(join(root, 'bin', 'gh'), 0o755)
  statePath = join(root, 'state.json')
  logPath = join(root, 'gh.log')
  writeFileSync(statePath, JSON.stringify(state()))
  writeFileSync(logPath, '')
})

afterEach(async () => {
  await rt?.dispose()
  rt = null
  rmSync(root, { recursive: true, force: true })
})

function runtime() {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: REPO_ROOT, trusted: true }],
    dataRoot: join(root, 'data'),
    reservedIds: [],
    env: { PATH: `${join(root, 'bin')}:${join(root, 'node')}`, HOME: root, FAKE_GH_STATE: statePath, FAKE_GH_LOG: logPath },
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 5_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  return rt
}

const agent: AppCaller = { kind: 'session', sessionId: 's1' }
async function call(name: string, args: Record<string, unknown> = {}, caller: AppCaller = screen) {
  const out = await rt!.call(ref, name, args, caller)
  if (!out.result) throw new Error(`${name} did not answer: ${out.status} ${out.error}`)
  return { text: resultText(out.result), isError: out.result.isError === true, data: out.result.structuredContent as any }
}
const ghCalls = () =>
  readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { args: string[]; stdin: string | null })
const threadReads = () => ghCalls().filter((c) => c.args.some((a) => a.includes('comments(last:')))
const posts = () => ghCalls().filter((c) => c.args[2] === 'POST')
const patch = (fn: (s: ReturnType<typeof state>) => void) => {
  const s = JSON.parse(readFileSync(statePath, 'utf8'))
  fn(s)
  writeFileSync(statePath, JSON.stringify(s))
}

describe.skipIf(process.platform === 'win32')('the board app reads and answers items', { timeout: 60_000 }, () => {
  it('passes check, and its screen declares GitHub image hosts, and only those, in the CSP Centralu reads', async () => {
    const r = await runtime().check(ref)
    expect(r.text.split('\n').filter((l) => l.startsWith('- problem'))).toEqual([])
    for (const line of [
      'read_item — reads, app',
      'decision_summaries — reads, app',
      'save_answer — changes, app',
      'delete_answer — changes, app',
      'list_owner_answers — reads, model',
      'mark_answer_recorded — changes, model',
    ])
      expect(r.text).toContain(line)
    // Nothing on the screen posts the owner's text to GitHub any more
    expect(r.text).not.toMatch(/post_answer|preview_answer/)
    const doc = (await rt!.readResource(ref, 'ui://project-board/index.html')).contents[0] as { text: string; _meta?: { ui?: { csp?: Record<string, string[]> } } }
    expect(doc.text).toContain('McpApp')
    expect(doc._meta?.ui?.csp).toEqual({ resourceDomains: ['https://github.com', 'https://*.githubusercontent.com'] })
    const csp = buildViewCsp(doc._meta!.ui!.csp)
    expect(csp.dropped).toEqual([])
    expect(csp.policy).toContain('img-src data: blob: https://github.com https://*.githubusercontent.com')
    expect(csp.policy).toContain("connect-src 'none'")
  })

  it('reads an item with its labels, board fields, rendered body and comments, newest last', async () => {
    runtime()
    const r = await call('read_item', { item: '#113' })
    expect(r.isError).toBe(false)
    expect(r.text).toBe('#113 Narrow-window reading (issue, open): 3 comments, 3 shown.')
    expect(r.data.item).toMatchObject({
      ref: '#113',
      title: 'Narrow-window reading',
      state: 'OPEN',
      labels: ['enhancement', 'ui'],
      inProject: true,
      status: 'Needs decision',
      priority: 'Medium',
      area: 'UI',
      author: 'ijun17',
    })
    expect(r.data.item.html).toContain('<table><thead><tr><th>a</th><th>b</th></tr></thead>')
    expect(r.data.comments.map((c: { id: string }) => c.id)).toEqual(['IC_1', 'IC_2', 'IC_3'])
    expect(r.data.comments[1].html).toContain('<h2>Decision needed (summary, 2026-10-12)</h2>')
    expect(r.data.needsDecision).toBe(true)
    expect(r.data.decision).toMatchObject({ date: '2026-10-12', recommendation: 'A.', answered: null })
    expect(r.data.decision.question).toContain('data-item="ijun17/centralu#406"')

    // An item outside the project still reads, without board fields and without an answer box
    const other = await call('read_item', { item: 'https://github.com/ijun17/centralu/issues/8' })
    expect(other.data.item).toMatchObject({ inProject: true, status: 'Ready' })
    expect(other.data.needsDecision).toBe(false)
    patch((s) => (s.threads['ijun17/centralu#77'] = thread(77, 'Not on the board', [])))
    expect((await call('read_item', { item: 77 })).data.item).toMatchObject({ inProject: false, status: null })

    const missing = await call('read_item', { item: 9999 })
    expect(missing.data).toMatchObject({ ok: false, error: { kind: 'not-found', message: '#9999 is not an issue or pull request this GitHub login can see.' } })
  })

  /*
   * A thread is read from its newest page back, 100 comments a page, up to 1,000. Swept across the
   * page edges and the limit: every comment arrives once and in order, and a longer thread keeps
   * its latest 1,000 and says how many there are.
   */
  it.each([0, 1, 99, 100, 101, 200, 201, 999, 1000, 1001, 1250])('reads a thread of %i comments whole, in order, up to the latest 1,000', async (n) => {
    runtime()
    patch((s) => (s.threads['ijun17/centralu#8']!.comments = Array.from({ length: n }, (_, i) => comment(i + 1))))
    const r = await call('read_item', { item: 8, comments: 1000 })
    const kept = Math.min(n, 1000)
    expect(r.data.totalComments).toBe(n)
    expect(r.data.loadedComments).toBe(kept)
    const ids = r.data.comments.map((c: { id: string }) => c.id)
    expect(ids).toEqual(Array.from({ length: kept }, (_, i) => `IC_${n - kept + i + 1}`))
    // One page of 100 per read, and never a page past the 1,000th comment
    expect(threadReads()).toHaveLength(Math.max(1, Math.ceil(kept / 100)))
    // By default the view gets the latest 50
    const short = await call('read_item', { item: 8 })
    expect(short.data.comments.map((c: { id: string }) => c.id)).toEqual(ids.slice(-50))
  })

  it('answers a second read from the short cache, and asks GitHub again on refresh', async () => {
    runtime()
    await call('read_item', { item: 113 })
    await call('read_item', { item: '#113' })
    expect(threadReads()).toHaveLength(1)
    await call('read_item', { item: 113, refresh: true })
    expect(threadReads()).toHaveLength(2)
  })

  it('lists what each decision asks, highest priority first, and whether it was answered after', async () => {
    runtime()
    const r = await call('decision_summaries')
    expect(r.data.ok).toBe(true)
    expect(r.text).toBe('2 items with Status Needs decision.')
    expect(r.data.items.map((i: { ref: string }) => i.ref)).toEqual(['#101', '#113'])
    expect(r.data.items[0].decision).toMatchObject({ date: '2026-10-12', answered: '2026-10-03T08:00:00Z' })
    expect(r.data.items[1].decision).toMatchObject({ answered: null, recommendation: 'A.' })
    expect(r.data.items[1].decision.question).toContain('fold it into')
  })

  /*
   * The repository is public and the owner answers in their own words and language: an answer from
   * the screen is saved on this computer, in the app's data folder (a temporary folder here), and
   * never reaches GitHub. An agent records the decision in English and marks the answer recorded.
   */
  const KOREAN = 'A로 갑니다. #406에 합칩니다.'
  const answersFile = () => filesNamed(join(root, 'data'), 'owner-answers.json')

  it("saves the owner's answer on this computer only: nothing goes to GitHub, and the item shows it", async () => {
    runtime()
    const r = await call('save_answer', { item: 113, text: KOREAN, title: 'Narrow-window reading' })
    expect(r.isError).toBe(false)
    expect(r.text).toBe('Saved the answer on #113 on this computer only; nothing went to GitHub. An agent records the decision on #113 in English.')
    expect(posts()).toEqual([])
    const [file] = answersFile()
    expect(file).toBeDefined()
    expect(file!.startsWith(join(root, 'data'))).toBe(true)
    expect(JSON.parse(readFileSync(file!, 'utf8')).answers).toEqual([
      expect.objectContaining({ repository: 'ijun17/centralu', number: 113, title: 'Narrow-window reading', text: KOREAN, recordedAt: null, recordedUrl: null }),
    ])
    // Never in the app's folder, which is in the (public) repository
    expect(filesNamed(join(REPO_ROOT, '.centralu/apps/project-board'), 'owner-answers.json')).toEqual([])

    const read = await call('read_item', { item: 113 })
    expect(read.data.ownerAnswer).toMatchObject({ text: KOREAN, recordedAt: null })
    const summaries = await call('decision_summaries')
    const row = (n: number) => summaries.data.items.find((i: { number: number }) => i.number === n)
    expect(row(113).ownerAnswer).toMatchObject({ text: KOREAN, recordedAt: null })
    expect(row(101).ownerAnswer).toBeNull()

    // Saving again changes the answer waiting, it does not add another
    const again = await call('save_answer', { item: '#113', text: 'B로 바꿉니다.' })
    expect(again.text).toMatch(/^Saved the changed answer on #113/)
    expect(JSON.parse(readFileSync(file!, 'utf8')).answers.map((a: { text: string }) => a.text)).toEqual(['B로 바꿉니다.'])
    const empty = await call('save_answer', { item: 113, text: '  \n ' })
    expect(empty.isError).toBe(true)
    expect(empty.text).toBe('Not saved: The answer is empty; write it first.')
    expect(posts()).toEqual([])
  })

  it('shows an agent the answers not recorded yet, on the decision list and on their own', async () => {
    runtime()
    await call('save_answer', { item: 113, text: KOREAN })
    const list = await call('list_owner_answers', {}, agent)
    expect(list.data.count).toBe(1)
    expect(list.data.summary).toMatch(/^1 owner answer not recorded yet\. For each: post the decision on its issue in English with comment/)
    expect(list.data.answers).toEqual([expect.stringMatching(new RegExp(`^#113 Narrow-window reading — answered, not recorded yet, saved \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC\\n  ${KOREAN}$`))])
    const needs = await call('list_needs_decision', {}, agent)
    expect(needs.data.summary).toBe('Centralu: 2 items with Status Needs decision, 1 answered, not recorded yet (list_owner_answers).')
    expect(needs.data.items).toEqual(['#101 Worktree management — Needs decision · High · Host', '#113 Narrow-window reading — Needs decision · Medium · UI · answered, not recorded yet'])
  })

  it('lets the owner delete an answer while it is not recorded', async () => {
    runtime()
    await call('save_answer', { item: 113, text: KOREAN })
    const r = await call('delete_answer', { item: 113 })
    expect(r.text).toBe('Deleted the answer on #113.')
    expect(r.data.answer).toBeNull()
    expect((await call('read_item', { item: 113 })).data.ownerAnswer).toBeNull()
    expect((await call('delete_answer', { item: 113 })).text).toBe('Not deleted: #113: There is no saved answer for it.')
    expect((await call('list_owner_answers', {}, agent)).data.count).toBe(0)
  })

  it('records the decision in English through comment, then marks the answer recorded with that comment', async () => {
    runtime()
    await call('save_answer', { item: 113, text: KOREAN })
    // The owner's words as written are refused: comment holds agents to English
    const raw = await call('comment', { item: 113, body: KOREAN }, agent)
    expect(raw.isError).toBe(true)
    expect(posts()).toEqual([])
    const posted = await call('comment', { item: 113, body: '**Decision (owner, 2026-10-12):** A. Fold it into #406.' }, agent)
    expect(posted.isError).toBe(false)
    const url = posted.data.comment.url as string
    expect(url).toBe('https://github.com/ijun17/centralu/issues/113#issuecomment-9004')

    const marked = await call('mark_answer_recorded', { item: 113, url }, agent)
    expect(marked.isError).toBe(false)
    expect(marked.text).toBe(`Marked the owner's answer on #113 recorded: ${url}`)
    expect((await call('list_owner_answers', {}, agent)).data.count).toBe(0)
    expect((await call('list_owner_answers', { all: true }, agent)).data.answers[0]).toMatch(/^#113 Narrow-window reading — recorded \d{4}-\d{2}-\d{2}: https:\/\/github\.com\/ijun17\/centralu\/issues\/113#issuecomment-9004\n/)
    expect((await call('list_needs_decision', {}, agent)).data.items[1]).toBe('#113 Narrow-window reading — Needs decision · Medium · UI')
    expect((await call('read_item', { item: 113 })).data.ownerAnswer).toMatchObject({ text: KOREAN, recordedUrl: url })
    // Recorded is history: not deleted from the screen, and a new answer starts beside it
    expect((await call('delete_answer', { item: 113 })).text).toBe('Not deleted: #113: Its answer is recorded on GitHub already; it is not deleted here.')
    // Only the agent's English comment went to GitHub
    expect(posts().map((p) => JSON.parse(p.stdin!).body)).toEqual(['**Decision (owner, 2026-10-12):** A. Fold it into #406.'])
  })

  it('marks an answer recorded only with an English decision comment on that same item', async () => {
    runtime()
    await call('save_answer', { item: 113, text: KOREAN })
    const mark = (url: string, item = 113) => call('mark_answer_recorded', { item, url }, agent)
    expect((await mark('not a url')).text).toBe('Not marked: "not a url" is not the address of a comment on GitHub (https://github.com/owner/name/issues/N#issuecomment-ID).')
    expect((await mark('https://github.com/ijun17/centralu/issues/8#issuecomment-1')).text).toBe(
      'Not marked: https://github.com/ijun17/centralu/issues/8#issuecomment-1 is a comment on ijun17/centralu#8, not on ijun17/centralu#113.',
    )
    expect((await mark('https://github.com/ijun17/centralu/issues/113#issuecomment-123')).text).toBe('Not marked: GitHub has no comment 123 on #113.')
    const plain = await call('comment', { item: 113, body: 'Going with A.' }, agent)
    expect((await mark(plain.data.comment.url)).text).toBe('Not marked: The comment does not hold "Decision (owner, YYYY-MM-DD)", the form a decision is recorded in (CONTRIBUTING.md).')
    expect((await mark('https://github.com/ijun17/centralu/issues/101#issuecomment-1', 101)).text).toBe('Not marked: #101 has no answer waiting to be recorded.')
    expect((await call('list_owner_answers', {}, agent)).data.count).toBe(1)
  })

  it('posts an agent comment on the item, answers it rendered, and the next read shows it', async () => {
    runtime()
    await call('read_item', { item: 113 }) // cached without the comment
    const body = '**Decision (owner, 2026-10-12):** A.\n\nFold it into #406.'
    const r = await call('comment', { item: '#113', body }, agent)
    expect(r.isError).toBe(false)
    expect(r.text).toBe('Posted a comment on #113: https://github.com/ijun17/centralu/issues/113#issuecomment-9004.')
    expect(r.data.comment).toMatchObject({ id: 'IC_new4', author: 'owner' })
    expect(r.data.comment.html).toContain('<strong>Decision (owner, 2026-10-12):</strong> A.')
    // The text went on stdin, never on the command line
    expect(posts()).toEqual([{ args: ['api', '-X', 'POST', 'repos/ijun17/centralu/issues/113/comments', '--input', '-'], stdin: JSON.stringify({ body }) }])
    const after = await call('read_item', { item: 113 })
    expect(after.data.comments.map((c: { id: string }) => c.id)).toEqual(['IC_1', 'IC_2', 'IC_3', 'IC_new4'])
    const summaries = await call('decision_summaries')
    expect(summaries.data.items.find((i: { ref: string }) => i.ref === '#113').decision.answered).toBe('2026-10-12T10:00:04Z')
  })

  /*
   * A read that began before a comment was posted ends after it with the thread as it was. Held back
   * by the fake, released after the post: it must not go into the cache, or the reader would show
   * the item without the comment just posted until the cache ran out.
   */
  it('a read that started before a post never refills the cache with the thread from before it', async () => {
    runtime()
    patch((s) => ((s as unknown as { threadDelayMs: number }).threadDelayMs = 1500))
    const slow = call('read_item', { item: 113 })
    // The slow read is under way (its gh call is logged) before the post goes out
    await expect.poll(() => threadReads().length, { timeout: 10_000 }).toBe(1)
    patch((s) => ((s as unknown as { threadDelayMs: number }).threadDelayMs = 0))
    expect((await call('comment', { item: 113, body: 'An answer.' }, agent)).isError).toBe(false)
    const stale = await slow
    expect(stale.data.comments.map((c: { id: string }) => c.id)).toEqual(['IC_1', 'IC_2', 'IC_3'])
    const fresh = await call('read_item', { item: 113 })
    expect(fresh.data.comments.map((c: { id: string }) => c.id)).toEqual(['IC_1', 'IC_2', 'IC_3', 'IC_new4'])
  })

  it('says why a comment was not posted, and that an interrupted one may have been', async () => {
    runtime()
    patch((s) => ((s as unknown as { lockedPost: boolean }).lockedPost = true))
    const locked = await call('comment', { item: 113, body: 'An answer.' }, agent)
    expect(locked.isError).toBe(true)
    expect(locked.text).toBe('GitHub refused the comment on ijun17/centralu#113: Unable to create comment because issue is locked. (HTTP 403). Nothing was posted.')
    const gone = await call('comment', { item: 9999, body: 'An answer.' }, agent)
    expect(gone.text).toBe('ijun17/centralu#9999 is not an issue or pull request this GitHub login can see. Nothing was posted.')
    patch((s) => (s.mode = 'offline'))
    const offline = await call('comment', { item: 113, body: 'An answer.' }, agent)
    expect(offline.isError).toBe(true)
    expect(offline.text).toContain('GitHub could not be reached')
    expect(offline.text).toContain('The comment may have been posted anyway: read the item again before posting it a second time.')
    expect((await call('read_item', { item: 113 })).data).toMatchObject({ ok: false, error: { kind: 'network' } })
  })
})

function filesNamed(dir: string, name: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesNamed(join(dir, e.name), name) : e.name === name ? [join(dir, e.name)] : []))
}
