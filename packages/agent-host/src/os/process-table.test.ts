import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { leftoverOs, parseWinProcs } from './kill-tree.js'
import { tableReader, type ReaderProcess } from './process-table.js'
import { SLOW } from '../../../../tooling/test-timing.js'

/**
 * The warm process-table reader (#2178): one PowerShell for the host's life, asked over stdin, in place of one per
 * read, which a busy machine took 9–12 s to start. What it is asked and answers is checked with a stand-in; the
 * reading itself on Windows.
 */
class FakeReader extends EventEmitter implements ReaderProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly asked: string[] = []
  killed = false
  constructor(answer: () => string | null) {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (line: string) => {
      this.asked.push(line)
      const a = answer()
      if (a !== null) this.stdout.write(a)
    })
  }
  kill = () => ((this.killed = true), true)
  unref = () => {}
}

/** Readers that answer the nth read asked of any of them with what `answer` gives for n, or nothing for null; every start counted */
function fake(answer: (n: number) => string | null = () => '200 100 1500\nEND\n') {
  const started: FakeReader[] = []
  let asked = 0
  const reader = tableReader(() => {
    const r = new FakeReader(() => answer(++asked))
    started.push(r)
    return r
  })
  return { reader, started }
}

describe('the warm process-table reader', () => {
  it('answers every read from one PowerShell, started once, whose answer may come in pieces', async () => {
    const { reader, started } = fake((n) => (n === 1 ? '200 100 1500\n300 20' : '200 100 1500\nEND\n'))
    const read = reader.read(1000)
    await vi.waitFor(() => expect(started[0]!.asked).toHaveLength(1))
    started[0]!.stdout.write('0 1600\nEN')
    started[0]!.stdout.write('D\n')
    expect(await read).toBe('200 100 1500\n300 200 1600\n')
    expect(parseWinProcs(await reader.read(1000))).toEqual([{ pid: 200, ppid: 100, created: 1500 }])
    expect(started).toHaveLength(1)
    expect(started[0]!.asked).toEqual(['t\n', 't\n'])
  })

  it('is started ahead of the first read by `warm`, and once however often it is warmed', async () => {
    const { reader, started } = fake()
    reader.warm()
    reader.warm()
    expect(started).toHaveLength(1)
    expect(started[0]!.asked).toEqual([])
    await reader.read(1000)
    expect(started).toHaveLength(1)
  })

  it('reads one at a time: a read asked during another is asked after it is answered', async () => {
    const { reader, started } = fake((n) => `${n} 1 1\nEND\n`)
    const [a, b] = await Promise.all([reader.read(1000), reader.read(1000)])
    expect([a, b]).toEqual(['1 1 1\n', '2 1 1\n'])
    expect(started).toHaveLength(1)
  })

  it('rejects with why the table could not be read, and reads again on the next ask', async () => {
    const { reader, started } = fake((n) => (n === 1 ? 'ERR NtQuerySystemInformation status 5\nEND\n' : '200 100 1500\nEND\n'))
    await expect(reader.read(1000)).rejects.toThrow('NtQuerySystemInformation status 5')
    expect(await reader.read(1000)).toBe('200 100 1500\n')
    expect(started).toHaveLength(1)
  })

  it('a reader that ends during a read fails that read, and the next read starts another', async () => {
    const { reader, started } = fake((n) => (n === 1 ? null : '200 100 1500\nEND\n'))
    const read = reader.read(1000)
    await vi.waitFor(() => expect(started[0]!.asked).toHaveLength(1))
    started[0]!.emit('exit', 1)
    await expect(read).rejects.toThrow('the process table reader ended (1)')
    expect(await reader.read(1000)).toBe('200 100 1500\n')
    expect(started).toHaveLength(2)
  })

  it('a read that times out ends that reader, so its late answer is never taken for the next read', async () => {
    const { reader, started } = fake(() => null)
    await expect(reader.read(20)).rejects.toMatchObject({ message: 'timed out', killed: true })
    expect(started[0]!.killed).toBe(true)
    const next = reader.read(1000)
    await vi.waitFor(() => expect(started[1]?.asked).toHaveLength(1))
    // The first reader's answer comes while the next read waits for the second's
    started[0]!.stdout.write('999 1 1\nEND\n')
    started[1]!.stdout.write('300 100 1600\nEND\n')
    expect(await next).toBe('300 100 1600\n')
    expect(started).toHaveLength(2)
  })
})

describe('leftoverOs reading the table', () => {
  /** A PowerShell of its own that answers `stdout`, counting how often it was started */
  function readsOfItsOwn(stdout: string) {
    const counted = { n: 0 }
    const run = (async () => (counted.n++, { stdout })) as unknown as Parameters<typeof leftoverOs>[0]
    return { run, counted }
  }

  it('reads from the warm reader, and starts no PowerShell of its own', async () => {
    const { run, counted } = readsOfItsOwn('')
    const { reader } = fake()
    expect(await leftoverOs(run, reader).listProcesses(1000)).toEqual([{ pid: 200, ppid: 100, created: 1500 }])
    expect(counted.n).toBe(0)
  })

  it('reads once in a PowerShell of its own when the warm reader cannot answer, and not when it timed out', async () => {
    const { run, counted } = readsOfItsOwn('400 1 1700\n')
    const ended = fake((n) => (n === 1 ? 'ERR access denied\nEND\n' : null))
    expect(await leftoverOs(run, ended.reader).listProcesses(1000)).toEqual([{ pid: 400, ppid: 1, created: 1700 }])
    expect(counted.n).toBe(1)
    await expect(leftoverOs(run, ended.reader).listProcesses(20)).rejects.toMatchObject({ killed: true })
    expect(counted.n).toBe(1)
  })
})

describe.runIf(process.platform === 'win32')('the table on Windows', () => {
  it(
    'shows this process under its parent, created when it started, the same in the warm reader and in one read of its own',
    async () => {
      const os = leftoverOs(promisify(execFile), tableReader())
      const warm = (await os.listProcesses(30_000)).find((r) => r.pid === process.pid)
      const once = (await leftoverOs(promisify(execFile)).listProcesses(30_000)).find((r) => r.pid === process.pid)
      expect(warm).toEqual(once)
      expect(warm?.ppid).toBe(process.ppid)
      const started = Date.now() - process.uptime() * 1000
      expect(Math.abs(warm!.created - started)).toBeLessThan(5000)
    },
    20_000 * SLOW,
  )
})
