// Centralu's remote installer, step 2 (docs/plans/remote-hub.md §10.2). The hub sends this file over
// ssh and runs it on the pinned Node that step 1 placed; it never runs on the hub. It imports Node's
// own modules only, and reads one argument: the base64 of a JSON object the hub wrote
// ({ version, node, platform, hub, packages: [{ name, tarball, integrity }], activate? }), or for the
// update's later steps ({ action: 'pointers', current, previous } and { action: 'prune' }; plan §10.5).
//
// It prints one line for the hub to read, `CENTRALU-INSTALL done <json>` or
// `CENTRALU-INSTALL fail <code> <detail>`, and nothing that matters on its exit code (exit codes do
// not survive the way back from Windows; tunnel.ts). The sentences for the person are the hub's.
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const WORD = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/

class Refusal extends Error {
  constructor(code, detail = '') {
    super(`${code} ${detail}`.trim())
    this.code = code
    this.detail = detail
  }
}

/** The data folder: `CC_DATA_DIR`, else `~/.centralu`, the rule `serve` and the host use */
export function remoteLayout(dataDir) {
  const root = join(dataDir, 'remote')
  return { root, current: join(root, 'current'), previous: join(root, 'previous'), versions: join(root, 'versions'), node: join(root, 'node'), bin: join(root, 'bin'), lock: join(root, 'install.lock') }
}

/** `current` / `previous`: "<centralu version> <node version>", two plain words, or null */
export function readPointer(file) {
  try {
    const m = /^\s*(\S+)[ \t]+(\S+)\s*$/.exec(readFileSync(file, 'utf8'))
    return m && WORD.test(m[1]) && WORD.test(m[2]) ? { version: m[1], node: m[2] } : null
  } catch {
    return null
  }
}

/**
 * Replaces `file` by a rename over it, so a reader (the launcher, `serve --connection`) sees the old
 * line or the new one and never half of one. Atomic on posix, and measured atomic on Windows
 * (`renameSync` over an existing file replaces it; plan §10.1)
 */
export function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/** Points `current` at `next`, the old `current` becoming `previous` (plan §10.5 step 3) */
export function switchTo(l, next) {
  const cur = readPointer(l.current)
  if (cur && cur.version === next.version && cur.node === next.node) return { current: next, previous: readPointer(l.previous) }
  if (cur) writeAtomic(l.previous, `${cur.version} ${cur.node}\n`)
  writeAtomic(l.current, `${next.version} ${next.node}\n`)
  return { current: next, previous: cur ?? readPointer(l.previous) }
}

/**
 * Removes every version that is neither `current` nor `previous`, and every Node neither uses. A
 * folder that cannot go (a Windows program still running from it) stays and is named, never fatal
 */
export function prune(l) {
  const keep = [readPointer(l.current), readPointer(l.previous)].filter(Boolean)
  const removed = []
  const left = []
  const sweep = (dir, kept) => {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (kept.has(name) || name.startsWith('.')) continue
      try {
        rmSync(join(dir, name), { recursive: true, force: true })
        removed.push(name)
      } catch {
        left.push(name)
      }
    }
  }
  sweep(l.versions, new Set(keep.map((p) => p.version)))
  // What `placeVersion` moved aside and could not remove then
  try {
    for (const name of readdirSync(l.root).filter((n) => n.startsWith('.replaced-'))) {
      try {
        rmSync(join(l.root, name), { recursive: true, force: true })
      } catch {
        left.push(name)
      }
    }
  } catch {}
  sweep(l.node, new Set(keep.map((p) => `v${p.node}`)))
  return { removed, left }
}

/** A lock folder with no pid in it, younger than this, is held: its installer has made it and not yet written the pid */
const LOCK_YOUNG_MS = 60_000

/**
 * One installer at a time per data folder; a lock whose process is gone is taken over.
 *
 * Taking it is `mkdir`, which only one installer can do; the pid follows. A lock found with no pid is
 * held while it is young (another installer between the two, which reading it as pid 0 once took
 * over), and stale only after `LOCK_YOUNG_MS` (an installer that died between them). A stale lock is
 * taken over by moving it aside first, so of two installers that both found it stale only one removes
 * it, and one that moved a lock just replaced by a live one puts it back. Unlock removes the lock only
 * while it is still this run's own (its `token`).
 */
