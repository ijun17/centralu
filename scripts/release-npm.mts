/**
 * The npm release — packs the built `.app` into the architecture package and publishes both
 * packages.
 *
 * **The default is a rehearsal.** Called without `--publish`, this stops after `npm pack`.
 * Publishing cannot be undone (npm blocks unpublish after 24 hours), so this is built to make
 * a mistake hard to make.
 *
 *   pnpm release:npm              # rehearsal — build, copy, check, pack
 *   pnpm release:npm --publish    # the real publish
 *
 * Platform coverage (#14). The platform package is always the one for the host this
 * runs on, and there is no cross-build switch. That is not laziness: every check
 * below interrogates a real artifact — the code signature, the exec bit, the machine
 * type reported by `file` — and none of those questions can be answered honestly
 * about a Linux binary from a Mac. A cross-build flag would only let us publish an
 * unverified bundle. The other host comes from CI instead — `.github/workflows/release.yml`
 * runs one job per platform.
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_NAME, APP_VERSION } from '../packages/protocol/src/brand.js'
import { checkStaged, shellToCarry, stageBundle, stageContent, type CarriedShell } from './bundle-stage.mjs'
import { resolveSigningKey, trustedKeys, verifyContent, type SigningKey } from './content-manifest.mjs'
import { hostPackageDir, hostPackageProblems, remotePlatforms, stageHostPackage } from './host-package.mjs'
import { publishStep, stillMissing, viewPublished } from './release-registry.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_ROOT = join(ROOT, 'apps/desktop/src-tauri/target/release/bundle')
const MAIN_PKG = join(ROOT, 'packaging/npm/centralu')

const publish = process.argv.includes('--publish')
const skipBuild = process.argv.includes('--skip-build')
/**
 * Publish the platform package but not the `centralu` shim.
 *
 * Needed because the shim pins its platform packages to an exact version, so it can
 * only go out once *every* platform is already on the registry at that version. With
 * more than one platform that is no longer a single run on a single machine: Linux is
 * published from CI, macOS from a Mac, and whoever goes last publishes the shim.
 */
const platformOnly = process.argv.includes('--platform-only')
/**
 * Publish the `centralu` shim and nothing else.
 *
 * The other half of `--platform-only`, and the reason the two exist at all: with the
 * platforms spread across machines, the "platform packages first, shim last" order has to
 * hold *across separate runs*. Whoever goes last publishes the shim — and once that is a
 * workflow rather than a person (`.github/workflows/release.yml`), "last" is its own job
 * that starts only after every platform job succeeded.
 *
 * This is the one mode with no host requirement. The shim ships `bin/centralu.mjs` and
 * nothing else: no bundle to build, no artifact to interrogate, so no reason to care which
 * machine runs it. The registry check below is still what enforces the ordering for real.
 */
const shimOnly = process.argv.includes('--shim-only')
// `fail` is a hoisted function declaration, so it is callable from here.
if (platformOnly && shimOnly) fail('--platform-only and --shim-only are opposites — pass one or neither.')
/**
 * An account with two-factor authentication is asked for an OTP on every publish. That prompt
 * is **interactive input**, so an automated place (an agent, CI) has no way to answer it and
 * just hangs. This is kept open so one can be supplied ahead of time instead:
 * `pnpm release:npm --publish --otp=123456`
 */
const otp = process.argv.find((a) => a.startsWith('--otp='))?.slice('--otp='.length)
/**
 * Whether a prerelease should also be reachable through `npm i -g centralu` (the default
 * install, with no tag).
 *
 * If there is not a single stable release yet, the `latest` tag is empty and that command
 * **fails outright** — "No matching version found for centralu@latest". This is turned on
 * while only betas exist. It must not stay on once a stable release ships (a beta would then
 * shadow the stable one).
 */
const alsoLatest = process.argv.includes('--also-latest')
/**
 * The content signing key (docs/plans/thin-shell.md §4), taken out of the environment before
 * anything is spawned: the verify run, `tauri build` and `npm publish` (with its lifecycle
 * scripts) all inherit this process's environment, and none of them has any business holding it.
 * `_NEXT` is never used here (rotation swaps the secrets) and is dropped for the same reason.
 */
const contentSigningPem = process.env.CONTENT_SIGNING_KEY
delete process.env.CONTENT_SIGNING_KEY
delete process.env.CONTENT_SIGNING_KEY_NEXT
/**
 * Fail a publish that would sign the content manifest with anything but a key in
 * `packaging/shell/keys.json`. `release.yml` passes it for the targets that write a manifest when it
 * publishes. Publishing by hand cannot sign for real (the key exists only as a GitHub secret), so
 * without this flag a publish signs with a throwaway key and says so.
 */
const requireContentKey = process.argv.includes('--require-content-key')

/**
 * A prerelease (`0.1.0-beta.1`) must always carry a tag — npm refuses to publish one
 * untagged. Otherwise the beta becomes `latest`, and anyone who installs without thinking
 * about it gets the beta.
 */
const tag = APP_VERSION.includes('-') ? 'beta' : 'latest'

