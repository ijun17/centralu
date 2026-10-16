/**
 * An app that is gone, or never reads, while the host writes to it (docs/runtime-lessons.md HO14):
 * the write lands on a closed pipe, and a stream 'error' nobody listens to is an uncaught exception
 * that ends the host and every session. The start fails; nothing escapes.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppProcess, AppStartError } from './app-process.js'
import { SLOW } from '../../../../../tooling/test-timing.js'

async function expectStartFailsQuietly(command: string, args: string[], timing: { probeTimeoutMs: number; connectTimeoutMs: number; exitWaitMs: number }): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cc-app-epipe-'))
  const uncaught: unknown[] = []
  const onUncaught = (e: unknown) => void uncaught.push(e)
  process.on('uncaughtException', onUncaught)
  try {
    const started = AppProcess.start({
      command,
      args,
      cwd: dir,
      env: { PATH: process.env.PATH, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) },
      logPath: join(dir, 'app.log'),
      logMaxBytes: 1024 * 1024,
      redact: (t) => t,
      ...timing,
    })
    await expect(started).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 100))
    expect(uncaught.map((e) => (e as NodeJS.ErrnoException).code ?? String(e))).toEqual([])
  } finally {
    process.off('uncaughtException', onUncaught)
  }
}

describe('writing to an app that closed its stdin', () => {
  // `exec 0<&-` is a POSIX shell's; the Windows counterpart is the next test
  it.skipIf(process.platform === 'win32')('fails the start, and EPIPE never escapes as an uncaught exception', async () => {
    // Closes stdin and fd 3 at once, then lives long enough for the host's probe to be written
    await expectStartFailsQuietly('/bin/sh', ['-c', 'exec 0<&- 3>&-; sleep 1'], { probeTimeoutMs: 500, connectTimeoutMs: 1500, exitWaitMs: 1500 })
  })

  /*
   * Windows (#849). A Node app cannot close its stdin there (libuv keeps descriptors 0-2 open), so the app is Windows
   * PowerShell, which closes the handle itself through .NET. It reads the host's probe first, closes stdin, then answers
   * the probe with "method not found": the host falls back to `initialize`, a write that lands on the closed pipe
   * whenever PowerShell gets there, with no race against a timer.
   */
  it.runIf(process.platform === 'win32')('on Windows, fails the start, and EPIPE never escapes as an uncaught exception', async () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const script = [
      '$probe = [Console]::In.ReadLine() | ConvertFrom-Json',
      "$getStd = [Type]::GetType('Microsoft.Win32.Win32Native').GetMethod('GetStdHandle', [Reflection.BindingFlags]'NonPublic,Static')",
      '([Microsoft.Win32.SafeHandles.SafeFileHandle]::new($getStd.Invoke($null, @([int]-10)), $true)).Dispose()',
      "[Console]::Out.WriteLine((@{ jsonrpc = '2.0'; id = $probe.id; error = @{ code = -32601; message = 'Method not found' } } | ConvertTo-Json -Compress))",
      'Start-Sleep -Seconds 1',
    ].join('; ')
    await expectStartFailsQuietly(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { probeTimeoutMs: 60_000, connectTimeoutMs: 60_000, exitWaitMs: 5_000 })
  }, 90_000 * SLOW)
})

/** An app's crash reason (#428): its last stderr lines as it wrote them, whatever the pipe's chunks were */
describe('the stderr lines a failed start carries', () => {
  it('keeps a character split between chunks whole, and drops the carriage return of a CRLF line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-app-stderr-'))
    const script = [
      "const b = Buffer.from('실패: 한글\\r\\n')",
      'process.stderr.write(b.subarray(0, 4))',
      'setTimeout(() => { process.stderr.write(b.subarray(4)); setTimeout(() => process.exit(3), 50) }, 200)',
    ].join('; ')
    const started = AppProcess.start({
      command: process.execPath,
      args: ['-e', script],
      cwd: dir,
      env: process.env,
      logPath: join(dir, 'app.log'),
      logMaxBytes: 1024 * 1024,
      redact: (t) => t,
      probeTimeoutMs: 5000,
      connectTimeoutMs: 5000,
      exitWaitMs: 5000,
    })
    const err = (await started.catch((e: unknown) => e)) as AppStartError
    expect(err).toBeInstanceOf(AppStartError)
    expect(err.stderr).toEqual(['실패: 한글'])
  })
})

/**
 * #849: a manifest's relative command was read from the host's own folder, and on Windows an extensionless one never had
 * its `.cmd` tried: the app started everywhere but there. A `.cmd` the spawn refused threw before there was a process,
 * outside the start's own failure handling, and left the app's log open for good.
 */
describe("a manifest's command as a path in the app folder", () => {
  const appDir = () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-app-cmd-')))
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'server.js'), "process.stderr.write('ran from ' + require('node:path').basename(process.cwd()) + '\\n'); process.exit(3)\n")
    // npm's shim shape on Windows; a script that runs the same file elsewhere
    writeFileSync(join(dir, 'bin', 'server.cmd'), '@"%~dp0\\..\\server.js" %*\r\n')
    writeFileSync(join(dir, 'bin', 'server'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/../server.js" "$@"\n`)
    chmodSync(join(dir, 'bin', 'server'), 0o755)
    return dir
  }
  const start = (dir: string, command: string) =>
    AppProcess.start({
      command,
      args: [],
      cwd: dir,
      env: process.env,
      logPath: join(dir, 'logs', 'app.log'),
      logMaxBytes: 1024 * 1024,
      redact: (t) => t,
      probeTimeoutMs: 10_000,
      connectTimeoutMs: 10_000,
      exitWaitMs: 10_000,
    })

  it('starts bin/server from the app folder, its .cmd on Windows', async () => {
    const dir = appDir()
    const err = (await start(dir, 'bin/server').catch((e: unknown) => e)) as AppStartError
    expect(err).toBeInstanceOf(AppStartError)
    expect(err.head).toBe('exited before it was ready (code 3)')
    expect(err.stderr).toEqual([`ran from ${basename(dir)}`])
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }, 30_000 * SLOW)

  it.runIf(process.platform === 'win32')('on Windows, starts a relative .cmd shim from the app folder', async () => {
    const dir = appDir()
    const err = (await start(dir, '.\\bin\\server.cmd').catch((e: unknown) => e)) as AppStartError
    expect(err).toBeInstanceOf(AppStartError)
    expect(err.stderr).toEqual([`ran from ${basename(dir)}`])
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }, 30_000 * SLOW)

  it.runIf(process.platform === 'win32')('on Windows, a .cmd that is not a shim fails the start with the reason, and lets go of the log', async () => {
    const dir = appDir()
    writeFileSync(join(dir, 'run.cmd'), '@echo run\r\n')
    const err = (await start(dir, './run.cmd').catch((e: unknown) => e)) as AppStartError
    expect(err).toBeInstanceOf(AppStartError)
    expect(err.message).toMatch(/EINVAL.*needs a shell/)
    expect(readFileSync(join(dir, 'logs', 'app.log'), 'utf8')).toMatch(/could not run .*run\.cmd/)
    // Windows refuses to delete a file that is still open: the log is closed, with no retries to wait it out
    rmSync(join(dir, 'logs'), { recursive: true })
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }, 30_000 * SLOW)
})