export function lock(l) {
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`
  for (let i = 0; i < 3; i++) {
    try {
      mkdirSync(l.lock)
      writeFileSync(join(l.lock, 'pid'), String(process.pid))
      writeFileSync(join(l.lock, 'token'), token)
      return () => {
        if (readFileSafe(join(l.lock, 'token')) === token) rmSync(l.lock, { recursive: true, force: true })
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    const held = readFileSafe(join(l.lock, 'pid'))
    if (!lockIsStale(l.lock, held)) throw new Refusal('busy', held.trim())
    const aside = `${l.lock}.${token}.stale`
    try {
      renameSync(l.lock, aside)
    } catch {
      continue // gone already, or another installer moved it first
    }
    const moved = readFileSafe(join(aside, 'pid'))
    if (moved !== held) {
      // Replaced by a live lock between reading it and moving it: not ours to remove
      try {
        renameSync(aside, l.lock)
      } catch {
        // Someone holds a newer one; this one stays aside, named, and harmless
      }
      throw new Refusal('busy', moved.trim())
    }
    rmSync(aside, { recursive: true, force: true })
  }
  throw new Refusal('busy')
}

function lockIsStale(dir, pidText) {
  const pid = Number(pidText.trim())
  if (pidText.trim() && pid > 0) return !alive(pid)
  try {
    return Date.now() - statSync(dir).mtimeMs > LOCK_YOUNG_MS
  } catch {
    return true // gone: the next turn takes the lock
  }
}

function readFileSafe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** The system's tar. On Windows the one in System32 (bsdtar): a GNU tar on PATH reads `C:` as a host */
function tarProgram() {
  return process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
}

/** The tarball's bytes, refused unless their sha512 is the integrity the hub read from the signed metadata */
export async function fetchChecked(pkg) {
  let res
  try {
    res = await fetch(pkg.tarball, { signal: AbortSignal.timeout(300_000) })
  } catch (err) {
    throw new Refusal('download', `${pkg.name}: ${err.cause?.message ?? err.message}`)
  }
  if (!res.ok) throw new Refusal('download', `${pkg.name}: HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const have = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (have !== pkg.integrity) throw new Refusal('integrity', pkg.name)
  return bytes
}

/**
 * Which package brings the host, where the host sits in it, and what of it a remote never runs (plan
 * S6). The host-only package (`@centralu/host-<platform>`) is the host and nothing else; a version
 * published before it existed comes as its platform package, whose window is thrown away
 */
function hostParts(platform, packages) {
  const hostOnly = `@centralu/host-${platform}`
  if (packages.some((pkg) => pkg.name === hostOnly)) return { pkg: hostOnly, host: join('host', 'main.mjs'), drop: [] }
  const pkg = `@centralu/${platform}`
  if (platform === 'win32-x64') return { pkg, host: join('Centralu', 'resources', 'host', 'main.mjs'), drop: [join('Centralu', 'centralu.exe')] }
  return { pkg, host: join('host', 'main.mjs'), drop: ['Centralu.AppImage'] }
}

function sameInstall(dir, p) {
  try {
    const was = JSON.parse(readFileSync(join(dir, 'install.json'), 'utf8'))
    return was.version === p.version && p.packages.every((pkg) => was.packages?.some((w) => w.name === pkg.name && w.integrity === pkg.integrity))
  } catch {
    return false
  }
}

/**
 * Puts the unpacked `partial` folder in place as `dir`. A `dir` already there (the same version
 * installed again with other bytes, possibly the one `current` runs) is moved aside first and removed
 * only once the new one is in place, and put back if that fails: removing it first would leave
 * `current` naming nothing after a failed rename, and on Windows a removal can stop halfway on the
 * files of a host running from it (moving that folder is allowed, plan §10.5). What cannot be removed
 * stays aside under a dot name, and the next prune tries again
 */
export function placeVersion(l, partial, dir) {
  const aside = existsSync(dir) ? join(l.root, `.replaced-${basename(dir)}-${process.pid}-${randomBytes(4).toString('hex')}`) : null
  if (aside) renameSync(dir, aside)
  try {
    renameSync(partial, dir)
  } catch (err) {
    if (aside) renameSync(aside, dir)
    throw err
  }
  if (aside) {
    try {
      rmSync(aside, { recursive: true, force: true })
    } catch {
      // A Windows program still running from it; harmless where it is
    }
  }
}

/** Installs `p.version` beside what is there, switches `current` to it, and keeps `previous` */
export async function install(p, { dataDir = process.env.CC_DATA_DIR || join(homedir(), '.centralu'), platform = process.platform } = {}) {
  if (!WORD.test(p.version) || !WORD.test(p.node)) throw new Refusal('params', 'version')
  const l = remoteLayout(dataDir)
  mkdirSync(l.root, { recursive: true })
  const unlock = lock(l)
  try {
    const dir = join(l.versions, p.version)
    const parts = hostParts(p.platform, p.packages)
    if (!sameInstall(dir, p)) {
      // Everything lands in a folder of its own first; the version's folder appears by one rename
      const partial = join(l.root, `.partial-${p.version}-${process.pid}`)
      rmSync(partial, { recursive: true, force: true })
      try {
        for (const [i, pkg] of p.packages.entries()) {
          const bytes = await fetchChecked(pkg)
          const file = join(partial, `${i}.tgz`)
          const dest = join(partial, 'node_modules', ...pkg.name.split('/'))
          mkdirSync(dest, { recursive: true })
          writeFileSync(file, bytes)
          const r = spawnSync(tarProgram(), ['-xzf', file, '-C', dest, '--strip-components', '1'], { encoding: 'utf8', windowsHide: true })
          if (r.status !== 0) throw new Refusal('unpack', `${pkg.name}: ${(r.stderr || r.error?.message || '').trim().split('\n').at(-1)}`)
          rmSync(file, { force: true })
        }
        const pkgDir = join(partial, 'node_modules', ...parts.pkg.split('/'))
        if (!existsSync(join(pkgDir, parts.host))) throw new Refusal('no_host', p.platform)
        for (const d of parts.drop) rmSync(join(pkgDir, d), { force: true })
        writeFileSync(
          join(partial, 'install.json'),
          JSON.stringify({ version: p.version, node: p.node, platform: p.platform, packages: p.packages.map(({ name, integrity }) => ({ name, integrity })), installedAt: new Date().toISOString(), by: p.hub ?? null }, null, 2) + '\n',
        )
        mkdirSync(l.versions, { recursive: true })
        placeVersion(l, partial, dir)
      } finally {
        rmSync(partial, { recursive: true, force: true })
      }
    }
    // An update installs beside and switches later, once the running host is stopped (plan §10.5):
    // nothing is pointed at the new version and nothing is removed yet. Without a `current`, no
    // launcher either, so the lookup still finds the Centralu that runs now
    if (p.activate === false) {
      return { installed: { version: p.version, node: p.node }, current: readPointer(l.current), previous: readPointer(l.previous), removed: [], left: [] }
    }
    const launcher = await ensureManagedLauncher(l, dir, p.version, platform)
    const pointers = switchTo(l, { version: p.version, node: p.node })
    return { ...pointers, ...prune(l), launcher }
  } finally {
    unlock()
  }
}

