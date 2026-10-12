import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeProjectFolder, projectFolderTarget, projectsHome } from './project-folder.js'

/**
 * Where a new project goes by default (#515): `~/Centralu` on every machine (owner decision, 2026-10-12), never the
 * Desktop, which macOS protects with a permission prompt. No real home is read here: the home is passed in.
 */

describe('the default location of a new project', () => {
  it('is ~/Centralu on macOS and on Linux (WSL included), whatever the Desktop is called', () => {
    expect(projectsHome('darwin', '/Users/me', {})).toBe('/Users/me/Centralu')
    // A localized XDG Desktop changes nothing: the folder is the home's own
    expect(projectsHome('linux', '/home/me', { XDG_CONFIG_HOME: '/cfg' })).toBe('/home/me/Centralu')
  })

  it('is %USERPROFILE%\\Centralu on Windows, in Windows path terms on any machine', () => {
    expect(projectsHome('win32', 'C:\\x', { USERPROFILE: 'C:\\Users\\me' })).toBe('C:\\Users\\me\\Centralu')
    // No USERPROFILE: the home Node reports
    expect(projectsHome('win32', 'C:\\Users\\me', {})).toBe('C:\\Users\\me\\Centralu')
  })
})

describe('making the folder', () => {
  it('makes ~/Centralu on first use, then the project in it', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'cc-pfold-')))
    try {
      const target = projectFolderTarget({ name: 'game' }, projectsHome(process.platform, home, { USERPROFILE: home }))
      expect(target.isDefault).toBe(true)
      makeProjectFolder(target)
      expect(readdirSync(home)).toEqual(['Centralu'])
      expect(readdirSync(join(home, 'Centralu'))).toEqual(['game'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('refuses a name taken between the check and the making, and leaves what is there alone', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-pfold-')))
    try {
      const target = projectFolderTarget({ name: 'race' }, join(root, 'Centralu'))
      // Someone makes it after the check (or while the orchestrator's card stood)
      mkdirSync(target.path, { recursive: true })
      writeFileSync(join(target.path, 'keep.txt'), 'mine')
      expect(() => makeProjectFolder(target)).toThrow(/already in/)
      expect(readdirSync(target.path)).toEqual(['keep.txt'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
