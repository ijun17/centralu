import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExternalAppInfo, NormalizedEvent } from '@cc/protocol'
import { runtimeViewSource } from '../../packages/agent-host/src/app-view-source.js'
import type { SessionApps } from '../../packages/agent-host/src/adapters/contract.js'
import {
  ExternalApps,
  resultText,
  type AppCallOutcome,
  type AppRef,
  type AppRunRow,
  type RunLedger,
} from '../../packages/agent-host/src/apps/external/runtime.js'
import { MANIFEST_FILE } from '../../packages/agent-host/src/apps/external/manifest.js'
import { InlineViews } from '../../packages/agent-host/src/inline-views.js'
import { SessionAppsHub } from '../../packages/agent-host/src/sessions/session-apps.js'
import { HostServer } from '../../packages/agent-host/src/transport/server.js'
import { OriginPorts, type PortBook } from '../../packages/agent-host/src/views/origin-ports.js'
import { ViewHost } from '../../packages/agent-host/src/views/view-host.js'

/**
 * Public MCP Apps servers, run unmodified inside the real host code (M4 F-3).
 *
 * The servers are official ext-apps examples as published to npm, pinned by version and by the
 * registry's sha512. They were built for other hosts. Centralu learns about them only through a
 * minimal `centralu.app.json` written here: an id, a name, and the published `--stdio` entry point.
 * Nothing in the servers or their views is changed.
 *
 * Everything on the host side is the real code the host runs (main.ts wires the same pieces):
 * the app runtime starts the server process, a session's attachment calls it through the single
 * call path, `InlineViews` decides whether the call gets a view (the screen spoof check included),
 * and `ViewHost` serves the sandbox proxy behind a per-launch secret. What is faked is the two ends:
 * the agent (the test calls the attachment the way a Claude or Codex proxy would), and the UI's
 * transport (the mock platform, with its view hooks pointed at these objects).
 */

export type PublicApp = {
  /** App id in Centralu (= folder name) */
  id: string
  /** npm package and exact version */
  pkg: string
  version: string
  /** The registry's `dist.integrity` for that version — the tarball must hash to it */
  integrity: string
  name: string
}

export const PUBLIC_APPS = {
  time: {
    id: 'basic-vanillajs',
    pkg: '@modelcontextprotocol/server-basic-vanillajs',
    version: '2.0.1',
    integrity:
      'sha512-ada8pelZQ0hUVXX/hECamIb46vucGDHOQEi8LE12EjnonFX5BvUYpCavcKZhP/0RwU7DRVthC9ZUrEj7+L38vQ==',
    name: 'Get Time (ext-apps example)',
  },
  monitor: {
    id: 'system-monitor',
    pkg: '@modelcontextprotocol/server-system-monitor',
    version: '2.0.1',
    integrity:
      'sha512-+VdtFJ5EddntRd5+e05TVhgRFMPlbTjVMVK0lsQ3lBNHHicBQuwh3BK1JMJ0wVqmpJSocmLUWiAMAhZQr6Jy/w==',
    name: 'System Monitor (ext-apps example)',
  },
} as const satisfies Record<string, PublicApp>

/**
 * Where fetched packages are kept, under the repository's (git-ignored) node_modules.
 *
 * Why not a devDependency of @cc/e2e: pnpm would install each example's runtime dependencies too,
 * the MCP SDK 2.0.0 among them, and a second `@modelcontextprotocol/core` changes what pnpm hoists.
 * The app runtime's build check (`build-app-runtime.mjs --check`) then read core 2.0.0 and failed
 * (measured). The published packages are self-contained bundles: `dist/` is all they need.
 */
const CACHE_DIR = fileURLToPath(
  new URL('../../node_modules/.cache/centralu-e2e-public-apps/', import.meta.url),
)

/**
 * The package's folder, fetched once from the registry and verified against its sha512. A copy only
 * lands in the cache after it verified, so a cached copy needs no second check. Workers racing to
 * fetch it each write a private folder and rename; the loser drops its copy.
 */
async function fetchPackage(app: PublicApp): Promise<string> {
  const dir = join(CACHE_DIR, `${app.pkg.replace('/', '+')}@${app.version}`)
  const pkgDir = join(dir, 'package')
  if (existsSync(join(pkgDir, 'dist', 'index.js'))) return pkgDir

  const url = `https://registry.npmjs.org/${app.pkg}/-/${app.pkg.split('/')[1]}-${app.version}.tgz`
  let tgz: Buffer
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    tgz = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    throw new Error(
      `Could not fetch ${app.pkg}@${app.version} (${(e as Error).message}). The compatibility e2e needs the ` +
        `network once to fetch it into ${CACHE_DIR}`,
    )
  }
  const got = `sha512-${createHash('sha512').update(tgz).digest('base64')}`
  if (got !== app.integrity)
    throw new Error(`${app.pkg}@${app.version}: tarball hash ${got} is not the pinned ${app.integrity}`)

  mkdirSync(CACHE_DIR, { recursive: true })
  const staging = `${dir}.${process.pid}.${randomUUID()}`
  mkdirSync(staging)
  try {
    writeFileSync(join(staging, 'package.tgz'), tgz)
    execFileSync('tar', ['-xzf', join(staging, 'package.tgz'), '-C', staging])
    rmSync(join(staging, 'package.tgz'))
    const { version } = JSON.parse(readFileSync(join(staging, 'package', 'package.json'), 'utf8')) as {
      version: string
    }
    if (version !== app.version)
      throw new Error(`${app.pkg}: the tarball says ${version}, pinned ${app.version}`)
    renameSync(staging, dir)
  } catch (e) {
    rmSync(staging, { recursive: true, force: true })
    if (!existsSync(join(pkgDir, 'dist', 'index.js'))) throw e
  }
  return pkgDir
}

