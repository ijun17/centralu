import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MACHINE_CHANGE, type MachineConnect, type MachineInfo, type MachineProbe, type ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import type { MachineOps } from './machine-flow.js'
import { CrossAdapter } from './cross-project.test-helpers.js'
import { commandsFor, profileAllows, RARE_TIERS } from './orchestrator-tools.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * The orchestrator's commands for linked machines (#1219): each reaches the hub's links as the Machines screen does,
 * a change to a machine or to this computer's reach only after the person's card, reconnecting and the connect mode
 * without one, and every refusal that can be known first before any card. The links here record what they were asked;
 * links/links.test.ts runs the same commands against a real hub.
 */
const COMMANDS = ['add_machine', 'install_machine', 'remove_machine', 'reconnect_machine', 'set_machine_connect', 'set_machine_autostart'] as const

let root: string
let store: Store
let mgr: SessionManager
let rpc: (method: string, params: unknown) => Promise<unknown>
let ops: ReturnType<typeof fakeOps>

function machine(over: Partial<MachineInfo>): MachineInfo {
  return {
    id: 'laptop',
    name: 'Laptop',
    sshTarget: 'me@laptop',
    shell: 'powershell',
    wslDistro: null,
    command: null,
    status: 'connected',
    error: null,
    versions: null,
    lastConnectedAt: null,
    localPort: null,
    sameLocalPort: false,
    hostStarted: null,
    install: null,
    operation: null,
    autostart: null,
    elevated: null,
    connect: 'at_start',
    ...over,
  } as MachineInfo
}

/** The hub's links as the commands reach them: what each call was, and the machines as they are after it */
function fakeOps() {
  const calls: unknown[][] = []
  const machines: MachineInfo[] = [machine({})]
  const probes = new Map<string, MachineProbe>()
  let refusal: string | null = null
  const find = (id: string) => machines.find((m) => m.id === id)!
  const o: MachineOps = {
    list: () => machines.map((m) => ({ ...m })),
    probe: async (sshTarget) => {
      calls.push(['probe', sshTarget])
      return probes.get(sshTarget) ?? { sshTarget, reachable: false, os: null, windowsShell: null, wslDistros: [], error: 'Connection refused' }
    },
    add: (spec) => {
      calls.push(['add', spec])
      const m = machine({ id: spec.name.toLowerCase().replace(/\s+/g, '-'), name: spec.name, sshTarget: spec.sshTarget, shell: spec.shell, wslDistro: spec.wslDistro ?? null, status: 'connecting' })
      machines.push(m)
      return m
    },
    remove: async (id) => {
      calls.push(['remove', id])
      machines.splice(machines.indexOf(find(id)), 1)
    },
    reconnect: (id) => {
      calls.push(['reconnect', id])
      return { ...find(id), status: 'connecting' }
    },
    setConnect: (id, connect: MachineConnect) => {
      calls.push(['setConnect', id, connect])
      find(id).connect = connect
      return find(id)
    },
    install: async (id) => {
      calls.push(['install', id])
      return { machine: find(id), current: { version: '0.1.0-beta.29' } }
    },
    update: async (id) => {
      calls.push(['update', id])
      return { machine: find(id), current: { version: '0.1.0-beta.29' } }
    },
    autostart: async (id, on) => {
      calls.push(['autostart', id, on])
      return { machine: find(id), autostart: { on: on === true, how: 'task', linger: null } }
    },
    installRefusal: (id, kind) => {
      calls.push(['installRefusal', id, kind])
      return refusal
    },
  }
  return {
    ops: o,
    calls,
    probes,
    refuseInstalls: (why: string) => {
      refusal = why
    },
    /** The calls that changed something, leaving out the reads and the pre-checks */
    changes: () => calls.filter((c) => !['probe', 'installRefusal'].includes(c[0] as string)),
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-machines-')))
  store = new Store()
  const adapters = new Map<ToolName, CrossAdapter>([['claude', new CrossAdapter('claude')]])
  const agents = adapters as unknown as Map<ToolName, AgentAdapter>
  mgr = new SessionManager(store, agents, () => {})
  ops = fakeOps()
  mgr.useMachineOps(ops.ops)
  mgr.useMachineList(() => ops.ops.list())
  const handler = createRpcHandler(mgr, agents)
  rpc = (method, params) => handler(method, params)
})
afterEach(async () => {
  await mgr.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** The machine card standing in a session, if one is */
function card(sessionId: string) {
  const pending = mgr.listSessions().find((s) => s.id === sessionId)?.pendingApproval
  const d = pending?.detail
  return d?.kind === 'other' && d.about === MACHINE_CHANGE ? { requestId: pending!.requestId, text: d.raw } : undefined
}

function run(orcId: string, command: (typeof COMMANDS)[number], args: Record<string, unknown>) {
  return mgr.runOrchestratorTool(orcId, 'centralu_run', { command, args })
}

/** Runs a command whose card the person answers with `decision`; the card's question and the answer */
async function answered(orcId: string, command: (typeof COMMANDS)[number], args: Record<string, unknown>, decision: 'allow' | 'deny' | 'always') {
  const call = run(orcId, command, args)
  await eventually(() => !!card(orcId))
  const question = card(orcId)!.text
  mgr.respondApproval(orcId, card(orcId)!.requestId, decision)
  return { question, r: await call }
}

describe('add_machine', () => {
  it('probes first, asks with the target, what runs there and what linking does, and links it only on Allow', async () => {
    ops.probes.set('me@box', { sshTarget: 'me@box', reachable: true, os: 'posix', windowsShell: null, wslDistros: [], error: null })
    const orc = await mgr.orchestrator()
    const call = run(orc.id, 'add_machine', { sshTarget: 'me@box' })
    await eventually(() => !!card(orc.id))
    expect(ops.calls).toEqual([['probe', 'me@box']])
    expect(card(orc.id)!.text).toContain('Link me@box as the machine box (macOS or Linux, Unix shell)?')
    expect(card(orc.id)!.text).toContain('centralu serve --connection')
    expect(card(orc.id)!.text).toContain('Nothing is installed')
    mgr.respondApproval(orc.id, card(orc.id)!.requestId, 'allow')
    const r = await call
    expect(r.isError).toBeFalsy()
    expect(ops.changes()).toEqual([['add', { name: 'box', sshTarget: 'me@box', shell: 'posix', wslDistro: null }]])
    expect(r.text).toContain('Linked me@box as box.')
    expect(r.text).toContain('- "box" [box]: connecting; macOS or Linux, Unix shell; connects at start')
  })

  it('links Windows as PowerShell, or the WSL distro named, as the Add machine dialog offers them', async () => {
    ops.probes.set('me@win', { sshTarget: 'me@win', reachable: true, os: 'windows', windowsShell: 'cmd', wslDistros: [{ name: 'Ubuntu', default: true }], error: null })
    const orc = await mgr.orchestrator()
    const win = await answered(orc.id, 'add_machine', { sshTarget: 'me@win', name: 'Desk' }, 'allow')
    expect(win.question).toContain('as the machine Desk (Windows, PowerShell)')
    const wsl = await answered(orc.id, 'add_machine', { sshTarget: 'me@win', wslDistro: 'ubuntu' }, 'allow')
    expect(wsl.question).toContain('(Linux in WSL (Ubuntu) on Windows)')
    expect(ops.changes()).toEqual([
      ['add', { name: 'Desk', sshTarget: 'me@win', shell: 'powershell', wslDistro: null }],
      ['add', { name: 'win ubuntu', sshTarget: 'me@win', shell: 'wsl', wslDistro: 'Ubuntu' }],
    ])
  })

  it('links nothing when the person denies it', async () => {
    ops.probes.set('me@box', { sshTarget: 'me@box', reachable: true, os: 'posix', windowsShell: null, wslDistros: [], error: null })
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'add_machine', { sshTarget: 'me@box' }, 'deny')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/did not approve/)
    expect(ops.changes()).toEqual([])
  })

  it('refuses before any card: no ssh target, no answer, a name or a way already linked, a distro that is not there', async () => {
    ops.probes.set('me@box', { sshTarget: 'me@box', reachable: true, os: 'posix', windowsShell: null, wslDistros: [], error: null })
    ops.probes.set('me@laptop', { sshTarget: 'me@laptop', reachable: true, os: 'windows', windowsShell: 'powershell', wslDistros: [], error: null })
    const orc = await mgr.orchestrator()
    for (const [args, reason] of [
      [{ sshTarget: '-oProxyCommand=x' }, /Not an ssh target/],
      [{ sshTarget: 'me@ box' }, /Not an ssh target/],
      [{ sshTarget: 'me@gone' }, /me@gone did not answer over ssh: Connection refused/],
      [{ sshTarget: 'me@box', name: 'laptop' }, /already called laptop/],
      [{ sshTarget: 'me@laptop', name: 'Other' }, /already linked that way, as Laptop/],
      [{ sshTarget: 'me@laptop', name: 'Other', wslDistro: 'Debian' }, /has no WSL distro Debian/],
      [{ sshTarget: 'me@box', wslDistro: 'Ubuntu' }, /runs a Unix shell, not Windows/],
    ] as const) {
      const r = await run(orc.id, 'add_machine', args)
      expect(r.isError, JSON.stringify(args)).toBe(true)
      expect(r.text, JSON.stringify(args)).toMatch(reason)
      expect(card(orc.id), JSON.stringify(args)).toBeUndefined()
    }
    // A target that is not one is never even probed
    expect(ops.calls.filter((c) => c[0] === 'probe').map((c) => c[1])).not.toContain('-oProxyCommand=x')
    expect(ops.changes()).toEqual([])
  })
})

describe('install_machine', () => {
  it('asks with the machine and what an install or an update does there, then runs the one asked for', async () => {
    const orc = await mgr.orchestrator()
    const install = await answered(orc.id, 'install_machine', { machine: 'laptop' }, 'allow')
    expect(install.question).toContain("Install this computer's Centralu on Laptop (me@laptop, Windows, PowerShell)?")
    expect(install.r.text).toContain('Installed Centralu 0.1.0-beta.29 on Laptop.')
    const update = await answered(orc.id, 'install_machine', { machine: 'Laptop', action: 'update' }, 'allow')
    expect(update.question).toContain('stops the Centralu there')
    expect(update.question).toContain('a turn in progress is lost')
    expect(update.r.text).toContain('Updated to Centralu 0.1.0-beta.29 on Laptop.')
    expect(ops.changes()).toEqual([
      ['install', 'laptop'],
      ['update', 'laptop'],
    ])
  })

  it('runs nothing when the person denies it', async () => {
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'install_machine', { machine: 'laptop', action: 'update' }, 'deny')
    expect(r.isError).toBe(true)
    expect(ops.changes()).toEqual([])
  })

  it('refuses before any card a machine not linked, and an install this computer cannot make (a development build)', async () => {
    const orc = await mgr.orchestrator()
    const unknown = await run(orc.id, 'install_machine', { machine: 'server' })
    expect(unknown.text).toBe('Nothing changed: No linked machine is called "server"; list_machines names them.')
    ops.refuseInstalls('A development build is not published, so it cannot be installed on Laptop; install the latest release there (npm.cmd i -g centralu)')
    const dev = await run(orc.id, 'install_machine', { machine: 'laptop' })
    expect(dev.isError).toBe(true)
    expect(dev.text).toMatch(/A development build is not published/)
    expect(card(orc.id)).toBeUndefined()
    expect(ops.changes()).toEqual([])
  })
})

