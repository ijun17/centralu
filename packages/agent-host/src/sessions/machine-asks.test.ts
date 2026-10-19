import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

/**
 * A linked machine's session asking a project here (#550), against the manager alone: what the ask rests on (the
 * machine's switch, the project) is read again once the session asked is awake to take the task. The ask over a real
 * link is links/reverse-asks.test.ts.
 */

describe("a machine's ask, read again once the asked session is awake (#550)", () => {
  let w: CrossWorld
  let target: string
  const machine = { id: 'm1', name: 'Remote box' }
  const caller = { sessionId: 'remote-s1', name: 'worker', project: 'api' }
  beforeEach(async () => {
    w = await crossWorld()
    target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'codex', permissionPreset: 'normal' })).id
    w.store.machines.addLinkedMachine({ id: machine.id, name: machine.name, sshTarget: 'box', remote: { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
    w.store.machines.setLinkedMachineAsks(machine.id, true)
    // An approved pair, so no card stands in between and the switch was read just before the wait
    expect(w.store.machines.setMachineAskConsent({ machineId: machine.id, sessionId: caller.sessionId, sessionName: caller.name, projectId: w.target.id })).toBe(true)
  })
  afterEach(async () => {
    await w.dispose()
  })

  /** The asked session asleep, so the delivery waits for it to wake: its tool's start is held until `wake()` is called */
  const askIntoSleeper = async () => {
    const codex = w.adapters.get('codex')!
    // A tool that reports its background work can be put to sleep (#568)
    Object.assign(codex.capabilities, { backgroundTasks: true })
    expect(await w.mgr.sleepSession(target)).toBe(true)
    const create = codex.createSession.bind(codex)
    let wake!: () => void
    const held = new Promise<void>((r) => (wake = r))
    let waking = false
    vi.spyOn(codex, 'createSession').mockImplementation(async (opts, emit) => {
      waking = true
      await held
      return create(opts, emit)
    })
    const p = w.mgr.askFromMachine(machine, { caller, project: w.target.name, task: 'export the sprites', depth: 1 })
    await w.until(() => waking)
    // Either the call settles or the task reaches the woken session, whichever comes first
    let settled = false
    void p.then(() => (settled = true))
    const delivered = async () => {
      await w.until(() => settled || (codex.handles.get(target)?.sent.length ?? 0) > 0)
      return codex.handles.get(target)?.sent ?? []
    }
    return { p, wake, delivered }
  }

  it.each([
    ['the person turns the machine\'s switch off', (cw: CrossWorld) => cw.store.machines.setLinkedMachineAsks(machine.id, false), 'does not let sessions on Remote box ask'],
    // Removed at the store, as another host would: the session stays, so only the read at delivery can see it
    ['the project is removed', (cw: CrossWorld) => cw.store.trash.deleteProject(cw.target.id), 'was removed'],
  ] as const)('is not delivered when %s while it wakes', async (_what, takeAway, why) => {
    const { p, wake, delivered } = await askIntoSleeper()
    takeAway(w)
    wake()
    expect(await delivered()).toEqual([])
    expect(await p).toMatchObject({ ok: false, error: expect.stringContaining(why) })
  })
})
