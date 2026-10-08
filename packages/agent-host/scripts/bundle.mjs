/**
 * F-0: bundles agent-host into a shippable form.
 *
 * Approach decision (F-0a): **run on the system Node**.
 *   Node SEA would require bundling `.node` separately plus re-signing after injection, because of
 *   better-sqlite3 (a native addon) — too much cost for what dogfooding needs. If the deployment
 *   target broadens later, only this file needs to change to switch to SEA.
 *
 * Output (apps/desktop/src-tauri/resources/host/):
 *   main.mjs                     — the bundled host (only better-sqlite3 kept external)
 *   schema.sql                   — the store looks for this next to the bundle
 *   codex-orchestrator-bridge.mjs — codex launches this directly with node (bundled with `ws` inside)
 *   node_modules/better-sqlite3  — the native addon (only the files needed)
 *   remote-runtime.json          — the Node a remote this host installs runs, pinned (scripts/node-pin.mjs)
 *   remote-install.mjs           — the installer's step a remote runs on that Node (links/install.ts)
 */
import { build } from 'esbuild'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const OUT = join(ROOT, 'apps/desktop/src-tauri/resources/host')

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// 1) JS bundle — native addons cannot be bundled, so they are kept external
/**
 * **Makes the build output state which commit it came from, on its own.**
 *
 * During dogfooding, answering "which commit is the running app" required matching the binary's
 * mtime against commit times — a guess, and one that breaks the moment it is rebuilt. Embedded in
 * the first line of the startup log instead. The build continues even if git is absent or fails
 * ('unknown' is better than a failed build).
 */
function buildId() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return 'unknown'
  }
}