/**
 * On Windows `npm` and `pnpm` are `.cmd` files, which Node will only start through a shell
 * (EINVAL otherwise, since the April 2024 security releases). Every argument this script
 * passes them is a fixed token or a version, so the shell's re-parsing has nothing to
 * mangle. Real executables (git) keep going without one.
 */
const viaShell = (cmd: string) => process.platform === 'win32' && (cmd === 'npm' || cmd === 'pnpm')
const sh = (cmd: string, args: string[], cwd = ROOT) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', encoding: 'utf8', shell: viaShell(cmd) })
const out = (cmd: string, args: string[], cwd = ROOT) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', shell: viaShell(cmd) }).trim()

function step(msg: string) {
  console.log(`\n\x1b[1m▶ ${msg}\x1b[0m`)
}

function fail(msg: string): never {
  console.error(`\n\x1b[31m✗ ${msg}\x1b[0m`)
  process.exit(1)
}

/**
 * Exactly one match under `dir`, or stop.
 *
 * Tauri stamps the version and the architecture into Linux bundle file names
 * (`Centralu_0.1.0-beta.2_amd64.AppImage`) and rewrites them on the way, so matching a
 * literal name would break the first time the version format changes. Reading the
 * directory instead is only safe if we refuse to guess: `target/` is never cleaned
 * between builds, so "take the first one" would happily ship last month's bundle.
 */
function soleFile(dir: string, keep: (name: string) => boolean): string {
  if (!existsSync(dir)) fail(`bundle directory is missing — did the build produce anything? ${dir}`)
  const hits = readdirSync(dir).filter(keep)
  if (hits.length === 0) fail(`no bundle found in ${dir}`)
  if (hits.length > 1) fail(`${hits.length} bundles in ${dir} — delete the stale ones: ${hits.join(', ')}`)
  return join(dir, hits[0] as string)
}

/** Read the first `n` bytes without pulling a ~100MB bundle into memory. */
function head(path: string, n: number): Buffer {
  const buf = Buffer.alloc(n)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, n, 0)
  } finally {
    closeSync(fd)
  }
  return buf
}

/**
 * The bundled host, unpacked beside the AppImage, for `centralu serve` (#82).
 *
 * The app's own copy is inside the AppImage's squashfs, which a headless server can only reach by
 * mounting it (FUSE, often missing there) or extracting it on every start. So the Linux packages
 * carry the same folder a second time, as plain files; `hostDirIn` in the launcher's platform.mjs
 * looks for it here. Taken from `src-tauri/resources/host`, which the build's `beforeBuildCommand`
 * has just written, for the same reason as the Windows target below. `dereference`: npm drops
 * symlinks from a tarball without a word.
 */
function installLinuxHost(pkgDir: string): void {
  const dest = join(pkgDir, 'host')
  rmSync(dest, { recursive: true, force: true })
  cpSync(join(ROOT, 'apps/desktop/src-tauri/resources/host'), dest, { recursive: true, dereference: true })
}

/** The files `centralu serve` cannot start without, in the unpacked Linux host */
function checkLinuxHost(pkgDir: string): void {
  for (const rel of ['host/main.mjs', 'host/bundle-info.json', 'host/node_modules/better-sqlite3/package.json', 'host/node_modules/node-pty/package.json']) {
    if (!existsSync(join(pkgDir, rel))) fail(`${rel} is missing from the package — \`centralu serve\` would not start`)
  }
  const info = JSON.parse(readFileSync(join(pkgDir, 'host/bundle-info.json'), 'utf8')) as { platform?: string; arch?: string }
  if (`${info.platform}-${info.arch}` !== HOST) fail(`the unpacked host was bundled for ${info.platform}-${info.arch}, not ${HOST}`)
  console.log('  unpacked host present (for centralu serve)')
  checkRemoteRuntime(join(pkgDir, 'host'))
}

/**
 * The pinned Node for remotes is in the host bundle, and is the pin (docs/plans/remote-hub.md §10.3).
 *
 * A hub reads this file to tell a remote which Node archive hash to accept. `bundle.mjs` copies it;
 * this catches a bundle built before the pin moved, which would send every remote a hash for another
 * Node and fail each install with a checksum error. The pin itself was checked against Node's signed
 * SHASUMS256.txt by the release's first job (`scripts/node-pin.mjs`).
 */
function checkRemoteRuntime(hostDir: string): void {
  const file = join(hostDir, 'remote-runtime.json')
  if (!existsSync(file)) fail(`${file} is missing: a hub on this build could not install Centralu on another machine`)
  if (readFileSync(file, 'utf8') !== readFileSync(join(ROOT, 'packaging/remote-runtime.json'), 'utf8')) {
    fail(`${file} differs from packaging/remote-runtime.json: the host was bundled before the Node pin moved. Run pnpm bundle:host again`)
  }
  console.log('  pinned Node for remotes present (remote-runtime.json)')
}

/** The keeper's own executable, shipped next to the window's on macOS and Linux (#440) */
const KEEPER_EXE = 'centralu-keeper'

/**
 * The keeper executable is there, executable, the right machine, and links no GUI framework.
 *
 * The last part is the reason it is a separate executable: the window's links WebKit and AppKit
 * (or webkit2gtk), and a keeper that pulled them in again would not be one that can later start
 * from outside the bundle. It is linked from a crate with no Tauri in it, so this only fails if
 * someone adds such a dependency there.
 */
