/**
 * T4-2 completion criterion: runs the same contract test suite against two implementations
 * (web/mock). A split between implementations is caught here — when a Tauri implementation is
 * added, it goes in as a third entry.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { HostServer } from '../../agent-host/src/transport/server.js'
import { SessionManager } from '../../agent-host/src/sessions/manager.js'
import { Store } from '../../agent-host/src/dev-services/store.js'
import { createRpcHandler } from '../../agent-host/src/rpc.js'
import { UpdateService } from '../../agent-host/src/updates.js'
import { AgentVersionService } from '../../agent-host/src/agent-versions.js'
import { ThemeFiles } from '../../agent-host/src/themes.js'
import { ViewHost } from '../../agent-host/src/views/view-host.js'
import { OriginPorts } from '../../agent-host/src/views/origin-ports.js'
import { ExternalApps } from '../../agent-host/src/apps/external/runtime.js'
import { PROJECT_APPS, plantApp } from '../../agent-host/src/apps/external/test-helpers.js'
import { runtimeViewSource } from '../../agent-host/src/app-view-source.js'
import { onExternalAppListChanged } from '../../agent-host/src/app-list-events.js'
import { broadcastAppChanges } from '../../agent-host/src/app-change-events.js'
import { storeRunLedger } from '../../agent-host/src/app-run-ledger.js'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../../agent-host/src/adapters/contract.js'
import type { ApprovalDecision, NormalizedEvent, ToolName } from '@cc/protocol'
import { APP_VERSION, DEFAULT_UI_PREFERENCES } from '@cc/protocol'
import type { Platform } from './ports/index.js'
import { createMockPlatform } from './mock/index.js'
import { createWebPlatform } from './web/index.js'

/** The minimal real host for testing the web implementation (only the adapter is fake) */
class EchoHandle implements SessionHandle {
  externalId = 'ext-1'
  constructor(readonly sessionId: string, private emit: EventSink) {}
  send(text: string) {
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text: `echo:${text}` })
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
  }
  respondApproval(requestId: string, decision: ApprovalDecision): boolean {
    this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision })
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
    return true
  }
  interrupt() {}
  async dispose() {}
}
class EchoAdapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  readonly descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'npm i -g x', login: 'x login' }
  readonly capabilities = { approvals: true, contextUsage: 'exact' as const, resume: true, autoTitle: true, attachments: ['image' as const], verbosities: [], exclusiveWriter: false, backgroundTasks: false }
  async detect() { return { tool: this.tool, installed: true, loggedIn: true, detail: 'echo' } }
  async createSession(opts: CreateSessionOpts, emit: EventSink) { return new EchoHandle(opts.sessionId, emit) }
}

/**
 * `offerUpdate`: makes it as if that version were already up on the registry (issue #43).
 * Whether both implementations answer the same stimulus the same way is this file's reason to
 * exist.
 *
 * `makeDir`: creates a folder ahead of time. **The port cannot create a folder** — creation was
 * deliberately left out in #19, so testing where a file gets moved to needs setup written
 * per-implementation. The actual moving and deleting below goes only through the port.
 */
type Harness = {
  platform: Platform
  cleanup: () => Promise<void>
  offerUpdate: (version: string) => void
  makeDir: (root: string, rel: string) => void
  /** Puts a theme file somewhere outside the themes folder and answers its path (what Import is given) */
  outsideThemeFile: (name: string, text: string) => string
}

async function makeWeb(): Promise<Harness> {
  const store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', new EchoAdapter()]])
  const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
  /*
   * Both the registry and `npm i -g` are **injected.**
   *
   * Otherwise, while this suite runs, a request would go out to the real registry, and in the
   * worst case a test would swap out this machine's global package. The two lines here are the
   * guarantee that cannot happen — by structure, not by rule.
   */
  let registryVersion: string | null = null
  const updates = new UpdateService((status) => server.broadcast({ type: 'update_status', status }), {
    fetchLatest: async () =>
      registryVersion === null
        ? { ok: false as const, reason: 'Could not reach the registry — check the network' }
        : { ok: true as const, version: registryVersion },
    run: async () => {},
  })
  // The themes folder is a temp directory: the real service, never the person's data folder
  const themesRoot = mkdtempSync(join(tmpdir(), 'cc-contract-themes-'))
  const themes = new ThemeFiles(join(themesRoot, 'themes'), () => server.broadcast({ type: 'themes_changed' }))
  await themes.start()
  // No tool reads an installed version here: this suite never runs a real CLI (#297)
  const agentVersions = new AgentVersionService({
    tools: () => [],
    sessions: mgr,
    publish: (status) => server.broadcast({ type: 'agent_versions', status }),
  })
  const server = new HostServer({
    port: 0,
    token: 'contract',
    onRpc: createRpcHandler(mgr, adapters, { updates, themes, agentVersions }),
  })
  const port = await server.listen()
  const platform = createWebPlatform({
    hostUrl: `ws://127.0.0.1:${port}`,
    token: 'contract',
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
  })
  await waitFor(() => platform.agents.listSessions().then(() => true).catch(() => false))
  return {
    platform,
    offerUpdate: (version) => {
      registryVersion = version
    },
    makeDir: (root, rel) => mkdirSync(join(root, rel), { recursive: true }),
    outsideThemeFile: (name, text) => {
      const path = join(themesRoot, name)
      writeFileSync(path, text)
      return path
    },
    cleanup: async () => {
      await platform.dispose()
      await mgr.disposeAll()
      await server.close()
      themes.close()
      store.close()
      rmSync(themesRoot, { recursive: true, force: true })
    },
  }
}

