import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, resultText, type AppRef, type RuntimeTiming } from './runtime.js'
import { appTemplateDir, scaffoldApp } from './scaffold.js'
import { until } from './test-helpers.js'

/**
 * App check (M4 C-3) — deliberately breaks the `server.mjs` of an app scaffolded from the template,
 * to see whether `check` catches the problem **in the app actually running.** The template as-is
 * must pass.
 */

let root = ''
let dataRoot = ''
let projRoot = ''
let rt: ExternalApps

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-check-')))
  dataRoot = join(root, 'data')
  projRoot = join(root, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
})

afterEach(async () => {
  await rt?.dispose()
  rmSync(root, { recursive: true, force: true })
})

const ref = (appId: string): AppRef => ({ projectId: 'p1', appId })
const status = (id: string) => rt.list().find((a) => a.appId === id)?.status

function make(timing: Partial<RuntimeTiming> = {}) {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, ...timing },
  })
  rt.refresh()
  return rt
}

/** One template app — if `server` is given, server.mjs is replaced with it (keeping the template's runtime as-is) */
function app(id: string, server?: string, manifest?: (m: Record<string, unknown>) => void): string {
  const dir = join(projRoot, '.centralu', 'apps', id)
  mkdirSync(dirname(dir), { recursive: true })
  scaffoldApp(appTemplateDir(), dir, { id, name: id, description: `${id} app` })
  if (server !== undefined) writeFileSync(join(dir, 'server.mjs'), `import { McpServer, serveStdio, z, centralu } from './runtime/centralu-app-runtime.mjs'\n${server}\n`)
  if (manifest) {
    const m = JSON.parse(readFileSync(join(dir, 'centralu.app.json'), 'utf8'))
    manifest(m)
    writeFileSync(join(dir, 'centralu.app.json'), JSON.stringify(m, null, 2))
  }
  return dir
}

/** A server with one screen and one home tool — `extra` adds a malformed tool */
const serverWith = (extra: string, home = `centralu.tool(server, 'show', { description: 'Show', annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: 'ui://x/index.html' } } }, async () => ({ content: [{ type: 'text', text: 'hi' }] }))`) => `
serveStdio(() => {
  const server = new McpServer({ name: 'x', version: '0' }, { capabilities: { tools: {}, resources: {} } })
  centralu.uiResource(server, 'screen', 'ui://x/index.html', new URL('./ui/index.html', import.meta.url))
  ${home}
  ${extra}
  return server
})`

const problems = (text: string) => text.split('\n').filter((l) => l.startsWith('- problem'))

describe('the template as-is passes', () => {
  it('no problems with the manifest, the tools, or the screen — states what each tool is and the screen\'s size', async () => {
    app('counter')
    const r = await make().check(ref('counter'))
    expect(problems(r.text)).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.text).toMatch(/^check p1\/counter: passed/)
    expect(r.text).toContain('show — reads, model+app, screen ui://counter/index.html')
    expect(r.text).toContain('increment — changes, model+app')
    expect(r.text).toContain('reset — changes, app')
    expect(r.text).toMatch(/Screen ui:\/\/counter\/index\.html: \d{4,} characters/)
    expect(r.text).toMatch(/Process: pid \d+, (modern|legacy) \(.+\), restarted from the files on disk/)
    // After a check, the app is a normal running app — its tools can be called as usual
    expect(status('counter')).toBe('running')
    const out = await rt.call(ref('counter'), 'increment', { by: 1 }, { kind: 'session', sessionId: 's1' })
    expect(out.status).toBe('ok')
  })
})