function checkKeeperExe(path: string, machine: string): void {
  if (!existsSync(path)) fail(`the keeper executable is missing: ${path}`)
  const mode = statSync(path).mode
  if ((mode & 0o111) === 0) fail(`the keeper executable has no exec bit (${mode.toString(8)}): ${path}`)
  const arch = out('/usr/bin/file', ['-b', path])
  if (!arch.includes(machine)) fail(`the keeper executable is not ${machine}: ${arch}`)
  const libs =
    process.platform === 'darwin' ? out('/usr/bin/otool', ['-L', path]) : out('/usr/bin/ldd', [path])
  if (/WebKit|AppKit|webkit2gtk|gtk-3|javascriptcore/i.test(libs)) fail(`the keeper executable links a GUI framework:\n${libs}`)
  console.log(`  ${KEEPER_EXE} present, ${machine}, no GUI framework linked`)
}

/**
 * `checkKeeperExe` for the keeper inside an AppImage. The AppImage runtime extracts by itself
 * (`--appimage-extract <pattern>`, into `squashfs-root/` of the working folder) without FUSE, so
 * this runs on any runner that can build one. The folder is under `target/`, removed afterwards.
 */
function checkKeeperInAppImage(appImage: string, machine: string): void {
  const dir = join(ROOT, 'apps/desktop/src-tauri/target/release/keeper-check')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  execFileSync(appImage, ['--appimage-extract', `usr/bin/${KEEPER_EXE}`], { cwd: dir, stdio: 'ignore' })
  checkKeeperExe(join(dir, 'squashfs-root/usr/bin', KEEPER_EXE), machine)
  rmSync(dir, { recursive: true, force: true })
}

type Target = {
  /** npm package suffix (`centralu-<id>`) *and* the `packaging/npm/` directory name */
  id: string
  /** `tauri build --bundles` override; omitted where tauri.conf.json already names the right targets */
  bundles?: string
  /** `tauri build --no-bundle`: what ships is the compiled exe itself, not any installer */
  noBundle?: true
  /**
   * The root scripts that stand in for `pnpm verify` on this host. Omitted means `verify`
   * itself; anything shorter has to say in its comment why, and where the rest runs.
   */
  verify?: string[]
  /**
   * Put the macOS shell and the signed content (the keeper and the host, with a signed manifest)
   * into the copied bundle (docs/plans/thin-shell.md §4, §10.2; `scripts/bundle-stage.mts`). The
   * content is made from what the bundle carries: its `Contents/MacOS/centralu-keeper` (the bundled
   * one, not cargo's, because the bundler signs it and so changes its bytes) and its host.
   */
  stagesShell?: true
  /** the name the artifact takes inside the npm package — fixed, so the launcher can find it */
  artifact: string
  /** locate what the build just produced */
  locate: () => string
  /** copy it into the package directory, keeping whatever makes it runnable */
  install: (src: string, dest: string) => void
  /** prove the copied artifact is intact, executable, and the right machine */
  check: (dest: string) => void
}

