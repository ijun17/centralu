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
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
  sweep(l.node, new Set(keep.map((p) => `v${p.node}`)))
  return { removed, left }
}

/** One installer at a time per data folder; a lock whose process is gone is taken over */
function lock(l) {
  for (let i = 0; i < 2; i++) {
    try {
      mkdirSync(l.lock)
      writeFileSync(join(l.lock, 'pid'), String(process.pid))
      return () => rmSync(l.lock, { recursive: true, force: true })
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const pid = Number(readFileSafe(join(l.lock, 'pid')))
      if (pid > 0 && alive(pid)) throw new Refusal('busy', String(pid))
      rmSync(l.lock, { recursive: true, force: true })
    }
  }
  throw new Refusal('busy')
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

/** Where the host sits in the platform package, and what of the package a remote never runs (plan S6) */
function platformParts(platform) {
  if (platform === 'win32-x64') return { host: join('Centralu', 'resources', 'host', 'main.mjs'), drop: [join('Centralu', 'centralu.exe')] }
  return { host: join('host', 'main.mjs'), drop: ['Centralu.AppImage'] }
}

function sameInstall(dir, p) {
  try {
    const was = JSON.parse(readFileSync(join(dir, 'install.json'), 'utf8'))
    return was.version === p.version && p.packages.every((pkg) => was.packages?.some((w) => w.name === pkg.name && w.integrity === pkg.integrity))
  } catch {
    return false
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
    const parts = platformParts(p.platform)
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
        const pkgDir = join(partial, 'node_modules', '@centralu', p.platform)
        if (!existsSync(join(pkgDir, parts.host))) throw new Refusal('no_host', p.platform)
        for (const d of parts.drop) rmSync(join(pkgDir, d), { force: true })
        writeFileSync(
          join(partial, 'install.json'),
          JSON.stringify({ version: p.version, node: p.node, platform: p.platform, packages: p.packages.map(({ name, integrity }) => ({ name, integrity })), installedAt: new Date().toISOString(), by: p.hub ?? null }, null, 2) + '\n',
        )
        mkdirSync(l.versions, { recursive: true })
        rmSync(dir, { recursive: true, force: true })
        renameSync(partial, dir)
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
    const node = join(l.node, `v${current.node}`)
    if (!existsSync(join(dir, 'install.json')) || !existsSync(node)) throw new Refusal('missing', `${current.version} ${current.node}`)
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
