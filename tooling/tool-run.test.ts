import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { execTool } from '../packages/agent-host/src/tool-run.js'

describe('execTool', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  /** A tool on PATH, as npm puts one there: a `.cmd` shim on Windows, a shell script elsewhere */
  function fakeTool(name: string, js: string): void {
    dir = mkdtempSync(join(tmpdir(), 'cc-tool-run-'))
    writeFileSync(join(dir, `${name}.cjs`), js)
    if (process.platform === 'win32') writeFileSync(join(dir, `${name}.cmd`), `@"${process.execPath}" "%~dp0\\${name}.cjs" %*\r\n`)
    else writeFileSync(join(dir, name), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, `${name}.cjs`)}" "$@"\n`, { mode: 0o755 })
    vi.stubEnv('PATH', `${dir}${delimiter}${process.env.PATH ?? ''}`)
  }

  it('asks the tool found on PATH, with the arguments after its own', async () => {
    fakeTool('faketool', "process.stdout.write(JSON.stringify(process.argv.slice(2)))")
    expect(JSON.parse((await execTool('faketool', ['--version'], { timeoutMs: 30_000 })).stdout)).toEqual(['--version'])
  })

  it('names the tool in a failure, not the Node its shim runs', async () => {
    fakeTool('faketool', "process.stderr.write('not signed in'); process.exit(3)")
    await expect(execTool('faketool', ['auth', 'status'], { timeoutMs: 30_000 })).rejects.toThrow(/^faketool exited 3: not signed in$/)
  })
})
