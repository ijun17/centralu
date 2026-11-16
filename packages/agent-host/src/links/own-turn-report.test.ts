import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAdapter } from '../adapters/claude/index.js'
import { claudeCli, offlineClaude } from '../adapters/claude/claude-cli-fake.test-helpers.js'
import { OWN_WORK_SETTLE_MS } from '../sessions/child-ownership.js'
import { sessionAddress } from '../mail/address.js'
import { cleanups, folder, runCleanups } from './links-world.test-helpers.js'
import { hubHost, machineHost } from './reverse-link.test-helpers.js'
import { namedFolder } from '../temp-dir.test-helpers.js'
import { SLOW, eventually } from '../../../../tooling/test-timing.js'

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../adapters/claude/claude-cli-fake.test-helpers.js')).claudeCli.sdk(),
}))

/**
 * A task that reaches a session as a background task's notification waits there (#2318). Measured with Claude Code 2.1.296: the CLI runs its own turn
 * for the notification first, a turn that names no input, then the task's. That first end is not the task's: the task's own turn's end is its one
 * report. Real hosts in one process, the real Claude adapter over a CLI that does what 2.1.296 was measured to do (`claudeCli`). Two ways the input
 * waits: a session asleep, woken by the task (as on 2026-11-16 08:43), takes it before its CLI said what it tracks, so untracked; one whose process
 * runs takes it tracked (#2318 review)
 */

afterEach(async () => {
  vi.restoreAllMocks()
  await runCleanups()
  claudeCli.reset()
})

const ORIGIN = 'git@github.com:me/app.git'
const claude = () => offlineClaude(new ClaudeAdapter({ startGapMs: 0 }))
const running = (host: { mgr: { listSessions(): { id: string; state: string }[] } }, id: string) => host.mgr.listSessions().find((s) => s.id === id)?.state

/** A machine whose session `w2` ran a turn and was put to sleep: the next input wakes it in a new process */
async function asleep() {
  const machine = await machineHost({ mail: true, sessions: ['w1', 'w2'], claude })
  const at = (id: string) => sessionAddress(machine.id, id)
  await machine.mgr.inputs.send('w2', 'hello')
  await eventually(() => running(machine, 'w2') === 'waiting_input')
  expect(await machine.mgr.processes.sleepSession('w2')).toBe(true)
  return { machine, at }
}

