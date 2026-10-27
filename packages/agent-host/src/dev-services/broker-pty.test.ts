import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PtyBroker, brokerPath, brokerPtyModule, openForPerson, parseBrokerEvent } from './broker-pty.js'
import type { Pty, PtyModule } from './pty-slot.js'
import { TerminalService } from './terminal.js'
import { cleanUp, plantTreeScript, settle, treePids } from './process-tree.test-helpers.js'
import { SLOW } from '../../../../tooling/test-timing.js'

/*
 * #1067: on Windows terminals are started by a broker outside the host's work job, so what a person starts in one
 * outlives the host. The broker's handle has the surface `terminal.ts` takes from node-pty and from the keeper.
 */

/** A broker speaking the real protocol with no pty behind it: answers each request with what it was asked */
const FAKE_BROKER = `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const killed = new Set()
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.op === 'spawn') {
    if (m.file === 'missing.exe') return send({ ev: 'error', id: m.id, message: 'File not found: missing.exe' })
    // The pid answers late, as a real spawn's: a kill may come first
    setTimeout(() => {
      send({ ev: 'spawned', id: m.id, pid: 4000 + m.id })
      send({ ev: 'data', id: m.id, data: 'started ' + m.file + ' ' + JSON.stringify(m.args) + ' in ' + m.cwd + ' ' + m.cols + 'x' + m.rows })
      if (killed.has(m.id)) send({ ev: 'exit', id: m.id, exitCode: 0, signal: 1 })
    }, 50)
  } else if (m.op === 'write') {
    if (m.data === 'end the broker') process.exit(3)
    // Lines that are no event: they are skipped, and the next one still arrives
    if (m.data === 'say junk') process.stdout.write('{"ev":"data","id":' + m.id + '}\\nnull\\n[1]\\n7\\n{"ev":"unheard of","id":1}\\nnot json\\n')
    send({ ev: 'data', id: m.id, data: 'got ' + m.data })
  } else if (m.op === 'resize') send({ ev: 'data', id: m.id, data: 'size ' + m.cols + 'x' + m.rows })
  else if (m.op === 'open') appendFileSync(new URL('./opened.txt', import.meta.url), m.url + '\\n')
  else if (m.op === 'kill') {
    killed.add(m.id)
    send({ ev: 'exit', id: m.id, exitCode: 0, signal: 1 })
  }
})
`

describe('parseBrokerEvent', () => {
  it('reads each event the broker speaks, and nothing else', () => {
    expect(parseBrokerEvent('{"ev":"ready"}')).toEqual({ ev: 'ready' })
    expect(parseBrokerEvent('{"ev":"spawned","id":2,"pid":99}')).toEqual({ ev: 'spawned', id: 2, pid: 99 })
    expect(parseBrokerEvent('{"ev":"error","id":2,"message":"no"}')).toEqual({ ev: 'error', id: 2, message: 'no' })
    expect(parseBrokerEvent('{"ev":"data","id":2,"data":"x"}')).toEqual({ ev: 'data', id: 2, data: 'x' })
    expect(parseBrokerEvent('{"ev":"exit","id":2,"exitCode":1,"signal":null}')).toEqual({ ev: 'exit', id: 2, exitCode: 1, signal: null })
    for (const junk of ['null', '[1]', '7', 'not json', '{}', '{"ev":"data","id":1}', '{"ev":"data","data":"x"}', '{"ev":"exit","id":1,"exitCode":"1","signal":null}', '{"ev":"other","id":1}']) {
      expect(parseBrokerEvent(junk)).toBeNull()
    }
  })
})

function follow(p: Pty) {
  const seen = { data: '', exit: null as { exitCode: number; signal?: number } | null }
  p.onData((d) => (seen.data += d))
  p.onExit((e) => (seen.exit = e))
  return seen
}

