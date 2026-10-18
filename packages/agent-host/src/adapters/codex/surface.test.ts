import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { baselineSource, compareSurface } from '../surface-drift.js'
import { CODEX_KNOWN_NOTIFICATIONS } from './known-notifications.js'
import { CODEX_LIMITATIONS, CODEX_SURFACE, readCodexSurface } from './surface.js'
import { SURFACE_BASELINE } from './surface-baseline.js'

const fixture = (name: string) => readFileSync(new URL(`../surface-fixtures/codex-0.163.0-${name}`, import.meta.url), 'utf8')

// Recorded 2026-10-18 from codex-cli 0.163.0: three files of `codex app-server generate-ts`, --version and --help
const recorded = {
  'codex --version': 'codex-cli 0.163.0\n',
  'codex --help': fixture('help.txt'),
  'ClientRequest.ts': fixture('ClientRequest.ts.txt'),
  'ServerNotification.ts': fixture('ServerNotification.ts.txt'),
  'ServerRequest.ts': fixture('ServerRequest.ts.txt'),
}
const surface = readCodexSurface(recorded)
const protocolContract = JSON.parse(readFileSync(new URL('./protocol-contract.json', import.meta.url), 'utf8')) as {
  clientRequests: string[]
  serverNotifications: string[]
  serverRequests: string[]
}

describe('the Codex surface', () => {
  it('names the CLI it was read from', () => {
    expect(surface.version).toBe('codex-cli 0.163.0')
  })

  it("reads the requests the adapter can make as commands, the ones it sends among them", () => {
    expect(surface.offered.command).toHaveLength(108)
    expect(surface.offered.command).toEqual(expect.arrayContaining(protocolContract.clientRequests))
  })

  it('reads what the app-server can send, notifications and server requests both, as messages', () => {
    expect(surface.offered.message).toHaveLength(97)
    expect(surface.offered.message).toEqual(expect.arrayContaining([...protocolContract.serverNotifications, ...protocolContract.serverRequests]))
  })

  it('reads the CLI flags and subcommands as capabilities', () => {
    expect(surface.offered.capability).toEqual(expect.arrayContaining(['subcommand:app-server', 'flag:--config']))
  })

  it('throws when a generated file is missing, rather than reading an empty surface', () => {
    const { ['ServerRequest.ts']: _gone, ...rest } = recorded
    expect(() => readCodexSurface(rest)).toThrow(/needs ServerRequest\.ts/)
  })

  it('is what the adapter declares in the contract', () => {
    expect(CODEX_SURFACE.read).toBe(readCodexSurface)
    expect(CODEX_SURFACE.limitations).toBe(CODEX_LIMITATIONS)
  })
})

describe('what the Codex adapter writes down', () => {
  const notifications = new Set([...fixture('ServerNotification.ts.txt').matchAll(/"method": "([^"]+)"/g)].map((m) => m[1]!))

  /*
   * What was reviewed is accounted for. A notification Codex adds is not in the baseline until someone reviews it, so
   * it is the drift run's to report, not this test's; re-recording the baseline without sorting it fails here.
   */
  it('every notification in the reviewed baseline is mapped, ignored on purpose, or a limitation', () => {
    const limited = new Set(CODEX_LIMITATIONS.map((l) => l.name))
    const reviewed = (SURFACE_BASELINE.offered.message ?? []).filter((m) => notifications.has(m))
    expect(reviewed.length).toBeGreaterThan(80)
    expect(reviewed.filter((m) => !CODEX_KNOWN_NOTIFICATIONS.has(m) && !limited.has(m))).toEqual([])
  })

  it('a dropped notification stays out of the known set, so its first real instance is still logged', () => {
    for (const l of CODEX_LIMITATIONS.filter((x) => x.treatment === 'dropped')) expect(CODEX_KNOWN_NOTIFICATIONS.has(l.name), l.name).toBe(false)
  })

  it('every limitation on a name offered when measured is still offered by the recorded surface', () => {
    expect(compareSurface(surface, CODEX_LIMITATIONS).filter((f) => f.sort === 'stale')).toEqual([])
  })

  it('the baseline is in the form drift:surface --record writes', () => {
    expect(readFileSync(new URL('./surface-baseline.ts', import.meta.url), 'utf8')).toBe(baselineSource(SURFACE_BASELINE, SURFACE_BASELINE.recorded))
  })
})
