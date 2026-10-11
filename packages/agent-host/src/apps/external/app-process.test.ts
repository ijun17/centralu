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

describe.skipIf(process.platform === 'win32')('writing to an app that closed its stdin', () => {
  it('fails the start, and EPIPE never escapes as an uncaught exception', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-app-epipe-'))
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown) => void uncaught.push(e)
    process.on('uncaughtException', onUncaught)
    try {
      const started = AppProcess.start({
        command: '/bin/sh',
        // Closes stdin and fd 3 at once, then lives long enough for the host's probe to be written
        args: ['-c', 'exec 0<&- 3>&-; sleep 1'],
        cwd: dir,
        env: { PATH: process.env.PATH },
        logPath: join(dir, 'app.log'),
        logMaxBytes: 1024 * 1024,
        redact: (t) => t,
        probeTimeoutMs: 500,
        connectTimeoutMs: 1500,
        exitWaitMs: 1500,
      })
      await expect(started).rejects.toThrow()
      await new Promise((r) => setTimeout(r, 100))
      expect(uncaught.map((e) => (e as NodeJS.ErrnoException).code ?? String(e))).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })
})
