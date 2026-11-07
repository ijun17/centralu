import { describe, expect, it } from 'vitest'
import { askHubAuto } from './hub-auto.js'
import { LinkedMachine } from './linked-machine-ops.js'

describe('what a machine says of its "Allow auto from a linked computer"', () => {
  const answering = (reply: unknown) => async (method: string, params: unknown) => {
    seen.push({ method, params })
    if (reply instanceof Error) throw reply
    return reply
  }
  const seen: { method: string; params: unknown }[] = []

  it('reads it with host.hubAuto and sets it with host.setHubAuto', async () => {
    seen.length = 0
    expect(await askHubAuto(answering({ allowed: true }))).toBe('on')
    expect(await askHubAuto(answering({ allowed: false }), false)).toBe('off')
    expect(seen).toEqual([{ method: 'host.hubAuto', params: {} }, { method: 'host.setHubAuto', params: { allowed: false } }])
  })

  it('reads a machine without the method as older, and any other failure as it came', async () => {
    expect(await askHubAuto(answering(new Error('Unknown method: host.hubAuto')))).toBe('older')
    await expect(askHubAuto(answering(new Error('the store is read-only')))).rejects.toThrow('the store is read-only')
  })
})

describe('the window asking a machine for its "Allow auto from a linked computer"', () => {
  const machine = (call: () => Promise<unknown>) =>
    Object.assign(Object.create(LinkedMachine.prototype), { record: { name: 'Box' }, deps: { hubAutoReadMs: 30 }, client: { connected: true, call } }) as LinkedMachine

  // A link that is up and never answers: the read says so after the bound, not after the client's whole call limit.
  // The set is not bound: the machine applies a change when it gets to it, and the row shows what it then answered
  it('says a machine that never answers did not, for the read within the bound, and waits for a slow set', async () => {
    await expect(machine(() => new Promise<never>(() => {})).hubAuto()).rejects.toThrow('Box did not answer for its "Allow auto from a linked computer": no answer within 30 ms')
    const slow = machine(() => new Promise((resolve) => setTimeout(() => resolve({ allowed: true }), 90)))
    expect(await slow.hubAuto(true)).toBe('on')
  })
})
