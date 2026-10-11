/**
 * The host's start as data (docs/runtime-lessons.md ST16, HO2, HO3, HO6, HO11): the order
 * `main.ts` must keep, the guard that holds it to it, the refusal, the gate for early frames and the
 * launcher's variables.
 */
import { describe, expect, it } from 'vitest'
import { Gate } from './gate.js'
import { LAUNCH_VARIABLES, takeLaunchEnv } from './launch-env.js'
import { START_ORDER, StartSequence, refuse, type StartStep } from './start.js'

const at = (s: StartStep) => START_ORDER.indexOf(s)

describe('the start order', () => {
  it("the launcher's variables leave the environment first, before anything can be spawned (ST16)", () => {
    expect(START_ORDER[0]).toBe('launch variables')
  })

  it('the log is on before the PATH probe, the lock and the store (HO3)', () => {
    expect(at('log')).toBeLessThan(at('path'))
    expect(at('log')).toBeLessThan(at('lock'))
    expect(at('log')).toBeLessThan(at('store'))
  })

  it('signals are held right after the lock, before anything that takes time (HO6)', () => {
    expect(at('hold signals')).toBe(at('lock') + 1)
  })

  it('a swap waits before the lock; the services are wired before the server listens', () => {
    expect(at('standby')).toBeLessThan(at('lock'))
    expect(at('services')).toBeLessThan(at('listen'))
    expect(at('listen')).toBeLessThan(at('ready'))
    expect(START_ORDER.at(-1)).toBe('endings')
  })

  it('names each step once', () => {
    expect(new Set(START_ORDER).size).toBe(START_ORDER.length)
  })
})

describe('the start sequence', () => {
  it('lets the steps through in order', () => {
    const s = new StartSequence()
    for (const step of START_ORDER) s.at(step)
    expect(() => s.done()).not.toThrow()
  })

  it('throws at a step taken out of turn', () => {
    const s = new StartSequence()
    s.at('launch variables')
    s.at('data folder')
    expect(() => s.at('path')).toThrow('host start out of order: "path" where "log" comes next')
  })

  it('throws when the start ends with steps not taken', () => {
    const s = new StartSequence()
    s.at('launch variables')
    expect(() => s.done()).toThrow('host start ended before "data folder"')
  })
})

describe('a final refusal (HO2)', () => {
  it('is said on stderr and on stdout, then exit 1', () => {
    const said: string[] = []
    refuse('Another Centralu is already using this data', {
      stderr: (l) => void said.push(`err ${l}`),
      stdout: (l) => void said.push(`out ${l}`),
      exit: (c) => void said.push(`exit ${c}`),
    })
    expect(said).toEqual(['err Another Centralu is already using this data', 'out Another Centralu is already using this data', 'exit 1'])
  })

  it('still exits 1 when stdout is closed', () => {
    const said: string[] = []
    refuse('written by a newer Centralu', {
      stderr: (l) => void said.push(l),
      stdout: () => {
        throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' })
      },
      exit: (c) => void said.push(`exit ${c}`),
    })
    expect(said).toEqual(['written by a newer Centralu', 'exit 1'])
  })
})

describe('frames before the server exists (HO11)', () => {
  it('are dropped, not thrown, and the ones after it opens are sent', () => {
    const gate = new Gate<string>()
    const sent: string[] = []
    // A pty adopted from the keeper replays its scrollback as soon as it is attached
    expect(() => gate.push('replayed before the server')).not.toThrow()
    gate.open((f) => void sent.push(f))
    gate.push('after')
    expect(sent).toEqual(['after'])
  })
})

describe("the launcher's variables (ST16)", () => {
  it('are read once and taken out of the environment', () => {
    const env: Record<string, string | undefined> = {
      CC_KEEPER: '1',
      CC_HOST_SOURCE: 'content',
      CC_FRONT_DOOR: 'ws://127.0.0.1:4100',
      CC_SERVE: '1',
      CC_HOST_TOKEN: 'secret',
      CC_DATA_DIR: '/d',
      PATH: '/bin',
    }
    expect(takeLaunchEnv(env)).toEqual({
      underKeeper: true,
      keeperSource: 'content',
      frontDoor: 'ws://127.0.0.1:4100',
      startedByServe: true,
      token: 'secret',
    })
    for (const name of LAUNCH_VARIABLES) expect(env, name).not.toHaveProperty(name)
    expect(env).toEqual({ CC_DATA_DIR: '/d', PATH: '/bin' })
  })
})
