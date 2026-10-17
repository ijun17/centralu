import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { FOLDER_CACHE_KEYS, remember } from './folder-cache.js'
import { SessionManager } from './manager.js'

describe('the per-folder caches keep the most recently used tool-and-folder keys only (#392)', () => {
  it('lets the least recently used key go past the cap', () => {
    const m = new Map<string, number>()
    for (let i = 0; i < 100; i++) remember(m, `claude:/wt/${i}`, i, 32)
    expect(m.size).toBe(32)
    expect(m.has('claude:/wt/99')).toBe(true)
    expect(m.has('claude:/wt/0')).toBe(false)
  })

  it('a key used again is kept over older ones', () => {
    const m = new Map<string, number>()
    remember(m, 'a', 1, 2)
    remember(m, 'b', 2, 2)
    remember(m, 'a', 3, 2)
    remember(m, 'c', 4, 2)
    expect([...m.keys()]).toEqual(['a', 'c'])
  })
})

/*
 * The wiring: every write to the session manager's two per-folder caches goes through `remember`. Each test drives
 * one of the three call sites alone across more folders than the cap; a plain `.set` at that site lets its cache
 * grow by one key per folder.
 */

class Handle implements SessionHandle {
  externalId: string | null = null
  listCommands?: () => Promise<{ name: string }[]>
  constructor(
    readonly sessionId: string,
    answers: boolean,
  ) {
    if (answers) this.listCommands = async () => [{ name: 'from-the-tool' }]
  }
  send() {}
  respondApproval() {
    return true
  }
  interrupt() {}
  async dispose() {}
}

class Adapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
  }
  /** Whether a session's process answers the slash-command list */
  answers = false
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async listExternalSessions() {
    return [{ externalId: 'x', title: 'x', updatedAt: 1 }]
  }
  async createSession(opts: CreateSessionOpts, _emit: EventSink) {
    return new Handle(opts.sessionId, this.answers)
  }
}

const FOLDERS = FOLDER_CACHE_KEYS + 8

let root = ''
let store: Store
let adapter: Adapter
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>

/** What the manager holds in one of its caches — reached past its interface on purpose: the size is invisible through it */
const held = (name: 'commandCache' | 'externalIndex') => {
  // The index lives with the external conversations since #428, the commands with the tool queries
  const parts = mgr as unknown as { externals: object; toolQueries: object }
  const owner = name === 'externalIndex' ? parts.externals : parts.toolQueries
  return (owner as unknown as Record<typeof name, Map<string, unknown>>)[name].size
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-folder-cache-')))
  store = new Store()
  adapter = new Adapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  mgr = new SessionManager(store, adapters, () => {})
  rpc = createRpcHandler(mgr, adapters)
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** A project of its own per folder, so each session has its own tool-and-folder key */
async function sessionIn(i: number): Promise<{ dir: string; id: string }> {
  const dir = join(root, `f${i}`)
  mkdirSync(dir)
  const p = (await rpc('projects.add', { path: dir })) as { id: string; path: string }
  const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
  return { dir: p.path, id: s.id }
}

describe('the session manager writes its per-folder caches through remember (#392)', () => {
  it('slash commands read back from disk', async () => {
    for (let i = 0; i < FOLDERS; i++) {
      store.saveCommands('claude', join(root, `f${i}`), [{ name: 'from-disk', description: '', argumentHint: '' }])
      const { id } = await sessionIn(i)
      expect((await mgr.listCommands(id)).commands.map((c) => c.name)).toEqual(['from-disk'])
    }
    expect(held('commandCache')).toBe(FOLDER_CACHE_KEYS)
  })

  it('slash commands the tool answered', async () => {
    adapter.answers = true
    /*
     * Waits on the save itself (#786). Polling for it with `vi.waitFor` cost one 50 ms interval per folder, about
     * 2 of the test's 3 to 4 s, and a loaded full run then took it past its 5 s limit.
     */
    const saved = new Set<string>()
    let onSave = () => {}
    const save = store.saveCommands.bind(store)
    store.saveCommands = (tool, cwd, commands) => {
      save(tool, cwd, commands)
      saved.add(cwd)
      onSave()
    }
    const savedIn = (dir: string) =>
      new Promise<void>((resolve) => {
        onSave = () => saved.has(dir) && resolve()
        onSave()
      })
    for (let i = 0; i < FOLDERS; i++) {
      const { dir } = await sessionIn(i)
      // Creating a session fetches its commands ahead of time; the answer is saved right after it is cached
      await savedIn(dir)
      expect(store.loadCommands('claude', dir)).not.toBeNull()
    }
    expect(held('commandCache')).toBe(FOLDER_CACHE_KEYS)
  })

  it("the index of a tool's stored conversations", async () => {
    // Private: it is reached only on the wake path, and the key it caches under is all this asks about
    const indexOf = (cwd: string) => (mgr as unknown as { externals: { externalIndexOf(t: ToolName, c: string): Promise<unknown> } }).externals.externalIndexOf('claude', cwd)
    for (let i = 0; i < FOLDERS; i++) expect(await indexOf(join(root, `f${i}`))).not.toBeNull()
    expect(held('externalIndex')).toBe(FOLDER_CACHE_KEYS)
  })
})
