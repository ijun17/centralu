import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The bytes of an ssh error that are in the machine's ANSI code page are read with the code page `reg.exe` names
 * (`unescapeBytes`, #849). That `reg.exe` is a Windows system program: it is started by its full path under
 * `%SystemRoot%\System32` and only when `SystemRoot` is a whole path from a drive's root, the one rule every
 * system program of the host follows (`systemTool`, #428), so a planted folder cannot stand in for it.
 */

const windowsRoot = 'C:\\Windows\\System32\\reg.exe'

describe('which reg.exe reads the ANSI code page', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const systemRoot = process.env.SystemRoot
  const started: string[] = []

  beforeEach(() => {
    started.length = 0
    vi.resetModules()
    vi.doMock('node:child_process', async (original) => ({
      ...(await original<typeof import('node:child_process')>()),
      execFileSync: (file: string) => {
        started.push(file)
        return '    ACP    REG_SZ    949\r\n'
      },
    }))
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    if (systemRoot === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = systemRoot
    vi.doUnmock('node:child_process')
    vi.resetModules()
  })

  /** Bytes that are not UTF-8 (a Korean sign-in message in code page 949), so the code page is asked for */
  const needsCodePage = '\\276\\313\\267\\301'

  it.each([
    ['a share', '\\\\planted\\share'],
    ['a rooted path with no drive', '\\Windows'],
  ])('does not start it from SystemRoot as %s', async (_what, root) => {
    process.env.SystemRoot = root
    const { unescapeBytes } = await import('./tunnel.js')
    unescapeBytes(needsCodePage)
    expect(started).toEqual([windowsRoot])
  })
})
