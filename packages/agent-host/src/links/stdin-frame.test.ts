import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PS_PREAMBLE, remoteScript, SshTunnel, STDIN_ACK, STDIN_END, STDIN_READY } from './tunnel.js'
import { fakeExe } from '../fake-exe.test-helpers.js'
import { removeTree } from '../temp-dir.test-helpers.js'
import { SLOW } from '../../../../tooling/test-timing.js'

/**
 * A script on a Windows remote's stdin (#1360). The hub's step ran `[Console]::In.ReadToEnd()`, which on a Windows 11 PC with
 * OpenSSH 9.5 never returned in 7 to 60 percent of the runs (2026-10-20, measured through a private sshd on loopback), so
 * the update stopped at the `centralu` step until ssh's 30-minute limit. The script is now framed (base64, then a line with one
 * dot) and read from the raw stream up to that line, which did not stall in 200 of 200 runs; the reader says when it runs and
 * when it has the script, and the hub waits for both, so a remote that never saw its input fails in seconds, said so.
 */

const KB = 1024
/** A script of about `size` characters of PowerShell that prints how much of itself arrived, then `done` */
function script(size: number): string {
  return `$n = ${size}\nWrite-Output "got $n"\n# ${'x'.repeat(size)}\nWrite-Output 'done'\n`
}

/** What a real remote shell would run: the encoded command decoded */
function decoded(command: string): string {
  return Buffer.from(command.slice(command.lastIndexOf(' ') + 1), 'base64').toString('utf16le')
}

type Framed = { command: string; stdin: string; expect?: readonly string[] }

function framedCommand(ps: string): Framed {
  const c = remoteScript({ shell: 'powershell' }, { sh: '', ps })
  if (typeof c === 'string') throw new Error('expected the script to go on stdin')
  return c
}

describe('the framing of a script on stdin', () => {
  it('goes on stdin whole above 64 KB, base64 then one dot line, with the lines to wait for', () => {
    const c = framedCommand(script(100 * KB))
    expect(c.stdin.length).toBeGreaterThan(64 * KB)
    expect(c.stdin).toMatch(new RegExp(`^[A-Za-z0-9+/=]+\\n\\${STDIN_END}\\n$`))
    expect(c.expect).toEqual([STDIN_READY, STDIN_ACK])
    // The script is what the base64 holds, preamble first
    const body = Buffer.from(c.stdin.split('\n')[0] ?? '', 'base64').toString('utf8')
    expect(body.startsWith(PS_PREAMBLE)).toBe(true)
    expect(body).toContain("Write-Output 'done'")
  })

  it('does not read the text of stdin, whose readers stalled on Windows OpenSSH, and does not need its end', () => {
    const reader = decoded(framedCommand(script(100 * KB)).command)
    expect(reader).not.toContain('ReadToEnd')
    expect(reader).not.toContain('[Console]::In')
    expect(reader).toContain('OpenStandardInput')
    expect(reader).toContain(STDIN_READY)
    expect(reader).toContain(STDIN_ACK)
  })

  it('frames the WSL step the same way', () => {
    const c = remoteScript({ shell: 'wsl', wslDistro: 'Ubuntu' }, { sh: `echo ${'x'.repeat(30 * KB)}`, ps: '' })
    if (typeof c === 'string') throw new Error('expected stdin')
    expect(c.stdin).toMatch(/\n\.\n$/)
    expect(c.expect).toEqual([STDIN_READY, STDIN_ACK])
    expect(decoded(c.command)).not.toContain('ReadToEnd')
  })
})

/*
 * Windows PowerShell 5.1 itself, started as sshd starts a command (`cmd.exe /c "powershell …"`), with the script on its stdin
 * and the input never closed: the reader must go on at the dot line, and a script over 64 KB must arrive whole.
 */
describe.runIf(process.platform === 'win32')('on Windows PowerShell 5.1', () => {
  function runPowerShell(command: string, input: string, o: { end: boolean }): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.stdin.on('error', () => {})
      child.once('error', reject)
      child.once('close', (code) => {
        clearTimeout(guard)
        resolve({ stdout, stderr, code })
      })
      if (o.end) child.stdin.end(input)
      else child.stdin.write(input)
      // The input stays open in the second case: the reader must not need its end
      const guard = setTimeout(() => child.kill(), 60_000 * SLOW)
    })
  }

  it('runs a script of 100 KB whole when the input is never closed, saying it runs and that it has the script first', async () => {
    const c = framedCommand(script(100 * KB))
    const r = await runPowerShell(c.command, c.stdin, { end: false })
    expect(r.stdout).toContain(`got ${100 * KB}`)
    expect(r.stdout).toContain('done')
    expect(r.stdout.indexOf(STDIN_READY)).toBeGreaterThanOrEqual(0)
    expect(r.stdout.indexOf(STDIN_READY)).toBeLessThan(r.stdout.indexOf(STDIN_ACK))
    expect(r.stdout.indexOf(STDIN_ACK)).toBeLessThan(r.stdout.indexOf('got '))
    expect(r.code).toBe(0)
  }, 90_000 * SLOW)

  it('runs it the same when the input is closed after the last byte', async () => {
    const c = framedCommand(script(100 * KB))
    const r = await runPowerShell(c.command, c.stdin, { end: true })
    expect(r.stdout).toContain(`got ${100 * KB}`)
    expect(r.code).toBe(0)
  }, 90_000 * SLOW)

  it('takes a dot line that ends with a carriage return too', async () => {
    const c = framedCommand(script(20 * KB))
    const r = await runPowerShell(c.command, c.stdin.replace(/\n\.\n$/, '\n.\r\n'), { end: false })
    expect(r.stdout).toContain('done')
    expect(r.code).toBe(0)
  }, 90_000 * SLOW)

  it('runs nothing when the input ends before its dot line, and says so', async () => {
    const c = framedCommand(script(10 * KB))
    const r = await runPowerShell(c.command, c.stdin.slice(0, 5 * KB), { end: true })
    expect(r.stdout).not.toContain('done')
    expect(r.stdout).not.toContain(STDIN_ACK)
    expect(r.stderr).toContain('The input ended before its end line')
    expect(r.code).toBe(3)
  }, 90_000 * SLOW)
})

