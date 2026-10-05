import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, resultText, type AppCaller, type AppRef } from '../packages/agent-host/src/apps/external/runtime.js'

/**
 * The project board app committed with this repository (`.centralu/apps/project-board`), run by
 * the real external-app runtime against a **fake `gh`** on PATH. The fake answers the same GraphQL
 * the app sends and keeps the project in a JSON file, so a write is visible to the next read the way
 * it is on GitHub, and every call is logged so a test can see what reached "GitHub".
 *
 * The live checks against the real project (list, needs decision, #8 round trip) are in the pull
 * request that added the app; they need the person's own gh login and are not run here.
 */

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const ref: AppRef = { projectId: 'p1', appId: 'project-board' }
const agent: AppCaller = { kind: 'session', sessionId: 's1' }
const screen: AppCaller = { kind: 'view' }

const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\n')
const st = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'))
const save = () => fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(st))
const fail = (stderr, code = 1, stdout = '') => { process.stdout.write(stdout); process.stderr.write(stderr); process.exit(code) }
if (st.mode === 'offline') fail('error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n')
if (st.mode === 'logged-out') fail('To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n', 4)
if (st.mode === 'no-access') fail('gh: Could not resolve to a ProjectV2 with the number 1.\n', 1, JSON.stringify({ data: { repositoryOwner: { projectV2: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a ProjectV2 with the number 1.' }] }))
if (st.mode === 'no-scope') fail('gh: Your token has not been granted the required scopes to execute this query.\n', 1, JSON.stringify({ errors: [{ type: 'INSUFFICIENT_SCOPES', message: "Your token has not been granted the required scopes to execute this query. The 'id' field requires one of the following scopes: ['read:project']" }] }))
const v = {}
let query = ''
for (let i = 2; i < args.length; i += 2) {
  const [k, ...rest] = args[i + 1].split('=')
  if (k === 'query') query = rest.join('=')
  else v[k] = args[i] === '-F' ? Number(rest.join('=')) : rest.join('=')
}
const out = (data) => process.stdout.write(JSON.stringify({ data }))
const fieldNode = (f) => ({ id: f.id, name: f.name, options: f.options.map((o) => ({ id: o.id, name: o.name })) })
const graphqlError = (type, message) => fail('gh: ' + message + '\n', 1, JSON.stringify({ data: null, errors: [{ type, message }] }))
if (query.startsWith('mutation') && st.mode === 'read-only') graphqlError('FORBIDDEN', 'Resource not accessible by personal access token')
// delayMs: a slow write, so writes that were not one at a time would overlap
if (query.startsWith('mutation') && st.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, st.delayMs)
if (query.includes('updateProjectV2ItemFieldValue')) {
  if ((st.failItems ?? []).includes(v.item)) graphqlError('UNPROCESSABLE', 'Could not update the item ' + v.item)
  const item = st.items.find((i) => i.id === v.item)
  const field = st.fields.find((f) => f.id === v.field)
  // ignoreWrites: GitHub says yes but keeps the old value, which only the read-back can see
  if (!(st.ignoreWrites ?? []).includes(v.item)) item.values[field.name] = field.options.find((o) => o.id === v.option).name
  save()
  out({ updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } })
} else if (query.includes('addProjectV2ItemById')) {
  const c = st.repo.find((x) => x.id === v.content)
  const id = 'item-' + c.number
  // lag: GitHub lists a newly added item only after a few reads, as it did live on 2026-10-04
  st.items.push({ id, content: c, values: {}, hiddenReads: st.lag ?? 0 })
  save()
  out({ addProjectV2ItemById: { item: { id } } })
} else if (query.includes('issueOrPullRequest')) {
  const c = st.repo.find((x) => x.number === v.number)
  if (!c) fail('gh: Could not resolve to an issue or pull request with the number of ' + v.number + '.\n', 1, JSON.stringify({ data: { repository: { issueOrPullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to an issue or pull request with the number of ' + v.number + '.' }] }))
  out({ repository: { issueOrPullRequest: { __typename: c.__typename, id: c.id, number: c.number, title: c.title, url: c.url } } })
} else if (query.includes('projectV2(number')) {
  if (v.number !== 1) fail('gh: Could not resolve to a ProjectV2 with the number ' + v.number + '.\n', 1, JSON.stringify({ data: { repositoryOwner: { projectV2: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a ProjectV2 with the number ' + v.number + '.' }] }))
  const start = v.after ? Number(v.after) : 0
  if (start === 0 && st.items.some((i) => i.hiddenReads > 0)) {
    for (const i of st.items) if (i.hiddenReads > 0) i.hiddenReads -= 1
    save()
  }
  const visible = st.items.filter((i) => !(i.hiddenReads > 0))
  const page = visible.slice(start, start + 2)
  const more = start + 2 < visible.length
  out({ repositoryOwner: { projectV2: {
    id: 'PVT_test', title: 'Centralu', url: 'https://github.com/users/ijun17/projects/1',
    fields: { nodes: [{}, ...st.fields.map(fieldNode)] },
    items: {
      pageInfo: { hasNextPage: more, endCursor: more ? String(start + 2) : null },
      nodes: page.map((i) => ({ id: i.id, isArchived: !!i.archived, content: i.content, fieldValues: { nodes: [{}, ...Object.entries(i.values).map(([f, name]) => ({ name, field: { name: f } }))] } })),
    },
  } } })
} else fail('fake gh: unexpected call ' + JSON.stringify(args) + '\n')
`

const opt = (prefix: string, names: string[]) => names.map((name, n) => ({ id: `${prefix}${n}`, name }))
const issue = (number: number, title: string) => ({
  __typename: 'Issue',
  id: `I_${number}`,
  number,
  title,
  url: `https://github.com/ijun17/centralu/issues/${number}`,
  state: 'OPEN',
  repository: { nameWithOwner: 'ijun17/centralu' },
})

function project() {
  return {
    mode: 'ok',
    fields: [
      // Not GitHub's order on purpose: the decision column comes first whatever the field's order is
      { id: 'F_status', name: 'Status', options: opt('s', ['Ready', 'Needs decision', 'In progress', 'In review', 'On hold', 'Done']) },
      { id: 'F_priority', name: 'Priority', options: opt('p', ['High', 'Medium', 'Low']) },
      { id: 'F_area', name: 'Area', options: opt('a', ['UI', 'Host', 'Apps', 'Design']) },
    ],
    items: [
      { id: 'item-280', content: issue(280, 'Agents survive restarts'), values: { Status: 'In progress', Priority: 'High', Area: 'Host' } },
      { id: 'item-113', content: issue(113, 'Narrow-window reading'), values: { Status: 'Needs decision', Priority: 'Medium', Area: 'UI' } },
      { id: 'item-8', content: issue(8, 'Polish the overall design'), values: { Status: 'On hold', Priority: 'Low', Area: 'Design' } },
      { id: 'item-101', content: issue(101, 'Worktree management'), values: { Status: 'Needs decision', Priority: 'Low', Area: 'Host' } },
      { id: 'item-old', content: issue(5, 'Archived long ago'), values: { Status: 'Done' }, archived: true },
    ],
    repo: [issue(42, 'A new issue'), { ...issue(43, 'A pull request'), __typename: 'PullRequest', url: 'https://github.com/ijun17/centralu/pull/43', isDraft: false }],
  }
}

let root = ''
let rt: ExternalApps | null = null
let statePath = ''
let logPath = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-project-board-')))
  mkdirSync(join(root, 'bin'))
  mkdirSync(join(root, 'data'))
  mkdirSync(join(root, 'node'))
  symlinkSync(process.execPath, join(root, 'node', 'node'))
  writeFileSync(join(root, 'bin', 'gh'), FAKE_GH)
  chmodSync(join(root, 'bin', 'gh'), 0o755)
  statePath = join(root, 'project.json')
  logPath = join(root, 'gh.log')
  writeFileSync(statePath, JSON.stringify(project()))
  writeFileSync(logPath, '')
})

afterEach(async () => {
  await rt?.dispose()
  rt = null
  rmSync(root, { recursive: true, force: true })
})

/** The runtime the host uses, on this repository, with `gh` resolving to the fake (or to nothing) */
function runtime(withGh = true) {
  // node through a link of its own, so the folder node lives in (often Homebrew's, which holds the
  // real gh too) is never on this PATH
  const path = withGh ? `${join(root, 'bin')}:${join(root, 'node')}` : join(root, 'node')
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: REPO_ROOT, trusted: true }],
    dataRoot: join(root, 'data'),
    reservedIds: [],
    env: { PATH: path, HOME: root, FAKE_GH_STATE: statePath, FAKE_GH_LOG: logPath },
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 5_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  return rt
}

async function call(name: string, args: Record<string, unknown> = {}, caller: AppCaller = agent) {
  const out = await rt!.call(ref, name, args, caller)
  if (!out.result) throw new Error(`${name} did not answer: ${out.status} ${out.error}`)
  return { text: resultText(out.result), isError: out.result.isError === true, data: out.result.structuredContent as Record<string, unknown> | undefined }
}
const ghCalls = () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
const queries = () => ghCalls().map((a) => a.find((x) => x.startsWith('query='))!)
const mutations = () => queries().filter((q) => q.startsWith('query=mutation'))
const patchState = (patch: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), ...patch }))
const setMode = (mode: string) => patchState({ mode })
/** The project item each field write went to, in the order "GitHub" received them */
const writtenItems = () => ghCalls().filter((a) => a.some((x) => x.includes('updateProjectV2ItemFieldValue'))).map((a) => a.find((x) => x.startsWith('item='))!.slice(5))
const stored = (id: string) => (JSON.parse(readFileSync(statePath, 'utf8')) as ReturnType<typeof project>).items.find((i) => i.id === id)

// The fake `gh` is a sh script, node is reached through a symlink and PATH is joined with `:`; the
// board app is this repository's own tool, run from macOS. Not on Windows (#14).
describe.skipIf(process.platform === 'win32')('the project board app', { timeout: 30_000 }, () => {
  it('passes check: every tool annotated, the screen served with its bridge, show as an app-only home', async () => {
    const r = await runtime().check(ref)
    expect(r.text.split('\n').filter((l) => l.startsWith('- problem'))).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.text).toContain('show — reads, app, screen ui://project-board/index.html')
    expect(r.text).toContain('list_items — reads, model')
    expect(r.text).toContain('get_items — reads, model')
    expect(r.text).toContain('list_needs_decision — reads, model')
    expect(r.text).toContain('set_item_fields — changes, model+app')
    expect(r.text).toContain('add_item — changes, model')
    const html = (await rt!.readResource(ref, 'ui://project-board/index.html')).contents[0] as { text: string }
    expect(html.text).toContain('McpApp')
    expect(html.text).toContain('centralu/notifications/changed')
  })

  it('lists every page in board order, one line per item, without archived items, and filters by status, area and priority', async () => {
    runtime()
    const all = await call('list_items')
    expect(all.isError).toBe(false)
    expect(all.text).toBe(
      [
        'Centralu: 4 of 4 items. Needs decision 2 · Ready 0 · In progress 1 · In review 0 · On hold 1 · Done 0.',
        '#113 Narrow-window reading — Needs decision · Medium · UI',
        '#101 Worktree management — Needs decision · Low · Host',
        '#280 Agents survive restarts — In progress · High · Host',
        '#8 Polish the overall design — On hold · Low · Design',
      ].join('\n'),
    )
    // Two items per page in the fake: three board pages were read, once, and the second call came from the short cache
    await call('list_items', { area: 'host' })
    expect(queries().filter((q) => q.includes('projectV2(number'))).toHaveLength(3)

    const host = await call('list_items', { area: 'host', priority: 'low' })
    expect(host.text).toContain('1 of 4 items, filtered by Area Host, Priority Low.')
    expect(host.data!.items).toEqual(['#101 Worktree management — Needs decision · Low · Host'])
    const unknown = await call('list_items', { status: 'Blocked' })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toBe('Status "Blocked" does not exist in this project. Choose one of: Ready, Needs decision, In progress, In review, On hold, Done.')
  })

  it('answers reads compactly, with the text saying exactly what the structured part says, and the rest only on request', async () => {
    // Claude Code hands the model structuredContent, not the text (docs/apps.md §9.2)
    runtime()
    for (const [name, args] of [
      ['list_items', {}],
      ['list_needs_decision', {}],
      ['get_items', { items: [8, 113] }],
    ] as const) {
      const r = await call(name, args)
      expect(Object.keys(r.data!).sort()).toEqual(['items', 'summary'])
      expect(r.text).toBe([r.data!.summary, ...(r.data!.items as string[])].join('\n'))
      expect(JSON.stringify(r.data)).not.toMatch(/https?:|item-|PVT_|ijun17\/centralu/)
    }
    const full = await call('get_items', { items: [8], detail: 'full' })
    expect(full.text).toContain('#8 Polish the overall design — On hold · Low · Design · issue open · https://github.com/ijun17/centralu/issues/8 · item item-8')
    expect(full.data).toMatchObject({ project: { id: 'PVT_test' }, items: [{ itemId: 'item-8', url: 'https://github.com/ijun17/centralu/issues/8', status: 'On hold' }] })
  })

  it('reads specific items by number, in the order asked, and names the ones not in the project', async () => {
    runtime()
    const got = await call('get_items', { items: ['ijun17/centralu#101', 8, '#8', 'https://github.com/ijun17/centralu/issues/42', 'other/repo#3'] })
    expect(got.isError).toBe(false)
    expect(got.text).toBe(
      [
        'Centralu: 2 of 4 in the project.',
        '#101 Worktree management — Needs decision · Low · Host',
        '#8 Polish the overall design — On hold · Low · Design',
        'Not in the project: #42, other/repo#3.',
      ].join('\n'),
    )
    expect(got.data).toEqual({
      summary: 'Centralu: 2 of 4 in the project.',
      items: [expect.stringMatching(/^#101 /), expect.stringMatching(/^#8 /)],
      missing: ['#42', 'other/repo#3'],
    })

    // The same filter on list_items, combined with the others
    const listed = await call('list_items', { numbers: [8, '#113', 42] })
    expect(listed.data!.items).toEqual(['#8 Polish the overall design — On hold · Low · Design', '#113 Narrow-window reading — Needs decision · Medium · UI'])
    expect(listed.data!.missing).toEqual(['#42'])
    expect((await call('list_items', { numbers: [8, 113], status: 'On hold' })).data!.items).toEqual(['#8 Polish the overall design — On hold · Low · Design'])

    const bad = await call('get_items', { items: [8, 'eight'] })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('"eight" is not an issue or pull request.')
  })

  it('lists what needs a decision, highest priority first', async () => {
    runtime()
    const r = await call('list_needs_decision')
    expect(r.text).toBe(
      [
        'Centralu: 2 items with Status Needs decision.',
        '#113 Narrow-window reading — Needs decision · Medium · UI',
        '#101 Worktree management — Needs decision · Low · Host',
      ].join('\n'),
    )
    expect((await call('list_needs_decision', { area: 'UI' })).data!.summary).toBe('Centralu: 1 item with Status Needs decision in Area UI.')
  })

  it('sets a status on GitHub and back, saying in one line what changed, checked against GitHub', async () => {
    runtime()
    await call('list_items') // fills the cache with "On hold"
    const there = await call('set_item_fields', { item: '#8', status: 'ready' })
    expect(there.isError).toBe(false)
    expect(there.text).toBe('Project Centralu on GitHub: 1 changed. Read back from GitHub: as set.\n#8 Status On hold → Ready')
    // The same words are the structured part, which is what Claude Code hands the model
    expect(there.data).toEqual({ summary: 'Project Centralu on GitHub: 1 changed. Read back from GitHub: as set.', results: ['#8 Status On hold → Ready'] })
    expect(stored('item-8')!.values.Status).toBe('Ready')
    // The next read is not the board cached before the write
    expect((await call('list_items', { status: 'Ready' })).text).toContain('#8 Polish the overall design')

    const back = await call('set_item_fields', { item: 'https://github.com/ijun17/centralu/issues/8', status: 'On hold' })
    expect(back.data!.results).toEqual(['#8 Status Ready → On hold'])
    expect(stored('item-8')!.values.Status).toBe('On hold')
    expect(mutations()).toHaveLength(2)

    const same = await call('set_item_fields', { item: 8, status: 'On hold' })
    expect(same.text).toBe('Project Centralu on GitHub: 1 unchanged.\n#8 unchanged: Status already On hold')
    expect(mutations()).toHaveLength(2)
  })

  it('runs writes sent at once in arrival order, so each "from" is true and the last one wins', async () => {
    // A live Claude session sent both halves of a round trip in parallel
    runtime()
    const [there, back] = await Promise.all([call('set_item_fields', { item: '8', status: 'Ready' }), call('set_item_fields', { item: '8', status: 'On hold' })])
    expect(there.data!.results).toEqual(['#8 Status On hold → Ready'])
    expect(back.data!.results).toEqual(['#8 Status Ready → On hold'])
    expect(stored('item-8')!.values.Status).toBe('On hold')
  })

  it('sets a batch in the order given, one line per item, with shared and per-item fields', async () => {
    runtime()
    const r = await call('set_item_fields', {
      items: [113, { item: '#8', priority: 'High' }, 101, { item: 8, status: 'In review' }],
      status: 'Ready',
    })
    expect(r.isError).toBe(false)
    expect(r.text).toBe(
      [
        'Project Centralu on GitHub: 4 changed. Read back from GitHub: as set.',
        '#113 Status Needs decision → Ready',
        '#8 Status On hold → Ready, Priority Low → High',
        '#101 Status Needs decision → Ready',
        // The second entry for #8 starts from what the first one set
        '#8 Status Ready → In review',
      ].join('\n'),
    )
    expect(writtenItems()).toEqual(['item-113', 'item-8', 'item-8', 'item-101', 'item-8'])
    expect([stored('item-113')!.values.Status, stored('item-8')!.values.Status, stored('item-8')!.values.Priority, stored('item-101')!.values.Status]).toEqual([
      'Ready',
      'In review',
      'High',
      'Ready',
    ])
    // One fresh read before the batch and one to check it (three pages each), not two per item
    expect(queries().filter((q) => q.includes('projectV2(number'))).toHaveLength(6)
  })

  it('carries on past an item that fails, and lists the failures after the lines', async () => {
    runtime()
    patchState({ failItems: ['item-113'] })
    const r = await call('set_item_fields', { items: [8, 42, 113, 101], status: 'Ready' })
    expect(r.isError).toBe(false)
    expect(r.text).toBe(
      [
        'Project Centralu on GitHub: 2 changed, 2 failed. Read back from GitHub: as set.',
        '#8 Status On hold → Ready',
        '#101 Status Needs decision → Ready',
        'Failed:',
        '#42 is not in the project Centralu; add it with add_item.',
        '#113: GitHub answered with an error: UNPROCESSABLE Could not update the item item-113',
      ].join('\n'),
    )
    expect(r.data!.failed).toHaveLength(2)
    expect(stored('item-101')!.values.Status).toBe('Ready')

    // When every item failed, the answer is an error
    const none = await call('set_item_fields', { items: [42, 113], status: 'Done' })
    expect(none.isError).toBe(true)
    expect(none.data!.summary).toBe('Project Centralu on GitHub: 2 failed.')
  })

  it('reads a batch back once and says on the line when GitHub shows something else', async () => {
    runtime()
    patchState({ ignoreWrites: ['item-101'] })
    const r = await call('set_item_fields', { items: [8, 101], status: 'Ready' })
    expect(r.data).toEqual({
      summary: 'Project Centralu on GitHub: 2 changed. Read back from GitHub: 1 differs, see the line.',
      results: ['#8 Status On hold → Ready', '#101 Status Needs decision → Ready (but GitHub now shows Status Needs decision)'],
    })
  })

  it('stops a batch at a failure the rest would repeat, and says which items were not tried', async () => {
    runtime()
    setMode('read-only')
    const r = await call('set_item_fields', { items: [8, 113, 101], status: 'Ready' })
    expect(r.isError).toBe(true)
    expect(r.data!.failed).toEqual([
      "#8: The GitHub login gh uses may not change this project (GitHub said: FORBIDDEN Resource not accessible by personal access token). Ask the project's owner for write access, then try again.",
      'Not tried after that: #113, #101.',
    ])
    expect(mutations()).toHaveLength(1)
  })

  it('runs batches sent at once one after the other, never interleaved', async () => {
    runtime()
    patchState({ delayMs: 150 })
    const [first, second] = await Promise.all([
      call('set_item_fields', { items: [8, 113], status: 'Ready' }),
      call('set_item_fields', {
        items: [
          { item: 8, status: 'Done' },
          { item: 113, status: 'Done' },
        ],
      }),
    ])
    expect(first.data!.results).toEqual(['#8 Status On hold → Ready', '#113 Status Needs decision → Ready'])
    expect(second.data!.results).toEqual(['#8 Status Ready → Done', '#113 Status Ready → Done'])
    expect(writtenItems()).toEqual(['item-8', 'item-113', 'item-8', 'item-113'])
    expect([stored('item-8')!.values.Status, stored('item-113')!.values.Status]).toEqual(['Done', 'Done'])
  })

  it('writes nothing when a value or a reference is wrong, and names each problem once with the valid names', async () => {
    runtime()
    const badValue = await call('set_item_fields', { item: '8', priority: 'Urgent' })
    expect(badValue.isError).toBe(true)
    expect(badValue.text).toBe('Priority "Urgent" does not exist in this project. Choose one of: High, Medium, Low. Nothing changed.')
    const batch = await call('set_item_fields', { items: [8, 113, 'issue eight', { item: 101, area: 'Mars' }], status: 'Readyy' })
    expect(batch.text).toBe(
      'Status "Readyy" does not exist in this project. Choose one of: Ready, Needs decision, In progress, In review, On hold, Done. "issue eight" is not an issue or pull request. Give a number such as 8 or #8, owner/repo#8, or a github.com issue or pull request URL. Area "Mars" does not exist in this project. Choose one of: UI, Host, Apps, Design. Nothing changed.',
    )
    const nothing = await call('set_item_fields', { items: [8, { item: 113, status: 'Ready' }] })
    expect(nothing.text).toBe('Nothing to change for #8: give status, priority or area. Nothing changed.')
    expect((await call('set_item_fields', { status: 'Ready' })).text).toBe('Give item (one) or items (a list). Nothing changed.')
    expect((await call('set_item_fields', { item: 8, items: [113], status: 'Ready' })).text).toBe('Give item (one) or items (a list), not both. Nothing changed.')
    expect(mutations()).toEqual([])
  })

  it('adds issues or pull requests by number or URL, sets their fields, and never adds one twice', async () => {
    runtime()
    const added = await call('add_item', { item: '#42', status: 'Ready', area: 'Apps' })
    expect(added.isError).toBe(false)
    expect(added.text).toBe('Project Centralu on GitHub: 1 added. Read back from GitHub: as set.\n#42 added: A new issue; Status (none) → Ready, Area (none) → Apps')
    expect(stored('item-42')!.values).toEqual({ Status: 'Ready', Area: 'Apps' })

    const pr = await call('add_item', { item: 'https://github.com/ijun17/centralu/pull/43' })
    expect(pr.data!.results).toEqual(['#43 added: A pull request (PR)'])

    const again = await call('add_item', { item: 42 })
    expect(again.data!.results).toEqual(['#42 already in the project, nothing added'])
    expect(mutations().filter((q) => q.includes('addProjectV2ItemById'))).toHaveLength(2)

    const missing = await call('add_item', { item: '999' })
    expect(missing.isError).toBe(true)
    expect(missing.data!.failed).toEqual(['#999 is not an issue or pull request this GitHub login can see. Nothing added.'])
    const badStatus = await call('add_item', { item: '43', status: 'Someday' })
    expect(badStatus.text).toContain('Status "Someday" does not exist in this project.')
    expect(mutations().filter((q) => q.includes('addProjectV2ItemById'))).toHaveLength(2)
  })

  it('adds a batch in order, sets each one, and lists what failed', async () => {
    runtime()
    const r = await call('add_item', { items: [43, 999, { item: 42, area: 'UI' }, 8, { item: '#42', status: 'Done' }], status: 'In review' })
    expect(r.isError).toBe(false)
    expect(r.text).toBe(
      [
        'Project Centralu on GitHub: 2 added, 2 already in the project, 1 failed. Read back from GitHub: as set.',
        '#43 added: A pull request (PR); Status (none) → In review',
        '#42 added: A new issue; Status (none) → In review, Area (none) → UI',
        '#8 already in the project; Status On hold → In review',
        // Named twice: added once, and the second entry starts from what the first one set
        '#42 already in the project; Status In review → Done',
        'Failed:',
        '#999 is not an issue or pull request this GitHub login can see. Nothing added.',
      ].join('\n'),
    )
    expect(mutations().filter((q) => q.includes('addProjectV2ItemById'))).toHaveLength(2)
    expect(writtenItems()).toEqual(['item-43', 'item-42', 'item-42', 'item-8', 'item-42'])
  })

  it('finds an item GitHub lists only a moment after adding it, and still sets its fields', async () => {
    runtime()
    patchState({ lag: 2 })
    const r = await call('add_item', { item: '#42', status: 'Ready', priority: 'Medium', area: 'UI' })
    expect(r.isError).toBe(false)
    expect(r.data!.results).toEqual(['#42 added: A new issue; Status (none) → Ready, Priority (none) → Medium, Area (none) → UI'])
    expect(r.data!.summary).toContain('Read back from GitHub: as set.')
  })

  it('the screen gets the board in column order with the decision column first', async () => {
    runtime()
    const r = await call('show', {}, screen)
    expect(r.data).toMatchObject({ ok: true, decisionStatus: 'Needs decision', project: { title: 'Centralu', number: 1, owner: 'ijun17' } })
    expect(r.data!.columns).toEqual(['Needs decision', 'Ready', 'In progress', 'In review', 'On hold', 'Done'])
    expect((r.data!.items as unknown[]).length).toBe(4)
  })

  /*
   * An unreachable GitHub, a missing scope, a logged-out or missing gh: each must be one plain
   * sentence with the fix, never an empty board or an empty list.
   */
  it.each([
    ['offline', /^GitHub could not be reached \(error connecting to api\.github\.com\)\. Check the network, then refresh\.$/],
    ['no-scope', /lacks the "project" scope this app needs\. Run `gh auth refresh -s project`/],
    ['logged-out', /^gh is not logged in to github\.com\. Run `gh auth login`/],
    // The project is private: someone without access sees why, and what to do about it
    ['no-access', /cannot see it\. A project can be private to its owner: ask for access, or point project\.json at a project your account can see\.$/],
  ])('when gh fails (%s), the tools and the screen say why instead of showing nothing', async (mode, message) => {
    runtime()
    setMode(mode)
    const list = await call('list_items')
    expect(list.isError).toBe(true)
    expect(list.text).toMatch(message)
    expect((await call('list_needs_decision')).text).toMatch(message)
    const set = await call('set_item_fields', { item: '8', status: 'Ready' })
    expect(set.isError).toBe(true)
    expect(set.text).toMatch(message)
    const show = await call('show', {}, screen)
    expect(show.data).toMatchObject({ ok: false, error: { kind: expect.any(String) } })
    expect((show.data!.error as { message: string }).message).toMatch(message)
    expect(show.data).not.toHaveProperty('items')
    expect(mutations()).toEqual([])
  })

  it('without gh on this machine, says to install it', async () => {
    runtime(false)
    const r = await call('list_items')
    expect(r.isError).toBe(true)
    expect(r.text).toBe('The GitHub CLI (gh) was not found on this machine. Install it from https://cli.github.com, run `gh auth login`, then refresh.')
  })
})