function launcherPath(l, platform) {
  return join(l.bin, platform === 'win32' ? 'centralu.cmd' : 'centralu')
}

/** The launcher reads `current` at every start and never changes (S8): written once, never over */
async function ensureManagedLauncher(l, dir, version, platform) {
  const launcher = launcherPath(l, platform)
  if (!existsSync(launcher)) {
    const serve = await import(pathToFileURL(join(dir, 'node_modules', 'centralu', 'bin', 'serve.mjs')).href)
    if (typeof serve.managedLauncherScript !== 'function') throw new Refusal('no_launcher', version)
    mkdirSync(l.bin, { recursive: true })
    writeAtomic(launcher, serve.managedLauncherScript(platform))
    if (platform !== 'win32') chmodSync(launcher, 0o755)
  }
  return launcher
}

const pointerOf = (v) => (v && WORD.test(v.version) && WORD.test(v.node) ? { version: v.version, node: v.node } : null)

/**
 * Writes both pointers as given (plan §10.5 steps 3 and 5, and rollback): `previous` first, then
 * `current`, each by rename; a null `previous` removes that file. `current` must name a version and a
 * Node that are both there. A null `current` puts the machine back to having no managed version: the
 * pointers and the launcher go, so the lookup finds the Centralu it ran before (an npm install).
 * Nothing is removed from `versions/` or `node/`
 */
export async function setPointers(p, { dataDir = process.env.CC_DATA_DIR || join(homedir(), '.centralu'), platform = process.platform } = {}) {
  const l = remoteLayout(dataDir)
  mkdirSync(l.root, { recursive: true })
  const unlock = lock(l)
  try {
    const current = pointerOf(p.current)
    const previous = pointerOf(p.previous)
    if (!current) {
      for (const f of [l.previous, l.current, launcherPath(l, platform)]) rmSync(f, { force: true })
      return { current: null, previous: null }
    }
    const dir = join(l.versions, current.version)
    // Both must be there: a `previous` naming nothing would offer a rollback to a version that is gone
    for (const v of [current, previous].filter(Boolean)) {
      if (!existsSync(join(l.versions, v.version, 'install.json')) || !existsSync(join(l.node, `v${v.node}`))) throw new Refusal('missing', `${v.version} ${v.node}`)
    }
    await ensureManagedLauncher(l, dir, current.version, platform)
    if (previous) writeAtomic(l.previous, `${previous.version} ${previous.node}\n`)
    else rmSync(l.previous, { force: true })
    writeAtomic(l.current, `${current.version} ${current.node}\n`)
    return { current, previous }
  } finally {
    unlock()
  }
}

/** Plan §10.5 step 6, on its own: what is neither `current` nor `previous` goes */
export function pruneNow({ dataDir = process.env.CC_DATA_DIR || join(homedir(), '.centralu') } = {}) {
  const l = remoteLayout(dataDir)
  mkdirSync(l.root, { recursive: true })
  const unlock = lock(l)
  try {
    return { current: readPointer(l.current), previous: readPointer(l.previous), ...prune(l) }
  } finally {
    unlock()
  }
}

async function main() {
  try {
    const p = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'))
    const r = p.action === 'pointers' ? await setPointers(p) : p.action === 'prune' ? pruneNow() : await install(p)
    process.stdout.write(`CENTRALU-INSTALL done ${JSON.stringify(r)}\n`)
  } catch (err) {
    const code = err instanceof Refusal ? err.code : 'error'
    const detail = err instanceof Refusal ? err.detail : err.message
    process.stdout.write(`CENTRALU-INSTALL fail ${code} ${String(detail).replace(/\s+/g, ' ')}\n`)
    process.exitCode = 1
  }
}

// Run as a program (not imported by a test). Node names its main module by its real path: compare that
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main()