describe('a broken app states what is wrong and where', () => {
  it('__ in a tool name — a tool Centralu drops', async () => {
    app('names', serverWith(`server.registerTool('save__draft', { description: 'Save', annotations: { readOnlyHint: false } }, async () => ({ content: [] }))`))
    const r = await make().check(ref('names'))
    expect(r.ok).toBe(false)
    expect(problems(r.text)).toEqual([
      '- problem [tool save__draft] a tool name cannot contain "__" (it separates names in a session\'s tool names): save__draft — Centralu drops this tool, so nobody can call it',
    ])
  })

  it('a write tool has no readOnlyHint', async () => {
    app('annot', serverWith(`centralu.tool(server, 'save', { description: 'Save the note', inputSchema: z.object({ text: z.string() }) }, async () => ({ content: [] }))`))
    const r = await make().check(ref('annot'))
    expect(problems(r.text)).toEqual([
      '- problem [tool save] annotations.readOnlyHint is missing — write `readOnlyHint: true` if the tool only reads, `readOnlyHint: false` if it changes anything. ' +
        "Without it the tool counts as one that changes things: a session asks before every call, Codex's auto preset does not call it, and every call makes all of this app's open screens read again",
    ])
    expect(r.text).toContain('save — no readOnlyHint, model+app')
  })

  it('home has no screen / home is closed to the screen / home is not in the tool list', async () => {
    app('nohome-ui', serverWith('', `centralu.tool(server, 'show', { description: 'Show', annotations: { readOnlyHint: true } }, async () => ({ content: [] }))`))
    app('hidden-home', serverWith('', `centralu.tool(server, 'show', { description: 'Show', annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: 'ui://x/index.html', visibility: ['model'] } } }, async () => ({ content: [] }))`))
    app('lost-home', serverWith(''), (m) => (m.home = 'open'))
    const r = make()
    expect(problems((await r.check(ref('nohome-ui'))).text)).toEqual([
      '- problem [home (show)] the home tool has no screen — add `_meta: { ui: { resourceUri: "ui://…" } }` and register that resource with `centralu.uiResource`',
    ])
    expect(problems((await r.check(ref('hidden-home'))).text)).toEqual([
      '- problem [home (show)] the home tool is not open to the screen (visibility: ["model"]) — when the app opens, Centralu calls home from the screen\'s side',
    ])
    expect(problems((await r.check(ref('lost-home'))).text)).toEqual([
      '- problem [home (open)] the tool centralu.app.json names as home is not in the tool list — the app cannot be opened from the sidebar',
    ])
  })

  it('the audience field is malformed', async () => {
    app('vis', serverWith(`centralu.tool(server, 'peek', { description: 'Peek', annotations: { readOnlyHint: true }, _meta: { ui: { visibility: 'app' } } }, async () => ({ content: [] }))`))
    expect(problems((await make().check(ref('vis'))).text)).toEqual([
      '- problem [tool peek] peek: _meta.ui.visibility must be a list of "model" and "app" (got "app") — Centralu drops this tool',
    ])
  })

  it('screen: the ui:// it points at does not exist / is not ui:// / was emitted raw with no bridge', async () => {
    app('screens', serverWith(`
  centralu.tool(server, 'missing', { description: 'M', annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: 'ui://x/missing.html' } } }, async () => ({ content: [] }))
  centralu.tool(server, 'web', { description: 'W', annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: 'https://example.com/app' } } }, async () => ({ content: [] }))
  centralu.tool(server, 'raw', { description: 'R', annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: 'ui://x/raw.html' } } }, async () => ({ content: [] }))
  server.registerResource('raw', 'ui://x/raw.html', { mimeType: 'text/html' }, async () => ({ contents: [{ uri: 'ui://x/raw.html', mimeType: 'text/html', text: '<script src="centralu:mcp-app.js"></script>' }] }))`))
    const found = problems((await make().check(ref('screens'))).text)
    expect(found).toHaveLength(4)
    expect(found[0]).toBe('- problem [tool web] web: _meta.ui.resourceUri must be a ui:// URI (got "https://example.com/app") — it will not open as a screen')
    expect(found[1]).toMatch(/^- problem \[screen ui:\/\/x\/missing\.html\] could not be read: .*missing\.html/)
    expect(found[2]).toBe('- problem [screen ui://x/raw.html] its mimeType is "text/html" — a screen must be "text/html;profile=mcp-app" (centralu.uiResource sets it)')
    expect(found[3]).toBe('- problem [screen ui://x/raw.html] <script src="centralu:mcp-app.js"> is still in the page — this screen has no bridge, so it cannot call tools. Register it with centralu.uiResource')
  })

  it('the manifest is malformed — states the reason without starting the app', async () => {
    app('manifest', undefined, (m) => {
      m.id = 'other'
      m.extra = 1
    })
    const r = await make().check(ref('manifest'))
    expect(problems(r.text)).toEqual([
      "- problem [centralu.app.json] the folder name (manifest) and the manifest's id (other) differ — the folder name is the app's id",
    ])
    expect(r.text).toContain('- warning [centralu.app.json] unknown field, ignored: extra')
  })

  it('the server fails to start — the reason and stderr are in the report', async () => {
    app('broken', `serveStdio(() => { throw new Error('forgot to define the tools') })`)
    const r = await make().check(ref('broken'))
    expect(r.ok).toBe(false)
    expect(problems(r.text)[0]).toMatch(/^- problem \[start\] /)
    expect(r.text).toContain('forgot to define the tools')
    expect(r.text).toContain('the server could not start')
  })
})

