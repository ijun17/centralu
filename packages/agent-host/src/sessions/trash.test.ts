import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApprovalDecision, ProjectInfo, SessionInfo, ToolName, TrashedSession } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'
import { createRpcHandler } from '../rpc.js'
import { ORCHESTRATOR_TOOLS, RARE_COMMANDS, RARE_TIERS, profileAllows } from './orchestrator-tools.js'
import { BROKER_TOOLS } from '../apps/external/broker.js'
import { HOST_CAPABILITIES } from '../apps/external/capabilities.js'

/**
 * The session archive beyond one session (#204): deleting a project, restoring into a project that is gone, and who can
 * delete for good. The one-session round trip and the guard across the listing paths are in manager.test.ts
 * ("deleting a session"); the store's side is in the UI's store-sessions.test.ts ("the session archive").
 */

class EchoHandle implements SessionHandle {
  externalId = 'ext-1'
  constructor(readonly sessionId: string, private emit: EventSink) {}
  send(text: string) {
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text: `echo:${text}` })
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
  }
  respondApproval(_requestId: string, _decision: ApprovalDecision): boolean {
    return true
  }
  interrupt() {}
  async dispose() {}
}

class EchoAdapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  readonly descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities = {
    approvals: true, contextUsage: 'exact' as const, resume: true, autoTitle: true, attachments: [],
    verbosities: [], exclusiveWriter: false, backgroundTasks: false,
  }
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'echo' }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    return new EchoHandle(opts.sessionId, emit)
  }
}

let root = ''
let rpc: ReturnType<typeof createRpcHandler>

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-trash-')))
  const store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', new EchoAdapter()]])
  const mgr = new SessionManager(store, adapters, () => {})
  rpc = createRpcHandler(mgr, adapters)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const folder = (name: string) => mkdtempSync(join(root, `${name}-`))
const addProject = async (path: string) => (await rpc('projects.add', { path })) as ProjectInfo
const newSession = async (p: ProjectInfo, text?: string) => {
  const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo
  if (text) await rpc('agents.send', { sessionId: s.id, text })
  return s
}
const trash = async () => (await rpc('trash.list', {})) as { sessions: TrashedSession[]; bytes: number }
const listed = async () => ((await rpc('sessions.list', {})) as SessionInfo[]).map((s) => s.id)

describe('deleting a project', () => {
  it('moves its sessions to the session archive, and restoring one registers the folder again under the same id', async () => {
    const p = await addProject(folder('alpha'))
    const a = await newSession(p, 'first words')
    const b = await newSession(p)

    await rpc('projects.delete', { projectId: p.id })

    expect(await rpc('projects.list', {})).toEqual([])
    expect(await listed()).toEqual([])
    const before = await trash()
    expect(before.sessions.map((s) => s.id).sort()).toEqual([a.id, b.id].sort())
    expect(before.sessions.every((s) => s.project?.id === p.id && s.project.name === p.name && !s.project.exists)).toBe(true)
    // Nobody was asked about the tool's file, so deleting all archived sessions would leave it in the tool
    expect(before.sessions.find((s) => s.id === a.id)?.conversationFile).toBe('keep')

    const back = (await rpc('trash.restore', { sessionId: a.id })) as { session: SessionInfo; project: ProjectInfo | null }
    expect(back.project).toMatchObject({ id: p.id, path: p.path, name: p.name })
    expect(back.session).toMatchObject({ id: a.id, projectId: p.id })
    expect(((await rpc('projects.list', {})) as ProjectInfo[]).map((x) => x.id)).toEqual([p.id])
    expect(await listed()).toEqual([a.id])
    expect(((await rpc('messages.search', { query: 'first words' })) as { sessionId: string }[]).map((h) => h.sessionId)).toContain(a.id)
    // The other one now has its project again, and restoring it needs no registering
    expect((await trash()).sessions.map((s) => [s.id, s.project?.exists])).toEqual([[b.id, true]])
    expect(((await rpc('trash.restore', { sessionId: b.id })) as { project: unknown }).project).toBeNull()
  })

  it('a session whose folder is gone too stays in the session archive and says where the folder was', async () => {
    const dir = folder('beta')
    const p = await addProject(dir)
    const s = await newSession(p)
    await rpc('projects.delete', { projectId: p.id })
    rmSync(dir, { recursive: true, force: true })

    await expect(rpc('trash.restore', { sessionId: s.id })).rejects.toThrow(`its folder is gone (${dir})`)
    expect((await trash()).sessions.map((x) => x.id)).toEqual([s.id])
    // Still readable, still deletable for good
    await expect(rpc('trash.read', { sessionId: s.id })).resolves.toBeDefined()
    await rpc('trash.purge', { sessionId: s.id })
    expect((await trash()).sessions).toEqual([])
  })

  it('restoring goes to the folder registered again under a new id', async () => {
    const dir = folder('gamma')
    const p = await addProject(dir)
    const s = await newSession(p)
    await rpc('projects.delete', { projectId: p.id })
    const again = await addProject(dir)
    expect(again.id).not.toBe(p.id)

    const back = (await rpc('trash.restore', { sessionId: s.id })) as { session: SessionInfo; project: unknown }
    expect(back.session.projectId).toBe(again.id)
    expect(back.project).toBeNull()
  })
})