async function makeMock(): Promise<Harness> {
  const platform = createMockPlatform()
  return {
    platform,
    offerUpdate: (version) => {
      platform.registryVersion = version
    },
    // The mock's file tree is "parent path → entries", so one folder is one row under its parent plus an empty list
    makeDir: (_root, rel) => {
      const cut = rel.lastIndexOf('/')
      const parent = cut < 0 ? '' : rel.slice(0, cut)
      platform.fsState.entries[parent] = [
        ...(platform.fsState.entries[parent] ?? []),
        { name: rel.slice(cut + 1), path: rel, isDir: true, ignored: false },
      ]
      platform.fsState.entries[rel] ??= []
    },
    outsideThemeFile: (name, text) => {
      const path = `/elsewhere/${name}`
      platform.themeImportSources.set(path, text)
      return path
    },
    cleanup: async () => platform.dispose(),
  }
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    if (await pred()) return
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe.each([
  ['mock', makeMock],
  ['web(+real host)', makeWeb],
])('Platform contract: %s', (_name, make) => {
  let h: Harness
  let events: NormalizedEvent[]

  beforeAll(async () => {
    h = await make()
    events = []
    h.platform.agents.subscribe((e) => events.push(e))
  })
  afterAll(async () => h.cleanup())

  it('registers a project and it shows up in the list', async () => {
    const p = await h.platform.projects.add(tmpdir())
    expect(p.path).toBe(tmpdir())
    const list = await h.platform.projects.list()
    expect(list.some((x) => x.id === p.id)).toBe(true)
  })

  it('re-registering the same path does not create a duplicate', async () => {
    const before = (await h.platform.projects.list()).length
    await h.platform.projects.add(tmpdir())
    expect((await h.platform.projects.list()).length).toBe(before)
  })

  /**
   * A registered shell command **comes along with the project** (issue #44).
   *
   * This is not just a test of whether saving works. The run menu draws whatever comes
   * attached to the project without asking the list separately, so if saving succeeded but
   * `list()` does not carry it, the screen shows "never registered" — whether both
   * implementations answer the same way is what this checks.
   */
  it('a shell command registered on a project comes back with the list (#44, label 2026-09-06)', async () => {
    const [p] = await h.platform.projects.list()
    const saved = await h.platform.projects.setCommands(p!.id, [
      { command: 'pnpm test', label: '  test  ' },
      { command: '   ' },
      { command: 'pnpm lint', label: '' },
    ])
    // An empty command is not saved, a label is trimmed, and an empty label means no label
    expect(saved).toEqual([{ command: 'pnpm test', label: 'test' }, { command: 'pnpm lint' }])
    const found = (await h.platform.projects.list()).find((x) => x.id === p!.id)
    expect(found?.commands).toEqual([{ command: 'pnpm test', label: 'test' }, { command: 'pnpm lint' }])

    // Deleting also comes through the same door — sending only what remains is the new list
    await h.platform.projects.setCommands(p!.id, [{ command: 'pnpm lint' }])
    expect((await h.platform.projects.list()).find((x) => x.id === p!.id)?.commands).toEqual([
      { command: 'pnpm lint' },
    ])
  })

  it('creating a session shows up in the list', async () => {
    const [p] = await h.platform.projects.list()
    const s = await h.platform.agents.createSession({ projectId: p!.id, cwd: p!.path, tool: 'claude', permissionPreset: 'normal' })
    expect(s.id).toBeTruthy()
    const list = await h.platform.agents.listSessions()
    expect(list.some((x) => x.id === s.id)).toBe(true)
  })

  it('sending delivers an event to subscribers', async () => {
    const [p] = await h.platform.projects.list()
    const s = await h.platform.agents.createSession({ projectId: p!.id, cwd: p!.path, tool: 'claude', permissionPreset: 'normal' })
    events.length = 0
    await h.platform.agents.send(s.id, 'hi')
    await waitFor(() => events.length > 0)
    expect(events.some((e) => e.sessionId === s.id)).toBe(true)
  })

  it('the first message becomes the session name (FR-18)', async () => {
    const [p] = await h.platform.projects.list()
    const s = await h.platform.agents.createSession({ projectId: p!.id, cwd: p!.path, tool: 'claude', permissionPreset: 'normal' })
    await h.platform.agents.send(s.id, 'refactor auth please')
    await waitFor(async () => (await h.platform.agents.listSessions()).find((x) => x.id === s.id)?.name === 'refactor auth please')
  })

  it('after a rename, the automatic name does not overwrite it', async () => {
    const [p] = await h.platform.projects.list()
    const s = await h.platform.agents.createSession({ projectId: p!.id, cwd: p!.path, tool: 'claude', permissionPreset: 'normal' })
    await h.platform.agents.rename(s.id, 'my session')
    await h.platform.agents.send(s.id, 'a different prompt')
    const found = (await h.platform.agents.listSessions()).find((x) => x.id === s.id)
    expect(found?.name).toBe('my session')
  })

  it('markRead does not move backward', async () => {
    const [p] = await h.platform.projects.list()
    const s = await h.platform.agents.createSession({ projectId: p!.id, cwd: p!.path, tool: 'claude', permissionPreset: 'normal' })
    await h.platform.agents.markRead(s.id, 10)
    await h.platform.agents.markRead(s.id, 3)
    const found = (await h.platform.agents.listSessions()).find((x) => x.id === s.id)
    expect(found?.lastReadSeq).toBe(10)
  })

  it('saves a message and reads it back', async () => {
    const [p] = await h.platform.projects.list()
    const s = await h.platform.agents.createSession({ projectId: p!.id, cwd: p!.path, tool: 'claude', permissionPreset: 'normal' })
    await h.platform.agents.send(s.id, 'a message to record')
    await waitFor(async () => (await h.platform.agents.loadMessages(s.id)).length > 0)
    const msgs = await h.platform.agents.loadMessages(s.id)
    expect(msgs[0]!.role).toBe('user')
  })

  /*
   * The trash (#204): deleting moves a session there with its conversation, and the ways out answer alike in both
   * implementations — the e2e scenarios drive the mock, so a mock that deleted for real would pass them all.
   */
  it('a deleted session goes to the trash, reads, comes back, and is deleted for good only from there', async () => {
    const [p] = await h.platform.projects.list()
    const s = await h.platform.agents.createSession({ projectId: p!.id, cwd: p!.path, tool: 'claude', permissionPreset: 'normal' })
    await h.platform.agents.send(s.id, 'kept in the trash')
    await waitFor(async () => (await h.platform.agents.loadMessages(s.id)).length > 0)
    const said = (await h.platform.agents.loadMessages(s.id)).map((m) => [m.seq, m.role, m.payload])

    await h.platform.agents.deleteSession(s.id)
    await waitFor(() => events.some((e) => e.type === 'session_deleted' && e.sessionId === s.id))
    expect((await h.platform.agents.listSessions()).some((x) => x.id === s.id)).toBe(false)
    const listed = await h.platform.trash.list()
    const row = listed.sessions.find((x) => x.id === s.id)
    expect(row).toMatchObject({ project: { id: p!.id, exists: true }, worktree: null })
    expect(row!.conversationFile).not.toBe('remove') // nothing was chosen to go with it
    expect(row!.messages).toBe(said.length)
    expect(listed.bytes).toBeGreaterThan(0)
    expect((await h.platform.trash.read(s.id)).map((m) => [m.seq, m.role, m.payload])).toEqual(said)

    const back = await h.platform.trash.restore(s.id)
    expect(back).toMatchObject({ session: { id: s.id, projectId: p!.id }, project: null })
    expect((await h.platform.agents.listSessions()).some((x) => x.id === s.id)).toBe(true)
    expect((await h.platform.trash.list()).sessions.some((x) => x.id === s.id)).toBe(false)

    await h.platform.agents.deleteSession(s.id)
    await h.platform.trash.purge(s.id)
    expect((await h.platform.trash.list()).sessions.some((x) => x.id === s.id)).toBe(false)
    await expect(h.platform.trash.read(s.id)).rejects.toThrow(/Not in the trash/)
    await expect(h.platform.trash.restore(s.id)).rejects.toThrow(/Not in the trash/)
  })

  /**
   * The keyboard's labels are also a capability (issue #32).
   *
   * ui has no implementation behind it, so putting an OS branch there would be invisible to
   * any test we run — that is why `⌘` comes through the port. This checks that both
   * implementations answer alike here: if only one silently changed, the screen seen in a
   * browser and the one seen in the app would diverge.
   *
   * **The Mac labels are the right answer for both implementations.** Only Rust (the tauri
   * implementation) actually knows the keyboard; these two belong to the dev server and to
   * e2e respectively, so guessing the keyboard here would make the result depend on whatever
   * machine the test runs on.
   */
  it('answers what the keyboard calls a modifier combination (#32)', () => {
    const keys = h.platform.capabilities.shortcutKeys
    expect(keys.mod).toBe('⌘')
    expect(keys.alt).toBe('⌥')
    // The symbols run together (`⌘⇧A`). A separator only appears on a keyboard whose keys become names
    expect(keys.join).toBe('')
  })

  /**
   * The contract for file operations (#18, #19).
   *
   * Creating a file here also goes **only through the port.** A real host sits behind the web
   * implementation, and memory sits behind the mock, so writing setup separately for each would
   * mean the two suites test different worlds — sending it in through the same door and moving
   * it through the same door is what makes "a split between implementations is caught here"
   * true.
   */
  describe('file operations (#18, #19)', () => {
    let projectId = ''
    let dir = ''

    beforeAll(async () => {
      // The real host side really writes to disk — it never takes one step outside the temp directory
      dir = mkdtempSync(join(tmpdir(), 'cc-contract-fs-'))
      projectId = (await h.platform.projects.add(dir)).id
    })
    afterAll(() => rmSync(dir, { recursive: true, force: true }))

    it('a file dropped in from outside appears in the listing', async () => {
      const res = await h.platform.fs.importFile(projectId, '', 'dropped.txt', btoa('hello'))
      expect(res.path).toBe('dropped.txt')
      const listed = await h.platform.fs.listDir(projectId, '')
      expect(listed.map((e) => e.name)).toContain('dropped.txt')
      expect((await h.platform.fs.readFile(projectId, 'dropped.txt')).text).toBe('hello')
    })

    /** There is no overwrite — it names what it collided with and does nothing */
    it('does not import if the same name already exists', async () => {
      await expect(h.platform.fs.importFile(projectId, '', 'dropped.txt', btoa('other'))).rejects.toThrow(
        /already exists/,
      )
      expect((await h.platform.fs.readFile(projectId, 'dropped.txt')).text).toBe('hello')
    })

    it('cannot import outside the project', async () => {
      await expect(h.platform.fs.importFile(projectId, '../..', 'evil.txt', btoa('x'))).rejects.toThrow()
    })

    it('moving within the tree changes the parent', async () => {
      h.makeDir(dir, 'sub')
      const moved = await h.platform.fs.move(projectId, 'dropped.txt', 'sub')
      expect(moved).toEqual({ path: 'sub/dropped.txt', moved: true })
      expect((await h.platform.fs.listDir(projectId, 'sub')).map((e) => e.name)).toContain('dropped.txt')
    })

    it('dropping something back where it already is is not a failure (moved:false)', async () => {
      expect(await h.platform.fs.move(projectId, 'sub/dropped.txt', 'sub')).toEqual({
        path: 'sub/dropped.txt',
        moved: false,
      })
    })

    it('does not move if the destination is already taken', async () => {
      await h.platform.fs.importFile(projectId, '', 'dropped.txt', btoa('second'))
      await expect(h.platform.fs.move(projectId, 'dropped.txt', 'sub')).rejects.toThrow(/already exists/)
      // The original has to stay where it was — a half-moved state is the worst outcome
      expect((await h.platform.fs.listDir(projectId, '')).map((e) => e.name)).toContain('dropped.txt')
    })

    it('cannot move outside the project', async () => {
      await expect(h.platform.fs.move(projectId, 'dropped.txt', '../..')).rejects.toThrow()
    })

    /**
     * The trash and the file manager **answer whether they can, first** (the same shape as
     * `models()`).
     *
     * It is normal for the two implementations to answer differently here: a browser has no
     * trash, and never will. The contract is not "it works" but **"if it does not, a reason
     * comes with it"** — a supported:false with no reason is indistinguishable on screen from
     * quietly doing nothing.
     */
    it('the trash answers whether it can, and gives a reason if it cannot', async () => {
      const res = await h.platform.fs.trash(projectId, 'dropped.txt')
      if (res.supported) {
        expect((await h.platform.fs.listDir(projectId, '')).map((e) => e.name)).not.toContain('dropped.txt')
      } else {
        expect(res.reason).toMatch(/\S/)
      }
    })

    it('viewing in the file manager answers in the same shape', async () => {
      const res = await h.platform.fs.reveal(projectId, 'sub')
      if (!res.supported) expect(res.reason).toMatch(/\S/)
    })

    it('answers what this desktop calls the file manager', () => {
      expect(h.platform.capabilities.fileManagerName).toMatch(/\S/)
    })

    it('answers how its engine reports a frame\'s dragend (#308) — Node has no Chromium client hints', () => {
      expect(h.platform.capabilities.frameDragEndInPage).toBe(false)
    })
  })

  it('exposes capabilities and detect', async () => {
    expect((await h.platform.agents.capabilities('claude')).approvals).toBe(true)
    expect((await h.platform.agents.detect()).length).toBeGreaterThan(0)
  })

  it('an operation on a nonexistent session errors', async () => {
    await expect(h.platform.agents.send('nope', 'x')).rejects.toThrow()
  })

  /**
   * Updates: stops at announcing it (issue #43).
   *
   * Checks that finding out about it does not change anything by itself. `phase` being 'idle'
   * is what says so — between finding a new version and installing it, there is a human click.
   */
  it('announces a new version on the registry but does not install it on its own (#43)', async () => {
    h.offerUpdate('9999.0.0')
    const s = await h.platform.updates.status(true)
    expect(s.current).toBe(APP_VERSION)
    expect(s.latest).toBe('9999.0.0')
    expect(s.newer).toBe(true)
    expect(s.phase).toBe('idle')
  })

  /**
   * Turning it off really means it does not ask.
   *
   * There is exactly one way this checkbox would become decorative: only blocking the
   * periodic request while letting **the one right after startup** through unchanged. The
   * screen calls `status(force: false)` every time the app opens, so without a guard there, a
   * request keeps going out from the machine of someone who was told it is off.
   */
  it('turning off automatic checking keeps automatic calls from reaching the registry (#43)', async () => {
    await h.platform.updates.setAuto(false)
    h.offerUpdate('8888.0.0')
    // The automatic call went nowhere — the previously known answer stays
    expect((await h.platform.updates.status(false)).latest).toBe('9999.0.0')
    // A click from a person still goes through
    expect((await h.platform.updates.status(true)).latest).toBe('8888.0.0')
    // Turning it back on asks right there — someone who just turned it on wants to know now
    h.offerUpdate('9999.0.0')
    expect((await h.platform.updates.setAuto(true)).latest).toBe('9999.0.0')
  })

  /**
   * Installing responds **as soon as it starts**, and the word that it finished arrives as an
   * event (issue #43).
   *
   * `npm i -g` routinely exceeds the RPC timeout (30 seconds). A contract that waits for it to
   * finish would make an install that actually succeeded look like a timeout on screen, and
   * from then on the two sides would be telling different stories.
   *
   * The last line is this feature's whole point: even once it is done, **the app is still
   * running as it was.**
   */
  it('installing responds to the start and announces completion as an event — does not restart itself (#43)', async () => {
    h.offerUpdate('9999.0.0')
    await h.platform.updates.status(true)
    events.length = 0

    const started = await h.platform.updates.apply()
    expect(started.phase).toBe('updating')

    await waitFor(() => events.some((e) => e.type === 'update_status' && e.status.phase === 'restart_required'))
    expect((await h.platform.updates.status(false)).phase).toBe('restart_required')
  })

  /**
   * Moving idle sessions to a newly installed agent CLI (#297) starts on — the owner's decision — and the switch sticks.
   * With nothing installed newer, the app-wide action restarts nothing.
   */
  it('moving idle sessions to a new agent CLI starts on, the switch sticks, and nothing older restarts nothing (#297)', async () => {
    expect((await h.platform.agents.versions(true)).autoApply).toBe(true)
    expect((await h.platform.agents.setAutoApplyVersions(false)).autoApply).toBe(false)
    expect((await h.platform.agents.versions(false)).autoApply).toBe(false)
    expect(await h.platform.agents.applyVersions()).toEqual({ restarted: [], busy: [] })
  })

  /**
   * Screen preferences (UiPreferences).
   *
   * Two things are checked here. First, **a fresh install that has never chosen anything
   * answers with defaults** — if a read came back empty-handed, the composer would not know
   * what to do. Second, writing changes **only what was written**. With just one field today
   * this second rule looks free, since an implementation that overwrites everything would pass
   * just the same right now — so it is pinned down here before the fields grow.
   */
  it('screen preferences start at defaults, and writing changes only what was written', async () => {
    expect(await h.platform.prefs.load()).toEqual(DEFAULT_UI_PREFERENCES)

    expect(await h.platform.prefs.save({ sendWithModifierEnter: true })).toEqual({
      ...DEFAULT_UI_PREFERENCES,
      sendWithModifierEnter: true,
    })
    // Asking again gives the same answer — meaning the answer comes from the record
    expect(await h.platform.prefs.load()).toEqual({ ...DEFAULT_UI_PREFERENCES, sendWithModifierEnter: true })
    // A write with nothing in it reverts nothing
    expect(await h.platform.prefs.save({})).toEqual({ ...DEFAULT_UI_PREFERENCES, sendWithModifierEnter: true })
    // The theme choice is one more field, written on its own
    expect(await h.platform.prefs.save({ themeMode: 'system', accent: '#6ea8fe' })).toEqual({
      ...DEFAULT_UI_PREFERENCES,
      sendWithModifierEnter: true,
      themeMode: 'system',
      accent: '#6ea8fe',
    })
  })

  /**
   * The text size moved from the workspace snapshot into the preferences (#312 step 5). The old
   * step comes across once; after that the record has its own value, and a snapshot that still
   * carries the old step (written by an older window) does not override a size chosen since.
   */
  describe('a fresh install with a snapshot from before #312', () => {
    let fresh: Harness
    beforeAll(async () => {
      fresh = await make()
    })
    afterAll(async () => fresh.cleanup())

    it('a text size kept in the workspace snapshot moves into the preferences once', async () => {
      await fresh.platform.workspace.save({ textScale: 4 })
      expect((await fresh.platform.prefs.load()).textSize).toBe(1.25)
      expect((await fresh.platform.prefs.save({ textSize: 0.925 })).textSize).toBe(0.925)
      await fresh.platform.workspace.save({ textScale: 4 })
      expect((await fresh.platform.prefs.load()).textSize).toBe(0.925)
    })
  })

  it('a text size between the steps lands on the nearest one, and the other appearance fields round-trip', async () => {
    expect(await h.platform.prefs.save({ textSize: 1.2, bodyFont: 'Inter', codeFont: '"JetBrains Mono"', lineHeight: 'relaxed' })).toMatchObject({
      textSize: 1.25,
      bodyFont: 'Inter',
      codeFont: '"JetBrains Mono"',
      lineHeight: 'relaxed',
    })
  })

  /**
   * Theme files (#312): a save is a file the list reads back, a second save of the same id
   * replaces it, an import copies a file in under a fresh id, and every change is announced.
   */
  it('theme files: save, list, overwrite and import round-trip, and each change is announced', async () => {
    const seen: NormalizedEvent[] = []
    const off = h.platform.agents.subscribe((e) => seen.push(e))
    const saved = await h.platform.themes.save(null, { name: 'Paper', base: 'light', tokens: { 'surface-floor': '#fafafa' } })
    expect(saved).toMatchObject({ id: 'paper', name: 'Paper', base: 'light', tokens: { 'surface-floor': '#fafafa' }, broken: false })
    await waitFor(() => seen.some((e) => e.type === 'themes_changed'))

    await h.platform.themes.save('paper', { name: 'Paper', base: 'light', tokens: { ink: '#111111' } })
    expect((await h.platform.themes.list()).map((t) => [t.id, t.tokens])).toEqual([['paper', { ink: '#111111' }]])

    const path = h.outsideThemeFile('Shared.json', JSON.stringify({ name: 'Paper', base: 'light', tokens: { 'ink-faint': '#999999' } }))
    const imported = await h.platform.themes.importFile(path)
    expect(imported).toMatchObject({ id: 'paper-2', tokens: { 'ink-faint': '#999999' } })
    expect((await h.platform.themes.list()).map((t) => t.id)).toEqual(['paper', 'paper-2'])
    off()
  })

  it('unsubscribing works', async () => {
    const seen: NormalizedEvent[] = []
    const off = h.platform.agents.subscribe((e) => seen.push(e))
    const [p] = await h.platform.projects.list()
    const s = await h.platform.agents.createSession({ projectId: p!.id, cwd: p!.path, tool: 'claude', permissionPreset: 'normal' })
    await h.platform.agents.send(s.id, 'a')
    await waitFor(() => seen.length > 0)
    const count = seen.length
    off()
    await h.platform.agents.send(s.id, 'b')
    await new Promise((r) => setTimeout(r, 100))
    expect(seen.length).toBe(count)
  })
})

/**
 * The half of the path contract this machine cannot run (issue #47).
 *
 * Everything above runs the same suite against both implementations, which is what catches them
 * drifting apart. Separators are the one axis where that does not work: the harness above builds
 * a real directory with `mkdtempSync` and the host refuses a path that is not on the disk, so a
 * Windows-shaped project directory can never reach it from here. On the axis it *can* reach, the
 * two agreed — on the same wrong assumption, which is the failure this file is supposed to make
 * impossible.
 *
 * So the mock's answer is pinned to the function the host uses instead of to the host itself.
 * `SessionManager.addProject` names a project with `basename` from `node:path`; on Windows that
 * is `win32.basename`. Reading only `/` here meant the mock called a project
 * `C:\Users\me\proj` while the host called it `proj`, and e2e — which only ever runs the mock —
 * had no way to notice.
 */
describe('Platform contract: path separator (#47)', () => {
  it('the project name the mock builds matches the basename the host uses', async () => {
    const mock = createMockPlatform()
    const windowsDir = 'C:\\Users\\me\\proj'
    expect((await mock.projects.add(windowsDir)).name).toBe(win32.basename(windowsDir))

    const posixDir = '/Users/me/proj'
    expect((await mock.projects.add(posixDir)).name).toBe(posix.basename(posixDir))
  })

  /**
   * The mock's "cannot go outside" reads the **wire path** (the same rule caught in #19).
   * Since the segments are obtained from the protocol, the real thing and the mock read the
   * same string as the same segments.
   */
  it('the mock also rejects a wire path that points outside the root', async () => {
    const mock = createMockPlatform()
    const p = await mock.projects.add('/tmp/sep-contract')
    await expect(mock.fs.importFile(p.id, '../..', 'evil.txt', btoa('x'))).rejects.toThrow(
      /outside the project/,
    )
    // And the inside is accepted as normal — if a rejection blocked everything, that would be a bug, not a rule
    expect((await mock.fs.importFile(p.id, '', 'ok.txt', btoa('x'))).path).toBe('ok.txt')
  })
})

/**
 * The app screen's three doors (M4 B-3) — whether the web implementation connects straight
 * through to the host's RPC.
 *
 * A spot where the same suite cannot be run against the mock. The mock has no host to
 * construct a screen address (e2e plugs the real ViewHost into the mock for that). So only the
 * web implementation is tested against a real host and ViewHost — only the side that reads
 * documents (ViewSource) is a stand-in.
 */
describe('Platform contract: app screen (web + real host)', () => {
  it('an opened screen gets an address with a secret path, and resources and tools go to the host', async () => {
    const store = new Store()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', new EchoAdapter()]])
    const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
    const secret = 'contract-view-secret-0123456789abcdefgh'
    let port: number | null = null
    const reads: string[] = []
    const views = new ViewHost({
      secret,
      allowedOrigins: ['http://127.0.0.1:5174'],
      source: {
        async readResource(app, uri) {
          reads.push(`${app.projectId}/${app.appId} ${uri}`)
          return { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<p>v</p>' }] }
        },
      },
      ports: new OriginPorts({ load: () => null, save: () => {} }, { log: () => {} }),
      hostPort: () => port,
      log: () => {},
    })
    const server = new HostServer({
      port: 0,
      token: 'contract',
      onRpc: createRpcHandler(mgr, adapters, { views }),
      http: { secret, routes: views.routes },
    })
    port = await server.listen()
    const platform = createWebPlatform({ hostUrl: `ws://127.0.0.1:${port}`, token: 'contract', WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket })
    try {
      await waitFor(() => platform.agents.listSessions().then(() => true).catch(() => false))
      const { instanceId } = views.open({ projectId: 'p1', appId: 'notes' }, 'ui://notes/board')

      const frame = await platform.apps.viewFrame('notes', instanceId, { projectId: 'p1', hostOrigin: 'http://127.0.0.1:5174' })
      expect(frame.url.startsWith(`http://127.0.0.1:${port}/${secret}/views/${instanceId}/?`)).toBe(true)
      expect(frame.sandbox.csp.connectDomains).toEqual([])
      // Even the same instance does not open if the app name or the project differs
      await expect(platform.apps.viewFrame('other', instanceId, { projectId: 'p1', hostOrigin: 'http://127.0.0.1:5174' })).rejects.toThrow(/not open/)
      await expect(platform.apps.viewFrame('notes', instanceId, { hostOrigin: 'http://127.0.0.1:5174' })).rejects.toThrow(/not open/)

      const res = await platform.apps.readResource('notes', 'ui://notes/data', { projectId: 'p1', instanceId })
      expect(res.contents[0]).toMatchObject({ uri: 'ui://notes/data', text: '<p>v</p>' })
      expect(reads.at(-1)).toBe('p1/notes ui://notes/data')
    } finally {
      await platform.dispose()
      await mgr.disposeAll()
      await views.dispose()
      await server.close()
      store.close()
    }
  })
})

/**
 * A tool call from a screen (M4 B-4 `oncalltool`) — web implementation → `apps.invoke` →
 * external app runtime → a real app process (the `view` mode of the runtime fixture). What the
 * screen receives has to be exactly the MCP result the app gave. The "changed" that call
 * produces is broadcast through the same seam as main.ts (`broadcastAppChanges`), and comes
 * back carrying the calling screen's instance as the owner (B-5) — only that screen skips that
 * notification.
 */
describe('Platform contract: tool call from a screen (web + real host + real app)', () => {
  it("the app's response arrives intact down to structuredContent, isError and _meta, and a call that could not reach the app is an isError carrying a reason", async () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-contract-apps-')))
    const projRoot = join(fixture, 'proj')
    mkdirSync(join(fixture, 'data'))
    plantApp(join(projRoot, ...PROJECT_APPS), 'slider', {
      server: {
        command: process.execPath,
        args: [fileURLToPath(new URL('../../agent-host/src/apps/external/test-fixtures/app.mjs', import.meta.url)), '--mode', 'view'],
      },
    })
    const store = new Store()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', new EchoAdapter()]])
    const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
    const project = await mgr.addProject(projRoot)
    mgr.setProjectTrusted(project.id, true)
    const changes = broadcastAppChanges((e) => server.broadcast(e))
    const rt = new ExternalApps({
      projects: () => store.projectRoots(),
      dataRoot: join(fixture, 'data'),
      reservedIds: ['control'],
      timing: { graceMs: 1_000, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
      emitChanged: changes.emit,
    })
    rt.refresh()
    let port: number | null = null
    const views = new ViewHost({
      secret: 'contract-app-secret-0123456789abcdefgh',
      allowedOrigins: ['http://127.0.0.1:5174'],
      source: runtimeViewSource(rt),
      ports: new OriginPorts({ load: () => null, save: () => {} }, { log: () => {} }),
      hostPort: () => port,
      log: () => {},
    })
    const server = new HostServer({ port: 0, token: 'contract', onRpc: createRpcHandler(mgr, adapters, { externalApps: rt, views }) })
    port = await server.listen()
    const platform = createWebPlatform({ hostUrl: `ws://127.0.0.1:${port}`, token: 'contract', WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket })
    const from = { projectId: project.id, instanceId: 'frame-contract' }
    const heard: NormalizedEvent[] = []
    const off = platform.agents.subscribe((e) => void heard.push(e))
    try {
      await waitFor(() => platform.agents.listSessions().then(() => true).catch(() => false))

      const ok = await platform.apps.callTool('slider', 'set_interval', { seconds: 9 }, from)
      expect(ok).toMatchObject({
        content: [{ type: 'text', text: 'interval 9' }],
        structuredContent: { interval: 9 },
        _meta: { 'fixture/served-by': expect.any(Number) },
      })
      expect(ok.isError).toBeFalsy()
      // The state lives in the app process — the next read sees the same value
      expect((await platform.apps.callTool('slider', 'get_interval', {}, from)).structuredContent).toEqual({ interval: 9 })

      // The app answered with a failure — the shape of the failure also belongs to the screen
      const failed = await platform.apps.callTool('slider', 'set_interval', { seconds: -1 }, from)
      expect(failed).toMatchObject({ isError: true, structuredContent: { field: 'seconds', got: -1 }, content: [{ type: 'text', text: 'seconds must be positive' }] })

      // The host never sent it to the app (a tool not opened to a screen) — the reason arrives as the result
      const refused = await platform.apps.callTool('slider', 'agent_only', {}, from)
      expect(refused.isError).toBe(true)
      expect(refused.structuredContent).toBeUndefined()
      expect(JSON.stringify(refused.content)).toContain('visibility')

      // A screen cannot enter through a built-in app's door (apps.invoke with no projectId) — there is no control in the user folder
      await expect(platform.apps.callTool('control', 'control_notify', { text: 'x' })).rejects.toThrow(/There is no such app: user\/control/)

      // The change this screen produced comes back carrying this screen's instance as the owner — the broadcast does not slip past web's own check
      await waitFor(() => heard.some((e) => e.type === 'external_app_state_changed'))
      const changed = heard.filter((e) => e.type === 'external_app_state_changed')
      for (const e of changed) {
        expect(e).toEqual({ type: 'external_app_state_changed', appId: 'slider', projectId: project.id, cause: { kind: 'view', instanceId: 'frame-contract' } })
      }
    } finally {
      off()
      changes.dispose()
      await platform.dispose()
      await mgr.disposeAll()
      await views.dispose()
      await rt.dispose()
      await server.close()
      store.close()
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

/**
 * The external app list (M4 A-8) — the web implementation's `apps.list` and
 * `external_apps_changed` run through a real host and a real runtime. Plugs in the exact same
 * seam main.ts uses (`onExternalAppListChanged`).
 */
describe('Platform contract: external app list (web + real host)', () => {
  it('the list comes with a reason, a broadcast arrives when trust changes, and the list re-read at that point is the new state', async () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-contract-applist-')))
    const projRoot = join(fixture, 'proj')
    mkdirSync(join(fixture, 'data'))
    plantApp(join(projRoot, ...PROJECT_APPS), 'notes')
    const store = new Store()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', new EchoAdapter()]])
    const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
    const project = await mgr.addProject(projRoot)
    const rt = new ExternalApps({ projects: () => store.projectRoots(), dataRoot: join(fixture, 'data'), reservedIds: ['control'] })
    rt.refresh()
    const server = new HostServer({ port: 0, token: 'contract', onRpc: createRpcHandler(mgr, adapters, { externalApps: rt }) })
    onExternalAppListChanged(rt, () => server.broadcast({ type: 'external_apps_changed' }))
    const port = await server.listen()
    const platform = createWebPlatform({ hostUrl: `ws://127.0.0.1:${port}`, token: 'contract', WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket })
    const heard: string[] = []
    const off = platform.agents.subscribe((e) => void heard.push(e.type))
    try {
      await waitFor(() => platform.agents.listSessions().then(() => true).catch(() => false))
      expect((await platform.apps.list()).map((a) => [a.appId, a.projectId, a.status])).toEqual([['notes', project.id, 'untrusted']])

      mgr.setProjectTrusted(project.id, true)
      rt.refresh()
      await waitFor(() => heard.includes('external_apps_changed'))
      expect((await platform.apps.list()).find((a) => a.appId === 'notes')?.status).toBe('stopped')

      // A user-folder app can be deleted (A-7), and the host rejects a project app
      plantApp(join(fixture, 'data', 'apps'), 'helper')
      rt.refresh()
      await waitFor(async () => (await platform.apps.list()).some((a) => a.appId === 'helper'))
      await platform.apps.remove('helper', null)
      expect((await platform.apps.list()).map((a) => a.appId)).toEqual(['notes'])
      await expect(platform.apps.remove('notes', project.id)).rejects.toThrow(/part of the project's repository/)
    } finally {
      off()
      await platform.dispose()
      await mgr.disposeAll()
      await rt.dispose()
      await server.close()
      store.close()
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

/**
 * A pinned screen (M4 B-2) — the web implementation's `openView`/`closeView` run through a
 * real host, a real runtime and a real app process. An opened instance opens via `viewFrame`,
 * and once closed does not open again.
 */
describe('Platform contract: pinned screen (web + real host + real app)', () => {
  it('the result and instance home called arrive, a home with no screen is rejected with a reason, and a closed instance does not open again', async () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-contract-home-')))
    const projRoot = join(fixture, 'proj')
    mkdirSync(join(fixture, 'data'))
    const server0 = {
      command: process.execPath,
      args: [fileURLToPath(new URL('../../agent-host/src/apps/external/test-fixtures/app.mjs', import.meta.url)), '--mode', 'view'],
    }
    plantApp(join(projRoot, ...PROJECT_APPS), 'slider', { server: server0, home: 'home' })
    plantApp(join(projRoot, ...PROJECT_APPS), 'plain', { server: server0, home: 'no_screen' })
    const store = new Store()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', new EchoAdapter()]])
    const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
    const project = await mgr.addProject(projRoot)
    mgr.setProjectTrusted(project.id, true)
    const rt = new ExternalApps({
      projects: () => store.projectRoots(),
      dataRoot: join(fixture, 'data'),
      reservedIds: ['control'],
      runs: storeRunLedger(store),
      timing: { graceMs: 1_000, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
    })
    rt.refresh()
    let port: number | null = null
    const secret = 'contract-home-secret-0123456789abcdefgh'
    const views = new ViewHost({
      secret,
      allowedOrigins: ['http://127.0.0.1:5174'],
      source: runtimeViewSource(rt),
      ports: new OriginPorts({ load: () => null, save: () => {} }, { log: () => {} }),
      hostPort: () => port,
      log: () => {},
    })
    const server = new HostServer({ port: 0, token: 'contract', onRpc: createRpcHandler(mgr, adapters, { externalApps: rt, views }), http: { secret, routes: views.routes } })
    port = await server.listen()
    const platform = createWebPlatform({ hostUrl: `ws://127.0.0.1:${port}`, token: 'contract', WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket })
    const hostOrigin = 'http://127.0.0.1:5174'
    try {
      await waitFor(() => platform.agents.listSessions().then(() => true).catch(() => false))

      const v = await platform.apps.openView('slider', project.id)
      expect(v).toMatchObject({ tool: 'home', resourceUri: 'ui://fixture/main', toolInput: {}, toolResult: { structuredContent: { interval: 5 } } })
      const frame = await platform.apps.viewFrame('slider', v.instanceId, { projectId: project.id, hostOrigin })
      expect(frame.url).toContain(`/${secret}/views/${v.instanceId}/`)
      // What the run-history panel (B-7) reads — the host's history has "the screen called home"
      expect((await platform.apps.runs('slider', project.id)).map((r) => [r.id, r.tool, r.callerKind, r.status])).toEqual([[v.runId, 'home', 'view', 'ok']])

      await expect(platform.apps.openView('plain', project.id)).rejects.toThrow('declares no _meta.ui.resourceUri')

      await platform.apps.closeView(v.instanceId)
      await expect(platform.apps.viewFrame('slider', v.instanceId, { projectId: project.id, hostOrigin })).rejects.toThrow(/not open/)

      // Restart (B-6) goes to the host's apps.restart — an app that was up comes down, and a nonexistent app is rejected with its name
      expect(rt.list().find((a) => a.appId === 'slider')?.status).toBe('running')
      await platform.apps.restart('slider', project.id)
      expect(rt.list().find((a) => a.appId === 'slider')?.status).toBe('stopped')
      await expect(platform.apps.restart('ghost', project.id)).rejects.toThrow(/ghost/)
    } finally {
      await platform.dispose()
      await mgr.disposeAll()
      await views.dispose()
      await rt.dispose()
      await server.close()
      store.close()
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

/**
 * A new app (M4 C-1) — the web implementation's `create`, `builder` and `createBuilder` run
 * through a real host, a real runtime and a real template. Rejection arrives exactly as the
 * host phrased it (the "New app" window shows that wording).
 */
describe('Platform contract: new app (web + real host)', () => {
  it('the app and its builder session are returned, that app is found by its builder session, an existing id is rejected with the host wording, and a message from the input line reaches that session', async () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-contract-newapp-')))
    const projRoot = join(fixture, 'proj')
    mkdirSync(projRoot)
    mkdirSync(join(fixture, 'data'))
    const store = new Store()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', new EchoAdapter()]])
    const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
    const project = await mgr.addProject(projRoot)
    mgr.setProjectTrusted(project.id, true)
    const rt = new ExternalApps({ projects: () => store.projectRoots(), dataRoot: join(fixture, 'data'), reservedIds: ['control'] })
    rt.refresh()
    mgr.useExternalApps(rt)
    const server = new HostServer({ port: 0, token: 'contract', onRpc: createRpcHandler(mgr, adapters, { externalApps: rt }) })
    const port = await server.listen()
    const platform = createWebPlatform({ hostUrl: `ws://127.0.0.1:${port}`, token: 'contract', WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket })
    try {
      await waitFor(() => platform.agents.listSessions().then(() => true).catch(() => false))
      const made = await platform.apps.create({ projectId: project.id, id: 'notes', name: 'Notes', tool: 'claude' })
      expect(made.app).toMatchObject({ appId: 'notes', projectId: project.id, name: 'Notes', home: 'show', status: 'stopped' })
      expect(made.builder).toMatchObject({ appId: 'notes', projectId: project.id, name: 'Notes · builder', tool: 'claude' })
      expect((await platform.apps.builder('notes', project.id))?.id).toBe(made.builder!.id)
      expect((await platform.apps.createBuilder('notes', project.id)).id).toBe(made.builder!.id)
      await expect(platform.apps.create({ projectId: project.id, id: 'notes', name: 'Again' })).rejects.toThrow(/An app "notes" already exists/)
      expect(await platform.apps.builder('ghost', project.id)).toBeNull()
      // Whether a session reaches the app's tools (#308) — its builder does; a user-folder app is not this project's
      expect(await platform.apps.reach(made.builder!.id, 'notes', project.id)).toEqual({ reachable: true })
      expect(await platform.apps.reach(made.builder!.id, 'ghost', null)).toEqual({ reachable: false, reason: 'unavailable' })

      // "Fix this" (C-5) — the builder session's agent receives the message with the host's header attached (the echo adapter sends it back)
      const heard: string[] = []
      const off = platform.agents.subscribe((e) => {
        if (e.type === 'message_delta' && e.sessionId === made.builder!.id) heard.push(e.text)
      })
      expect(await platform.apps.askBuilder({ appId: 'notes', projectId: project.id, text: 'Add a reset button' })).toEqual({ sessionId: made.builder!.id })
      await waitFor(() => heard.length > 0)
      off()
      expect(heard).toEqual(['echo:[Centralu] The person wrote this in the app "Notes" (app-notes) that you build.\nAdd a reset button'])
      await expect(platform.apps.askBuilder({ appId: 'ghost', projectId: project.id, text: 'hi' })).rejects.toThrow('This app no longer exists')

      // An error bundle (C-6) — when a tool called from a screen fails, the host holds the bundle, and it goes out once when the person clicks
      await platform.apps.callTool('notes', 'increment', { by: 'many' }, { projectId: project.id })
      const { latest } = await platform.apps.errors('notes', project.id)
      expect(latest).toMatchObject({ kind: 'tool', tool: 'increment', sentAt: null })
      heard.length = 0
      const off2 = platform.agents.subscribe((e) => {
        if (e.type === 'message_delta' && e.sessionId === made.builder!.id) heard.push(e.text)
      })
      expect(await platform.apps.sendError('notes', project.id, latest!.at)).toEqual({ sessionId: made.builder!.id })
      await waitFor(() => heard.length > 0)
      off2()
      expect(heard[0]).toMatch(/^echo:\[Centralu\] The person sent you this error report from the app "Notes" \(app-notes\)/)
      expect((await platform.apps.errors('notes', project.id)).latest?.sentAt).toEqual(expect.any(Number))
      await expect(platform.apps.sendError('notes', project.id, latest!.at)).rejects.toThrow('This error was already sent to the builder')
    } finally {
      await platform.dispose()
      await mgr.disposeAll()
      await rt.dispose()
      await server.close()
      store.close()
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

/**
 * An app's secrets (M4 E) — the web implementation's `setSecret` runs through a real host and
 * a real runtime. The list carries only present/absent per name (no values), and setting one
 * broadcasts. Rejection arrives exactly as the host phrased it — the secret field shows that
 * wording.
 */
describe('Platform contract: app secrets (web + real host)', () => {
  it('setting one flips the listing to "set" and broadcasts, the value never appears in the listing, and an undeclared name is rejected with the host wording', async () => {
    const VALUE = 'contract-secret-value-42'
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-contract-secrets-')))
    const projRoot = join(fixture, 'proj')
    mkdirSync(join(fixture, 'data'))
    plantApp(join(projRoot, ...PROJECT_APPS), 'keys', { secrets: ['API_KEY'] })
    const store = new Store()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', new EchoAdapter()]])
    const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
    const project = await mgr.addProject(projRoot)
    mgr.setProjectTrusted(project.id, true)
    const rt = new ExternalApps({ projects: () => store.projectRoots(), dataRoot: join(fixture, 'data'), reservedIds: ['control'] })
    rt.refresh()
    const server = new HostServer({ port: 0, token: 'contract', onRpc: createRpcHandler(mgr, adapters, { externalApps: rt }) })
    onExternalAppListChanged(rt, () => server.broadcast({ type: 'external_apps_changed' }))
    const port = await server.listen()
    const platform = createWebPlatform({ hostUrl: `ws://127.0.0.1:${port}`, token: 'contract', WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket })
    const heard: string[] = []
    const off = platform.agents.subscribe((e) => void heard.push(e.type))
    const slots = async () => (await platform.apps.list()).find((a) => a.appId === 'keys')?.secrets
    try {
      await waitFor(() => platform.agents.listSessions().then(() => true).catch(() => false))
      expect(await slots()).toEqual([{ name: 'API_KEY', set: false }])

      await platform.apps.setSecret('keys', project.id, 'API_KEY', VALUE)
      await waitFor(() => heard.includes('external_apps_changed'))
      expect(await slots()).toEqual([{ name: 'API_KEY', set: true }])
      expect(JSON.stringify(await platform.apps.list())).not.toContain(VALUE)

      await expect(platform.apps.setSecret('keys', project.id, 'NOPE', VALUE)).rejects.toThrow('This app does not declare a secret named NOPE')
      await expect(platform.apps.setSecret('keys', project.id, 'API_KEY', '')).rejects.toThrow('Enter a value, or clear the secret instead')
      await platform.apps.setSecret('keys', project.id, 'API_KEY', null)
      expect(await slots()).toEqual([{ name: 'API_KEY', set: false }])
    } finally {
      off()
      await platform.dispose()
      await mgr.disposeAll()
      await rt.dispose()
      await server.close()
      store.close()
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

/**
 * Import (M4 E-3) — the web implementation's `importPrepare`, `importCommit`, `review` and
 * `enable` run through a real host and a real runtime. An admitted app stands in the list
 * disabled (`unconfirmed`), and enabling it with the key the person reviewed makes it an
 * ordinary user-folder app. Rejection arrives exactly as the host phrased it.
 */
describe('Platform contract: app import (web + real host)', () => {
  it('preparing does not admit it, admitting it stands it up disabled, it is enabled with the review window key — a different key is rejected with the host wording', async () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-contract-import-')))
    mkdirSync(join(fixture, 'data'))
    const source = plantApp(join(fixture, 'src'), 'notes', { uses: { agent: true } })
    const store = new Store()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', new EchoAdapter()]])
    const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
    const rt = new ExternalApps({ projects: () => store.projectRoots(), dataRoot: join(fixture, 'data'), reservedIds: ['control'] })
    rt.refresh()
    const server = new HostServer({ port: 0, token: 'contract', onRpc: createRpcHandler(mgr, adapters, { externalApps: rt }) })
    const port = await server.listen()
    const platform = createWebPlatform({ hostUrl: `ws://127.0.0.1:${port}`, token: 'contract', WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket })
    try {
      await waitFor(() => platform.agents.listSessions().then(() => true).catch(() => false))
      const { token, review } = await platform.apps.importPrepare(source)
      expect(review).toMatchObject({ appId: 'notes', uses: { agent: true }, source, changed: null })
      expect(await platform.apps.list()).toEqual([])

      const app = await platform.apps.importCommit(token, { enable: false })
      expect(app).toMatchObject({ appId: 'notes', projectId: null, status: 'unconfirmed', imported: { source, confirmedAt: null } })
      expect((await platform.apps.review('notes', null)).reviewKey).toBe(review.reviewKey)
      await expect(platform.apps.enable('notes', null, 'nope')).rejects.toThrow('This app changed since you reviewed it. Review it again')
      expect(await platform.apps.enable('notes', null, review.reviewKey)).toMatchObject({ status: 'stopped', imported: { confirmedAt: expect.any(Number) } })
      await expect(platform.apps.importPrepare(source)).rejects.toThrow('An app with the id "notes" is already in your apps')
      await expect(platform.apps.importPrepare('http://example.com/a.zip')).rejects.toThrow('Only folders and .zip files on this machine, or https links, can be imported')
    } finally {
      await platform.dispose()
      await mgr.disposeAll()
      await rt.dispose()
      await server.close()
      store.close()
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

/**
 * A local image a reply names, across the real wire: the schema carries the answer both ways, a refusal arrives as an
 * answer with its reason rather than an error, and a browser cannot reveal the file.
 */
describe('Platform contract: an image a reply names (web + real host)', () => {
  it('reads one a reply wrote, refuses one no reply wrote, and says a browser cannot reveal it', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-contract-reply-image-')))
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
    writeFileSync(join(dir, 'shot.png'), png)
    writeFileSync(join(dir, 'other.png'), png)
    const store = new Store()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', new EchoAdapter()]])
    const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
    const server = new HostServer({ port: 0, token: 'contract', onRpc: createRpcHandler(mgr, adapters) })
    const port = await server.listen()
    const platform = createWebPlatform({ hostUrl: `ws://127.0.0.1:${port}`, token: 'contract', WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket })
    try {
      await waitFor(() => platform.agents.listSessions().then(() => true).catch(() => false))
      const p = await platform.projects.add(dir)
      const s = await platform.agents.createSession({ projectId: p.id, cwd: p.path, tool: 'claude', permissionPreset: 'normal' })
      // The echo agent repeats the message as its reply, so the reply names the path
      await platform.agents.send(s.id, `![shot](${join(dir, 'shot.png')})`)
      expect(await platform.agents.messageImage(s.id, join(dir, 'shot.png'))).toEqual({
        ok: true,
        mime: 'image/png',
        data: png.toString('base64'),
        file: join(dir, 'shot.png'),
      })
      expect(await platform.agents.messageImage(s.id, join(dir, 'other.png'))).toMatchObject({ ok: false, reason: 'not_mentioned' })
      const reveal = await platform.fs.revealMessageImage(join(dir, 'shot.png'))
      expect(reveal.supported).toBe(false)
      expect(reveal.reason).toMatch(/\S/)
    } finally {
      await platform.dispose()
      await mgr.disposeAll()
      await server.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