describe('a check never leaves the app in a strange state', () => {
  // Eight real node starts (seven that fail, one that passes) take ~1.8 s alone; a loaded machine
  // has stretched them 2.5x, so this test gets more room than vitest's 5 s default. Windows gets three
  // times that, like every limit in vitest.config.ts (#368): on windows-2022 each start took 1.0 to
  // 1.8 s, with a process listing for leftovers after every failed one, and the eight ran past 10 s.
  it('checking an app that fails to start repeatedly never pushes it to a stopped (failed) state, and once fixed, it passes and stays running', { timeout: 10_000 * (process.platform === 'win32' ? 3 : 1) }, async () => {
    const dir = app('fixme', `serveStdio(() => { throw new Error('not yet') })`)
    // This server stays alive after throwing (S-6), so each of the seven failed starts below waits
    // out startExitWaitMs for an exit that never comes — at the product's 250 ms, ~1.75 s of nothing
    const r = make({ maxFailures: 3, startExitWaitMs: 20 })
    for (let i = 0; i < 4; i++) expect((await r.check(ref('fixme'))).ok).toBe(false)
    expect(status('fixme')).toBe('crashed')
    // Even an app stopped by the caller failing it repeatedly — a check tries starting it again (the same as the person's "Restart")
    for (let i = 0; i < 3; i++) await r.tools(ref('fixme')).catch(() => {})
    expect(status('fixme')).toBe('failed')
    writeFileSync(join(dir, 'server.mjs'), readFileSync(join(appTemplateDir(), 'server.mjs'), 'utf8').replaceAll('{{APP_ID}}', 'fixme').replaceAll('{{APP_NAME}}', 'fixme'))
    const fixed = await r.check(ref('fixme'))
    expect(fixed.ok).toBe(true)
    expect(status('fixme')).toBe('running')
  })

  it('does not cut off a call in progress — waits for it to finish, then restarts with the current files', async () => {
    const gate = join(root, 'gate')
    const dir = app(
      'busy',
      serverWith(`centralu.tool(server, 'hold', { description: 'Waits for the gate file', annotations: { readOnlyHint: true } }, async () => {
    const { existsSync } = await import('node:fs')
    while (!existsSync(${JSON.stringify(gate)})) await new Promise((r) => setTimeout(r, 20))
    return { content: [{ type: 'text', text: 'held pid ' + process.pid }] }
  })`),
    )
    const r = make()
    await r.tools(ref('busy'))
    const call = r.call(ref('busy'), 'hold', {}, { kind: 'session', sessionId: 's1' })
    await until(() => (r as unknown as { openRuns: Map<string, unknown> }).openRuns.size, (n) => n === 1)
    // The code changes in the meantime — one more tool is added
    writeFileSync(join(dir, 'server.mjs'), readFileSync(join(dir, 'server.mjs'), 'utf8').replace("  return server\n", "  centralu.tool(server, 'added', { description: 'New', annotations: { readOnlyHint: true } }, async () => ({ content: [] }))\n  return server\n"))
    let checked = false
    const report = r.check(ref('busy')).then((x) => ((checked = true), x))
    await new Promise((res) => setTimeout(res, 300))
    expect(checked).toBe(false) // it does not shut down before the call finishes
    writeFileSync(gate, '')
    const out = await call
    expect(out.status).toBe('ok')
    const held = Number(resultText(out.result!).replace('held pid ', ''))
    const rep = await report
    expect(rep.text).toContain('added — reads, model+app')
    expect(rep.text).toContain('restarted from the files on disk')
    expect(rep.text).not.toContain(`pid ${held},`)
  })

  it('when a call runs past the cap, it checks the already-running process instead of restarting, and states so', async () => {
    const gate = join(root, 'gate2')
    app(
      'slow',
      serverWith(`centralu.tool(server, 'hold', { description: 'Waits', annotations: { readOnlyHint: true } }, async () => {
    const { existsSync } = await import('node:fs')
    while (!existsSync(${JSON.stringify(gate)})) await new Promise((r) => setTimeout(r, 20))
    return { content: [{ type: 'text', text: 'done' }] }
  })`),
    )
    const r = make({ checkDrainMs: 200 })
    const call = r.call(ref('slow'), 'hold', {}, { kind: 'session', sessionId: 's1' })
    await until(() => (r as unknown as { openRuns: Map<string, unknown> }).openRuns.size, (n) => n === 1)
    const rep = await r.check(ref('slow'))
    expect(rep.text).toContain(
      '- note: 1 call was still running after 200 ms, so the app was not restarted — this report is about the process that was already running, which may not have your latest code',
    )
    expect(rep.text).toContain('the process that was already running')
    writeFileSync(gate, '')
    expect((await call).status).toBe('ok')
    expect(existsSync(gate)).toBe(true)
  })
})