describe('deleting all archived sessions', () => {
  it('deletes every session in it for good, and reports the total it took before', async () => {
    const p = await addProject(folder('delta'))
    const a = await newSession(p, 'one')
    const b = await newSession(p, 'two')
    await rpc('agents.deleteSession', { sessionId: a.id })
    await rpc('agents.deleteSession', { sessionId: b.id })
    const full = await trash()
    expect(full.bytes).toBe(full.sessions.reduce((n, s) => n + s.bytes, 0))
    expect(full.bytes).toBeGreaterThan(0)

    expect(await rpc('trash.empty', {})).toEqual({ purged: 2, failed: [] })
    expect(await trash()).toEqual({ sessions: [], runs: [], bytes: 0, subagentSteps: [] })
    expect(await rpc('messages.load', { sessionId: a.id, limit: 10 })).toEqual([])
  })
})

/*
 * Nobody but the person decides to delete for good (#204, carried from #96; #1219). The session archive is reached through the RPC,
 * which is the UI's socket, and by the central orchestrator's six trash commands, which make the same calls and delete
 * for good only after the person's card (trash-commands.test.ts); the sixth, `delete_session`, only moves a session to the
 * trash, and nothing in it is destroyed. This holds it three ways: no other agent tool, broker tool or host capability is
 * named for it, those six are rare commands of the orchestrator's seat alone, and no code outside the RPC handler calls
 * the manager's purge.
 */
const ORCHESTRATOR_TRASH_COMMANDS = ['list_archive', 'restore_archived', 'archive_subagent_steps', 'delete_session', 'delete_archived', 'delete_all_archived']
const TRASH_VERB = /archive|trash|purge|delete_session|restore_session|empty/i

describe('who can delete for good', () => {
  it("agents and apps have no verb for the session archive, but the orchestrator's six commands", () => {
    const names = [
      ...ORCHESTRATOR_TOOLS.map((t) => t.name),
      ...BROKER_TOOLS,
      ...HOST_CAPABILITIES,
    ]
    expect(names.length).toBeGreaterThan(10)
    // A new verb for the session archive has to be named in this list, with the card that guards its delete
    expect(names.filter((n) => TRASH_VERB.test(n)).sort()).toEqual([...ORCHESTRATOR_TRASH_COMMANDS].sort())
    expect([...BROKER_TOOLS, ...HOST_CAPABILITIES].filter((n) => TRASH_VERB.test(n))).toEqual([])
  })

  it("the orchestrator's session archive commands are its own rare commands: no other seat has them in any tier", () => {
    for (const name of ORCHESTRATOR_TRASH_COMMANDS) {
      expect(RARE_COMMANDS.orchestrator, name).toContain(name)
      for (const tier of RARE_TIERS) {
        for (const profile of ['scoped', 'builder', 'reader'] as const) {
          expect(profileAllows(profile, name, tier), `${profile} ${tier} ${name}`).toBe(false)
        }
      }
    }
  })

  it('only the RPC handler calls the purge', () => {
    const src = join(fileURLToPath(new URL('.', import.meta.url)), '..')
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && !/\.test(-helpers)?\.tsx?$/.test(e.name)) {
          for (const m of readFileSync(p, 'utf8').matchAll(/([\w.]+)\.(purgeSession|emptyTrash)\(/g)) {
            callers.push(`${p.slice(src.length + 1).replaceAll('\\', '/')}: ${m[1]}.${m[2]}`)
          }
        }
      }
    }
    walk(src)
    expect(callers.sort()).toEqual([
      'rpc.ts: mgr.emptyTrash',
      'rpc.ts: mgr.purgeSession',
      /*
       * The one deletion the host makes itself (#378): a finished app-agent session, once its record (request, answer,
       * the whole conversation) is kept in the session archive. It reaches the purge only through `agentRunEnded` after a clean run
       * (app-agents.test.ts holds when it does and when the session stays); the manager hands it the same purge
       */
      'sessions/app-sessions.ts: this.host.purgeSession',
      'sessions/manager.ts: self.purgeSession',
      // The manager passes the two calls on to its session archive (session-trash.ts, #428); the same calls, not other callers
      'sessions/manager.ts: this.trash.emptyTrash',
      'sessions/manager.ts: this.trash.purgeSession',
      // emptyTrash purges one by one; purgeSession removes the rows through the store
      'sessions/session-trash.ts: this.host.store.trash.purgeSession',
      'sessions/session-trash.ts: this.purgeSession',
    ])
  })
})
