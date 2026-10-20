import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MACHINE_CHANGE, type MachineInfo, type MachineProbe, type ToolName } from '@cc/protocol'
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
 * a change to a machine or to this computer's reach only after the person's card, reconnecting and Auto reconnect
 * without one, and every refusal that can be known first before any card. The links here record what they were asked;
 * links/links.test.ts runs the same commands against a real hub.
 */
const COMMANDS = ['add_machine', 'install_machine', 'remove_machine', 'reconnect_machine', 'set_machine_auto_reconnect', 'set_machine_autostart'] as const

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
    autoReconnect: true,
    connect: 'at_start',
    ...over,
  } as MachineInfo
}

/** The hub's links as the commands reach them: what each call was, and the machines as they are after it */
function fakeOps() {
  const calls: unknown[][] = []
  const machines: MachineInfo[] = [machine({})]
  const probes = new Map<string, MachineProbe>()
  /** What `ssh -G` resolves a target to; a target not set here resolves to itself */
  const resolved = new Map<string, Awaited<ReturnType<MachineOps['resolve']>>>()
  let refusal: string | null = null
  /** Why the hub starts no host on the first machine just now (#1143), or null */
  let heldBack: string | null = null
  const find = (id: string) => machines.find((m) => m.id === id)!
  const o: MachineOps = {
    list: () => machines.map((m) => ({ ...m })),
    resolve: async (sshTarget) => {
      calls.push(['resolve', sshTarget])
      return resolved.get(sshTarget) ?? { hostName: sshTarget.replace(/^.*@/, ''), user: sshTarget.includes('@') ? sshTarget.replace(/@.*$/, '') : null, port: 22, error: null }
    },
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
    reconnect: (id, opts) => {
      calls.push(opts ? ['reconnect', id, opts] : ['reconnect', id])
      return { ...find(id), status: 'connecting' }
    },
    startHeldBack: () => heldBack,
    setAutoReconnect: (id, autoReconnect: boolean) => {
      calls.push(['setAutoReconnect', id, autoReconnect])
      Object.assign(find(id), { autoReconnect, connect: autoReconnect ? 'at_start' : 'when_needed' })
      return find(id)
    },
    install: async (id) => {
      calls.push(['install', id])
      return { machine: find(id), current: { version: '9.9.9-test.1' } }
    },
    update: async (id) => {
      calls.push(['update', id])
      return { machine: find(id), current: { version: '9.9.9-test.1' } }
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
    resolved,
    refuseInstalls: (why: string) => {
      refusal = why
    },
    /** The first machine as the hub has it now */
    patch: (over: Partial<MachineInfo>) => void Object.assign(machines[0]!, over),
    holdBack: (why: string | null) => {
      heldBack = why
    },
    /** The calls that changed something, leaving out the reads and the pre-checks */
    changes: () => calls.filter((c) => !['resolve', 'probe', 'installRefusal'].includes(c[0] as string)),
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
  const posix = (sshTarget: string): MachineProbe => ({ sshTarget, reachable: true, os: 'posix', windowsShell: null, wslDistros: [], error: null })

  it('connects nowhere before the card, which shows what ssh -G resolves the target to; probes and links only after Allow', async () => {
    ops.probes.set('box', posix('box'))
    ops.resolved.set('box', { hostName: 'box.lan', user: 'me', port: 2222, proxyCommand: 'ssh -W %h:%p jump', proxyJump: null, error: null })
    const orc = await mgr.orchestrator()
    const call = run(orc.id, 'add_machine', { sshTarget: 'box' })
    await eventually(() => !!card(orc.id))
    // Only ssh -G so far, which opens no connection: the person's keys have reached nothing
    expect(ops.calls).toEqual([['resolve', 'box']])
    expect(card(orc.id)!.text).toContain('Link box as the machine box? ssh resolves it to me@box.lan, port 2222, through ProxyCommand ssh -W %h:%p jump.')
    expect(card(orc.id)!.text).toContain('connects there with your ssh keys, first to see what runs there')
    expect(card(orc.id)!.text).toContain('centralu serve --connection')
    expect(card(orc.id)!.text).toContain('Nothing is installed')
    mgr.respondApproval(orc.id, card(orc.id)!.requestId, 'allow')
    const r = await call
    expect(r.isError).toBeFalsy()
    expect(ops.calls.map((c) => c[0])).toEqual(['resolve', 'probe', 'add'])
    expect(ops.changes()).toEqual([['add', { name: 'box', sshTarget: 'box', shell: 'posix', wslDistro: null }]])
    expect(r.text).toContain('Linked box as box (macOS or Linux, Unix shell).')
    expect(r.text).toContain('- "box" [box]: connecting; macOS or Linux, Unix shell; auto reconnect on')
  })

  it('links Windows as PowerShell, or the WSL distro named, as the Add machine dialog offers them', async () => {
    ops.probes.set('me@win', { sshTarget: 'me@win', reachable: true, os: 'windows', windowsShell: 'cmd', wslDistros: [{ name: 'Ubuntu', default: true }], error: null })
    const orc = await mgr.orchestrator()
    const win = await answered(orc.id, 'add_machine', { sshTarget: 'me@win', name: 'Desk' }, 'allow')
    expect(win.r.text).toContain('Linked me@win as Desk (Windows, PowerShell).')
    const wsl = await answered(orc.id, 'add_machine', { sshTarget: 'me@win', wslDistro: 'ubuntu' }, 'allow')
    expect(wsl.question).toContain('Link me@win as the machine win ubuntu (its WSL distro ubuntu)?')
    expect(wsl.r.text).toContain('(Linux in WSL (Ubuntu) on Windows)')
    expect(ops.changes()).toEqual([
      ['add', { name: 'Desk', sshTarget: 'me@win', shell: 'powershell', wslDistro: null }],
      ['add', { name: 'win ubuntu', sshTarget: 'me@win', shell: 'wsl', wslDistro: 'Ubuntu' }],
    ])
  })

  it('links nothing when the person denies it, and never connects', async () => {
    ops.probes.set('me@box', posix('me@box'))
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'add_machine', { sshTarget: 'me@box' }, 'deny')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/did not approve/)
    expect(ops.calls).toEqual([['resolve', 'me@box']])
  })

  it('after Allow, links nothing and says why when the target does not answer or runs nothing it can link; no second card', async () => {
    ops.probes.set('me@odd', { sshTarget: 'me@odd', reachable: true, os: null, windowsShell: null, wslDistros: [], error: null })
    ops.probes.set('me@box', posix('me@box'))
    ops.probes.set('me@laptop', { sshTarget: 'me@laptop', reachable: true, os: 'windows', windowsShell: 'powershell', wslDistros: [], error: null })
    const orc = await mgr.orchestrator()
    for (const [args, reason] of [
      [{ sshTarget: 'me@gone' }, /me@gone did not answer over ssh: Connection refused\. Nothing was linked/],
      [{ sshTarget: 'me@odd' }, /Could not tell what runs on me@odd, so nothing was linked/],
      [{ sshTarget: 'me@laptop', name: 'Other' }, /already linked that way, as Laptop, so nothing more was linked/],
      [{ sshTarget: 'me@laptop', name: 'Other', wslDistro: 'Debian' }, /has no WSL distro Debian\. Nothing was linked/],
      [{ sshTarget: 'me@box', wslDistro: 'Ubuntu' }, /runs a Unix shell, not Windows, so it has no WSL distro; nothing was linked/],
    ] as const) {
      const { r } = await answered(orc.id, 'add_machine', args, 'allow')
      expect(r.isError, JSON.stringify(args)).toBe(true)
      expect(r.text, JSON.stringify(args)).toMatch(reason)
      expect(card(orc.id), JSON.stringify(args)).toBeUndefined()
    }
    expect(ops.changes()).toEqual([])
  })

  it('links nothing more when the same machine was linked while the card stood', async () => {
    ops.probes.set('me@box', posix('me@box'))
    const orc = await mgr.orchestrator()
    const call = run(orc.id, 'add_machine', { sshTarget: 'me@box' })
    await eventually(() => !!card(orc.id))
    // Linked meanwhile, from the Machines screen
    ops.ops.add({ name: 'Box', sshTarget: 'me@box', shell: 'posix' })
    mgr.respondApproval(orc.id, card(orc.id)!.requestId, 'allow')
    const r = await call
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/already linked that way, as Box/)
    expect(ops.changes().filter((c) => c[0] === 'add').length).toBe(1)
  })

  it('refuses before any card and any ssh: no ssh target, control or bidi characters, a name taken, a target ssh -G cannot read', async () => {
    ops.resolved.set('me@broken', { hostName: null, user: null, port: null, error: 'bad configuration option: Hostnme' })
    const orc = await mgr.orchestrator()
    for (const [args, reason] of [
      [{ sshTarget: '-oProxyCommand=x' }, /Not an ssh target/],
      [{ sshTarget: 'me@ box' }, /Not an ssh target/],
      [{ sshTarget: 'me@box\u202e' }, /ssh target has a control or formatting character/],
      [{ sshTarget: 'me@box\n' }, /ssh target has a control or formatting character/],
      [{ sshTarget: 'me@box', name: 'Lap\u200btop' }, /name has a control or formatting character/],
      [{ sshTarget: 'me@box', name: 'Desk\u0007' }, /name has a control or formatting character/],
      [{ sshTarget: 'me@win', wslDistro: 'Ubu\u202entu' }, /WSL distro has a control or formatting character/],
      [{ sshTarget: 'me@box', name: 'laptop' }, /already called laptop/],
      [{ sshTarget: 'me@broken' }, /ssh could not read where me@broken goes: bad configuration option/],
    ] as const) {
      const r = await run(orc.id, 'add_machine', args)
      expect(r.isError, JSON.stringify(args)).toBe(true)
      expect(r.text, JSON.stringify(args)).toMatch(reason)
      expect(card(orc.id), JSON.stringify(args)).toBeUndefined()
    }
    // Only ssh -G ran, and only for the one target that got that far
    expect(ops.calls).toEqual([['resolve', 'me@broken']])
  })
})