const TARGETS: Record<string, Target | undefined> = {
  'darwin-arm64': {
    id: 'darwin-arm64',
    /*
     * Only the `.app`, even though the config also builds a `.dmg`. Same rule as Linux —
     * a release builds what it publishes and nothing else — but here it also removes a
     * failure mode from the release path: Tauri's `bundle_dmg.sh` drives Finder through
     * `osascript`, and a shell with no GUI session behind it is denied Automation access
     * and exits 64. That would fail a release whose `.app` was already built and signed.
     * The `.dmg` is still built in CI, where a break in it should be visible.
     */
    bundles: 'app',
    stagesShell: true,
    artifact: `${APP_NAME}.app`,
    locate: () => join(BUNDLE_ROOT, 'macos', `${APP_NAME}.app`),
    install: (src, dest) => {
      rmSync(dest, { recursive: true, force: true })
      // ditto, not cp — carries over permissions and extended attributes unchanged (so the
      // signature does not break).
      sh('/usr/bin/ditto', [src, dest])
    },
    check: (dest) => {
      // (a) Is the signature intact — confirmed it survives a round trip through an npm
      // tarball, but that is pointless if it was already broken before packing.
      sh('/usr/bin/codesign', ['--verify', '--deep', '--strict', dest])
      console.log('  signature valid')

      // (b) Does the executable have the exec bit — without it, the install succeeds but it
      // never opens.
      const bin = join(dest, 'Contents/MacOS/centralu')
      if (!existsSync(bin)) fail(`executable is missing: ${bin}`)
      const mode = out('/bin/sh', ['-c', `stat -f '%p' '${bin}'`])
      if (!/[157][157][157]$/.test(mode.slice(-3))) fail(`no exec bit (${mode})`)
      console.log('  exec bit ok')

      // (c) architecture
      const arch = out('/usr/bin/file', ['-b', bin])
      if (!arch.includes('arm64')) fail(`not arm64: ${arch}`)
      console.log(`  ${arch.split(',')[0]}`)

      // (d) the keeper executable beside it (#440). Without it the app still runs (the window's
      // executable runs the keeper itself), so nothing else would notice it missing.
      checkKeeperExe(join(dest, 'Contents/MacOS', KEEPER_EXE), 'arm64')

      // (e) the pinned Node for remotes, which a Mac hub sends to the machines it installs
      checkRemoteRuntime(join(dest, 'Contents/Resources/resources/host'))
    },
  },

  'linux-x64': {
    id: 'linux-x64',
    /*
     * `tauri.linux.conf.json` builds both a `.deb` and an AppImage; narrow it here because
     * only the AppImage is shipped through npm. The AppImage carries its own webkit2gtk and
     * friends, so it runs on a machine where the user installed nothing — which is the whole
     * point of shipping through npm. A `.deb` needs root and apt: a different delivery
     * channel, not this one. Building it during a release would only cost time.
     */
    bundles: 'appimage',
    artifact: `${APP_NAME}.AppImage`,
    locate: () => soleFile(join(BUNDLE_ROOT, 'appimage'), (n) => n.endsWith('.AppImage')),
    install: (src, dest) => {
      rmSync(dest, { force: true })
      cpSync(src, dest)
      /*
       * Ship the icon next to the AppImage. `centralu install` writes a freedesktop
       * `.desktop` entry, and that entry can only point at an icon *file on disk* — the one
       * embedded in the AppImage is invisible to the menu. Without this the launcher falls
       * back to the bare name `centralu`, which resolves to nothing, and the app shows up in
       * the application menu as a generic grey square.
       *
       * Copied at release time rather than committed so it cannot drift from the icon the
       * build actually used; `.gitignore` covers it like the bundle itself.
       */
      cpSync(join(ROOT, 'apps/desktop/src-tauri/icons/icon.png'), join(dirname(dest), 'icon.png'))
      /*
       * Set +x rather than trusting whatever produced the file. The bit is easy to lose in
       * transit — a GitHub Actions artifact is a zip and drops it outright — and losing it
       * gives a symptom that does not name its cause: the package installs fine and then
       * nothing happens. `packages/agent-host/scripts/bundle.mjs` carries the same guard for
       * node-pty's spawn-helper, and the comment there records how long that one took to find.
       */
      chmodSync(dest, 0o755)
      installLinuxHost(dirname(dest))
    },
    check: (dest) => {
      checkLinuxHost(dirname(dest))
      /*
       * (a) macOS verifies the code signature here. An AppImage has none, so check what the
       *     signature was really standing in for: that this file is the artifact we think it
       *     is and did not arrive truncated. A type-2 AppImage is an ELF whose bytes 8..10
       *     are the magic `AI\x02` — both halves matter, since a half-written file can still
       *     start with a valid ELF header.
       */
      const magic = head(dest, 11)
      if (magic.subarray(0, 4).toString('latin1') !== '\x7fELF') fail(`not an ELF binary: ${dest}`)
      if (magic[8] !== 0x41 || magic[9] !== 0x49 || magic[10] !== 0x02) {
        fail(`not a type-2 AppImage — magic is ${[...magic.subarray(8, 11)].join(',')}, expected 65,73,2`)
      }
      console.log('  AppImage magic ok')

      // (b) exec bit — same failure mode as macOS: it installs, then nothing opens
      const mode = out('/usr/bin/stat', ['-c', '%a', dest])
      if (!/[157]$/.test(mode)) fail(`no exec bit (${mode})`)
      console.log('  exec bit ok')

      // (c) machine type
      const arch = out('/usr/bin/file', ['-b', dest])
      if (!arch.includes('x86-64')) fail(`not x86-64: ${arch}`)
      console.log(`  ${arch.split(',')[0]}`)

      // (d) the keeper executable inside the AppImage (#440), for `CC_USE_KEEPER=1` there
      checkKeeperInAppImage(dest, 'x86-64')
    },
  },

  /*
   * #29. Same shape as linux-x64 — same AppImage-only rule, same checks — because none of
   * those checks are architecture-specific: the type-2 magic bytes and the exec bit mean
   * the same thing on any machine type. Only the final `file` check has to name a
   * different machine.
   *
   * This entry only matters when `pnpm release:npm` runs *on* linux-arm64 hardware
   * (HOST below is `${process.platform}-${process.arch}`), so adding it here is safe on
   * its own: nobody has built on that host yet, so this branch has never executed. What
   * is *not* done yet on purpose — the shim's `optionalDependencies`, the launcher's
   * TARGETS table — is explained in docs/releasing.md under "Adding a platform" /
   * "linux-arm64 (#29)".
   */
  'linux-arm64': {
    id: 'linux-arm64',
    bundles: 'appimage',
    artifact: `${APP_NAME}.AppImage`,
    locate: () => soleFile(join(BUNDLE_ROOT, 'appimage'), (n) => n.endsWith('.AppImage')),
    install: (src, dest) => {
      rmSync(dest, { force: true })
      cpSync(src, dest)
      cpSync(join(ROOT, 'apps/desktop/src-tauri/icons/icon.png'), join(dirname(dest), 'icon.png'))
      chmodSync(dest, 0o755)
      installLinuxHost(dirname(dest))
    },
    check: (dest) => {
      checkLinuxHost(dirname(dest))
      // (a) same AppImage-magic check as linux-x64 — arch-independent
      const magic = head(dest, 11)
      if (magic.subarray(0, 4).toString('latin1') !== '\x7fELF') fail(`not an ELF binary: ${dest}`)
      if (magic[8] !== 0x41 || magic[9] !== 0x49 || magic[10] !== 0x02) {
        fail(`not a type-2 AppImage — magic is ${[...magic.subarray(8, 11)].join(',')}, expected 65,73,2`)
      }
      console.log('  AppImage magic ok')

      // (b) exec bit — same as linux-x64
      const mode = out('/usr/bin/stat', ['-c', '%a', dest])
      if (!/[157]$/.test(mode)) fail(`no exec bit (${mode})`)
      console.log('  exec bit ok')

      // (c) machine type — `file` names 64-bit ARM "aarch64", not "arm64" (that spelling
      // is npm/Node's `process.arch`, used for the id above and for the package's `cpu`
      // field; the two vocabularies just disagree)
      const arch = out('/usr/bin/file', ['-b', dest])
      if (!arch.includes('aarch64')) fail(`not aarch64: ${arch}`)
      console.log(`  ${arch.split(',')[0]}`)

      // (d) the keeper executable inside, same as linux-x64
      checkKeeperInAppImage(dest, 'aarch64')
    },
  },

  /*
   * #14, W3. The package ships the same portable folder `build.yml` uploads as the
   * `centralu-windows-x64` artifact (W1, #307): `Centralu\centralu.exe` beside
   * `Centralu\resources\host\`. npm can unpack a folder and start an exe; it cannot run an
   * installer, so the NSIS bundle is not built here at all (`--no-bundle`), by the same
   * rule as the other targets — a release builds what it publishes and nothing else.
   *
   * The host is taken from `src-tauri/resources/host`, which the build's
   * `beforeBuildCommand` (`bundle:host`) has just written, rather than from a copy under
   * `target/`: that copy is made by the Rust build script, and a build the cache let skip it
   * would leave an older host beside a new exe. Same choice, same reason, as `build.yml`.
   */
  'win32-x64': {
    id: 'win32-x64',
    noBundle: true,
    artifact: APP_NAME,
    /*
     * Not `pnpm verify`: its unit tests have known failures on Windows, the W2 checklist in
     * #307, which `build.yml`'s `windows tests` job reports on every PR without blocking.
     * Lint, dependency rules and types do pass on Windows and still gate the release here.
     * The full `pnpm verify` runs on the same commit in the linux and darwin platform jobs
     * and in the shim job, and the shim cannot go out unless all of them succeed. Drop this
     * line once the W2 list is empty, the same day `continue-on-error` leaves `build.yml`.
     */
    verify: ['lint', 'depcruise', 'typecheck'],
    locate: () => join(ROOT, 'apps/desktop/src-tauri/target/release/centralu.exe'),
    install: (exe, dest) => {
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(join(dest, 'resources'), { recursive: true })
      cpSync(exe, join(dest, 'centralu.exe'))
      // `dereference`: npm drops symlinks from a tarball without a word, so anything linked
      // would arrive as a hole in the host's node_modules.
      cpSync(join(ROOT, 'apps/desktop/src-tauri/resources/host'), join(dest, 'resources/host'), {
        recursive: true,
        dereference: true,
      })
      // The size check stands in for the copy being whole — the npm tarball is built from
      // this copy, not from the build output.
      if (statSync(exe).size !== statSync(join(dest, 'centralu.exe')).size) fail('centralu.exe was copied short')
    },
    check: (dest) => {
      /*
       * (a) There is no code signature to verify on Windows yet (unsigned; SmartScreen asks).
       *     What the signature check stood in for — this is the binary we think it is — is
       *     the PE header: `MZ`, the `PE\0\0` signature where `e_lfanew` points, and a sane
       *     header. Read from the copy in the package, which is what npm will pack.
       */
      const exe = join(dest, 'centralu.exe')
      if (!existsSync(exe)) fail(`executable is missing: ${exe}`)
      const pe = head(exe, 4096)
      if (pe.subarray(0, 2).toString('latin1') !== 'MZ') fail(`not a Windows executable (no MZ header): ${exe}`)
      const at = pe.readUInt32LE(0x3c)
      if (at + 94 > pe.length || pe.subarray(at, at + 4).toString('latin1') !== 'PE\0\0') {
        fail(`no PE signature at 0x${at.toString(16)}: ${exe}`)
      }
      console.log('  PE header ok')

      /*
       * (b) Windows has no exec bit; what the exec-bit check guarded against was "installs,
       *     then nothing opens". Here that is the exe being a console program — it would
       *     open a console window beside the app on every start (#14 audit, W11) — or the
       *     host missing from beside it. Subsystem 2 is IMAGE_SUBSYSTEM_WINDOWS_GUI, at
       *     offset 68 of the optional header (the same offset in PE32 and PE32+).
       */
      const subsystem = pe.readUInt16LE(at + 24 + 68)
      if (subsystem !== 2) fail(`centralu.exe is not a GUI program (subsystem ${subsystem}) — it would open a console window`)
      for (const rel of ['resources/host/main.mjs', 'resources/host/node_modules/node-pty/prebuilds/win32-x64/conpty.node']) {
        if (!existsSync(join(dest, rel))) fail(`${rel} is missing from the package — the app would not start its host or its terminal`)
      }
      console.log('  GUI subsystem, host and conpty present')
      checkRemoteRuntime(join(dest, 'resources/host'))

      // (c) machine type — 0x8664 is IMAGE_FILE_MACHINE_AMD64, the field right after `PE\0\0`
      const machine = pe.readUInt16LE(at + 4)
      if (machine !== 0x8664) fail(`not x86-64: PE machine 0x${machine.toString(16)}`)
      console.log('  PE32+ x86-64')
    },
  },
}

