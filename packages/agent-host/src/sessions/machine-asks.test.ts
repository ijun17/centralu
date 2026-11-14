import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { addressOf, wireHostMail } from './host-mail.test-helpers.js'

/**
 * A linked machine's session asking a project here (#550), against the manager alone: the task it gives is mail (#1948 step 6), written from that
 * session's address here at the depth it sent, and withdrawn while not given yet when the machine's switch goes off. The ask over a real link is
 * links/reverse-asks.test.ts and links/linked-asks-mail.test.ts.
 */

describe("a machine's ask (#550)", () => {
  let w: CrossWorld
  let target: string
  const machine = { id: 'm1', name: 'Remote box' }
  const caller = { sessionId: 'remote-s1', name: 'worker', project: 'api' }
  let mail: ReturnType<typeof wireHostMail>
  beforeEach(async () => {
    w = await crossWorld()
    mail = wireHostMail(w.mgr, w.store)
    target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'codex', permissionPreset: 'normal' })).id
    w.store.machines.addLinkedMachine({ id: machine.id, name: machine.name, sshTarget: 'box', remote: { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
    w.store.machines.setLinkedMachineAsks(machine.id, true)
    // An approved pair, so no card stands in between
    expect(w.store.machines.setMachineAskConsent({ machineId: machine.id, sessionId: caller.sessionId, sessionName: caller.name, projectId: w.target.id })).toBe(true)
  })
  afterEach(async () => {
    await w.dispose()
  })

  it('refuses an unnamed session with when each last moved, as an ask here does', async () => {
    w.store.messages.appendMessages([{ sessionId: target, seq: 1, role: 'assistant', kind: 'text', payload: { text: 'done' }, ts: Date.UTC(2026, 0, 2, 3, 4) }])
    const r = await w.mgr.machineAsks.ask(machine, { caller, project: w.target.name, session: 'missing', task: 'export', depth: 1 })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('"lastActive":"2026-01-02 03:04"') })
  })

  it("writes the task from the machine's session at the depth it sent, and withdraws it, not given yet, when the switch goes off", async () => {
    const asking = w.mgr.machineAsks.ask(machine, { caller, project: w.target.name, task: 'export the sprites', depth: 2 })
    const from = addressOf(`m1.${caller.sessionId}`)
    const task = () => w.store.mailbox.feedOf(addressOf(target), { limit: 5 }).find((m) => m.kind === 'task' && m.sender === from)
    await w.until(() => !!task())
    expect(task()).toMatchObject({ origin: 'ask_project', facts: { agentDepth: 2 } })
    expect(w.store.mailbox.recipient(task()!.id, addressOf(target))?.deliveredAt).toBeNull()
    w.mgr.closeMachineAskCards(machine.id)
    expect(w.store.mailbox.recipient(task()!.id, addressOf(target))?.settled).toBe('withdrawn')
    expect(await asking).toMatchObject({ ok: false, error: expect.stringContaining('did not finish: its task there ended with no report (withdrawn)') })
  })

  it('answers with a report that came in as the wait reached its bound, and passes it to the machine no more', async () => {
    const tasks = w.mgr.mail.linkedTasks!
    const from = addressOf(`m1.${caller.sessionId}`)
    // The bound is reached just as the session's turn ends: its report is written, and the wait says `bound`
    tasks.settled = async (taskId) => {
      mail.service.report(taskId, { body: 'Centralu: the session finished.', outcome: 'finished', answer: 'the sprites are exported' })
      return 'bound'
    }
    const r = await w.mgr.machineAsks.ask(machine, { caller, project: w.target.name, task: 'export the sprites', depth: 2 })
    expect(r).toMatchObject({ ok: true, state: 'done', answer: expect.stringContaining('the sprites are exported') })
    const task = w.store.mailbox.feedOf(addressOf(target), { limit: 5 }).find((m) => m.kind === 'task' && m.sender === from)!
    const [report] = w.store.mailbox.reportsOn(task.id)
    expect(w.store.mailbox.recipient(report!.id, from)).toMatchObject({ deliveredAt: expect.any(Number), readAt: expect.any(Number) })
  })

  it('answers a later call with the report on its task, not with words the session said since in other work', async () => {
    // A machine from before #1948 step 6: it takes no report by mail, and reads it by asking again
    mail.across.usePeers({ selfName: () => 'This computer', machine: (id) => (id === machine.id ? { id, name: machine.name, reachable: true, tasks: false, call: () => Promise.reject(new Error('older')) } : undefined) })
    const stop = new AbortController()
    const asking = w.mgr.machineAsks.ask(machine, { caller, project: w.target.name, task: 'export the sprites', depth: 2 }, stop.signal)
    const from = addressOf(`m1.${caller.sessionId}`)
    const task = () => w.store.mailbox.feedOf(addressOf(target), { limit: 5 }).find((m) => m.kind === 'task' && m.sender === from)
    await w.until(() => !!task())
    stop.abort()
    expect(await asking).toMatchObject({ ok: true, state: 'working', taskId: task()!.id })
    mail.service.report(task()!.id, { body: 'Centralu: the session finished.', outcome: 'finished', answer: 'the sprites are exported' })
    // The person works in the session after it: its last words are that work's, not the task's
    w.store.messages.appendMessages([{ sessionId: target, seq: 1, role: 'assistant', kind: 'text', payload: { text: "words of the person's own later work" }, ts: Date.now() + 1_000 }])
    const again = await w.mgr.machineAsks.ask(machine, { caller, project: w.target.name, depth: 2 })
    expect(again).toMatchObject({ ok: true, state: 'done', answer: expect.stringContaining('the sprites are exported') })
    expect(JSON.stringify(again)).not.toContain('later work')
  })
})
