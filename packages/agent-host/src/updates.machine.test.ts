import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTree, tempRoot } from './temp-dir.test-helpers.js'
import { realUpdateService, UpdateService } from './updates.js'

/** What reached the machine through the process runner (a process the service started), the folder the installed copy is taken to be in, and the version a program that reads it prints */
const reached = vi.hoisted(() => ({ calls: [] as string[], copy: '', version: '' }))
// The installed copy is a folder of the test's, whose version a program prints (a platform's own way of reading one is not what is tested)
vi.mock('./os.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./os.js')>()),
  installedCopyPath: () => reached.copy,
  installedCopyVersionSource: () => ({ kind: 'plutil' as const, args: ['copy-version'] }),
}))
vi.mock('./os/exec.js', () => ({
  execText: async (file: string, args: string[]) => {
    reached.calls.push(`${file} ${args.join(' ')}`)
    // An install that worked, whose global package then cannot be read: what is asked is what the test is about
    if (args.includes('root')) throw new Error('this test reads no global package')
    return { stdout: '', stderr: '' }
  },
  execTextSync: (file: string, args: string[]) => {
    // The one program of this test that answers: the installed copy's version
    if (args[0] === 'copy-version') return { stdout: reached.version, stderr: '' }
    reached.calls.push(`${file} ${args.join(' ')}`)
    throw new Error('this test reaches no process')
  },
}))

const fetched = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ version: '9999.0.0' })))
beforeEach(() => {
  reached.calls.length = 0
  fetched.mockClear()
  vi.stubGlobal('fetch', fetched)
})
afterEach(() => vi.unstubAllGlobals())

describe('the machine of the update service (#2299)', () => {
  it('a service built with nothing of the machine reaches none of it: the real registry and npm are not its defaults', async () => {
    // @ts-expect-error — the machine's five seams are required, so this is also a type error (`pnpm typecheck`; with defaults again the directive is unused)
    const bare = new UpdateService(() => {}, {})
    await bare.check(true).catch(() => {})
    bare.stop()
    expect(fetched).not.toHaveBeenCalled()
    expect(reached.calls).toEqual([])
  })

  it('realUpdateService, the host’s, is wired to the real ones: the registry for a check, npm for an install, then npm for the global package', async () => {
    const updates = realUpdateService(() => {})
    expect(await updates.check(true)).toMatchObject({ latest: '9999.0.0', newer: true })
    expect(fetched).toHaveBeenCalledTimes(1)
    expect(String(fetched.mock.calls[0]?.[0])).toMatch(/registry\.npmjs\.org\/centralu\/latest/)
    await updates.apply()
    // `installGlobal` asks for the global package right after the install: npm root -g
    await vi.waitFor(() => expect(reached.calls.some((c) => /\broot -g\b/.test(c))).toBe(true))
    const install = reached.calls.findIndex((c) => /\bi -g\b.*centralu@9999\.0\.0/.test(c))
    expect(install).toBeGreaterThanOrEqual(0)
    expect(install).toBeLessThan(reached.calls.findIndex((c) => /\broot -g\b/.test(c)))
    updates.stop()
  })

  it('realUpdateService reads the installed copy and its version where the host keeps them: an older copy is brought up to the host, a newer one is left, none is not looked for', async () => {
    const copy = tempRoot('cc-machine-copy-')
    const run = async (at: string, version: string) => {
      reached.calls.length = 0
      reached.copy = at
      reached.version = version
      const updates = realUpdateService(() => {}, { current: '0.1.0' })
      await updates.followHost()
      updates.stop()
      return reached.calls.filter((c) => /\bi -g\b/.test(c))
    }
    try {
      // The copy is found (installedCopy) and its version is older than this host's (installedCopyVersion): npm installs this host's version
      expect(await run(copy, '0.0.1')).toEqual([expect.stringMatching(/centralu@0\.1\.0/)])
      // Its version is newer: nothing to do, which a version read as unknown would not give
      expect(await run(copy, '9999.0.0')).toEqual([])
      // No copy at that place
      expect(await run(`${copy}-gone`, '0.0.1')).toEqual([])
    } finally {
      await removeTree(copy)
    }
  })
})
