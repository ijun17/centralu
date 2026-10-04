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
if (query.includes('updateProjectV2ItemFieldValue')) {
  const item = st.items.find((i) => i.id === v.item)
  const field = st.fields.find((f) => f.id === v.field)
  item.values[field.name] = field.options.find((o) => o.id === v.option).name
  save()
  out({ updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } })
} else if (query.includes('addProjectV2ItemById')) {
  const c = st.repo.find((x) => x.id === v.content)
  const id = 'item-' + c.number
  st.items.push({ id, content: c, values: {} })
  save()
  out({ addProjectV2ItemById: { item: { id } } })
} else if (query.includes('issueOrPullRequest')) {
  const c = st.repo.find((x) => x.number === v.number)
  if (!c) fail('gh: Could not resolve to an issue or pull request with the number of ' + v.number + '.\n', 1, JSON.stringify({ data: { repository: { issueOrPullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to an issue or pull request with the number of ' + v.number + '.' }] }))
  out({ repository: { issueOrPullRequest: { __typename: c.__typename, id: c.id, number: c.number, title: c.title, url: c.url } } })
} else if (query.includes('projectV2(number')) {
  if (v.number !== 1) fail('gh: Could not resolve to a ProjectV2 with the number ' + v.number + '.\n', 1, JSON.stringify({ data: { repositoryOwner: { projectV2: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a ProjectV2 with the number ' + v.number + '.' }] }))
  const start = v.after ? Number(v.after) : 0
  const page = st.items.slice(start, start + 2)
  const more = start + 2 < st.items.length
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
const setMode = (mode: string) => writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), mode }))
const stored = (id: string) => (JSON.parse(readFileSync(statePath, 'utf8')) as ReturnType<typeof project>).items.find((i) => i.id === id)

describe('the project board app', { timeout: 30_000 }, () => {
  it('passes check: every tool annotated, the screen served with its bridge, show as an app-only home', async () => {
    const r = await runtime().check(ref)
    expect(r.text.split('\n').filter((l) => l.startsWith('- problem'))).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.text).toContain('show — reads, app, screen ui://project-board/index.html')
    expect(r.text).toContain('list_items — reads, model')
    expect(r.text).toContain('list_needs_decision — reads, model')
    expect(r.text).toContain('set_item_fields — changes, model+app')
    expect(r.text).toContain('add_item — changes, model')
    const html = (await rt!.readResource(ref, 'ui://project-board/index.html')).contents[0] as { text: string }
    expect(html.text).toContain('McpApp')
    expect(html.text).toContain('centralu/notifications/changed')
  })

  it('lists every page grouped by Status in board order, without archived items, and filters by status, area and priority', async () => {
    runtime()
    const all = await call('list_items')
    expect(all.isError).toBe(false)
    expect(all.text).toContain('4 of 4 items')
    expect(all.text).not.toContain('Archived long ago')
    const order = ['Needs decision (2)', 'Ready (0)', 'In progress (1)', 'In review (0)', 'On hold (1)', 'Done (0)'].map((h) => all.text.indexOf(h))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // Two items per page in the fake: three board pages were read, once, and the second call came from the short cache
    await call('list_items', { area: 'host' })
    expect(queries().filter((q) => q.includes('projectV2(number'))).toHaveLength(3)

    const host = await call('list_items', { area: 'host', priority: 'low' })
    expect(host.text).toContain('1 of 4 items, filtered by Area Host, Priority Low')
    expect(host.text).toContain('#101 Worktree management')
    const unknown = await call('list_items', { status: 'Blocked' })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toBe('"Blocked" is not a Status in this project. Choose one of: Ready, Needs decision, In progress, In review, On hold, Done.')
  })

  it('lists what needs a decision, highest priority first', async () => {
    runtime()
    const r = await call('list_needs_decision')
    expect(r.text).toContain('2 items with Status Needs decision.')
    expect(r.text.indexOf('#113')).toBeLessThan(r.text.indexOf('#101'))
    expect((r.data!.items as { number: number }[]).map((i) => i.number)).toEqual([113, 101])
    expect((await call('list_needs_decision', { area: 'UI' })).text).toContain('1 item with Status Needs decision in Area UI.')
  })

  it('sets a status on GitHub and back, saying what changed and what GitHub shows afterwards', async () => {
    runtime()
    await call('list_items') // fills the cache with "On hold"
    const there = await call('set_item_fields', { item: '#8', status: 'ready' })
    expect(there.isError).toBe(false)
    expect(there.text).toContain('Changed on GitHub, project Centralu: #8 Polish the overall design\n- Status: On hold → Ready')
    expect(there.text).toContain('GitHub now shows #8: Status Ready · Priority Low · Area Design.')
    // The same words lead the structured part, which is what Claude Code hands the model
    expect(there.data).toMatchObject({ summary: there.text, changed: [{ field: 'Status', from: 'On hold', to: 'Ready' }] })
    expect(stored('item-8')!.values.Status).toBe('Ready')
    // The next read is not the board cached before the write
    expect((await call('list_items', { status: 'Ready' })).text).toContain('#8 Polish the overall design')

    const back = await call('set_item_fields', { item: 'https://github.com/ijun17/centralu/issues/8', status: 'On hold' })
    expect(back.text).toContain('- Status: Ready → On hold')
    expect(stored('item-8')!.values.Status).toBe('On hold')
    expect(mutations()).toHaveLength(2)

    const same = await call('set_item_fields', { item: 8, status: 'On hold' })
    expect(same.text).toContain('Nothing changed on GitHub for #8 Polish the overall design.\nUnchanged: Status was already On hold.')
    expect(mutations()).toHaveLength(2)
  })

  it('runs writes sent at once in arrival order, so each "from" is true and the last one wins', async () => {
    // A live Claude session sent both halves of a round trip in parallel
    runtime()
    const [there, back] = await Promise.all([call('set_item_fields', { item: '8', status: 'Ready' }), call('set_item_fields', { item: '8', status: 'On hold' })])
    expect(there.text).toContain('- Status: On hold → Ready')
    expect(back.text).toContain('- Status: Ready → On hold')
    expect(stored('item-8')!.values.Status).toBe('On hold')
  })

  it('writes nothing when the value or the item is wrong, and says so', async () => {
    runtime()
    const badValue = await call('set_item_fields', { item: '8', priority: 'Urgent' })
    expect(badValue.isError).toBe(true)
    expect(badValue.text).toBe('Nothing changed for #8 Polish the overall design. "Urgent" is not a Priority in this project. Choose one of: High, Medium, Low.')
    const notThere = await call('set_item_fields', { item: '42', status: 'Ready' })
    expect(notThere.text).toBe('ijun17/centralu#42 is not in the project Centralu. Nothing changed. Add it first with add_item.')
    const nothing = await call('set_item_fields', { item: '8' })
    expect(nothing.text).toBe('Nothing to change: give at least one of status, priority or area.')
    const garbage = await call('set_item_fields', { item: 'issue eight', status: 'Ready' })
    expect(garbage.text).toContain('"issue eight" is not an issue or pull request.')
    expect(mutations()).toEqual([])
  })

  it('adds an issue or pull request by number or URL, sets its fields, and never adds one twice', async () => {
    runtime()
    const added = await call('add_item', { item: '#42', status: 'Ready', area: 'Apps' })
    expect(added.isError).toBe(false)
    expect(added.text).toContain('Added to the project Centralu on GitHub: issue #42 A new issue (https://github.com/ijun17/centralu/issues/42).')
    expect(added.text).toContain('Then set:\n- Status: (none) → Ready\n- Area: (none) → Apps')
    expect(added.text).toContain('GitHub now shows #42: Status Ready · Priority (none) · Area Apps.')

    const pr = await call('add_item', { item: 'https://github.com/ijun17/centralu/pull/43' })
    expect(pr.text).toContain('Added to the project Centralu on GitHub: pull request #43 A pull request')

    const again = await call('add_item', { item: 42 })
    expect(again.text).toContain('Already in the project Centralu: #42 A new issue. Nothing added.')
    expect(mutations().filter((q) => q.includes('addProjectV2ItemById'))).toHaveLength(2)

    const missing = await call('add_item', { item: '999' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toBe('ijun17/centralu#999 is not an issue or pull request this GitHub login can see. Nothing added.')
    const badStatus = await call('add_item', { item: '43', status: 'Someday' })
    expect(badStatus.text).toContain('"Someday" is not a Status in this project.')
    expect(mutations().filter((q) => q.includes('addProjectV2ItemById'))).toHaveLength(2)
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
