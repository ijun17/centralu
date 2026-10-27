import { z } from 'zod'
import { asObj } from '../../json-value.js'
import type { AdapterSurface, SurfaceBaseline, SurfaceInputs, ToolSurface } from '../contract.js'
import { AcpConnection } from '../acp/connection.js'
import { startToolProcess } from '../core/tool-process.js'
import { agyHome, agyPlatformKey, isInstalled } from './agent-files.js'
import { agyLaunch } from './launch.js'
import { AGY_RELEASE } from './release.js'
import { agyStderrLine } from './shape.js'
import { dataRoot } from '../../data-dir.js'

const Initialized = z.looseObject({ agentCapabilities: z.unknown().optional(), authMethods: z.array(z.looseObject({ id: z.string() })).optional() })

/** What the installed agent offers (#270): the capabilities and sign-in methods its `initialize` answers, without a session */
async function gather(): Promise<SurfaceInputs> {
  const key = agyPlatformKey()
  const archive = key ? AGY_RELEASE.archives[key] : null
  const home = agyHome(dataRoot(), AGY_RELEASE.version)
  if (!archive || !isInstalled(home, archive)) throw new Error('Antigravity is not installed by Centralu on this machine')
  const launch = agyLaunch(home, archive)
  const proc = startToolProcess({ ...launch, cwd: home.root, env: { ...process.env, ...launch.env } })
  const conn = new AcpConnection(proc, { onNotification: () => {}, onRequest: async () => null, onExit: () => {} }, 'antigravity-surface', agyStderrLine)
  let init: unknown
  try {
    init = await conn.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'centralu-surface', version: '1' } }, 60_000)
  } finally {
    await conn.dispose()
  }
  return { version: AGY_RELEASE.version, initialize: JSON.stringify(init) }
}

function capabilityNames(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prefix ? [prefix] : []
  const entries = Object.entries(asObj(value))
  if (entries.length === 0) return prefix ? [prefix] : []
  return entries.flatMap(([k, v]) => (typeof v === 'object' && v !== null ? capabilityNames(v, prefix ? `${prefix}.${k}` : k) : [prefix ? `${prefix}.${k}` : k]))
}

export function readAgySurface(inputs: SurfaceInputs): ToolSurface {
  const init = Initialized.parse(JSON.parse(inputs.initialize ?? '{}'))
  return {
    version: `antigravity-acp ${inputs.version ?? 'unknown'}`,
    offered: { capability: [...capabilityNames(init.agentCapabilities), ...(init.authMethods ?? []).map((a) => `authMethods.${a.id}`)].sort() },
  }
}

const SPIKE = 'antigravity-acp 1.4.3 on macOS arm64, 2026-10-27 (the spike behind docs/plans/antigravity-adapter.md)'

/** Recorded from the spike's `initialize` answer (frames s2), by the same reading as `readAgySurface` */
const BASELINE: SurfaceBaseline = {
  recorded: '2026-10-27',
  version: 'antigravity-acp 1.4.3',
  offered: {
    capability: [
      '_meta.antigravity.systemPrompt.append',
      '_meta.antigravity.tier',
      'auth.logout',
      'authMethods.agent-platform',
      'authMethods.gemini-api-key',
      'authMethods.oauth-business',
      'authMethods.oauth-personal',
      'loadSession',
      'mcpCapabilities.http',
      'mcpCapabilities.sse',
      'promptCapabilities.audio',
      'promptCapabilities.embeddedContext',
      'promptCapabilities.image',
      'sessionCapabilities.list',
      'sessionCapabilities.resume',
    ],
  },
}

export const AGY_SURFACE: AdapterSurface = {
  gather,
  read: readAgySurface,
  limitations: [
    ...(['authMethods.oauth-business', 'authMethods.gemini-api-key', 'authMethods.agent-platform'] as const).map((name) => ({
      kind: 'capability' as const,
      name,
      treatment: 'blocked' as const,
      measured: `${SPIKE}: offered at initialize; each takes keys or project settings, not a browser`,
      offeredWhenMeasured: true,
      note: 'Only "Log in with Google" (oauth-personal) is offered, through Centralu\'s own sign-in. The others wait for a screen that takes their settings.',
    })),
    {
      kind: 'capability',
      name: '_meta.antigravity.systemPrompt.append',
      treatment: 'blocked',
      measured: `${SPIKE}: offered at initialize, not tried`,
      offeredWhenMeasured: true,
      note: "Centralu's role text is not passed yet (roleText: false), so Antigravity is not the orchestrator, a coordinator or an app's agent.",
    },
    {
      kind: 'capability',
      name: 'auth.logout',
      treatment: 'blocked',
      measured: `${SPIKE}: offered at initialize, not called`,
      offeredWhenMeasured: true,
      note: 'No sign-out in the first beta (owner 2026-10-27: no Settings row for account or sign-out).',
    },
  ],
  baseline: BASELINE,
}