describe('remove_machine', () => {
  it("asks, saying its sessions and projects leave this computer's lists and nothing on it changes, then removes it", async () => {
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, 'remove_machine', { machine: 'Laptop' }, 'allow')
    expect(question).toContain("Its sessions and projects leave this computer's lists. Nothing on Laptop changes")
    expect(r.text).toContain('Removed "Laptop" [laptop]')
    expect(ops.changes()).toEqual([['remove', 'laptop']])
    expect(ops.ops.list()).toEqual([])
  })

  it('removes nothing when the person denies it, and asks again under auto', async () => {
    const orc = await mgr.orchestrator()
    await mgr.updateSettings(orc.id, { permissionPreset: 'auto' })
    const { r } = await answered(orc.id, 'remove_machine', { machine: 'laptop' }, 'deny')
    expect(r.isError).toBe(true)
    expect(ops.changes()).toEqual([])
  })

  it('"always" removes this one and remembers nothing', async () => {
    ops.ops.add({ name: 'Box', sshTarget: 'me@box', shell: 'posix' })
    ops.calls.length = 0
    const orc = await mgr.orchestrator()
    await answered(orc.id, 'remove_machine', { machine: 'laptop' }, 'always')
    const second = await answered(orc.id, 'remove_machine', { machine: 'box' }, 'deny')
    expect(second.r.isError).toBe(true)
    expect(ops.changes()).toEqual([['remove', 'laptop']])
  })
})

