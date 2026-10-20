import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PS_PREAMBLE, remoteScript, SshTunnel, STDIN_ACK, STDIN_END, type RemoteCommand } from './tunnel.js'
import { fakeExe } from '../fake-exe.test-helpers.js'
import { removeTree } from '../temp-dir.test-helpers.js'
import { SLOW } from '../../../../tooling/test-timing.js'

/**
 * A script on a Windows remote's stdin (#1360). The hub's step ran `[Console]::In.ReadToEnd()`, which on a Windows 11 PC with
 * OpenSSH 9.5 never returned in 7 to 60 percent of the runs (2026-10-20, measured through a private sshd on loopback), so
 * the update stopped at the `centralu` step until ssh's 30-minute limit. The script is now framed (base64, then a line with one
 * dot) and read from the raw stream up to that line, with no wait for the end of input; the reader prints a confirmation
 * the hub waits for, so a remote that never saw its input fails in seconds, said so.
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

function framedCommand(ps: string): { command: string; stdin: string; ack?: string } {
  const c: RemoteCommand = remoteScript({ shell: 'powershell' }, { sh: '', ps })
  if (typeof c === 'string') throw new Error('expected the script to go on stdin')
  return c
}

describe('the framing of a script on stdin', () => {
  it('goes on stdin whole above 64 KB, base64 then one dot line, with a confirmation to wait for', () => {
    const c = framedCommand(script(100 * KB))
    expect(c.stdin.length).toBeGreaterThan(64 * KB)
    expect(c.stdin).toMatch(new RegExp(`^[A-Za-z0-9+/=]+\\n\\${STDIN_END}\\n$`))
    expect(c.ack).toBe(STDIN_ACK)
    // The script is what the base64 holds, preamble first
    const body = Buffer.from(c.stdin.split('\n')[0]!, 'base64').toString('utf8')
    expect(body.startsWith(PS_PREAMBLE)).toBe(true)
    expect(body).toContain("Write-Output 'done'")
  })

  it('does not read the text of stdin to its end, which Windows OpenSSH does not always deliver', () => {
    const reader = decoded(framedCommand(script(100 * KB)).command)
    expect(reader).not.toContain('ReadToEnd')
    expect(reader).not.toContain('[Console]::In')
    expect(reader).toContain('OpenStandardInput')
    expect(reader).toContain(STDIN_ACK)
  })

  it('frames the WSL step the same way', () => {
    const c = remoteScript({ shell: 'wsl', wslDistro: 'Ubuntu' }, { sh: `echo ${'x'.repeat(30 * KB)}`, ps: '' })
    if (typeof c === 'string') throw new Error('expected stdin')
    expect(c.stdin).toMatch(/\n\.\n$/)
    expect(c.ack).toBe(STDIN_ACK)
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
      child.once('close', (code) => resolve({ stdout, stderr, code }))
      if (o.end) child.stdin.end(input)
      else child.stdin.write(input)
      // The input stays open in the second case: the reader must not need its end
      const guard = setTimeout(() => child.kill(), 60_000 * SLOW)
      guard.unref()
    })
  }

  it('runs a script of 100 KB whole when the input is never closed', async () => {
    const c = framedCommand(script(100 * KB))
    const r = await runPowerShell(c.command, c.stdin, { end: false })
    expect(r.stdout).toContain(STDIN_ACK)
    expect(r.stdout).toContain(`got ${100 * KB}`)
    expect(r.stdout).toContain('done')
    expect(r.code).toBe(0)
  }, 90_000 * SLOW)

  it('runs it the same when the input is closed after the last byte', async () => {
    const c = framedCommand(script(100 * KB))
    const r = await runPowerShell(c.command, c.stdin, { end: true })
    expect(r.stdout).toContain(`got ${100 * KB}`)
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

describe('a step whose input the remote never confirms', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-stdin-'))
  })
  afterEach(() => removeTree(dir))

  /** A stand-in ssh: reads its stdin, counts the run in a file, and prints `lines[run]` (the lines, then it exits or hangs) */
  function fakeSsh(plan: { confirm: boolean[]; hang?: boolean }) {
    const counter = join(dir, 'runs.txt')
    const source = `
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(counter)}, 'x')
const run = fs.readFileSync(${JSON.stringify(counter)}, 'utf8').length
const confirm = ${JSON.stringify(plan.confirm)}[run - 1]
process.stdin.resume()
if (confirm) { process.stdout.write(${JSON.stringify(`${STDIN_ACK}\n`)}); process.stdout.write('step output\\n'); process.stdin.on('end', () => process.exit(0)); setTimeout(() => process.exit(0), 200) }
else if (${!!plan.hang}) setTimeout(() => process.exit(0), 600000)
else process.exit(0)
`
    return { ssh: fakeExe(dir, 'ssh', source), runs: () => (existsSync(counter) ? readFileSync(counter, 'utf8').length : 0) }
  }

  const command = (): { command: string; stdin: string; ack: string } => {
    const c = framedCommand(script(10 * KB))
    return { command: c.command, stdin: c.stdin, ack: STDIN_ACK }
  }

  it('fails within the confirmation time, not the step limit, naming what did not happen', async () => {
    const { ssh, runs } = fakeSsh({ confirm: [false, false], hang: true })
    const t = new SshTunnel({ target: 'ijun1', ssh, env: process.env, stdinAckMs: 400 * SLOW, execTimeoutMs: 600_000 })
    const at = Date.now()
    await expect(t.exec(command())).rejects.toThrow(/ijun1 did not confirm within \d+ seconds that it had read this step's input, so the step did not start/)
    expect(Date.now() - at).toBeLessThan(20_000 * SLOW)
    // Sent once more, since the step never started; then said
    expect(runs()).toBe(2)
    await t.close()
  }, 60_000 * SLOW)

  it('sends the step once more when the first try was not confirmed, and answers the second without the confirmation line', async () => {
    const { ssh, runs } = fakeSsh({ confirm: [false, true], hang: true })
    const t = new SshTunnel({ target: 'ijun1', ssh, env: process.env, stdinAckMs: 400 * SLOW, execTimeoutMs: 600_000 })
    const r = await t.exec(command())
    expect(r.stdout.trim()).toBe('step output')
    expect(runs()).toBe(2)
    await t.close()
  }, 60_000 * SLOW)

  it('does not wait for a confirmation for a command that has no script on stdin', async () => {
    const { ssh, runs } = fakeSsh({ confirm: [false], hang: false })
    const t = new SshTunnel({ target: 'ijun1', ssh, env: process.env, stdinAckMs: 100 * SLOW, execTimeoutMs: 10_000 * SLOW })
    const r = await t.exec('true')
    expect(r.code).toBe(0)
    expect(runs()).toBe(1)
    await t.close()
  }, 60_000 * SLOW)

  it('leaves no ssh behind when it gives up', async () => {
    const { ssh } = fakeSsh({ confirm: [false, false], hang: true })
    const t = new SshTunnel({ target: 'ijun1', ssh, env: process.env, stdinAckMs: 300 * SLOW, execTimeoutMs: 600_000 })
    await expect(t.exec(command())).rejects.toThrow(/did not confirm/)
    expect((t as unknown as { asking: Set<unknown> }).asking.size).toBe(0)
    await t.close()
  }, 60_000 * SLOW)
})