// ── 1. Is this a state it is safe to publish from ──────────────────────
step('Pre-publish checks')

const HOST = `${process.platform}-${process.arch}`
// `--shim-only` packages no binary, so it neither has nor needs a target for this host.
const target = shimOnly ? undefined : TARGETS[HOST]
if (!shimOnly && !target) {
  fail(
    `no npm package is defined for ${HOST} (have: ${Object.keys(TARGETS).join(', ')}).\n` +
      'The bundle must be built on the platform it ships to, so this cannot be overridden here — ' +
      'add a target above and a matching packaging/npm/<id>/package.json first.',
  )
}

const ARCH_PKG = target && join(ROOT, 'packaging/npm', target.id)
if (ARCH_PKG && !existsSync(join(ARCH_PKG, 'package.json'))) fail(`platform package is missing: ${ARCH_PKG}/package.json`)
/**
 * The host alone (`@centralu/host-<id>`, `host-package.mts`), for every platform a hub installs on:
 * the ones `packaging/remote-runtime.json` pins a Node for. Built in the same job as the platform
 * package because it is the same host, bundled on the same machine.
 */
const HOST_PKG = target && remotePlatforms().includes(target.id) ? hostPackageDir(target.id) : undefined
if (HOST_PKG && !existsSync(join(HOST_PKG, 'package.json'))) fail(`host-only package is missing: ${HOST_PKG}/package.json`)

