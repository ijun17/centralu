import { describe, expect, it } from 'vitest'
import { DEFAULT_FILE_ICON, iconForFile } from './fileIcon.js'

/**
 * This table is a hardcoded list — which is why **what happens when it falls behind** matters most
 * of all. An unknown extension turning into a blank would break the list, but falling back to the
 * default icon keeps it looking fine.
 */
describe('iconForFile', () => {
  it('uses its own icon for a known extension', () => {
    expect(iconForFile('App.tsx')).not.toBe(DEFAULT_FILE_ICON)
    expect(iconForFile('main.rs')).not.toBe(DEFAULT_FILE_ICON)
    expect(iconForFile('logo.svg')).not.toBe(DEFAULT_FILE_ICON)
  })

  it('shares one icon within the same family', () => {
    expect(iconForFile('a.jpg')).toBe(iconForFile('b.png'))
    expect(iconForFile('a.yml')).toBe(iconForFile('b.yaml'))
    expect(iconForFile('a.ts')).toBe(iconForFile('b.mts'))
  })

  it('falls back to the default file icon for an extension it has never seen — never a blank', () => {
    expect(iconForFile('main.zig')).toBe(DEFAULT_FILE_ICON)
    expect(iconForFile('page.astro')).toBe(DEFAULT_FILE_ICON)
  })

  it('falls back to the default file icon when there is no extension', () => {
    expect(iconForFile('LICENSE')).toBe(DEFAULT_FILE_ICON)
    expect(iconForFile('Makefile')).toBe(DEFAULT_FILE_ICON)
    expect(iconForFile('weird.')).toBe(DEFAULT_FILE_ICON)
  })

  it('identifies things by name itself — not caught by an extension', () => {
    expect(iconForFile('Dockerfile')).not.toBe(DEFAULT_FILE_ICON)
    expect(iconForFile('.gitignore')).not.toBe(DEFAULT_FILE_ICON)
    // A leading dot is not an extension
    expect(iconForFile('.env')).toBe(DEFAULT_FILE_ICON)
  })

  it('is case-insensitive — README.MD is markdown too', () => {
    expect(iconForFile('README.MD')).toBe(iconForFile('readme.md'))
    expect(iconForFile('DOCKERFILE')).toBe(iconForFile('Dockerfile'))
  })

  it('uses the last one when there are multiple dots', () => {
    expect(iconForFile('types.d.ts')).toBe(iconForFile('x.ts'))
  })
})
