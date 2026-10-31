import type { AdapterSurface, SurfaceBaseline, SurfaceInputs, ToolSurface } from '../contract.js'
import { acpCapabilities, acpInitialize } from '../acp/surface-kit.js'
import { agyHome, agyPlatformKey, isInstalled } from './agent-files.js'
import { agyLaunch } from './launch.js'
import { AGY_RELEASE } from './release.js'
import { agyStderrLine } from './shape.js'
import { dataRoot } from '../../data-dir.js'

/** What the installed agent offers (#270): the capabilities and sign-in methods its `initialize` answers, without a session */
async function gather(): Promise<SurfaceInputs> {
  const key = agyPlatformKey()
  const archive = key ? AGY_RELEASE.archives[key] : null
  const home = agyHome(dataRoot(), AGY_RELEASE.version)
  if (!archive || !isInstalled(home, archive)) throw new Error('Antigravity is not installed by Centralu on this machine')
  // `initialize` alone starts no sign-in, so no helper: an empty `BROWSER` still keeps the person's own out
  const launch = agyLaunch(home, archive, '')
  const initialize = await acpInitialize({ ...launch, cwd: home.root, env: { ...process.env, ...launch.env } }, 'antigravity-surface', agyStderrLine)
  return { version: AGY_RELEASE.version, initialize }
}

export function readAgySurface(inputs: SurfaceInputs): ToolSurface {
  return {
    version: `antigravity-acp ${inputs.version ?? 'unknown'}`,
    offered: { capability: acpCapabilities(inputs.initialize) },
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