if (out('git', ['status', '--porcelain'])) {
  // If uncommitted changes slip out with the release, "what was published" and "what is in the
  // repository" no longer agree. The build hash embedded in the host startup banner also
  // becomes `-dirty`, so there is no way to tell which code it was built from.
  fail('the working tree is not clean. Commit or revert, then run this again.')
}

if (publish) {
  // Getting blocked on auth after running the whole build wastes minutes — checked first.
  try {
    console.log(`  npm user: ${out('npm', ['whoami'])}`)
  } catch {
    fail('not logged in to npm. Run `npm login` first (a web login is separate from CLI auth).')
  }
}

for (const script of target?.verify ?? ['verify']) sh('pnpm', [script])

console.log(
  `  ${target?.id ?? 'centralu (shim only)'} · version ${APP_VERSION} · tag ${tag} · commit ${out('git', ['rev-parse', '--short', 'HEAD'])}`,
)

// ── 2-4. The bundle (--shim-only has nothing to bundle, so this whole block is skipped) ──
if (target && ARCH_PKG) {
  // ── 2. Build ─────────────────────────────────────────────────────────
  if (skipBuild) {
    console.log('\n  --skip-build: using the bundle that is already built')
  } else {
    step('Building the release app')
    sh('pnpm', [
      '--filter',
      '@cc/desktop',
      'exec',
      'tauri',
      'build',
      ...(target.bundles ? ['--bundles', target.bundles] : []),
      ...(target.noBundle ? ['--no-bundle'] : []),
    ])
  }
  const built = target.locate()
  if (!existsSync(built)) fail(`no bundle found: ${built}`)

  // ── 3. Copy the bundle into the architecture package ────────────────
  step('Copying the bundle')
  const dest = join(ARCH_PKG, target.artifact)
  target.install(built, dest)

  // ── 4. Does what was packed actually hold up ────────────────────────
  step('Verifying the bundle')
  target.check(dest)

  if (target.stagesShell) await stageShellAndContent(target.id, dest)

  if (HOST_PKG) {
    // From `src-tauri/resources/host`, which the build's `beforeBuildCommand` has just written: the
    // same folder the platform package's host was copied from, for the reason given at `win32-x64`
    step('Staging the host-only package')
    stageHostPackage(join(ROOT, 'apps/desktop/src-tauri/resources/host'), HOST_PKG)
    const problems = hostPackageProblems(HOST_PKG, target.id)
    if (problems.length) fail(`the host-only package would not run on a remote:\n  ${problems.join('\n  ')}`)
    console.log(`  host/ staged and checked: @centralu/host-${target.id}`)
  }

  // If `files` does not actually point at what was packed, the tarball ships **empty inside**
  // — invisible until someone reads the pack log by eye. Since the name is read from one place
  // (APP_NAME), it is checked here too.
  const archManifest = JSON.parse(readFileSync(join(ARCH_PKG, 'package.json'), 'utf8')) as { files?: string[] }
  if (!archManifest.files?.includes(target.artifact)) {
    fail(`${ARCH_PKG}/package.json "files" does not list ${target.artifact} — the tarball would ship empty`)
  }
  // And the other way round: npm drops a `files` entry that is not on disk without saying so,
  // so a listed-but-absent icon packs, installs, and only shows up as a wrong menu entry later.
  for (const entry of archManifest.files ?? []) {
    if (!existsSync(join(ARCH_PKG, entry))) {
      fail(`${ARCH_PKG}/package.json "files" lists ${entry}, which is not on disk — npm would drop it silently`)
    }
  }
}

