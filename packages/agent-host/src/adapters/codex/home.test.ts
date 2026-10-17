import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexHome } from './home.js'

describe('codexHome', () => {
  it('is CODEX_HOME when it is set, trimmed', () => {
    expect(codexHome({ CODEX_HOME: ' /tmp/codex ' }, '/home/me')).toBe('/tmp/codex')
  })

  it('is ~/.codex when CODEX_HOME is unset or blank', () => {
    expect(codexHome({}, '/home/me')).toBe(join('/home/me', '.codex'))
    expect(codexHome({ CODEX_HOME: '  ' }, '/home/me')).toBe(join('/home/me', '.codex'))
  })
})