describe('install_machine', () => {
  it('asks with the machine and what an install or an update does there, then runs the one asked for', async () => {
    const orc = await mgr.orchestrator()
    const install = await answered(orc.id, 'install_machine', { machine: 'laptop' }, 'allow')
    expect(install.question).toContain("Install this computer's Centralu on Laptop (me@laptop, Windows, PowerShell)?")
    expect(install.r.text).toContain('Installed Centralu 9.9.9-test.1 on Laptop.')
    const update = await answered(orc.id, 'install_machine', { machine: 'Laptop', action: 'update' }, 'allow')
    expect(update.question).toContain('stops the Centralu there')
    expect(update.question).toContain('a turn in progress is lost')
    expect(update.r.text).toContain('Updated to Centralu 9.9.9-test.1 on Laptop.')
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
    expect(question).toContain("Its sessions and projects leave this computer's lists, and what this computer let its sessions ask is forgotten.")
    expect(question).toContain('Nothing on Laptop changes')
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

describe('reconnect_machine and set_machine_auto_reconnect', () => {
  it('act at once with no card for a machine that only dropped and for turning the switch off, and say the machine as it is now', async () => {
    const orc = await mgr.orchestrator()
    ops.patch({ status: 'unreachable', error: 'ssh: connect to host laptop port 22: Operation timed out' })
    const re = await run(orc.id, 'reconnect_machine', { machine: 'Laptop' })
    expect(re.isError).toBeFalsy()
    expect(re.text).toBe('Reconnecting Laptop.\nNow:\n- "Laptop" [laptop]: connecting; Windows, PowerShell; auto reconnect on')
    const mode = await run(orc.id, 'set_machine_auto_reconnect', { machine: 'laptop', on: false })
    expect(mode.text).toBe(
      'Laptop no longer reconnects by itself: after a drop only the person\'s Connect brings it back, and nothing here connects it.\n' +
        'Now:\n- "Laptop" [laptop]: unreachable; Windows, PowerShell; auto reconnect off (only the person connects it again)',
    )
    expect(card(orc.id)).toBeUndefined()
    // Without a card the link is only opened: the orchestrator's reconnect is no Start (#1143)
    expect(ops.changes()).toEqual([
      ['reconnect', 'laptop', { start: false }],
      ['setAutoReconnect', 'laptop', false],
    ])
  })
})

/*
 * #1341: what the person chose is not undone by an agent on its own. A machine they disconnected or turned Auto reconnect
 * off for is reconnected, and the switch turned back on, only after their card; a machine away on its own with the switch
 * on, and turning the switch off, need none
 */
describe('undoing what the person did', () => {
  it('asks before it reconnects a machine the person disconnected, and connects nothing on Deny', async () => {
    const orc = await mgr.orchestrator()
    ops.patch({ status: 'disconnected', error: null })
    const denied = await answered(orc.id, 'reconnect_machine', { machine: 'Laptop' }, 'deny')
    expect(denied.question).toContain('Connect Laptop (me@laptop)? You disconnected it')
    expect(denied.r.isError).toBe(true)
    expect(ops.changes()).toEqual([])
    const allowed = await answered(orc.id, 'reconnect_machine', { machine: 'Laptop' }, 'allow')
    expect(allowed.r.text).toContain('Reconnecting Laptop.')
    // Opened without starting a host the link would not (#1143)
    expect(ops.changes()).toEqual([['reconnect', 'laptop', { start: false }]])
  })

  it('asks before it turns Auto reconnect back on, and leaves it off on Deny; turning it off, or on where it is on, asks nothing', async () => {
    const orc = await mgr.orchestrator()
    ops.patch({ autoReconnect: false, connect: 'when_needed' })
    const denied = await answered(orc.id, 'set_machine_auto_reconnect', { machine: 'laptop', on: true }, 'deny')
    expect(denied.question).toContain('Turn Auto reconnect back on for Laptop (me@laptop)? You turned it off.')
    expect(denied.r.isError).toBe(true)
    expect(ops.changes()).toEqual([])
    const allowed = await answered(orc.id, 'set_machine_auto_reconnect', { machine: 'laptop', on: true }, 'allow')
    expect(allowed.r.text).toContain('Laptop now reconnects by itself')
    expect(ops.changes()).toEqual([['setAutoReconnect', 'laptop', true]])

    // On already: nothing to undo. Off: the person's own choice, as the row's switch does
    expect((await run(orc.id, 'set_machine_auto_reconnect', { machine: 'laptop', on: true })).isError).toBeFalsy()
    expect((await run(orc.id, 'set_machine_auto_reconnect', { machine: 'laptop', on: false })).isError).toBeFalsy()
    expect(card(orc.id)).toBeUndefined()
  })

  it('asks before it reconnects a machine whose Auto reconnect the person turned off, and connects nothing on Deny', async () => {
    const orc = await mgr.orchestrator()
    ops.patch({ status: 'unreachable', error: 'ssh: connect to host laptop port 22: Operation timed out', autoReconnect: false, connect: 'when_needed' })
    const denied = await answered(orc.id, 'reconnect_machine', { machine: 'Laptop' }, 'deny')
    expect(denied.question).toContain('Connect Laptop (me@laptop)? You turned its Auto reconnect off')
    expect(denied.r.isError).toBe(true)
    expect(ops.changes()).toEqual([])
    const allowed = await answered(orc.id, 'reconnect_machine', { machine: 'Laptop' }, 'allow')
    expect(allowed.r.text).toContain('Reconnecting Laptop.')
    expect(ops.changes()).toEqual([['reconnect', 'laptop', { start: false }]])
  })

  it('answers that a machine is connected, with no card and nothing done, whatever its switch says', async () => {
    const orc = await mgr.orchestrator()
    for (const off of [false, true]) {
      ops.patch({ status: 'connected', error: null, ...(off ? { autoReconnect: false, connect: 'when_needed' as const } : {}) })
      const r = await run(orc.id, 'reconnect_machine', { machine: 'Laptop' })
      expect(r.isError).toBeFalsy()
      expect(r.text).toContain('Laptop is already connected; nothing was done.')
      expect(card(orc.id)).toBeUndefined()
    }
    expect(ops.changes()).toEqual([])
  })

  it('reconnects a machine that is away on its own, its switch on, with no card', async () => {
    const orc = await mgr.orchestrator()
    ops.patch({ status: 'unreachable', error: 'ssh: connect to host laptop port 22: Operation timed out' })
    expect((await run(orc.id, 'reconnect_machine', { machine: 'Laptop' })).isError).toBeFalsy()
    expect(card(orc.id)).toBeUndefined()
    expect(ops.changes()).toEqual([['reconnect', 'laptop', { start: false }]])
  })
})

/*
 * #1143: a machine where Centralu is stopped is started only by the person; reconnecting it starts it, so it asks. Asked
 * on what the hub holds back, not on the row's status of the moment: the row reads `connecting` while the line is read
 * again, and `unreachable` while the machine sleeps (#1293 re-review)
 */
describe('reconnect_machine where Centralu is stopped', () => {
  it('asks before it starts Centralu there, saying why it is stopped, and starts nothing on Deny', async () => {
    const orc = await mgr.orchestrator()
    const why = 'Centralu was stopped on Laptop with `centralu serve --stop`, so this computer does not start it by itself. Start starts it there'
    ops.holdBack(why)
    ops.patch({ status: 'connecting', error: null })
    const denied = await answered(orc.id, 'reconnect_machine', { machine: 'Laptop' }, 'deny')
    expect(denied.question).toContain('Start Centralu on Laptop (me@laptop)? Centralu was stopped on Laptop with `centralu serve --stop`')
    expect(denied.r.isError).toBe(true)
    expect(ops.changes()).toEqual([])
    ops.patch({ status: 'unreachable', error: 'ssh: connect to host laptop port 22: Operation timed out' })
    const asleep = await answered(orc.id, 'reconnect_machine', { machine: 'Laptop' }, 'deny')
    expect(asleep.question).toContain(why)
    expect(ops.changes()).toEqual([])
    const allowed = await answered(orc.id, 'reconnect_machine', { machine: 'Laptop' }, 'allow')
    expect(allowed.r.text).toContain('Starting Centralu on Laptop.')
    expect(ops.changes()).toEqual([['reconnect', 'laptop']])
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