describe('reconnect_machine and set_machine_connect', () => {
  it('act at once with no card, and say the machine as it is now', async () => {
    const orc = await mgr.orchestrator()
    const re = await run(orc.id, 'reconnect_machine', { machine: 'Laptop' })
    expect(re.isError).toBeFalsy()
    expect(re.text).toBe('Reconnecting Laptop.\nNow:\n- "Laptop" [laptop]: connecting; Windows, PowerShell; connects at start')
    const mode = await run(orc.id, 'set_machine_connect', { machine: 'laptop', connect: 'when_needed' })
    expect(mode.text).toBe('Laptop now connects only when something needs it.\nNow:\n- "Laptop" [laptop]: connected; Windows, PowerShell; connects when needed')
    expect(card(orc.id)).toBeUndefined()
    expect(ops.changes()).toEqual([
      ['reconnect', 'laptop'],
      ['setConnect', 'laptop', 'when_needed'],
    ])
  })
})

describe('set_machine_autostart', () => {
  it('asks to turn it on or off, and changes it only on Allow', async () => {
    const orc = await mgr.orchestrator()
    const on = await answered(orc.id, 'set_machine_autostart', { machine: 'laptop', on: true }, 'allow')
    expect(on.question).toContain('Make Laptop (me@laptop, Windows, PowerShell) start Centralu when it boots?')
    expect(on.r.text).toContain('Laptop starts Centralu when it boots.')
    const off = await answered(orc.id, 'set_machine_autostart', { machine: 'laptop', on: false }, 'deny')
    expect(off.question).toContain('Stop Laptop (me@laptop) starting Centralu when it boots?')
    expect(off.r.isError).toBe(true)
    expect(ops.changes()).toEqual([['autostart', 'laptop', true]])
  })
})