// ── 5. Read the version from one place (brand.ts) and write it everywhere ──────────────
step('Aligning package versions')
for (const pkgDir of [...(HOST_PKG ? [HOST_PKG] : []), ...(ARCH_PKG ? [ARCH_PKG] : []), MAIN_PKG]) {
  const file = join(pkgDir, 'package.json')
  const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  json.version = APP_VERSION
  if (json.optionalDependencies) {
    // The main package has to point at the **exact version**. Left as a range (^), only the
    // architecture package could end up on a newer version, and the shell and the contents
    // would drift apart.
    json.optionalDependencies = Object.fromEntries(
      Object.keys(json.optionalDependencies as object).map((k) => [k, APP_VERSION]),
    )
  }
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
  console.log(`  ${json.name as string}@${APP_VERSION}`)
}

/**
 * Signs the content and puts it, with the shell, into the bundle in the package (`bundle-stage.mts`):
 * `Contents/Resources/content/` and `Contents/Resources/shell/Centralu.app`. The content is signed in
 * `target/release/content/` first (the release workflow keeps that manifest as an artifact) and
 * verified there, then copied in; the bundle is signed again and what it now carries is verified once
 * more, so what was signed is exactly what is packed.
 *
 * The shell: a publish takes the asset shell.lock pins for the source's shell version (sha256 and
 * cdhash checked); without an entry, and in a rehearsal, it is built here and marked unpinned, which
 * the window neither installs nor opens.
 *
 * Before publishing, on purpose: a key that does not match keys.json, or a pinned shell that would
 * refuse the content, stops the release while nothing is on the registry, instead of failing the job
 * after the platform package went out and leaving the shim job waiting on it.
 */
async function stageShellAndContent(platform: string, bundle: string): Promise<void> {
  step('Signing the content and staging it with the shell')
  const release = join(ROOT, 'apps/desktop/src-tauri/target/release')
  let key: SigningKey
  try {
    key = resolveSigningKey({ dryRun: !publish, pem: contentSigningPem })
  } catch (e) {
    fail((e as Error).message)
  }
  if (publish && requireContentKey && key.throwaway) {
    fail('--require-content-key: CONTENT_SIGNING_KEY is not set. Is this job running in the npm-publish environment?')
  }
  const contentDir = join(release, 'content')
  const manifest = stageContent(contentDir, { bundle, key, platform })
  const keys = key.throwaway ? [{ name: 'throwaway', keyId: key.keyId, publicKey: key.publicKey }] : trustedKeys()
  try {
    verifyContent(contentDir, { platform, keys })
  } catch (e) {
    fail(
      `the content manifest does not verify: ${(e as Error).message}. ` +
        (key.throwaway ? '' : 'CONTENT_SIGNING_KEY does not match packaging/shell/keys.json.'),
    )
  }
  const files = (JSON.parse(manifest.toString('utf8')) as { files: unknown[] }).files.length
  console.log(`  ${files} files, key ${key.keyId}${key.throwaway ? ' (throwaway: this run signs nothing a shell will accept)' : ''}`)

  let shell: CarriedShell
  try {
    shell = await shellToCarry({ usePinned: publish, out: join(release, 'carried-shell'), targetDir: join(ROOT, 'apps/desktop/src-tauri/target') })
  } catch (e) {
    fail(`the shell to carry: ${(e as Error).message}`)
  }
  if (shell.pinned && key.throwaway) {
    fail('the pinned shell refuses content signed with a throwaway key, so every window would start without it. Publish from the release workflow.')
  }
  stageBundle(bundle, { shell, contentDir })
  try {
    checkStaged(bundle, { keys, platform, manifest, lock: shell.lock })
  } catch (e) {
    fail(`the staged bundle does not carry what was signed: ${(e as Error).message}`)
  }
  console.log(`  shell ${shell.version} (${shell.pinned ? 'pinned in shell.lock' : 'built here, unpinned'}) and the content are in the bundle; signature valid`)
  if (publish && !shell.pinned) {
    console.log(
      `\n\x1b[33m  warning: shell.lock has no entry for shell ${shell.version}, so this release carries a shell built here, which the window neither installs nor opens: the keeper starts directly, as before.\x1b[0m`,
    )
  }
  if (publish && key.throwaway) {
    console.log('\n\x1b[33m  warning: published with a throwaway content key. Harmless only because the shell it carries is unpinned and never opened.\x1b[0m')
  }
}

/**
 * The shim may only go out once every platform package it pins is already on the registry.
 *
 * This is the multi-platform version of the ordering rule below. npm treats an
 * optionalDependency that fails to resolve as a non-event: the install succeeds, nothing
 * is printed loudly, and the user is left with a shim that reports a missing app — which
 * reads as "your install is broken", not as "your platform isn't out yet". The
 * single-platform script could not reach this state, so the check did not exist.
 */
