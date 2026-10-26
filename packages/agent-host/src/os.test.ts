import { describe, expect, it } from 'vitest'
import { commandInterpreter, openCodeMatchesAnyCase, systemSettingsFolder, systemTool } from './os.js'

/**
 * Windows looks a relative program path up in the working directory first, and the host works in a project's folder:
 * a system program has to be named by a whole path. An empty `SystemRoot` made taskkill's `System32\taskkill.exe`
 * relative (#428).
 */
describe('a Windows system program', () => {
  it('is under %SystemRoot%\\System32 when SystemRoot is a whole path from a drive', () => {
    expect(systemTool(['taskkill.exe'], { SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\taskkill.exe')
    expect(systemTool(['WindowsPowerShell', 'v1.0', 'powershell.exe'], { SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
  })

  it.each([undefined, '', 'Windows', '.\\Windows', 'C:Windows', '\\Windows'])('never under a SystemRoot of %j, which is not one', (root) => {
    expect(systemTool(['taskkill.exe'], { SystemRoot: root })).toBe('C:\\Windows\\System32\\taskkill.exe')
  })

  it('cmd is %ComSpec% only when that is a whole path, else the one under System32', () => {
    expect(commandInterpreter({ ComSpec: 'C:\\Windows\\system32\\cmd.exe' })).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(commandInterpreter({ ComSpec: 'cmd.exe', SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(commandInterpreter({ ComSpec: '' })).toBe('C:\\Windows\\System32\\cmd.exe')
  })
})

describe('systemSettingsFolder', () => {
  it("is each OS's folder for every user's settings", () => {
    expect(systemSettingsFolder('opencode', { ProgramData: 'D:\\Data' }, 'win32')).toBe('D:\\Data\\opencode')
    expect(systemSettingsFolder('opencode', {}, 'win32')).toBe('C:\\ProgramData\\opencode')
    expect(systemSettingsFolder('opencode', {}, 'darwin')).toBe('/Library/Application Support/opencode')
    expect(systemSettingsFolder('opencode', {}, 'linux')).toBe('/etc/opencode')
  })
})

describe('openCodeMatchesAnyCase', () => {
  it('is Windows only, as OpenCode 1.19.4 builds its match', () => {
    expect(openCodeMatchesAnyCase('win32')).toBe(true)
    expect(openCodeMatchesAnyCase('darwin')).toBe(false)
    expect(openCodeMatchesAnyCase('linux')).toBe(false)
  })
})