describe('who may run them', () => {
  it('only the orchestrator, as rare commands in the default tier; no other seat in any tier', () => {
    for (const name of COMMANDS) {
      expect(commandsFor('orchestrator', 'commands')).toContain(name)
      for (const tier of RARE_TIERS) {
        for (const profile of ['scoped', 'builder', 'reader'] as const) {
          expect(profileAllows(profile, name, tier), `${profile} ${tier} ${name}`).toBe(false)
        }
      }
    }
  })

  it("refuses an ordinary session's calls by name and through centralu_run, and changes nothing", async () => {
    const dir = join(root, 'proj')
    mkdirSync(dir)
    const project = (await rpc('projects.add', { path: dir })) as { id: string }
    await rpc('projects.setTrusted', { projectId: project.id, trusted: true })
    const s = (await rpc('agents.createSession', { projectId: project.id, cwd: dir, tool: 'claude' })) as { id: string }
    for (const name of COMMANDS) {
      await expect(mgr.runOrchestratorTool(s.id, name, { machine: 'laptop' }), name).rejects.toThrow(`Not a tool of this session: ${name}`)
      await expect(mgr.runOrchestratorTool(s.id, 'centralu_run', { command: name, args: { machine: 'laptop' } }), name).rejects.toThrow(/Not a tool of this session/)
    }
    expect(ops.calls).toEqual([])
  })
})
