import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { execTool } from '../packages/agent-host/src/tool-run.js'
import { alive, cleanUp, plantTreeScript, settle, treePids } from '../packages/agent-host/src/dev-services/process-tree.test-helpers.js'
import { SLOW } from './test-timing.js'

/*
 * Here rather than beside tool-run.ts: a fake tool on PATH is written with fs, `process.execPath` and `PATH`, which a test in
 * the host's source may not touch outside the OS layer (`local/os-imports`), and a new file there would grow the allowlist.
 */
const ROOT = resolve(import.meta.dirname, '..')

describe('execTool', () => {
  let dir = ''
  // Read again here, so a run that failed before it read them still has its tree ended
  const pidsOf = () => (dir ? treePids(join(dir, 'pids')) : [])
  afterEach(async (test) => {
    await cleanUp(pidsOf(), test)
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

  it('names the tool when it cannot be started, not the path it was looked for at', async () => {
    await expect(execTool('cc-no-such-tool', ['--version'], { timeoutMs: 30_000 })).rejects.toThrow(/^cc-no-such-tool could not be started \(ENOENT\)$/)
  })

  /*
   * A tool that never answers and has started a child, which started its own, both outside the tool's job on Windows
   * (`plantTreeScript`); the caller exits as soon as the limit's rejection reaches it, as a script does.
   */
  it('leaves nothing running when the caller exits on a timeout', async () => {
    fakeTool('faketool', '')
    const pidFile = join(dir, 'pids')
    const tree = plantTreeScript(dir)
    writeFileSync(
      join(dir, 'faketool.cjs'),
      [
        "const { spawn } = require('node:child_process')",
        "const { appendFileSync } = require('node:fs')",
        `spawn(process.execPath, [${JSON.stringify(tree)}, ${JSON.stringify(pidFile)}, '1'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()`,
        `appendFileSync(${JSON.stringify(pidFile)}, '2 ' + process.pid + '\\n')`,
        'setInterval(() => {}, 1000)',
      ].join('\n'),
    )
    const caller = join(dir, 'caller.mts')
    writeFileSync(
      caller,
      [
        `import { execTool } from ${JSON.stringify(pathToFileURL(join(ROOT, 'packages/agent-host/src/tool-run.ts')).href)}`,
        `await execTool('faketool', ['--version'], { timeoutMs: ${4_000 * SLOW} }).catch(() => {})`,
        'process.exit(0)',
      ].join('\n'),
    )
    await promisify(execFile)(process.execPath, ['--import', 'tsx', caller], { cwd: ROOT, env: { ...process.env }, windowsHide: true })
    const pids = treePids(pidFile)
    expect(pids).toHaveLength(3)
    // A moment for the table to show what has ended; without the wait for the stop, the tree runs on for good
    expect(await settle(() => pids.filter(alive), (left) => left.length === 0, 2_000 * SLOW)).toEqual([])
  }, 60_000 * SLOW)
})
