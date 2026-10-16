/**
 * An app that is gone, or never reads, while the host writes to it (docs/runtime-lessons.md HO14):
 * the write lands on a closed pipe, and a stream 'error' nobody listens to is an uncaught exception
 * that ends the host and every session. The start fails; nothing escapes.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppProcess } from './app-process.js'

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
  }, 90_000)
})
