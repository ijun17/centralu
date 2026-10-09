/**
 * Every way the host process can be asked to end (docs/runtime-lessons.md HO4, HO6, HO7, HO10,
 * HO15), against a stand-in process the test sends signals and errors to.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { crashRecorder, guardErrors, holdSignals, watchParent, wireEndings } from './endings.js'
import type { LeaveMode } from './shutdown.js'

function fakeProcess() {
  const emitter = new EventEmitter()
  const exits: number[] = []
  return {
    emitter,
    exits,
    proc: {
      on: (e: string, l: (...a: unknown[]) => void) => emitter.on(e, l),
      off: (e: string, l: (...a: unknown[]) => void) => emitter.off(e, l),
      exit: (code: number) => void exits.push(code),
    },
  }
}

function fakeStdin() {
  const emitter = new EventEmitter()
  let resumed = false
  return {
    emitter,
    resumed: () => resumed,
    stdin: {
      resume: () => void (resumed = true),
      on: (e: 'end' | 'close' | 'error', l: () => void) => emitter.on(e, l),
    },
  }
}

describe('a signal while starting (HO6)', () => {
  it('is held, not obeyed, and acted on once the shutdown exists', () => {
    const f = fakeProcess()
    const signals = holdSignals(f.proc, () => {})
    f.emitter.emit('SIGTERM', 'SIGTERM')
    expect(f.exits).toEqual([])
    let acted = 0
    signals.act(() => void acted++)
    expect(acted).toBe(1)
  })

  it('a second one while still starting exits at once with 1', () => {
    const f = fakeProcess()
    holdSignals(f.proc, () => {})
    f.emitter.emit('SIGINT', 'SIGINT')
    f.emitter.emit('SIGINT', 'SIGINT')
    expect(f.exits).toEqual([1])
  })

  it('once acting, a signal runs the shutdown and never exits by itself', () => {
    const f = fakeProcess()
    const signals = holdSignals(f.proc, () => {})
    let acted = 0
    signals.act(() => void acted++)
    f.emitter.emit('SIGTERM', 'SIGTERM')
    f.emitter.emit('SIGTERM', 'SIGTERM')
    expect(acted).toBe(2)
    expect(f.exits).toEqual([])
  })
})

describe("the parent's pipe (HO7)", () => {
  it('without --watch-parent the end of stdin means nothing, and stdin is not even read', () => {
    const s = fakeStdin()
    let gone = 0
    watchParent(false, s.stdin, () => void gone++)
    s.emitter.emit('end')
    s.emitter.emit('close')
    expect(gone).toBe(0)
    expect(s.resumed()).toBe(false)
  })

  it('with it, the end, the close or an error of stdin is the parent gone', () => {
    for (const event of ['end', 'close', 'error'] as const) {
      const s = fakeStdin()
      let gone = 0
      watchParent(true, s.stdin, () => void gone++)
      s.emitter.emit(event)
      expect(gone, event).toBe(1)
    }
  })
})

describe('errors nobody caught (HO10)', () => {
  it('a rejection is recorded and survived; an uncaught exception is recorded and shuts down', () => {
    const f = fakeProcess()
    const recorded: string[] = []
    let crashed = 0
    guardErrors(f.proc, { record: (kind) => void recorded.push(kind), onCrash: () => void crashed++ })
    f.emitter.emit('unhandledRejection', new Error('one request went wrong'))
    expect(recorded).toEqual(['Unhandled rejection'])
    expect(crashed).toBe(0)
    f.emitter.emit('uncaughtException', new Error('state broke'))
    expect(recorded).toEqual(['Unhandled rejection', 'Uncaught exception'])
    expect(crashed).toBe(1)
  })
})

describe('host-errors.log (HO4)', () => {
  it('keeps one previous generation once it passes its size, and the new entry starts the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-crash-log-'))
    const path = join(dir, 'host-errors.log')
    writeFileSync(path, 'x'.repeat(2048))
    const record = crashRecorder(path, () => {}, 1024)
    record('Unhandled rejection', new Error('after the rollover'))
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('x'.repeat(2048))
    const now = readFileSync(path, 'utf8')
    expect(now).toContain('Unhandled rejection: Error: after the rollover')
    expect(now).not.toContain('xxxx')
    expect(existsSync(`${path}.2`)).toBe(false)
  })

  it('a log that cannot be written is not thrown again', () => {
    const logged: string[] = []
    const record = crashRecorder(join(tmpdir(), 'no-such-folder-cc', 'deeper', 'host-errors.log'), (l) => void logged.push(l))
    expect(() => record('Uncaught exception', new Error('boom'))).not.toThrow()
    expect(logged.join('\n')).toContain('boom')
  })
})

describe('every ending, wired (HO15)', () => {
  function wired(heldChildren: boolean, watch = true) {
    const f = fakeProcess()
    const s = fakeStdin()
    const left: [LeaveMode, boolean][] = []
    const signals = holdSignals(f.proc, () => {})
    const endings = wireEndings({
      proc: f.proc,
      signals,
      heldChildren,
      leave: (mode, handOver) => void left.push([mode, handOver]),
      record: () => {},
      stdin: s.stdin,
      watchParent: watch,
      log: () => {},
    })
    return { f, s, left, endings }
  }

  it('under the keeper\'s child service a signal is a restart: detach, and the next host takes the views', () => {
    const w = wired(true)
    w.f.emitter.emit('SIGTERM', 'SIGTERM')
    expect(w.left).toEqual([['detach', true]])
  })

  it('without it a signal is a stop, and nothing is handed over', () => {
    const w = wired(false)
    w.f.emitter.emit('SIGINT', 'SIGINT')
    expect(w.left).toEqual([['stop', false]])
  })

  it("the keeper's stop forces a stop even when it holds the children", () => {
    const w = wired(true)
    w.endings.keeperStop()
    expect(w.left).toEqual([['stop', false]])
  })

  it('a crash or a vanished parent hands nothing over', () => {
    const w = wired(true)
    w.f.emitter.emit('uncaughtException', new Error('state broke'))
    w.s.emitter.emit('end')
    expect(w.left).toEqual([
      ['detach', false],
      ['detach', false],
    ])
  })
})
