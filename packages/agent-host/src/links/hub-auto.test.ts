import { describe, expect, it } from 'vitest'
import { askHubAuto } from './hub-auto.js'

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