describe('a pty through the broker', () => {
  let dir = ''
  let broker: PtyBroker | undefined
  afterEach(() => {
    broker?.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  function fake(): PtyModule {
    dir = mkdtempSync(join(tmpdir(), 'cc-broker-'))
    writeFileSync(join(dir, 'broker.mjs'), FAKE_BROKER)
    broker = PtyBroker.start(join(dir, 'broker.mjs'))
    return brokerPtyModule(broker, () => {
      throw new Error('not the fallback')
    })
  }

  it('starts, writes, resizes and ends as node-pty does, its pid arriving once the broker has it', async () => {
    const p = fake().spawn('pwsh.exe', ['-NoLogo'], { cwd: 'C:\\work', cols: 90, rows: 20, env: { A: '1', B: undefined } })
    const seen = follow(p)
    expect(p.pid).toBeUndefined()
    await settle(() => seen.data, (d) => d.includes('started'), 5_000 * SLOW)
    expect(p.pid).toBe(4001)
    expect(seen.data).toBe('started pwsh.exe ["-NoLogo"] in C:\\work 90x20')
    p.write('ls\r')
    p.resize(120, 40)
    await settle(() => seen.data, (d) => d.includes('size'), 5_000 * SLOW)
    expect(seen.data).toContain('got ls\r')
    expect(seen.data).toContain('size 120x40')
    p.kill()
    expect(await settle(() => seen.exit, Boolean, 5_000 * SLOW)).toEqual({ exitCode: 0, signal: 1 })
  })

  it('lines that are no event are skipped, and the output after them still arrives', async () => {
    const p = fake().spawn('pwsh.exe', [], { cwd: 'C:\\', cols: 80, rows: 24, env: {} })
    const seen = follow(p)
    await settle(() => seen.data, (d) => d.includes('started'), 5_000 * SLOW)
    const before = seen.data
    p.write('say junk')
    p.write('after')
    await settle(() => seen.data, (d) => d.includes('got after'), 5_000 * SLOW)
    expect(seen.data).toBe(`${before}got say junkgot after`)
    expect(seen.exit).toBeNull()
  })

  it('a kill before the pid has come still ends it (a tab closed at once)', async () => {
    const p = fake().spawn('pwsh.exe', [], { cwd: 'C:\\', cols: 80, rows: 24, env: {} })
    const seen = follow(p)
    p.kill()
    expect(await settle(() => seen.exit, Boolean, 5_000 * SLOW)).toEqual({ exitCode: 0, signal: 1 })
  })

  it('a start that fails says why in the output, then ends', async () => {
    const p = fake().spawn('missing.exe', [], { cwd: 'C:\\', cols: 80, rows: 24, env: {} })
    const seen = follow(p)
    expect(await settle(() => seen.exit, Boolean, 5_000 * SLOW)).toEqual({ exitCode: 1 })
    expect(seen.data).toContain('Could not start: File not found: missing.exe')
  })

  it('a broker that ends ends its terminals with the reason, and the next one starts in the host', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-broker-'))
    writeFileSync(join(dir, 'broker.mjs'), FAKE_BROKER)
    broker = PtyBroker.start(join(dir, 'broker.mjs'))
    const inHost: string[] = []
    const ptys = brokerPtyModule(broker, () => ({
      spawn: (file) => {
        inHost.push(file)
        return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }
      },
    }))
    const p = ptys.spawn('pwsh.exe', [], { cwd: 'C:\\', cols: 80, rows: 24, env: {} })
    const seen = follow(p)
    await settle(() => seen.data, (d) => d.includes('started'), 5_000 * SLOW)
    p.write('end the broker')
    expect(await settle(() => seen.exit, Boolean, 5_000 * SLOW)).toEqual({ exitCode: 1 })
    expect(seen.data).toContain('the terminal service ended (3)')
    expect(broker.alive).toBe(false)
    ptys.spawn('pwsh.exe', [], { cwd: 'C:\\', cols: 80, rows: 24, env: {} })
    expect(inHost).toEqual(['pwsh.exe'])
  })
})

/*
 * Review of #1685: what the host opens for the person (Antigravity's sign-in page) is started by the broker, outside the
 * job, so the browser outlives a Stop and the host. Only an https address is sent; a broker that is gone opens it in the host
 */