describe('a step whose input the remote does not confirm', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-stdin-'))
  })
  afterEach(() => removeTree(dir))

  /**
   * A stand-in ssh: reads its stdin, counts the run in a file, and prints for run N what `plan[N-1]` says: nothing (`none`),
   * only that PowerShell runs (`ready`), or that and that it has the script, then the step's output (`both`)
   */
  function fakeSsh(plan: ('none' | 'ready' | 'both')[]) {
    const counter = join(dir, 'runs.txt')
    const source = `
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(counter)}, 'x')
const run = fs.readFileSync(${JSON.stringify(counter)}, 'utf8').length
const what = ${JSON.stringify(plan)}[run - 1]
process.stdin.resume()
if (what === 'both') { process.stdout.write(${JSON.stringify(`${STDIN_READY}\n${STDIN_ACK}\n`)} + 'step output\\n'); setTimeout(() => process.exit(0), 100) }
else if (what === 'ready') { process.stdout.write(${JSON.stringify(`${STDIN_READY}\n`)}); setTimeout(() => process.exit(0), 600000) }
else setTimeout(() => process.exit(0), 600000)
`
    return { ssh: fakeExe(dir, 'ssh', source), runs: () => (existsSync(counter) ? readFileSync(counter, 'utf8').length : 0) }
  }

  const framed = (): Framed => framedCommand(script(10 * KB))
  const tunnel = (ssh: string) =>
    new SshTunnel({ target: 'ijun1', ssh, env: process.env, stdinReadyMs: 3_000 * SLOW, stdinAckMs: 400 * SLOW, execTimeoutMs: 600_000 })

  it('fails when PowerShell never says it runs, naming that, and does not send the step again', async () => {
    const { ssh, runs } = fakeSsh(['none', 'none'])
    const t = new SshTunnel({ target: 'ijun1', ssh, env: process.env, stdinReadyMs: 400 * SLOW, stdinAckMs: 400 * SLOW, execTimeoutMs: 600_000 })
    const at = Date.now()
    await expect(t.exec(framed())).rejects.toThrow(/ijun1 did not start this step's PowerShell within \d+ seconds .*so nothing ran/)
    expect(Date.now() - at).toBeLessThan(20_000 * SLOW)
    expect(runs()).toBe(1)
    await t.close()
  }, 60_000 * SLOW)

  it('fails within the confirmation time, not the step limit, when PowerShell runs but the input never arrives; it was sent twice', async () => {
    const { ssh, runs } = fakeSsh(['ready', 'ready'])
    const t = tunnel(ssh)
    const at = Date.now()
    await expect(t.exec(framed())).rejects.toThrow(/PowerShell on ijun1 did not confirm within \d+ seconds? that it had read this step's input, so the step did not start, twice/)
    expect(Date.now() - at).toBeLessThan(20_000 * SLOW)
    expect(runs()).toBe(2)
    await t.close()
  }, 60_000 * SLOW)

  it('sends the step once more when the input did not arrive the first time, and answers the second without the reader\'s lines', async () => {
    const { ssh, runs } = fakeSsh(['ready', 'both'])
    const t = tunnel(ssh)
    const r = await t.exec(framed())
    expect(r.stdout.trim()).toBe('step output')
    expect(runs()).toBe(2)
    await t.close()
  }, 60_000 * SLOW)

  it('waits for nothing from a command that has no script on stdin', async () => {
    const { ssh, runs } = fakeSsh(['none'])
    const t = new SshTunnel({ target: 'ijun1', ssh, env: process.env, stdinReadyMs: 100 * SLOW, stdinAckMs: 100 * SLOW, execTimeoutMs: 600_000 })
    // The stand-in ssh never answers; the run ends at the step's own limit, here short
    const quick = new SshTunnel({ target: 'ijun1', ssh, env: process.env, execTimeoutMs: 1_500 * SLOW })
    await expect(quick.exec('true')).rejects.toThrow(/did not finish within/)
    expect(runs()).toBe(1)
    await quick.close()
    await t.close()
  }, 60_000 * SLOW)
})