await build({
  entryPoints: [join(ROOT, 'packages/agent-host/src/main.ts')],
  outfile: join(OUT, 'main.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['better-sqlite3', 'node-pty'],
  // Resolves the workspace alias to source (bundles directly, without a build step)
  alias: {
    '@cc/protocol': join(ROOT, 'packages/protocol/src/index.ts'),
  },
  define: {
    __CC_BUILD__: JSON.stringify(buildId()),
  },
  banner: {
    // Lets the ESM bundle load a CJS dependency (better-sqlite3) via require
    js: "import { createRequire as __cr } from 'node:module';const require = __cr(import.meta.url);",
  },
  logLevel: 'warning',
})

// 2) Bundle the schema — store.ts checks next to the build output first
cpSync(join(ROOT, 'packages/protocol/src/schema/schema.sql'), join(OUT, 'schema.sql'))
/*
 * The stdio bridge for the Codex orchestrator. Codex launches it directly with `node <path>`, so it
 * stays one plain `.mjs` file next to the host, but it is **bundled**, with `ws` inside.
 *
 * It used to be copied as is, and its `import { WebSocket } from 'ws'` then had nothing to resolve
 * against: the host folder carries `node_modules` only for the two native addons. Measured while
 * building #280 step 3: `node resources/host/codex-orchestrator-bridge.mjs` died at once with
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'`. From source it worked, because the workspace's
 * `node_modules` was up the tree, which is why nothing caught it; in the app (and in the keeper's
 * per-build copy) every Codex orchestrator tool call would have failed to start its bridge.
 * `ws`'s two optional speed-ups are left out: it loads them in a try/catch and runs without them.
 */
await build({
  entryPoints: [join(ROOT, 'packages/agent-host/src/adapters/codex/orchestrator-bridge.mjs')],
  outfile: join(OUT, 'codex-orchestrator-bridge.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module';const require = __cr(import.meta.url);",
  },
  logLevel: 'warning',
})
// The bridge has to start from the bundle alone: run it with no environment and expect its own
// "required" message, not a module error.
//
// "No environment" still keeps what Windows itself needs to start a process (#14): without
// SystemRoot, Node there fails before it runs a line (its crypto and socket setup read it), which
// would look exactly like a broken bundle. Nothing on this list can make a module resolvable, so
// a missing `ws` still fails here.
{
  const keep = ['PATH', 'SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP']
  const env = Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]))
  const r = spawnSync(process.execPath, [join(OUT, 'codex-orchestrator-bridge.mjs')], {
    cwd: OUT,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (!/are required/.test(r.stderr ?? '')) {
    throw new Error(`the bundled Codex bridge does not start on its own:\n${r.stderr}`)
  }
}
/*
 * The app template (M4 C-1) — the scaffold expanded when a new app is created. `scaffold.ts` looks
 * for it next to the build output (`app-template/`).
 *
 * The runtime (`runtime/`) is a committed generated file. **Before shipping, it is checked to match
 * its source byte for byte** — shipping after editing the runtime source but forgetting to
 * regenerate it would mean every app created afterward gets the old runtime. Since this file gets
 * committed into the app's own folder, there is no way to quietly fix it later either.
 */
execFileSync(process.execPath, [join(ROOT, 'packages/agent-host/scripts/build-app-runtime.mjs'), '--check'], { stdio: 'inherit' })
cpSync(join(ROOT, 'packages/agent-host/app-template'), join(OUT, 'app-template'), { recursive: true })

// 3) Native addon — picks out only this platform's prebuild (avoids copying all 26MB)
const pkgJson = require.resolve('better-sqlite3/package.json')
const src = dirname(pkgJson)
const dest = join(OUT, 'node_modules/better-sqlite3')
mkdirSync(dest, { recursive: true })
for (const entry of ['package.json', 'lib']) {
  cpSync(join(src, entry), join(dest, entry), { recursive: true })
}
const prebuild = `${process.platform}-${process.arch}.node`
const prebuildSrc = join(src, 'prebuilds', prebuild)
if (!existsSync(prebuildSrc)) {
  throw new Error(`no prebuild for this platform: ${prebuild} — a source build is required`)
}
mkdirSync(join(dest, 'prebuilds'), { recursive: true })
cpSync(prebuildSrc, join(dest, 'prebuilds', prebuild))

// The bindings lookup also checks the build/Release path, so it is placed there too (a defense against loader implementation differences)
mkdirSync(join(dest, 'build/Release'), { recursive: true })
cpSync(prebuildSrc, join(dest, 'build/Release/better_sqlite3.node'))

// 3-2) PTY for the terminal — also a native addon, so it is bundled the same way.
//      node-pty uses N-API, so the same prebuild works across Node versions.
const ptyPkg = require.resolve('node-pty/package.json')
const ptySrc = dirname(ptyPkg)
const ptyDest = join(OUT, 'node_modules/node-pty')
mkdirSync(ptyDest, { recursive: true })
for (const entry of ['package.json', 'lib']) {
  cpSync(join(ptySrc, entry), join(ptyDest, entry), { recursive: true })
}
/**
 * Where node-pty's native files actually are — which is not the same place on every OS.
 *
 * node-pty 1.1.0 publishes prebuilds for darwin and win32 only. On Linux its install
 * script (`node scripts/prebuild.js || node-gyp rebuild`) finds no matching prebuild,
 * falls through to a source build, and the result lands in `build/Release` instead.
 * This script used to only know about `prebuilds/`, so the Linux build died here —
 * before Tauri bundled anything, because this runs as `beforeBuildCommand` (#14).
 *
 * We check in the opposite order from node-pty's own loader (`lib/utils.js` tries
 * `build/Release` first, `prebuilds/<platform>-<arch>` second), on purpose: a prebuild
 * is what the package intends to ship, and a stale `build/Release` left over from an
 * earlier experiment should not quietly win over it. Only one of the two exists on a
 * clean checkout, so the difference only shows up on a machine that has both — which
 * is exactly the machine where guessing wrong is hardest to notice.
 *
 * A source build is safe to ship because node-pty builds against node-addon-api
 * (N-API), so the binary is ABI-stable across Node versions — the user's system Node
 * does not have to match the machine that built it. glibc still has to be old enough,
 * which is why CI pins the oldest supported runner rather than `ubuntu-latest`.
 */
const ptyPlatform = `${process.platform}-${process.arch}`
const ptyNativeDir = [join('prebuilds', ptyPlatform), join('build', 'Release')].find((rel) =>
  existsSync(join(ptySrc, rel, 'pty.node')),
)
if (!ptyNativeDir) {
  throw new Error(
    `could not find the node-pty native module (${ptyPlatform}).\n` +
      `looked in: prebuilds/${ptyPlatform}/pty.node, build/Release/pty.node\n` +
      'the source build may not have run — check whether node-pty is listed in allowBuilds in pnpm-workspace.yaml.',
  )
}
mkdirSync(join(ptyDest, ptyNativeDir), { recursive: true })
// Files are picked one by one. `build/Release` also holds node-gyp's intermediate output
// (obj.target and the like), so copying it whole would drag tens of megabytes of object files into
// the bundle.
//
// Windows (#14): on Windows 10 1809 and later node-pty loads `conpty.node`, not `pty.node`
// (lib/windowsPtyAgent.js picks ConPTY from build 18309), and `conpty_console_list.node` is what
// lets it find a shell's console processes to end them. Shipping only `pty.node` (the winpty
// binding) left the packaged terminal dead with "Failed to load native module: conpty.node".
// `conpty/` (conpty.dll and OpenConsole.exe) and winpty's agent are only used with options we do
// not pass (`useConptyDll`, or a Windows older than 1809), so they stay out.
for (const file of ['pty.node', 'spawn-helper', 'conpty.node', 'conpty_console_list.node']) {
  const from = join(ptySrc, ptyNativeDir, file)
  if (existsSync(from)) cpSync(from, join(ptyDest, ptyNativeDir, file))
}

/**
 * spawn-helper is an **executable**. If the +x bit is lost while extracting or copying, the shell
 * does not start, and only `posix_spawnp failed` is left behind (we actually hit this, and spent
 * real time tracking down the cause). The execute permission is always reset after copying.
 *
 * This has to follow whichever directory won above: node-pty resolves the helper as
 * `<the dir the module loaded from>/spawn-helper` (lib/unixTerminal.js), so guarding
 * the prebuilds path while shipping a source build would leave the real helper
 * unchecked — and a source build is exactly where the bit is most likely to be missing.
 */
const helper = join(ptyDest, ptyNativeDir, 'spawn-helper')
if (existsSync(helper)) {
  chmodSync(helper, 0o755)
  // Checked at build time — without the execute permission, the terminal is entirely dead in the
  // packaged app. This is hard to catch with a test (it needs the bundle to exist), and the
  // symptom does not point at the cause.
  const mode = statSync(helper).mode
  if (!(mode & 0o111)) {
    throw new Error(`spawn-helper has no execute permission: ${helper} — the terminal will not come up`)
  }
}

/*
 * 4) Mark the output as self-contained — host_command treats this file's existence as "prod".
 *
 * `commit` is here as well as in the startup log. The log answers "which commit is the
 * running app?" only while a host is running; this answers it for a bundle sitting on disk,
 * which is the case that actually came up — a `.app` had to be identified without launching
 * it, and the fallback was matching binary mtimes against commit times. That is a guess.
 */
/*
 * `protocolVersion` is the WebSocket protocol the bundled host speaks. The keeper (#280) records
 * it for each host it runs, so a window can see that a running host from another build speaks a
 * different protocol before it tries to talk to it. Read from the source rather than imported:
 * this script runs on plain Node, and the constant lives in TypeScript.
 */
function protocolVersion() {
  const src = readFileSync(join(ROOT, 'packages/protocol/src/envelope.ts'), 'utf8')
  const m = /export const PROTOCOL_VERSION = (\d+)/.exec(src)
  if (!m) throw new Error('could not find PROTOCOL_VERSION in packages/protocol/src/envelope.ts')
  return Number(m[1])
}

writeFileSync(
  join(OUT, 'bundle-info.json'),
  JSON.stringify(
    {
      commit: buildId(),
      protocolVersion: protocolVersion(),
      builtAt: new Date().toISOString(),
      runtime: 'system-node',
      platform: process.platform,
      arch: process.arch,
    },
    null,
    2,
  ) + '\n',
)

/*
 * The Node a remote runs (docs/plans/remote-hub.md §10.3): the version and the SHA-256 of each
 * platform's archive, from the pin `scripts/node-pin.mjs` checks against Node's signed
 * SHASUMS256.txt. A hub installing another machine sends that machine the hash for its platform, so
 * the value travels inside the hub's own host, never beside the archive it vouches for. Copied as it
 * is: `scripts/release-npm.mts` compares the bundle's copy with the pin byte for byte.
 */
cpSync(join(ROOT, 'packaging/remote-runtime.json'), join(OUT, 'remote-runtime.json'))
cpSync(join(ROOT, 'packages/agent-host/src/links/remote-install.mjs'), join(OUT, 'remote-install.mjs'))

const size = readFileSync(join(OUT, 'main.mjs')).length
console.log(
  // node-pty prints the directory, not the platform: "prebuilds/darwin-arm64" and
  // "build/Release" are the visible difference between a shipped binary and one this
  // machine compiled, and that is worth seeing in a release log.
  `[bundle] main.mjs ${(size / 1024).toFixed(0)}KB + better-sqlite3(${prebuild}) + node-pty(${ptyNativeDir}) → ${OUT}`,
)
