import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseHostOptions } from './host-options.js'

describe('host startup boundary', () => {
  it('preserves local defaults and ephemeral ports without remote mode', () => {
    expect(parseHostOptions([], {})).toMatchObject({ port: 5175, memory: false })
    expect(parseHostOptions(['--port', '0', '--token', 'dev-token'], {})).toMatchObject({ port: 0, token: 'dev-token' })
  })
  it.each(['-1', '65536', '1.5', 'NaN'])('rejects invalid port %s before startup', (port) => {
    expect(() => parseHostOptions(['--port', port], {})).toThrow('port')
  })
  it('requires a non-argv runtime token for remote mode', () => {
    expect(() => parseHostOptions(['--web-root', 'dist'], {})).toThrow('token')
    expect(() => parseHostOptions(['--web-root', 'dist', '--token', 'x'.repeat(32)], {})).toThrow('token-file')
    expect(() => parseHostOptions(['--web-root', 'dist'], { CC_HOST_TOKEN: 'short' })).toThrow('32')
    expect(parseHostOptions(['--web-root', 'dist', '--host-label', 'Build host'], { CC_HOST_TOKEN: 'x'.repeat(32) })).toMatchObject({ hostLabel: 'Build host', webRoot: 'dist' })
  })
  it('reads a token file without putting its contents in an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'centralu-options-'))
    try {
      const file = join(dir, 'token')
      writeFileSync(file, 'x'.repeat(32) + '\n')
      expect(parseHostOptions(['--web-root', 'dist', '--token-file', file], {}).token).toBe('x'.repeat(32))
      expect(() => parseHostOptions(['--token-file', join(dir, 'missing')], {})).toThrow('Cannot read token file')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
