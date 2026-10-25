/**
 * Writes a version into the files that carry it (#1501), and puts the placeholder back.
 *
 *   node scripts/stamp-version.mjs <version>    # stamp
 *   node scripts/stamp-version.mjs --restore    # back to 0.0.0-dev
 *
 * The carriers, committed as `0.0.0-dev` (`app-version.mjs`):
 *   - `packages/protocol/src/version.generated.ts`: `APP_VERSION` for the UI, the host and the scripts;
 *   - `apps/desktop/src-tauri/tauri.conf.json`: the bundle's version (Info.plist, the AppImage, NSIS)
 *     and what the window reads at run time (`package_info()`), passing it to the keeper as
 *     `--app-version`;
 *   - every `packaging/npm/<package>/package.json`, the shim's exact pins included.
 * `Cargo.toml` and `Cargo.lock` stay at `0.0.0-dev` for good: nothing reads them for the version.
 *
 * Its users: `release-npm.mts` in the release job's checkout, after the clean-tree check;
 * `local-update.mts` in its disposable clone; `app-build.mts` (`pnpm app`), which restores after the
 * build. Each file is edited in place, only on its version fields, so a stamped tree differs from HEAD
 * by those alone (`versionOnlyDirt`), which `bundle.mjs` does not count as a dirty build.
 *
 * Dependency-free JavaScript, for `bundle.mjs` under plain node.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAppVersion, PLACEHOLDER, ROOT } from './app-version.mjs'

export const GENERATED = 'packages/protocol/src/version.generated.ts'
export const TAURI_CONF = 'apps/desktop/src-tauri/tauri.conf.json'

/** Every file the stamper writes, relative to `root`, in a fixed order */
export function stampedFiles(root = ROOT) {
  const npm = join(root, 'packaging/npm')
  const manifests = readdirSync(npm, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(npm, e.name, 'package.json')))
    .map((e) => `packaging/npm/${e.name}/package.json`)
    .sort()
  return [GENERATED, TAURI_CONF, ...manifests]
}

const GENERATED_LINE = /^export const APP_VERSION: string = '[^'\n]*'$/m
const TOP_VERSION = /^( {2}"version": )"[^"\n]*"/m

/** `text` of the carrier at `path` with `version` in its version fields; throws when a field is missing */
export function stampText(path, text, version) {
  const swap = (re, to, what) => {
    if (!re.test(text)) throw new Error(`${path}: no ${what} to stamp`)
    text = text.replace(re, to)
  }
  if (path.replaceAll('\\', '/').endsWith(GENERATED)) {
    swap(GENERATED_LINE, `export const APP_VERSION: string = '${version}'`, "`export const APP_VERSION: string = '…'` line")
    return text
  }
  swap(TOP_VERSION, `$1"${version}"`, 'top-level "version"')
  // The shim pins each platform package exactly: a range would let the shell and its contents drift apart
  for (const name of Object.keys(JSON.parse(text).optionalDependencies ?? {})) {
    const key = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    swap(new RegExp(`^( {4}"${key}": )"[^"\\n]*"`, 'm'), `$1"${version}"`, `pin of ${name}`)
  }
  return text
}

/**
 * Stamps `version` into every carrier under `root` and answers the files it changed. The
 * placeholder is accepted too (a restore); anything else must be a version (`checkAppVersion`).
 * Every file is read and stamped before the first is written, so a missing field writes nothing.
 */
export function stampVersion(root, version) {
  if (version !== PLACEHOLDER) checkAppVersion(version)
  const next = stampedFiles(root).map((path) => {
    const before = readFileSync(join(root, path), 'utf8')
    return { path, before, after: stampText(path, before, version) }
  })
  for (const f of next) if (f.after !== f.before) writeFileSync(join(root, f.path), f.after)
  return next.filter((f) => f.after !== f.before).map((f) => f.path)
}

/** The signals a run by hand ends with: Ctrl-C, `kill`, and a closed terminal */
export const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

/**
 * Stamps `version` into `root`'s carriers and holds it until the returned `restore` runs, or the process ends: on exit,
 * and on each of `STOP_SIGNALS`, which Node's `exit` event does not cover (#1501 review). A signal calls `onStop` first
 * (to stop a child), puts the placeholder back and exits with 128 + its number, so nothing after it runs. A stamped
 * carrier left in the tree would be committed. `restore` is idempotent.
 */
export function holdStamp(root, version, { onStop } = {}) {
  stampVersion(root, version)
  let held = true
  const restore = () => {
    if (!held) return
    held = false
    try {
      stampVersion(root, PLACEHOLDER)
    } catch (e) {
      console.error(`could not put ${PLACEHOLDER} back: ${e.message}`)
    }
  }
  process.on('exit', restore)
  for (const signal of STOP_SIGNALS) {
    process.on(signal, () => {
      try {
        onStop?.(signal)
      } finally {
        restore()
        process.exit(128 + (osConstants.signals[signal] ?? 1))
      }
    })
  }
  return restore
}

/**
 * Runs `steps` (`[cmd, args]`) one after another in `root`, the first `stamped` of them with `version` stamped
 * (`holdStamp`), the rest after the placeholder is back. Children run asynchronously, so a signal is handled at once,
 * not once a blocking child has exited (#1501 review: SIGTERM to `pnpm app` alone left the tree stamped and ran the
 * later steps): it stops the running child, restores, and exits. A failing step throws, after the restore.
 */
export async function runSteps(root, version, steps, { stamped = steps.length, env = process.env } = {}) {
  let child = null
  const restore = holdStamp(root, version, { onStop: (signal) => child?.kill(signal) })
  try {
    for (const [i, [cmd, args]] of steps.entries()) {
      if (i === stamped) restore()
      await new Promise((done, failed) => {
        child = spawn(cmd, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' && !isAbsolute(cmd) })
        child.on('error', failed)
        child.on('exit', (code, signal) => {
          child = null
          if (code === 0) done()
          else failed(new Error(`${cmd} ${args.join(' ')} exited with ${code ?? signal}`))
        })
      })
    }
  } finally {
    restore()
  }
}

/**
 * `git status --porcelain` in `root`, less the carriers that differ from HEAD by their version
 * fields alone: a stamped release tree is not a dirty build (`bundle.mjs` `buildId`).
 */
export function versionOnlyDirt(root = ROOT) {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
  const stamped = new Set(stampedFiles(root))
  const lines = status.split('\n').filter(Boolean)
  return lines.filter((line) => {
    const path = line.slice(3)
    if (!/^(?: M|M |MM) /.test(line) || !stamped.has(path)) return true
    let head
    try {
      head = execFileSync('git', ['show', `HEAD:${path}`], { cwd: root, encoding: 'utf8' })
    } catch {
      return true
    }
    const lf = (s) => s.replaceAll('\r\n', '\n')
    try {
      return lf(stampText(path, readFileSync(join(root, path), 'utf8'), PLACEHOLDER)) !== lf(head)
    } catch {
      return true
    }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2]
  if (!arg || process.argv.length > 3) {
    console.error('usage: stamp-version.mjs <version> | --restore')
    process.exit(2)
  }
  try {
    const changed = stampVersion(ROOT, arg === '--restore' ? PLACEHOLDER : arg)
    console.log(`${arg === '--restore' ? `restored ${PLACEHOLDER} in` : `stamped ${arg} into`} ${changed.length} file(s)`)
  } catch (e) {
    console.error(`stamp-version: ${e.message}`)
    process.exitCode = 1
  }
}
