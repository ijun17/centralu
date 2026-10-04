import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { Drain, DrainCut } from './drain.js'
import { bridgeAddress, ControlChannel, runDrain, standby, viewPort, type StandbyDeps } from './swap-control.js'
import type { StoreInspection } from './dev-services/store.js'

describe('the Codex bridge address (#280 step 3)', () => {
  it('under a keeper is the front door, which outlives this host, and not the host’s own port', () => {
    expect(bridgeAddress('ws://127.0.0.1:61000', 52001, 'tok')).toEqual({ url: 'ws://127.0.0.1:61000', token: 'tok' })
  })

  it('without a keeper is the host itself, and nothing before the host listens', () => {
    expect(bridgeAddress(undefined, 52001, 'tok')).toEqual({ url: 'ws://127.0.0.1:52001', token: 'tok' })
    expect(bridgeAddress('ws://127.0.0.1:61000', undefined, 'tok')).toBeNull()
  })
})

describe('the port an app view address points at (#280 step 4)', () => {
  it('under a keeper is the front door’s, so the address an iframe holds still reaches the host after a swap', () => {
    expect(viewPort('ws://127.0.0.1:61000', 52001)).toBe(61000)
  })

  it('without a keeper, or with a door that is not a loopback port, is the host’s own; nothing before the host listens', () => {
    expect(viewPort(undefined, 52001)).toBe(52001)
    expect(viewPort('ws://example.com:61000', 52001)).toBe(52001)
    expect(viewPort('not a url', 52001)).toBe(52001)
    expect(viewPort('ws://127.0.0.1:61000', undefined)).toBeNull()
  })
})

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}
const exit = (code: number): never => {
  throw new Exit(code)
}

const store = (over: Partial<StoreInspection> = {}): StoreInspection => ({
  exists: true,
  userVersion: 41,
  minReaderVersion: 32,
  latestKnownVersion: 42,
  tooNew: null,
  pending: [{ to: 42, heavy: false, breaksOlderReaders: false }],
  ...over,
})

function standbyDeps(input: PassThrough, inspect: () => StoreInspection) {
  const out: string[] = []
  const deps: StandbyDeps = { control: new ControlChannel(input), inspect, write: (l) => out.push(l), log: () => {}, exit }
  return { deps, out }
}

describe('the control channel on the host’s stdin (#280 step 3)', () => {
  it('reads one JSON object per line, across chunk boundaries, and ignores anything else', async () => {
    const input = new PassThrough()
    const ch = new ControlChannel(input)
    const seen: string[] = []
    ch.on('drain', (m) => seen.push(`drain ${m.timeoutMs}`))
    input.write('not json\n{"op":"dra')
    input.write('in","timeoutMs":10}\n\n[1,2]\n')
    await new Promise((r) => setImmediate(r))
    expect(seen).toEqual(['drain 10'])
  })

  it('a waiter is rejected when the keeper closes the pipe', async () => {
    const input = new PassThrough()
    const ch = new ControlChannel(input)
    const waiting = ch.next('activate')
    input.end()
    await expect(waiting).rejects.toThrow(/closed/)
  })
})

describe('standby (#280 step 3)', () => {
  it('reports its schema check and waits for activate before it takes anything over', async () => {
    const input = new PassThrough()
    const { deps, out } = standbyDeps(input, () => store())
    let activated = false
    const done = standby(deps).then(() => (activated = true))
    await new Promise((r) => setImmediate(r))
    expect(JSON.parse(out[0]!).standby.schema).toMatchObject({ userVersion: 41, latestKnownVersion: 42 })
    expect(activated).toBe(false)
    input.write('{"op":"activate"}\n')
    await done
    expect(activated).toBe(true)
  })

  it('refuses a store this build cannot read, before the running host is asked to drain', async () => {
    const input = new PassThrough()
    const tooNew = '[agent-host] This data was written by a newer Centralu.'
    const { deps, out } = standbyDeps(input, () => store({ tooNew }))
    const err = await standby(deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Exit)
    expect((err as Exit).code).toBe(1)
    // On stdout, where the keeper reads it, and in the words the supervisor already treats as final
    expect(out).toEqual([tooNew])
  })

  it('exits without touching anything when the keeper abandons the swap', async () => {
    const input = new PassThrough()
    const { deps } = standbyDeps(input, () => store())
    const done = standby(deps).catch((e: unknown) => e)
    await new Promise((r) => setImmediate(r))
    input.end()
    const err = await done
    expect((err as Exit).code).toBe(0)
  })
})

describe('drain (#280 step 3)', () => {
  it('cuts a slow in-process call at the bound, then detaches, then lets go of the lock, then says drained', async () => {
    const drain = new Drain()
    const order: string[] = []
    const slow = drain.track('tool app-board/set_item_fields', () => new Promise<string>(() => {})).catch((e: unknown) => e)
    const write: string[] = []
    const err = await runDrain(50, {
      drain,
      detach: async () => void order.push('detach'),
      release: () => void order.push('release'),
      write: (l) => {
        order.push('write')
        write.push(l)
      },
      log: () => {},
      exit,
      settleMs: 0,
    }).catch((e: unknown) => e)
    expect((err as Exit).code).toBe(0)
    expect(await slow).toBeInstanceOf(DrainCut)
    expect(order).toEqual(['detach', 'release', 'write'])
    const drained = JSON.parse(write[0]!).drained
    expect(drained.cut).toEqual(['tool app-board/set_item_fields'])
    expect(drained.keptAgents).toBe(false)
  })

  it('a failing detach still lets go of the lock, or the next host could never start', async () => {
    const released: boolean[] = []
    await runDrain(0, {
      drain: new Drain(),
      detach: async () => Promise.reject(new Error('stuck')),
      release: () => void released.push(true),
      write: () => {},
      log: () => {},
      exit,
    }).catch(() => {})
    expect(released).toEqual([true])
  })
})
