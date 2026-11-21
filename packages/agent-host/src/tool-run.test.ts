import { afterEach, describe, expect, it, vi } from 'vitest'
import { execTool } from './tool-run.js'
import { realOs } from './os/real.js'
import { removeTree, tempRoot } from './temp-dir.test-helpers.js'
import { fakeTool } from './fake-exe.test-helpers.js'
import { alive, cleanUp, plantTreeScript, settle, treePids } from './dev-services/process-tree.test-helpers.js'
import { SLOW } from '../../../tooling/test-timing.js'

const { files, paths, processes, env } = realOs()
const { join, resolve, delimiter } = paths.path
const ROOT = resolve(import.meta.dirname, '../../..')

describe('execTool', () => {
  let dir = ''
  // Read again here, so a run that failed before it read them still has its tree ended
  const pidsOf = () => (dir ? treePids(join(dir, 'pids')) : [])
  afterEach(async (test) => {
    await cleanUp(pidsOf(), test)
    if (dir) await removeTree(dir)
    dir = ''
  })

  /** A tool `fakeTool` writes into this test's folder, first on PATH */
  function toolOnPath(name: string, js: string): void {
    dir ||= tempRoot('cc-tool-run-')
    vi.stubEnv('PATH', `${fakeTool(dir, name, js)}${delimiter}${env.get('PATH') ?? ''}`)
  }

  it('asks the tool found on PATH, with the arguments after its own', async () => {
    toolOnPath('faketool', "process.stdout.write(JSON.stringify(process.argv.slice(2)))")
    expect(JSON.parse((await execTool('faketool', ['--version'], { timeoutMs: 30_000 * SLOW })).stdout)).toEqual(['--version'])
  })

  it('names the tool in a failure, not the Node its shim runs', async () => {
    toolOnPath('faketool', "process.stderr.write('not signed in'); process.exit(3)")
    await expect(execTool('faketool', ['auth', 'status'], { timeoutMs: 30_000 * SLOW })).rejects.toThrow(/^faketool exited 3: not signed in$/)
  })

  it('names the tool when it cannot be started, not the path it was looked for at', async () => {
    await expect(execTool('cc-no-such-tool', ['--version'], { timeoutMs: 30_000 * SLOW })).rejects.toThrow(/^cc-no-such-tool could not be started \(ENOENT\)$/)
  })

  /*
   * A tool that never answers and has started a child, which started its own, both outside the tool's job on Windows
   * (`plantTreeScript`); the caller exits as soon as the limit's rejection reaches it, as a script does.
   */
  it('leaves nothing running when the caller exits on a timeout', async () => {
    dir = tempRoot('cc-tool-run-')
    const pidFile = join(dir, 'pids')
    const tree = plantTreeScript(dir)
    toolOnPath(
      'faketool',
      [
        "const { spawn } = require('node:child_process')",
        "const { appendFileSync } = require('node:fs')",
        `spawn(process.execPath, [${JSON.stringify(tree)}, ${JSON.stringify(pidFile)}, '1'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()`,
        `appendFileSync(${JSON.stringify(pidFile)}, '2 ' + process.pid + '\\n')`,
        'setInterval(() => {}, 1000)',
      ].join('\n'),
    )
    const caller = join(dir, 'caller.mts')
    files.writeFileSync(
      caller,
      [
        `import { execTool } from ${JSON.stringify(paths.toFileUrl(join(import.meta.dirname, 'tool-run.ts')).href)}`,
        `await execTool('faketool', ['--version'], { timeoutMs: ${4_000 * SLOW} }).catch(() => {})`,
        'process.exit(0)',
      ].join('\n'),
    )
    const ran = await processes.run(env.execPath, ['--import', 'tsx', caller], { cwd: ROOT, timeoutMs: 60_000 * SLOW })
    expect(ran.code, ran.stderr.toString()).toBe(0)
    const pids = treePids(pidFile)
    expect(pids).toHaveLength(3)
    // A moment for the table to show what has ended; without the wait for the stop, the tree runs on for good
    expect(await settle(() => pids.filter(alive), (left) => left.length === 0, 2_000 * SLOW)).toEqual([])
  }, 120_000 * SLOW)
})
