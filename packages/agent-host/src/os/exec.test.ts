import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SLOW } from '../../../../tooling/test-timing.js'
import { execText, type ExecFailure } from './exec.js'
import { realOs } from './real.js'

describe('execText', () => {
  it('answers the output of a program that exits 0', async () => {
    const r = await execText(process.execPath, ['-e', "process.stdout.write('out'); process.stderr.write('err')"], { timeoutMs: 30_000 })
    expect(r).toEqual({ stdout: 'out', stderr: 'err' })
  })

  it('rejects with the output of a program that exits 1, which callers still read (claude auth status)', async () => {
    const e = await execText(process.execPath, ['-e', "process.stdout.write('{\"loggedIn\":false}'); process.exit(1)"], { timeoutMs: 30_000 }).catch((x: ExecFailure) => x)
    expect(e).toBeInstanceOf(Error)
    expect(e).toMatchObject({ stdout: '{"loggedIn":false}', code: 1 })
  })

  it('rejects with the start error of a program that is not there', async () => {
    await expect(execText(join(tmpdir(), 'cc-no-such-program-for-exec-text'), [], { timeoutMs: 30_000 })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a run the limit ended, and says so', async () => {
    const e = await execText(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 500 * SLOW }).catch((x: ExecFailure) => x)
    expect(e).toMatchObject({ ended: 'timeout' })
  }, 60_000 * SLOW)

  it('goes through the OS it is given', async () => {
    const seen: string[] = []
    const os = { processes: { run: async (command: string) => (seen.push(command), { code: 0, signal: null, stdout: Buffer.from('v1\n'), stderr: Buffer.alloc(0) }) } }
    expect(await execText('tool', ['--version'], { timeoutMs: 1 }, os as unknown as ReturnType<typeof realOs>)).toEqual({ stdout: 'v1\n', stderr: '' })
    expect(seen).toEqual(['tool'])
  })
})
