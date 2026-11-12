import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { hasPs } from '../os.js'
import { environValue, environmentValues, psEnvironmentValues } from './process-env.js'
import { SLOW } from '../../../../tooling/test-timing.js'

/**
 * Reading one variable of another process's environment (#1898). An environment holds secrets: a session's credential
 * rides in it, so only the asked variable's value may come out, whatever else is there.
 */
describe('environValue (/proc/<pid>/environ)', () => {
  const environ = ['PATH=/usr/bin', 'CC_HOST_CREDENTIAL=s3cret-credential', 'CENTRALU_OWNER_X=other', 'CENTRALU_OWNER=1a2b3c', ''].join('\0')

  it('takes the asked variable\'s value and nothing else', () => {
    expect(environValue(environ, 'CENTRALU_OWNER')).toBe('1a2b3c')
    expect(environValue(environ, 'HOME')).toBeUndefined()
  })
})

describe('psEnvironmentValues (macOS `ps -E -ww -o pid=,command=`)', () => {
  // Recorded shapes: arguments, then the environment, joined by spaces; a platform binary shows no environment at all
  const out = [
    '  501 /opt/homebrew/bin/node server.js PATH=/usr/bin CC_HOST_CREDENTIAL=s3cret-credential CENTRALU_OWNER=1a2b3c',
    '  502 /bin/sleep 30',
    '  503 node echo.js CENTRALU_OWNER=forged-in-args HOME=/Users/me CENTRALU_OWNER=d4e5f6',
    '  504 node app.js CENTRALU_OWNER_X=other',
    '',
  ].join('\n')

  it('takes only the asked variable per pid: never another variable, never a process that shows none', () => {
    const values = psEnvironmentValues(out, 'CENTRALU_OWNER')
    expect([...values]).toEqual([
      [501, '1a2b3c'],
      [503, 'd4e5f6'],
    ])
    expect(JSON.stringify([...values])).not.toContain('s3cret')
  })
})

describe('environmentValues', () => {
  it('refuses what is no variable name, as it goes into a pattern', async () => {
    await expect(environmentValues('A=B', [1])).rejects.toThrow(/not a variable name/)
  })

  /** What `execText` rejects with: the program ran and failed, and carries what it printed */
  const failure = (fields: { code: number | null; ended?: 'timeout' }, stdout: string) =>
    Object.assign(new Error('ps failed'), { stdout, stderr: '', ...fields })
  const printed = '  501 node server.js CC_HOST_CREDENTIAL=s3cret-credential CENTRALU_OWNER=1a2b3c\n'

  it('macOS: takes what `ps` printed when a listed pid ended meanwhile (it exits 1 and prints the others)', async () => {
    const values = await environmentValues('CENTRALU_OWNER', [501, 502], 'darwin', () => Promise.reject(failure({ code: 1 }, printed)))
    expect([...values]).toEqual([[501, '1a2b3c']])
  })

  it('macOS: a listing that failed rejects with why, and with nothing of what it read', async () => {
    const e: unknown = await environmentValues('CENTRALU_OWNER', 'all', 'darwin', () => Promise.reject(failure({ code: null, ended: 'timeout' }, printed))).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(Error)
    expect(JSON.stringify(e, Object.getOwnPropertyNames(e))).not.toContain('s3cret')
    expect(String(e)).toMatch(/timeout/)
  })

  it('reads nothing on Windows, where nothing needs another process\'s environment', async () => {
    expect(await environmentValues('PATH', 'all', 'win32')).toEqual(new Map())
  })

  /*
   * A real child of this test with a variable in its environment. Where there is `ps` (Linux, WSL, macOS) the value is
   * read back, and nothing else of it; on Windows nothing is read, so a marked process is never taken for ours there.
   */
  it('reads a real child\'s variable back, and only that', async () => {
    const value = `v${process.pid}x${Date.now()}`
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { ...process.env, CC_TEST_MARK: value, CC_TEST_SECRET: 's3cret' } })
    try {
      await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', reject))
      const pid = child.pid ?? 0
      const values = await environmentValues('CC_TEST_MARK', [pid, process.pid])
      expect([...values]).toEqual(hasPs() ? [[pid, value]] : [])
    } finally {
      child.kill()
    }
  }, 10_000 * SLOW)
})
