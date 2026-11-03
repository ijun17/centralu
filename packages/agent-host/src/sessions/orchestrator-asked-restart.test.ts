/**
 * What the orchestrator's conversation read, across a host restart and a keeper swap (#1926, docs/plans/mailbox.md §9.7): the next host judges a
 * reply to a session's request by what was really read before it, on the same store in the same data folder, as the first host would have.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATOR_CHANGE, type ProjectInfo, type SessionInfo, type ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import type { HostMail } from '../mail/host-mail.js'
import { createRpcHandler } from '../rpc.js'
import { eventually } from '../../../../tooling/test-timing.js'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { FakeAdapter } from './manager.test-helpers.js'
import { FakeProcess } from './kept-host.test-helpers.js'
import { addressOf, mailReader, wireHostMail } from './host-mail.test-helpers.js'
import { commandsFor } from './orchestrator-tools.js'
import { SessionManager } from './manager.js'

let data = ''
let dirs: string[] = []
let clock = { t: 1_800_000_000_000 }
let hosts: Host[] = []

type Host = { store: Store; adapter: FakeAdapter; mgr: SessionManager; mail: HostMail; rpc: ReturnType<typeof createRpcHandler>; stopped: boolean }

/** A host on the data folder's store: its manager, its mail, and the fake tool its sessions run on */
async function startHost(kept: ReadonlySet<string> = new Set()): Promise<Host> {
  const store = new Store(`${data}/store.db`)
  const adapter = new FakeAdapter()
  adapter.capabilities.gatesSteps = true
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  const mgr = new SessionManager(store, adapters, () => {}, undefined, `${data}/worktrees`, { keptSessions: kept })
  const rpc = createRpcHandler(mgr, adapters)
  mgr.useWindowRpc((method, params) => rpc(method, params))
  const mail = wireHostMail(mgr, store, { now: () => clock.t, orchestratorHasMailCommand: () => commandsFor('orchestrator').includes('mail') })
  const sweep = vi.spyOn(mail.delivery, 'sweep')
  mail.delivery.start()
  await sweep.mock.results[0]?.value
  sweep.mockRestore()
  const host: Host = { store, adapter, mgr, mail, rpc, stopped: false }
  hosts.push(host)
  return host
}

async function stopHost(h: Host, how: 'quit' | 'swap') {
  h.mail.delivery.stop()
  await (how === 'quit' ? h.mgr.disposeAll() : h.mgr.detachAll())
  h.store.close()
  h.stopped = true
}

beforeEach(() => {
  data = tempRoot('cc-asked-restart-')
  vi.stubEnv('CC_DATA_DIR', data)
  dirs = []
  hosts = []
  clock = { t: 1_800_000_000_000 }
})
afterEach(async () => {
  for (const h of hosts) if (!h.stopped) await stopHost(h, 'quit')
  vi.unstubAllEnvs()
  for (const d of [...dirs, data]) await removeTree(d)
})

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
  await new Promise<void>((r) => setImmediate(r))
}

async function project(h: Host, label: string): Promise<ProjectInfo> {
  const dir = tempRoot(`cc-asked-${label}-`)
  dirs.push(dir)
  const p = (await h.rpc('projects.add', { path: dir })) as ProjectInfo
  await h.rpc('projects.setTrusted', { projectId: p.id, trusted: true })
  return p
}
const sessionIn = async (h: Host, p: ProjectInfo) => (await h.rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo

/** The session asks the orchestrator, and the request's turn begins */
async function ask(h: Host, orc: string, asker: SessionInfo, text: string): Promise<string> {
  expect((await h.mgr.runOrchestratorTool(asker.id, 'mail', { action: 'send', to: 'orchestrator', text })).isError).toBeUndefined()
  clock.t += 60_000
  await h.mail.delivery.process(addressOf(orc))
  await settle()
  const request = mailReader(h.store)
    .between(addressOf(asker.id), addressOf(orc), 'message')
    .at(-1)!
  expect(h.mail.turns.current(orc)).toMatchObject({ messageId: request.id, asker: addressOf(asker.id) })
  return request.id
}

function card(h: Host, orc: string) {
  const pending = h.mgr.sessionInfo(orc)?.pendingApproval
  const d = pending?.detail
  return d?.kind === 'other' && d.about === ORCHESTRATOR_CHANGE ? { requestId: pending!.requestId, text: d.raw } : undefined
}
const settled = <T>(p: Promise<T>) => Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), 150))])

/**
 * The first host: the orchestrator answers a request after reading `what` (a session of the asker's own project, or one of another), and its turn
 * ends. Then the host goes (`how`), and the next one starts on the same store with the orchestrator's conversation, resumed or taken over
 */
async function readThenRestart(what: 'own project' | 'other project', how: 'quit' | 'swap') {
  const a = await startHost()
  const orc = (await a.mgr.createSession({ projectId: null, cwd: data, tool: 'claude', permissionPreset: 'auto', kind: 'orchestrator' })).id
  const acme = await project(a, 'Acme')
  const asker = await sessionIn(a, acme)
  const read = what === 'own project' ? await sessionIn(a, acme) : await sessionIn(a, await project(a, 'Elsewhere'))
  await ask(a, orc, asker, 'what is the other session doing?')
  expect(await settled(a.mgr.runOrchestratorTool(orc, 'read_session', { sessionId: read.id }))).not.toBe('pending')
  a.adapter.handleOf(orc)!.finishTurn()
  await settle()
  await stopHost(a, how)

  const b = await startHost(how === 'swap' ? new Set([orc]) : new Set())
  if (how === 'swap') await b.mgr.adoptKept([{ sessionId: orc, tool: 'claude', process: new FakeProcess() }])
  else await b.mgr.resumeSession(orc)
  const request = await ask(b, orc, asker, 'and what did it find?')
  const reply = b.mgr.runOrchestratorTool(orc, 'centralu_run', { command: 'mail', args: { action: 'reply', thread: request, text: 'it found the bug in login' } })
  return { b, orc, asker, request, reply }
}

describe('a reply to a session after the host restarted (#1926)', () => {
  for (const how of ['quit', 'swap'] as const) {
    it(`after a ${how === 'quit' ? 'restart' : 'keeper swap'}: what was read in the asker's own reach before it raises no card`, async () => {
      const { b, orc, request, reply } = await readThenRestart('own project', how)
      expect(await settled(reply)).toMatchObject({ text: expect.stringContaining(`It answers ${request}`) })
      expect(card(b, orc)).toBeUndefined()
    })

    it(`after a ${how === 'quit' ? 'restart' : 'keeper swap'}: a read outside the asker's reach before it still puts the reply to the person`, async () => {
      const { b, orc, asker, request, reply } = await readThenRestart('other project', how)
      await eventually(() => !!card(b, orc))
      expect(card(b, orc)!.text).toContain('it found the bug in login')
      expect(card(b, orc)!.text).toContain('read_session of')
      // The session that asked is told at once that its answer waits for the person, not left polling the thread
      const told = mailReader(b.store).between('centralu', addressOf(asker.id))
      expect(told.map((x) => x.body).join('\n')).toContain(request)
      b.mgr.respondApproval(orc, card(b, orc)!.requestId, 'deny')
      expect((await reply).isError).toBe(true)
    })
  }
})
