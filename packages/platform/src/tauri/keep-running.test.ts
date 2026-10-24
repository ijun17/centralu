import { describe, expect, it } from 'vitest'
import { keepRunningThenQuit } from './keep-running.js'

describe('quit and keep running (#1512)', () => {
  it('turns background mode on before anything else, then stops the ticked processes, then quits', async () => {
    const calls: string[] = []
    await keepRunningThenQuit({
      background: { set: async (on) => (calls.push(`background ${on}`), on) },
      stopStrays: async () => void calls.push('stop strays'),
      quit: async () => void calls.push('quit'),
    })
    expect(calls).toEqual(['background true', 'stop strays', 'quit'])
  })

  it('quits nothing and stops nothing when the keeper cannot be told, or says the mode is still off', async () => {
    for (const background of [{ set: async () => Promise.reject(new Error('keeper unreachable')) }, { set: async () => false }, undefined]) {
      const calls: string[] = []
      await expect(
        keepRunningThenQuit({ background, stopStrays: async () => void calls.push('stop strays'), quit: async () => void calls.push('quit') }),
      ).rejects.toThrow()
      expect(calls).toEqual([])
    }
  })

  it('still quits when stopping the leftover processes fails', async () => {
    const calls: string[] = []
    await keepRunningThenQuit({
      background: { set: async () => true },
      stopStrays: async () => Promise.reject(new Error('gone')),
      quit: async () => void calls.push('quit'),
    })
    expect(calls).toEqual(['quit'])
  })
})
