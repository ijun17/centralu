import { beforeEach, describe, expect, it } from 'vitest'
import type { BackgroundTask } from '@cc/protocol'
import type { LinkedSessions } from '../adapters/contract.js'
import { LinkedReports, type LinkedEvent } from './linked-reports.js'

/*
 * What the hub knows of a linked machine's sessions' own background work (#723): what the machine relays, read whole again each time its link comes
 * up, dropped while it is down. agent_session list and an ask_project answer read it (`tasksOf`); the work given there is reported by mail.
 */

let linked: Set<string>
let listing: (machineId: string) => Promise<{ sessionId: string; tasks: BackgroundTask[] }[] | null>
let mirror: LinkedReports

beforeEach(() => {
  linked = new Set(['m1', 'm10'])
  listing = async () => []
  const reader = { machineLinked: (id: string) => linked.has(id), backgroundTasks: (id: string) => listing(id) } as unknown as LinkedSessions
  mirror = new LinkedReports({ linkedReader: reader })
})

/** Every read a step started has ended: they chain only on resolved promises, never on a timer */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

const verify: BackgroundTask = { id: 'bg-verify', kind: 'shell', description: 'pnpm verify', status: 'running' }
const build: BackgroundTask = { id: 'bg-build', kind: 'shell', description: 'pnpm build', status: 'running' }
const tasks = (sessionId: string, live: BackgroundTask[]): LinkedEvent => ({ type: 'background_tasks', sessionId, live })
const ids = (sessionId: string) => mirror.tasksOf(sessionId).map((t) => t.id)

describe("a linked machine's sessions' own background work (#723)", () => {
  it('is what the machine relays, and goes with a session deleted there', () => {
    mirror.observe(tasks('m1.w1', [verify, build]))
    expect(ids('m1.w1')).toEqual(['bg-verify', 'bg-build'])
    mirror.observe({ type: 'session_deleted', sessionId: 'm1.w1' })
    expect(ids('m1.w1')).toEqual([])
  })

  it("is dropped for that machine only when its link drops, even when another machine's id starts with its", () => {
    mirror.observe(tasks('m1.w1', [verify]))
    mirror.observe(tasks('m10.w1', [build]))
    mirror.observe({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'connected' } })
    expect(ids('m1.w1')).toEqual(['bg-verify'])
    mirror.observe({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'disconnected' } })
    expect(ids('m1.w1')).toEqual([])
    expect(ids('m10.w1')).toEqual(['bg-build'])
  })

  it('is read whole when the link comes up: a session not listed is forgotten, a read that fails forgets nothing, and a change relayed meanwhile is kept', async () => {
    mirror.observe(tasks('m1.w1', [verify]))
    mirror.observe(tasks('m1.w2', [build]))
    listing = async () => null
    mirror.observe({ type: 'machine_resync', machineId: 'm1' })
    listing = () => Promise.reject(new Error('ssh closed'))
    mirror.observe({ type: 'machine_resync', machineId: 'm1' })
    await flush()
    expect(ids('m1.w1')).toEqual(['bg-verify'])
    let answer!: (rows: { sessionId: string; tasks: BackgroundTask[] }[]) => void
    listing = () => new Promise((resolve) => (answer = resolve))
    mirror.observe({ type: 'machine_resync', machineId: 'm1' })
    // Relayed while the read is out: newer than what the read says
    mirror.observe(tasks('m1.w2', []))
    answer([{ sessionId: 'm1.w2', tasks: [build] }])
    await flush()
    expect(ids('m1.w1')).toEqual([])
    expect(ids('m1.w2')).toEqual([])
  })

  it('is forgotten for a machine removed from Centralu', () => {
    mirror.observe(tasks('m1.w1', [verify]))
    linked.delete('m1')
    mirror.observe({ type: 'machine_resync', machineId: 'm1' })
    expect(ids('m1.w1')).toEqual([])
  })
})
