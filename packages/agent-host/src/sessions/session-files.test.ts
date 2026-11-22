import { describe, expect, it, vi } from 'vitest'
import type { SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { FakeAdapter, projectDirs } from './manager.test-helpers.js'

/**
 * What a tool's adapter keeps per session (`AgentAdapter.sweepSessionFiles`, Antigravity's TEMP on Windows) goes when the
 * session is deleted for good: after the purge, and at the next host's start for a purge it did not see. A live session,
 * one being started and an archived one keep theirs
 */

/** An adapter that keeps a file per session it started, and lets go of those the sweep does not keep */
class KeepingAdapter extends FakeAdapter {
  readonly files = new Set<string>()
  /** Run while a session is being started, after its file is made and before its handle is back */
  duringStart: (() => Promise<void>) | null = null
  override async createSession(opts: CreateSessionOpts, emit: EventSink) {
    this.files.add(opts.sessionId)
    await this.duringStart?.()
    return super.createSession(opts, emit)
  }
  async sweepSessionFiles(kept: (sessionId: string) => boolean) {
    for (const id of this.files) if (!kept(id)) this.files.delete(id)
  }
}

const projectDir = projectDirs()

function world() {
  const store = new Store()
  const adapter = new KeepingAdapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  const mgr = new SessionManager(store, adapters, () => {})
  const rpc = createRpcHandler(mgr, adapters)
  const start = async () => {
    const p = (await rpc('projects.add', { path: projectDir('cc-session-files-') })) as { id: string; path: string }
    return (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo
  }
  return { store, adapter, adapters, mgr, start }
}

describe("a session's tool files", () => {
  it('go when it is deleted for good, at once or at the next start; a live or archived session keeps them', async () => {
    const { store, adapter, adapters, mgr, start } = world()
    const live = await start()
    const archived = await start()
    const purged = await start()
    await mgr.trash.trashSession(archived.id)
    await mgr.trash.trashSession(purged.id)
    // A purge whose sweep the host did not live to run
    adapter.files.add('gone')

    new SessionManager(store, adapters, () => {})
    await vi.waitFor(() => expect(adapter.files.has('gone')).toBe(false))
    expect([...adapter.files].sort()).toEqual([live.id, archived.id, purged.id].sort())

    await mgr.trash.purgeSession(purged.id)
    expect([...adapter.files].sort()).toEqual([live.id, archived.id].sort())
  })

  it('are kept for a session being started, before it is saved', async () => {
    const { adapter, mgr, start } = world()
    adapter.duringStart = () => mgr.trash.sweepSessionFiles()
    const s = await start()
    expect([...adapter.files]).toEqual([s.id])
  })
})