/** `name@<this version>` is visible on the registry (`release-registry.mts`) */
function onRegistry(name: string): boolean {
  return viewPublished(name, APP_VERSION, viaShell('npm')).state === 'present'
}

/** How long the shim waits for packages published moments ago to show on the registry */
const VISIBLE_TRIES = 10
const VISIBLE_DELAY_MS = 30_000

async function assertPinnedPlatformsPublished() {
  const main = JSON.parse(readFileSync(join(MAIN_PKG, 'package.json'), 'utf8')) as {
    optionalDependencies?: Record<string, string>
  }
  // The host-only packages too, though the shim does not pin them: a hub on this version asks for
  // its own version of one, and falls back to the 88 MB platform package on Linux without it
  const hostOnly = remotePlatforms().map(
    (id) => (JSON.parse(readFileSync(join(hostPackageDir(id), 'package.json'), 'utf8')) as { name: string }).name,
  )
  // A publish waits for the registry (0.1.0-beta.14's shim job failed on packages published a minute
  // before); a rehearsal published none, so it says so at once
  const missing = await stillMissing([...Object.keys(main.optionalDependencies ?? {}), ...hostOnly], onRegistry, {
    tries: publish ? VISIBLE_TRIES : 1,
    delayMs: VISIBLE_DELAY_MS,
    onWait: (m) => console.log(`  not visible on the registry yet: ${m.join(', ')}; asking again in ${VISIBLE_DELAY_MS / 1000} s`),
  })
  if (missing.length === 0) return
  const note =
    `${missing.join(', ')} @${APP_VERSION} is not on the registry yet.\n` +
    '  Publish every platform package first — that is what the platform jobs in the release\n' +
    '  workflow do — then re-run with --shim-only to publish the shim last.'
  if (publish) fail(note)
  console.log(`\n\x1b[33m  warning: ${note}\x1b[0m`)
}

// ── 6. pack (and publish, if asked) ─────────────────────────────────────
// The architecture package has to be published **first**. Reversed, there is a moment where
// someone who installed the main package is looking at a missing optional dependency.
// `--platform-only` publishes only the first, `--shim-only` only the second — this order holds
// even when the work is split across several machines.
//
// The host-only package goes before its platform package: it is new to the registry, so its first
// publish is the likelier one to be refused (a token that cannot create a package), and refused first
// it leaves nothing of this platform published.
//
// A package already on the registry at this version from this commit is skipped (an earlier attempt
// of this release published it), so re-running a job that failed halfway finishes the release; one
// from another commit stops the job (`release-registry.mts`).
const HEAD = out('git', ['rev-parse', 'HEAD'])
for (const pkgDir of [...(HOST_PKG ? [HOST_PKG] : []), ...(ARCH_PKG ? [ARCH_PKG] : []), ...(platformOnly ? [] : [MAIN_PKG])]) {
  const name = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name: string }).name
  if (pkgDir === MAIN_PKG) await assertPinnedPlatformsPublished()
  if (publish) {
    const next = publishStep(viewPublished(name, APP_VERSION, viaShell('npm')), HEAD, `${name}@${APP_VERSION}`)
    if (next.do === 'stop') fail(next.why)
    if (next.do === 'skip') {
      step(`Already published from this commit: ${name}@${APP_VERSION} (an earlier attempt of this release); not publishing it again`)
    } else {
      step(`Publishing: ${name}`)
      sh('npm', ['publish', '--access', 'public', '--tag', tag, ...(otp ? ['--otp', otp] : [])], pkgDir)
    }
    if (alsoLatest && tag !== 'latest') {
      // Moving a tag, unlike publishing, **can be undone** (a dist-tag can always be repointed),
      // and adding one that is already there changes nothing, so a re-run does it again.
      sh('npm', ['dist-tag', 'add', `${name}@${APP_VERSION}`, 'latest', ...(otp ? ['--otp', otp] : [])], pkgDir)
    }
  } else {
    step(`Rehearsal (pack): ${name}`)
    sh('npm', ['pack', '--dry-run'], pkgDir)
  }
}

if (platformOnly) {
  console.log(
    publish
      ? `\n\x1b[32m${target?.id} published — the centralu shim still has to go out separately\x1b[0m`
      : `\n Rehearsal complete (${target?.id} only). To actually publish: \x1b[1mpnpm release:npm --publish --platform-only\x1b[0m`,
  )
} else if (shimOnly) {
  console.log(
    publish
      ? `\n\x1b[32mPublished — npm i -g ${tag === 'latest' ? 'centralu' : `centralu@${tag}`}\x1b[0m`
      : `\n Rehearsal complete (shim only). To actually publish: \x1b[1mpnpm release:npm --publish --shim-only\x1b[0m`,
  )
} else {
  console.log(
    publish
      ? `\n\x1b[32mPublished — npm i -g ${tag === 'latest' ? 'centralu' : `centralu@${tag}`}\x1b[0m`
      : `\n Rehearsal complete. To actually publish: \x1b[1mpnpm release:npm --publish\x1b[0m`,
  )
}
