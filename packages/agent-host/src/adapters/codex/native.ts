import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { HOST_PLATFORM, pathsOf, programFile, rustTarget } from '../../os.js'
import { launchFor, type ToolLaunch } from '../../tool-launch.js'

/**
 * The program a Codex app-server is started from (#568): the platform binary the npm package ships,
 * not the package's `node` wrapper around it.
 *
 * `npm i -g @openai/codex` installs `bin/codex.js`, a Node script that finds the native binary in the
 * platform package (`@openai/codex-darwin-arm64`, …), starts it with stdio inherited, and stays alive
 * forwarding signals until it exits. Measured (#561, codex-cli 0.160): an idle `codex app-server` is
 * about 160 MB, of which about 43 MB is that wrapper. Every Codex session (and every short-lived
 * client: usage, models, history, fork, delete) paid for a second process that does nothing.
 *
 * So the host does what the wrapper does: it finds the binary the same way and sets the two variables
 * the wrapper sets, then starts the binary directly. The binary reads them to say how to update it
 * (`CODEX_MANAGED_BY_<NPM|PNPM|BUN>`) and to check its install's provenance
 * (`CODEX_MANAGED_PACKAGE_ROOT`; without it, `codex doctor` reports "npm-managed launch is missing
 * package-root provenance"). It finds its own helpers (`codex-path/rg`, `codex-resources`) next to
 * itself through `codex-package.json`, so nothing else is needed.
 *
 * Anything that is not that npm layout (a Homebrew cask, a native install, a binary on PATH, a
 * wrapper whose platform package is missing) starts as before, through `launchFor`. So does
 * everything when `CC_CODEX_NATIVE=0`, the switch back to the wrapper.
 */
export type CodexLaunch = ToolLaunch & {
  /** The environment to start it with, from the host's own */
  env: (base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
}

type Deps = {
  platform: NodeJS.Platform
  arch: string
  exists: (path: string) => boolean
  read: (path: string) => string
  realpath: (path: string) => string
  launch: (path: string) => ToolLaunch
  /** The Node a `.js` entry runs under: the host's own (what `launchFor` puts first for a Windows shim) */
  node: string
  /** `CC_CODEX_NATIVE`: `0` starts the wrapper as before */
  native: boolean
}

const realDeps = (): Deps => ({
  platform: HOST_PLATFORM,
  arch: process.arch,
  exists: existsSync,
  read: (p) => readFileSync(p, 'utf8'),
  realpath: (p) => realpathSync(p),
  launch: (p) => launchFor(p),
  node: process.execPath,
  native: process.env.CC_CODEX_NATIVE !== '0',
})

/** The platform package's folder under `@openai/` for each target (bin/codex.js, `PLATFORM_PACKAGE_BY_TARGET`, codex-cli 0.160.0) */
const PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-unknown-linux-musl': 'codex-linux-x64',
  'aarch64-unknown-linux-musl': 'codex-linux-arm64',
  'x86_64-apple-darwin': 'codex-darwin-x64',
  'aarch64-apple-darwin': 'codex-darwin-arm64',
  'x86_64-pc-windows-msvc': 'codex-win32-x64',
  'aarch64-pc-windows-msvc': 'codex-win32-arm64',
}

const plain = (launch: ToolLaunch): CodexLaunch => ({ ...launch, env: (base) => base })

export function codexLaunch(command: string, deps: Deps = realDeps()): CodexLaunch {
  const launch = deps.launch(command)
  if (!deps.native) return plain(launch)
  const path = pathsOf(deps.platform)
  // The script the command runs: the one a Windows shim names (`node <script>`), or the command itself (a symlink to it)
  const script = launch.command === deps.node && launch.args.length === 1 ? launch.args[0]! : launch.args.length === 0 ? launch.command : null
  if (!script) return plain(launch)
  let real: string
  try {
    real = deps.realpath(script)
  } catch {
    return plain(launch)
  }
  if (path.basename(real) !== 'codex.js' || path.basename(path.dirname(real)) !== 'bin') return plain(launch)
  const root = path.dirname(path.dirname(real))
  try {
    const pkg = JSON.parse(deps.read(path.join(root, 'package.json'))) as { name?: unknown }
    if (pkg.name !== '@openai/codex') return plain(launch)
  } catch {
    return plain(launch)
  }
  const triple = rustTarget(deps.platform, deps.arch)
  const platformDir = triple ? PACKAGE_BY_TARGET[triple] : undefined
  if (!triple || !platformDir) return plain(launch)
  const exe = programFile('codex', deps.platform)
  /*
   * Where the wrapper's `require.resolve('<platform package>/package.json')` finds it, without loading anything:
   * npm nests it in the package's own node_modules; pnpm and a hoisting install put it beside the package (the
   * node_modules holding `@openai/codex`); older packages carried `vendor/` themselves, the wrapper's fallback.
   */
  const candidates = [
    path.join(root, 'node_modules', '@openai', platformDir, 'vendor', triple, 'bin', exe),
    path.join(path.dirname(path.dirname(root)), '@openai', platformDir, 'vendor', triple, 'bin', exe),
    path.join(root, 'vendor', triple, 'bin', exe),
  ]
  const binary = candidates.find((c) => deps.exists(c))
  if (!binary) return plain(launch)
  const manager = managedBy(root, deps)
  return {
    command: binary,
    args: [],
    env: (base) => {
      const env = { ...base }
      for (const k of MANAGED_BY) delete env[k]
      env[`CODEX_MANAGED_BY_${manager}`] = '1'
      env.CODEX_MANAGED_PACKAGE_ROOT = root
      return env
    },
  }
}

const MANAGED_BY = ['CODEX_MANAGED_BY_NPM', 'CODEX_MANAGED_BY_BUN', 'CODEX_MANAGED_BY_PNPM', 'CODEX_MANAGED_BY_VITE_PLUS']

/**
 * Which package manager installed the package, as the wrapper tells it (`detectPackageManager`), for the update
 * command Codex suggests. Bun's global folder and pnpm's `.modules.yaml` are what it looks for; with neither, npm, which
 * is also what the wrapper says when started from outside a package manager (no `npm_config_user_agent`), as the host
 * always starts it.
 */
function managedBy(root: string, deps: Pick<Deps, 'platform' | 'exists'>): 'NPM' | 'PNPM' | 'BUN' {
  const path = pathsOf(deps.platform)
  if (/[\\/]\.bun[\\/]install[\\/]global[\\/]/.test(root)) return 'BUN'
  for (let dir = path.dirname(root); ; ) {
    if (path.basename(dir) === 'node_modules' && deps.exists(path.join(dir, '.modules.yaml'))) return 'PNPM'
    const up = path.dirname(dir)
    if (up === dir) return 'NPM'
    dir = up
  }
}