/**
 * The whole wrapping. No `home` (the inline surface does not need one), no `view.origin`
 * (the default, opaque origin, is what is being tested), no `uses`, no `csp`. The command is the
 * package's published bin with its documented `--stdio` flag.
 */
export function wrapperManifest(app: PublicApp, pkgDir: string): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: app.id,
    name: app.name,
    version: app.version,
    description: `${app.pkg}@${app.version}, unmodified`,
    server: { command: process.execPath, args: [join(pkgDir, 'dist', 'index.js'), '--stdio'] },
  }
}

/** A run record as the in-memory ledger keeps it */
export type Run = AppRunRow
/** An MCP tool result, as the app returned it */
export type ToolResult = NonNullable<AppCallOutcome['result']>

export type PublicAppsHost = {
  views: ViewHost
  runtime: ExternalApps
  /** Point the runtime at the UI's project id (the mock chooses it) and scan the apps again */
  useProject(projectId: string): void
  /** The app list the host would broadcast — for the mock's `setExternalApps` */
  list(): ExternalAppInfo[]
  /** A session attachment, the way the session manager gives one to an adapter */
  session(sessionId: string, projectId: string): SessionApps
  /** The view's tool call, the way `apps.invoke` (rpc.ts) and `viewToolResult` (platform/web) handle it */
  callAsView(ref: AppRef, tool: string, args: Record<string, unknown>): Promise<ToolResult>
  /** Where host events (`app_view`) go; null drops them */
  forwardTo(send: ((e: NormalizedEvent) => Promise<unknown>) | null): void
  /** Run records of one app, oldest first */
  runs(ref: AppRef): Run[]
  close(): Promise<void>
}

export async function startPublicAppsHost(
  apps: readonly PublicApp[],
  allowedOrigins: readonly string[],
): Promise<PublicAppsHost> {
  const tmp = mkdtempSync(join(tmpdir(), 'cc-public-apps-'))
  const projectDir = join(tmp, 'project')
  const dataRoot = join(tmp, 'data')
  for (const app of apps) {
    const pkgDir = await fetchPackage(app)
    const dir = join(projectDir, '.centralu', 'apps', app.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(wrapperManifest(app, pkgDir), null, 2) + '\n')
  }
  mkdirSync(dataRoot, { recursive: true })

  const rows = new Map<string, Run>()
  const ledger: RunLedger = {
    begin: (row) => void rows.set(row.id, { ...row }),
    end: (id, end) => {
      const row = rows.get(id)
      if (row) Object.assign(row, end)
    },
    link: (id, sessionId) => {
      const row = rows.get(id)
      if (row) row.sessionId = sessionId
    },
    keepFailure: () => {},
    list: (projectId, appId, limit) =>
      [...rows.values()]
        .filter((r) => r.projectId === projectId && r.appId === appId)
        .reverse()
        .slice(0, limit)
        .map((r) => ({ ...r, failure: null })),
    prune: () => 0,
    settleUnfinished: () => 0,
  }

  let project: { id: string; path: string; trusted: boolean } | null = null
  const runtime = new ExternalApps({
    projects: () => (project ? [project] : []),
    dataRoot,
    reservedIds: ['control'],
    runs: ledger,
  })
  runtime.refresh()

  const secret = randomBytes(32).toString('base64url')
  let port: number | null = null
  let book: PortBook | null = null
  const views = new ViewHost({
    secret,
    allowedOrigins,
    source: runtimeViewSource(runtime),
    ports: new OriginPorts(
      { load: () => book, save: (b) => void (book = structuredClone(b)) },
      { log: () => {} },
    ),
    hostPort: () => port,
    log: () => {},
  })
  const server = new HostServer({
    port: 0,
    token: 'e2e-token',
    onRpc: async () => ({}),
    http: { secret, routes: views.routes },
  })
  port = await server.listen()

  const hub = new SessionAppsHub(runtime)
  /*
   * Events leave in the order the host made them. The mock applies each one with a page.evaluate,
   * and the `result` of a fast call must not overtake its `open`.
   */
  let send: ((e: NormalizedEvent) => Promise<unknown>) | null = null
  let queue: Promise<unknown> = Promise.resolve()
  const inline = new InlineViews({
    rt: runtime,
    views,
    hub,
    emit: (e) => {
      const to = send
      if (!to) return
      queue = queue.then(() => to(e)).catch(() => {})
    },
    log: () => {},
  })

  return {
    views,
    runtime,
    useProject(projectId) {
      project = { id: projectId, path: projectDir, trusted: true }
      runtime.refresh()
    },
    list: () => runtime.list(),
    session: (sessionId, projectId) => hub.attach({ id: sessionId, kind: 'worker', projectId }),
    async callAsView(ref, tool, args) {
      const out = await runtime.call(ref, tool, args, { kind: 'view' })
      if (out.result && Array.isArray(out.result.content)) return out.result
      return {
        content: [{ type: 'text', text: out.result ? resultText(out.result) : (out.error ?? '') }],
        isError: true,
      }
    },
    forwardTo(to) {
      send = to
    },
    runs: (ref) => [...rows.values()].filter((r) => r.projectId === ref.projectId && r.appId === ref.appId),
    async close() {
      send = null
      inline.dispose()
      hub.dispose()
      await runtime.dispose()
      await views.dispose()
      await server.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}