describe('an address opened for the person through the broker', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('sends an https address to the broker, refuses any other, and opens in the host once the broker is gone', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-broker-'))
    writeFileSync(join(dir, 'broker.mjs'), FAKE_BROKER)
    const broker = PtyBroker.start(join(dir, 'broker.mjs'))
    const inHost: string[] = []
    openForPerson(broker, 'https://accounts.google.com/o?a=1&b=2', (u) => inHost.push(u))
    expect(broker.openUrl('file:///etc/passwd')).toBe(false)
    expect(broker.openUrl('http://accounts.google.com/x')).toBe(false)
    const opened = join(dir, 'opened.txt')
    expect(await settle(() => (existsSync(opened) ? readFileSync(opened, 'utf8') : ''), (t) => t.length > 0, 5_000 * SLOW)).toBe('https://accounts.google.com/o?a=1&b=2\n')
    expect(inHost).toEqual([])
    broker.close()
    await settle(() => broker.alive, (alive) => !alive, 5_000 * SLOW)
    openForPerson(broker, 'https://accounts.google.com/again', (u) => inHost.push(u))
    expect(inHost).toEqual(['https://accounts.google.com/again'])
  })
})

/*
 * The real broker and a real shell, through the terminal service as the host wires it (main.ts): what is typed comes
 * back, a resize reaches the console, `exit` ends the tab, and closing a tab ends its shell and what it started.
 */
describe.runIf(process.platform === 'win32')('a terminal through the real broker (Windows)', () => {
  it('runs input, output, resize, exit and close end to end', async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-broker-term-')))
    const broker = PtyBroker.start(brokerPath())
    let pids: number[] = []
    onTestFinished(async (test) => {
      broker.close()
      await cleanUp(pids, test)
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    })
    const exits: (number | null)[] = []
    const svc = new TerminalService((e) => {
      if (e.exitCode !== undefined) exits.push(e.exitCode)
    }, brokerPtyModule(broker))
    const prompt = (h: string) => /PS .*>/.test(h)

    // Input and output
    const t = svc.create(dir, 100, 30)
    await settle(() => t.history(), prompt, 60_000 * SLOW)
    svc.input(t.id, 'Write-Output ("mark" + "er-" + $PID)\r')
    const marked = await settle(() => /marker-(\d+)/.exec(t.history()), Boolean, 30_000 * SLOW)
    const shell = Number(marked![1])
    pids.push(shell)
    // The shell is the broker's child, not the host's: outside the host's job
    const parent = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${shell}").ParentProcessId`], { encoding: 'utf8', windowsHide: true }).trim()
    expect(Number(parent)).toBe(broker.pid)

    // Resize reaches the pseudoconsole
    svc.resize(t.id, 77, 21)
    await new Promise((r) => setTimeout(r, 500))
    svc.input(t.id, 'Write-Output ("width-" + [Console]::WindowWidth)\r')
    expect(await settle(() => t.history(), (h) => h.includes('width-77'), 30_000 * SLOW)).toContain('width-77')

    // `exit` ends the tab with its code
    svc.input(t.id, 'exit 7\r')
    expect(await settle(() => exits, (e) => e.length > 0, 30_000 * SLOW)).toEqual([7])

    // Closing a tab ends its shell and what it started, as without the broker
    const t2 = svc.create(dir, 100, 30)
    await settle(() => t2.history(), prompt, 60_000 * SLOW)
    const pidFile = join(dir, 'pids')
    svc.input(t2.id, `& '${process.execPath}' '${plantTreeScript(dir)}' '${pidFile}' 2\r`)
    const tree = await settle(() => treePids(pidFile), (p) => p.length === 3, 30_000 * SLOW)
    pids = [...pids, ...tree]
    svc.close(t2.id)
    expect(await settle(() => tree.filter(isAlive), (left) => left.length === 0, 15_000 * SLOW)).toEqual([])
  }, 180_000 * SLOW)
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
