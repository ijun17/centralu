import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
// @ts-expect-error The drift job runs this plain JavaScript module directly in Node.
import { permissionModeFindings } from '../scripts/claude-permission-probe.mjs'

type ProbeOptions = { permissionMode: string; spawnClaudeCodeProcess: (spec: { args: string[] }) => never }
const queryWith = (argv: (mode: string) => string[]) => ({ options }: { options: ProbeOptions }) =>
  options.spawnClaudeCodeProcess({ args: argv(options.permissionMode) })

describe('the permission drift probe observes SDK launch arguments without starting a CLI', () => {
  it('accepts both the old and the 0.3.295 argument encoding', () => {
    for (const argv of [(mode: string) => ['--permission-mode', mode], (mode: string) => [`--permission-mode=${mode}`]]) {
      expect(permissionModeFindings(queryWith(argv), process.env.CC_DATA_DIR)).toEqual([])
    }
  })

  it('rejects dropped, overwritten, duplicate, and bypassed modes', () => {
    for (const argv of [
      () => [],
      () => ['--permission-mode=default'],
      (mode: string) => [`--permission-mode=${mode}`, '--permission-mode=bypassPermissions'],
      (mode: string) => [`--permission-mode=${mode}`, '--dangerously-skip-permissions'],
    ]) {
      expect(permissionModeFindings(queryWith(argv), process.env.CC_DATA_DIR).length).toBeGreaterThan(0)
    }
  })

  it('reports an SDK startup failure instead of mistaking it for the probe stopping spawn', () => {
    const findings = permissionModeFindings(() => { throw new Error('SDK startup broke') }, process.env.CC_DATA_DIR)
    expect(findings).toHaveLength(6)
    expect(findings[0]).toContain('SDK startup broke')
  })

  it('passes the lockfile SDK through its real query option builder', async () => {
    const require = createRequire(new URL('../packages/agent-host/package.json', import.meta.url))
    const sdkUrl = pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href
    const sdk = await import(/* @vite-ignore */ sdkUrl)
    expect(permissionModeFindings(sdk.query, process.env.CC_DATA_DIR)).toEqual([])
  })
})