describe("a task that comes with a background task's notification (#2318)", { timeout: 30_000 * SLOW }, () => {
  it("is reported to the hub session at its own turn's end, once, not at the notification turn's: the session was asleep", async () => {
    const machine = await machineHost({ mail: true, origin: ORIGIN, claude })
    const hub = await hubHost(machine.port, { mail: true, origin: ORIGIN })
    await hub.mgr.setProjectTrusted('p-hub', true)
    await eventually(() => hub.machine().status === 'connected')
    await hub.router.handle('machines.setAsks', { machineId: 'm1', on: true })
    await eventually(() => machine.hubs.mailHubs()[0]?.you === 'm1' && hub.links.get('m1')?.takesTasks === true)
    for (const host of [machine, hub]) {
      host.mail!.delivery.start()
      cleanups.push(() => host.mail!.delivery.stop())
    }
    const atHub = (id: string) => sessionAddress(hub.id, id)
    const atMachine = (id: string) => sessionAddress(machine.id, id)
    const call = hub.mgr.startAgent('h1', { task: 'say hello', machine: 'Remote box', wait: false })
    await hub.answer('allow')
    const started = await call
    if (!started.ok) throw new Error(started.error)
    const local = started.sessionId.slice('m1.'.length)
    const tasks = () => hub.store.mailbox.feedOf(atHub(started.sessionId), { limit: 20 }).filter((m) => m.kind === 'task' && m.sender === atHub('h1'))
    // The first task's turn ends there: reported, and the session is put to sleep
    await eventually(async () => {
      await machine.mail!.delivery.process(atMachine(local))
      return hub.store.mailbox.reportsOn(tasks()[0]!.id).length === 1
    })
    await eventually(() => running(machine, local) === 'waiting_input')
    expect(await machine.mgr.processes.sleepSession(local)).toBe(true)

    // A background task of its ended meanwhile; the next task wakes it with its notification waiting
    claudeCli.notifyNext()
    const sent = await hub.mail!.across.sendTask('h1', atHub(started.sessionId), 'a long job', { origin: 'agent_session' })
    if (!sent.ok) throw new Error(sent.text)
    await eventually(async () => {
      await machine.mail!.delivery.process(atMachine(local))
      return claudeCli.ran('a long job')
    })
    // The notification's turn ended first: no end of the task, which its own turn runs
    expect(running(machine, local)).toBe('working')
    expect(machine.store.mailbox.recipient(sent.messageId, atMachine(local))?.settled).toBeNull()

    claudeCli.finish('all done')
    await eventually(() => hub.store.mailbox.reportsOn(sent.messageId).length === 1)
    expect(hub.store.mailbox.reportsOn(sent.messageId)[0]!.facts).toMatchObject({ outcome: 'finished', answer: expect.stringContaining('all done') })
    expect(machine.store.mailbox.reportsOn(sent.messageId)).toHaveLength(1)
  })

  it('is answered on one machine by its own turn, not the notification turn: a local task to a session asleep', async () => {
    const { machine, at } = await asleep()
    machine.mail!.delivery.start()
    cleanups.push(() => machine.mail!.delivery.stop())
    claudeCli.notifyNext()
    const task = machine.mail!.service.task(at('w1'), at('w2'), { text: 'a long job', origin: 'agent_session', delivered: false })
    await eventually(async () => {
      await machine.mail!.delivery.process(at('w2'))
      return claudeCli.ran('a long job')
    })
    expect(running(machine, 'w2')).toBe('working')
    expect(machine.store.mailbox.reportsOn(task.id)).toEqual([])
    claudeCli.finish('all done')
    await eventually(() => machine.store.mailbox.reportsOn(task.id).length === 1)
    expect(machine.store.mailbox.reportsOn(task.id)[0]!.facts).toMatchObject({ outcome: 'finished', answer: expect.stringContaining('all done') })
  })

  it('is answered once the session settles at rest when its tool never runs the input: no report is lost for good', async () => {
    const { machine, at } = await asleep()
    claudeCli.notifyNext('drop')
    const task = machine.mail!.service.task(at('w1'), at('w2'), { text: 'a long job', origin: 'agent_session', delivered: false })
    // The settle's bound, and only it (its call site, not every timer of that length), is short here: the rest runs on real time
    const realTimeout = globalThis.setTimeout
    const settle = (ms?: number) => ms === OWN_WORK_SETTLE_MS && (new Error().stack ?? '').includes('settleAtRest')
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => realTimeout(fn, settle(ms) ? 500 : ms)) as typeof setTimeout)
    machine.mail!.delivery.start()
    cleanups.push(() => machine.mail!.delivery.stop())
    // Its own turn ended, as the host heard (the session at rest), and the input waits for good: nothing answered then
    await eventually(async () => {
      await machine.mail!.delivery.process(at('w2'))
      return claudeCli.ran('a long job') && running(machine, 'w2') === 'waiting_input'
    })
    expect(machine.store.mailbox.recipient(task.id, at('w2'))?.deliveredAt).not.toBeNull()
    expect(machine.store.mailbox.reportsOn(task.id)).toEqual([])
    await eventually(() => machine.store.mailbox.reportsOn(task.id).length === 1)
  })

  it('is released once, as a stop, when the process goes before the waiting input ran', async () => {
    const { machine, at } = await asleep()
    claudeCli.notifyNext('drop')
    const task = machine.mail!.service.task(at('w1'), at('w2'), { text: 'a long job', origin: 'agent_session', delivered: false })
    machine.mail!.delivery.start()
    cleanups.push(() => machine.mail!.delivery.stop())
    // Its own turn ended, as the host heard (the session at rest)
    await eventually(async () => {
      await machine.mail!.delivery.process(at('w2'))
      return claudeCli.ran('a long job') && running(machine, 'w2') === 'waiting_input'
    })
    expect(machine.store.mailbox.recipient(task.id, at('w2'))?.releasedAt ?? null).toBeNull()
    machine.mgr.events.onEvent({ type: 'error', sessionId: 'w2', error: { code: 'adapter_crashed', message: 'the process exited', retryable: true } })
    await eventually(() => (machine.store.mailbox.recipient(task.id, at('w2'))?.releasedAt ?? null) !== null)
    expect(machine.store.mailbox.reportsOn(task.id)).toEqual([])
  })

  it("ends a wait on the session's turn with its task's turn, not the notification turn: the task went in tracked, into a running process", async () => {
    const machine = await machineHost({ mail: true, sessions: ['w2'], claude })
    const at = (id: string) => sessionAddress(machine.id, id)
    const project = machine.store.projects.listProjects().find((p) => p.id === 'p-remote')!
    const caller = (await machine.mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'codex', permissionPreset: 'auto' })).id
    // Its process runs and said what it tracks: the task goes in tracked, taken when its own turn begins
    await machine.mgr.inputs.send('w2', 'hello')
    await eventually(() => running(machine, 'w2') === 'waiting_input')
    let notified!: () => void
    claudeCli.notifyNext(true, new Promise<void>((resolve) => (notified = resolve)))
    machine.mail!.delivery.start()
    cleanups.push(() => machine.mail!.delivery.stop())
    machine.mail!.service.task(at(caller), at('w2'), { text: 'a long job', origin: 'agent_session', delivered: false })
    // Its delivery waits for the tool to take it, which its own turn does: not awaited here
    await eventually(() => {
      void machine.mail!.delivery.process(at('w2'))
      return running(machine, 'w2') === 'working'
    })
    let answered = false
    const waiting = machine.mgr.agentSession(caller, { sessionId: 'w2', action: 'wait' }).finally(() => (answered = true))
    notified()
    await eventually(() => claudeCli.ran('a long job'))
    // The notification turn ended: the wait goes on, on the task's turn
    expect(answered).toBe(false)
    claudeCli.finish('all done')
    expect(JSON.stringify(await waiting)).toContain('all done')
  })

  it("ends a call waiting on the turn with the input's turn, not the notification turn: ask_project into a running session", async () => {
    const machine = await machineHost({ mail: true, sessions: ['w1'], claude })
    const other = await machine.mgr.projectCreation.addProject(namedFolder(folder(), 'other-project'))
    await machine.mgr.setProjectTrusted(other.id, true)
    machine.store.permissions.setProjectConsent(other.id, 'p-remote', 'delegate')
    machine.store.permissions.setProjectConsent('p-remote', other.id, 'delegate')
    const target = (await machine.mgr.createSession({ projectId: other.id, cwd: other.path, tool: 'claude', permissionPreset: 'normal' })).id
    // Its process runs and said what it tracks: what goes in now is tracked
    await machine.mgr.inputs.send(target, 'hello')
    await eventually(() => running(machine, target) === 'waiting_input')
    claudeCli.notifyNext()
    let answered = false
    const asking = machine.mgr.askProject('w1', { project: other.id, session: target, task: 'a long job' }).finally(() => (answered = true))
    await eventually(() => claudeCli.ran('a long job'))
    // The notification turn ended: the call still waits, on the input's turn
    expect(answered).toBe(false)
    claudeCli.finish('all done')
    expect(JSON.stringify(await asking)).toContain('all done')
  })
})
