/**
 * A keeper from verified content handing over to the next build's verified content (thin shell
 * step 5, docs/plans/thin-shell.md §10.3), end to end with the real shell, the real keeper and the
 * real host. No model and no network.
 *
 *   pnpm exec tsx scripts/keeper-content-integration.mts [--no-build] [--target-dir <dir>]
 *
 * Makes a throwaway ed25519 key in memory and builds, into the keeper scripts' target folder, a
 * debug keeper and a debug shell that also trust its public half (the `test-key` features of the
 * keeper crate and the shell: a release build of either refuses to compile with them, and the
 * keeper people run trusts packaging/shell/keys.json alone). The plain debug keeper is built again
 * right after, so the other keeper scripts never pick the test build up from the target folder.
 * Then it lays out "bundles" as the window carries them, `<name>/Centralu.app/Contents/MacOS/
 * centralu-keeper` beside `Contents/Resources/content/` (that keeper and the bundled host, stamped
 * `content-<name>`, signed with the key), and starts the shell binary directly against a temporary
 * data folder, as LaunchServices would. Never `open`, never LaunchServices: nothing here can raise a
 * permission prompt.
 *
 * Checked:
 *   - the shell starts keeper A from `<data>/content/0.2.0/`, and A's host runs from that copy's
 *     `host/`, with nothing copied into `<data>/hosts/`;
 *   - a switch to content 0.2.2 changed after signing is refused with the reason `content`: keeper A
 *     and its host serve on, nothing is left in `<data>/content/`, the terminal keeps counting;
 *   - a switch to 0.1.9, older than what ran here, is refused with `downgrade`;
 *   - an upgrade to 0.2.1 hands keeper A over to keeper B running from `<data>/content/0.2.1/` (the
 *     bundle's own keeper and its window host, which the request names, are never started): the
 *     same host process, the same terminal, its counter continuous, the window never
 *     dropped, the front door unchanged, A gone, the floor at 0.2.1, and `content/0.2.0` kept for
 *     as long as the host runs from it;
 *   - the switch from the 0.2.1 window then moves only the host, to `content/0.2.1/host`, and once
 *     nothing runs from `content/0.2.0` it is removed;
 *   - stop ends the keeper, the host and the terminal.
 *
 * CI runs it in the `keeper e2e` job (.github/workflows/build.yml) with `--no-build` after the
 * job's own `pnpm bundle:host` and `cargo build`. Every process it starts, and everything those
 * start, is killed before it exits (`keeper-test-processes.mjs`). `KEEP_TEMP=1` keeps the folders.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { rawPublicKey, throwawayKey, writeContentManifest, type SigningKey } from './content-manifest.mjs'
import { cleanupOnExit, killFamily, once, printLogTails } from './keeper-test-processes.mjs'
import { buildShellExe, TAURI_DIR } from './shell-bundle.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const flag = (name: string) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}
const TARGET = flag('--target-dir') ?? process.env.KEEPER_TARGET_DIR ?? '/tmp/centralu-keeper-target'
const HOST_SRC = join(ROOT, 'apps/desktop/src-tauri/resources/host')
const PLATFORM = `${process.platform}-${process.arch}`

let failures = 0
const started = new Set<number>()
const tempDirs: string[] = []
const log = (msg: string) => process.stdout.write(`${msg}\n`)
function check(cond: unknown, what: string, detail = ''): boolean {
  if (cond) log(`  ok   ${what}`)
  else {
    failures++
    log(`  FAIL ${what}${detail ? `\n       ${detail}` : ''}`)
  }
  return Boolean(cond)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(fn: () => Promise<T> | T, timeoutMs: number, stepMs = 200): Promise<T | undefined> {
  const end = Date.now() + timeoutMs
  for (;;) {
    let v: T | undefined
    try {
      v = await fn()
    } catch {
      v = undefined
    }
    if (v) return v
    if (Date.now() > end) return undefined
    await sleep(stepMs)
  }
}
function alive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
/**
 * The executable a process runs now. Linux's `ps -o comm=` gives the name alone (`centralu-keeper`),
 * not the path macOS's gives, so there it is read from /proc as keeper-handoff-integration.mjs does.
 */
function exeOf(pid: number): string {
  if (process.platform === 'linux') {
    try {
      return readlinkSync(`/proc/${pid}/exe`)
    } catch {
      return ''
    }
  }
  return (spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim()
}

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** One request, one answer line, on a fresh connection to a keeper socket */
function request(sock: string, body: Json, timeoutMs = 8000): Promise<Json> {
  return new Promise((resolve, reject) => {
    const c = createConnection(sock)
    let buf = ''
    const timer = setTimeout(() => {
      c.destroy()
      reject(new Error('timeout'))
    }, timeoutMs)
    c.on('connect', () => c.write(`${JSON.stringify(body)}\n`))
    c.on('data', (d) => {
      buf += String(d)
      const lines = buf.split('\n')
      for (const l of lines.slice(0, -1)) {
        const v = JSON.parse(l) as Json
        if (body.op === 'hello' && v.rid === undefined && v.keeperPid) {
          c.write(`${JSON.stringify({ op: 'list', rid: 1 })}\n`)
          continue
        }
        clearTimeout(timer)
        c.end()
        return resolve(v)
      }
      buf = lines.at(-1) ?? ''
    })
    c.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}
const status = (sock: string) => request(sock, { op: 'status' }).then((r) => r.view as Json)
const heldChildren = (data: string) => request(join(data, 'children.sock'), { op: 'hello', protocol: 1 }).then((r) => (r.children ?? []) as Json[])

/** A stand-in for the window: attached until killed, writing every pushed line to a file */
function attachClient(sock: string, out: string): number {
  const code = `
    const fs = require('node:fs')
    const c = require('node:net').createConnection(${JSON.stringify(sock)})
    c.on('connect', () => c.write(JSON.stringify({ op: 'attach', protocol: 1 }) + '\\n'))
    c.on('data', (d) => fs.appendFileSync(${JSON.stringify(out)}, d))
    c.on('close', () => { fs.appendFileSync(${JSON.stringify(out)}, '{"closed":true}\\n'); process.exit(0) })
    setInterval(() => {}, 1 << 30)
  `
  const pid = spawn(process.execPath, ['-e', code], { stdio: 'ignore' }).pid as number
  started.add(pid)
  return pid
}

/** A WebSocket client of the host through the front door: RPCs and terminal frames */
async function hostClient(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const pending = new Map<string, { resolve: (v: Json) => void; reject: (e: Error) => void }>()
  const frames: Json[] = []
  let closed = false
  let next = 1
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no hello_ok')), 8000)
    ws.onopen = () => ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: 1 }))
    ws.onmessage = (e) => {
      const f = JSON.parse(String(e.data)) as Json
      if (f.kind === 'hello_ok') {
        clearTimeout(timer)
        resolve()
      } else if (f.kind === 'res' && pending.has(f.id)) {
        const p = pending.get(f.id)!
        pending.delete(f.id)
        if (f.ok) p.resolve(f.result)
        else p.reject(new Error(f.error?.message ?? 'rpc failed'))
      } else if (f.kind === 'term') frames.push(f)
    }
    ws.onerror = () => reject(new Error('websocket error'))
  })
  ws.onclose = () => {
    closed = true
  }
  return {
    get closed() {
      return closed
    },
    screen: (terminalId: string) =>
      frames
        .filter((f) => f.terminalId === terminalId)
        .map((f) => f.data)
        .join(''),
    call: (method: string, params: Json, timeoutMs = 20_000) =>
      new Promise<Json>((resolve, reject) => {
        const id = String(next++)
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} timed out`))
        }, timeoutMs)
        pending.set(id, {
          resolve: (v) => (clearTimeout(timer), resolve(v)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        })
        ws.send(JSON.stringify({ kind: 'rpc', id, method, params }))
      }),
    close: () => ws.close(),
  }
}

/** Numbers printed as `<tag> <n>` on their own lines, in order */
const numbers = (text: string, tag: string) => [...text.matchAll(new RegExp(`^${tag} (\\d+)\\r?$`, 'gm'))].map((m) => Number(m[1]))
function continuous(ns: number[]): { ok: boolean; why: string } {
  if (ns.length < 2) return { ok: false, why: `only ${ns.length} numbers` }
  for (let i = 1; i < ns.length; i++) if (ns[i] !== ns[i - 1]! + 1) return { ok: false, why: `${ns[i - 1]} then ${ns[i]} at ${i}` }
  return { ok: true, why: `${ns[0]}..${ns.at(-1)}` }
}

/** Keeper pids the log names as successors, to kill at the end with everything else */
const successorsInLog = (data: string) =>
  existsSync(join(data, 'keeper.log')) ? [...readFileSync(join(data, 'keeper.log'), 'utf8').matchAll(/handing over to keeper pid (\d+)/g)].map((m) => Number(m[1])) : []

// ---- builds

/** The debug keeper trusting `testKey` as well, copied out; the plain debug keeper is put back. */
function buildTestKeeper(testKey: string, out: string): void {
  const args = ['build', '--manifest-path', join(TAURI_DIR, 'Cargo.toml'), '-p', 'centralu', '--bin', 'centralu-keeper', '--target-dir', TARGET]
  const env = { ...process.env }
  delete env.CENTRALU_KEEPER_TEST_KEY
  const withKey = [...args, '--features', 'centralu-keeper-core/test-key']
  execFileSync('cargo', withKey, { stdio: ['ignore', 'inherit', 'inherit'], env: { ...env, CENTRALU_KEEPER_TEST_KEY: testKey } })
  copyFileSync(join(TARGET, 'debug', 'centralu-keeper'), out)
  chmodSync(out, 0o755)
  // The other keeper scripts run target/debug/centralu-keeper: it must be the plain build again
  execFileSync('cargo', args, { stdio: ['ignore', 'inherit', 'inherit'], env })
}

interface Bundle {
  name: string
  version: string
  app: string
  exe: string
  content: string
  commit: string
}

/** `<root>/<name>/Centralu.app` with the test keeper in `Contents/MacOS/` and signed content */
function makeBundle(root: string, name: string, version: string, keeper: string, key: SigningKey, spoil?: (content: string) => void): Bundle {
  const app = join(root, name, 'Centralu.app')
  const exe = join(app, 'Contents/MacOS/centralu-keeper')
  const content = join(app, 'Contents/Resources/content')
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
  copyFileSync(keeper, exe)
  chmodSync(exe, 0o755)
  mkdirSync(content, { recursive: true })
  copyFileSync(keeper, join(content, 'centralu-keeper'))
  chmodSync(join(content, 'centralu-keeper'), 0o755)
  cpSync(HOST_SRC, join(content, 'host'), { recursive: true })
  const infoPath = join(content, 'host/bundle-info.json')
  const commit = `content-${name}`
  writeFileSync(infoPath, JSON.stringify({ ...JSON.parse(readFileSync(infoPath, 'utf8')), commit, builtAt: new Date().toISOString() }))
  writeContentManifest(content, { appVersion: version, platform: PLATFORM }, key, [])
  // The window's own host, beside the content as in a real bundle: what a keeper started directly
  // would run, and what a keeper from verified content must never read
  cpSync(join(content, 'host'), join(app, 'Contents/Resources/resources/host'), { recursive: true })
  spoil?.(content)
  return { name, version, app, exe, content, commit }
}

/** What a window of this bundle sends (sidecar.rs `switch_build`); a keeper from content never reads `hostDir` */
const switchFrom = (b: Bundle) => ({
  op: 'switch',
  source: { commit: b.commit, hostDir: join(b.app, 'Contents/Resources/resources/host'), bundlePath: b.app, version: b.version },
  keeper: { exe: b.exe },
})

async function readyView(sock: string, notPid?: number): Promise<Json | undefined> {
  return waitFor(async () => {
    const v = await status(sock)
    return v?.status?.state === 'ready' && v.hostPid && v.hostPid !== notPid && v
  }, 60_000, 250)
}

const contentEntries = (data: string) => (existsSync(join(data, 'content')) ? readdirSync(join(data, 'content')).sort() : [])

async function scenario(testKeeper: string, testShell: string, key: SigningKey): Promise<void> {
  const builds = mkdtempSync(join(tmpdir(), 'ckc-builds-'))
  tempDirs.push(builds)
  // Short: keeper.sock must stay under the 104-byte limit for unix socket paths
  const data = mkdtempSync('/tmp/ckc-')
  tempDirs.push(data)
  const project = mkdtempSync('/tmp/ckc-proj-')
  tempDirs.push(project)
  execFileSync('git', ['init', '-q'], { cwd: project })
  const sock = join(data, 'keeper.sock')
  const keeperLog = () => (existsSync(join(data, 'keeper.log')) ? readFileSync(join(data, 'keeper.log'), 'utf8') : '')
  const env = { ...process.env, CC_DATA_DIR: data }

  const A = makeBundle(builds, 'A', '0.2.0', testKeeper, key)
  const B = makeBundle(builds, 'B', '0.2.1', testKeeper, key)
  const tampered = makeBundle(builds, 'C', '0.2.2', testKeeper, key, (c) => writeFileSync(join(c, 'host/schema.sql'), '-- not what was signed\n'))
  const old = makeBundle(builds, 'D', '0.1.9', testKeeper, key)

  log('\nthe shell starts keeper A from a verified copy of content 0.2.0')
  const r = spawnSync(testShell, ['--content', A.content, '--data-dir', data, '--bundle-path', A.app, '--nonce', 'n-a'], { encoding: 'utf8', timeout: 60_000, env })
  const shellStatus = existsSync(join(data, 'shell-status.json')) ? (JSON.parse(readFileSync(join(data, 'shell-status.json'), 'utf8')) as Json) : {}
  if (typeof shellStatus.keeperPid === 'number') started.add(shellStatus.keeperPid)
  if (!check(r.status === 0 && shellStatus.result === 'started', 'the shell started a keeper', `exit ${r.status}: ${r.stderr}`)) return
  let view = await readyView(sock)
  if (!check(view, 'keeper A brings its host up', keeperLog().slice(-2000))) return
  const keeperA = view!.keeper.pid as number
  started.add(keeperA)
  const contentA = join(data, 'content/0.2.0')
  check(real(exeOf(keeperA)) === real(join(contentA, 'centralu-keeper')), 'keeper A runs from <data>/content/0.2.0/', exeOf(keeperA))
  check(real(view!.source?.copyDir ?? '') === real(join(contentA, 'host')), "its host runs from that copy's host/", JSON.stringify(view!.source))
  check(!existsSync(join(data, 'hosts')), 'and nothing was copied into <data>/hosts/')
  check(keeperLog().includes('running from verified content') && keeperLog().includes('a test build'), 'the keeper log says it runs from verified content, as a test build')

  const windowOut = join(data, 'window.jsonl')
  attachClient(sock, windowOut)
  await waitFor(async () => (await status(sock))?.attached === 1, 5000)
  const door = { port: view!.status.port as number, token: view!.status.token as string }
  const host = await hostClient(door.port, door.token)
  const p = await host.call('projects.add', { path: project })
  const term = await host.call('terminal.create', { projectId: p.id, cols: 80, rows: 24 })
  await sleep(1500)
  await host.call('terminal.input', { terminalId: term.terminalId, data: 'i=0; while true; do echo "C $i"; i=$((i+1)); sleep 0.05; done\n' })
  check(await waitFor(() => numbers(host.screen(term.terminalId), 'C').length > 10, 15_000), 'the terminal counts', host.screen(term.terminalId).slice(-300))
  const hostPid = view!.hostPid as number
  started.add(hostPid)
  const before = await heldChildren(data)
  for (const c of before) started.add(c.pid)
  const termPid = before.find((c) => c.tag?.kind === 'terminal')?.pid as number | undefined
  check(termPid && alive(termPid), 'the keeper holds the terminal', JSON.stringify(before))

  const refusedWith = async (b: Bundle, reason: string) => {
    const sw = await request(sock, switchFrom(b))
    check(sw.ok, `the switch to ${b.version} is accepted for checking`, JSON.stringify(sw))
    const v = await waitFor(async () => {
      const s = await status(sock)
      return s?.swap?.phase === 'failed' && s?.swap?.target?.version === b.version && s
    }, 30_000, 100)
    check(v?.swap?.refused === reason, `refused: ${reason}`, JSON.stringify(v?.swap))
    log(`  (the window reads: ${v?.swap?.message})`)
    check(v?.keeper?.pid === keeperA && alive(keeperA), 'keeper A still serves')
    check(v?.hostPid === hostPid && alive(hostPid), 'its host was not touched')
    check(!contentEntries(data).some((n) => n.includes(b.version)), `nothing of ${b.version} is in <data>/content/`, contentEntries(data).join(', '))
  }

  log('\ncontent 0.2.2, changed after signing, is refused')
  await refusedWith(tampered, 'content')
  check(!readFileSync(windowOut, 'utf8').includes('"closed"'), 'the window is still attached')
  check(Array.isArray(await host.call('sessions.list', {})) && !host.closed, 'the WebSocket still answers')

  log('\ncontent 0.1.9, older than what ran here, is refused')
  await refusedWith(old, 'downgrade')

  log('\nkeeper A hands over to keeper B in a verified copy of content 0.2.1 (upgrade)')
  const up = await request(sock, { op: 'upgrade', exe: B.exe, source: switchFrom(B).source })
  check(up.ok, 'the upgrade is accepted', JSON.stringify(up))
  view = await waitFor(async () => {
    const v = await status(sock)
    return v?.keeper?.pid !== keeperA && v?.keeper?.build?.commit === B.commit && v
  }, 30_000, 100)
  for (const pid of successorsInLog(data)) started.add(pid)
  if (!check(view, 'keeper B answers on the same socket', keeperLog().slice(-2500))) return
  const keeperB = view!.keeper.pid as number
  const contentB = join(data, 'content/0.2.1')
  check(real(exeOf(keeperB)) === real(join(contentB, 'centralu-keeper')), 'keeper B runs from <data>/content/0.2.1/, not from the bundle', exeOf(keeperB))
  check(keeperLog().includes(`verified Centralu 0.2.1 into ${contentB}`), 'keeper A verified and copied it first')
  check(await waitFor(() => !alive(keeperA), 10_000), 'keeper A has exited')
  check(view!.hostPid === hostPid && alive(hostPid), 'the host is the same process')
  check(view!.status.port === door.port && view!.status.token === door.token, 'the front door has the same port and token')
  const after = await heldChildren(data)
  check(after.some((c) => c.pid === termPid && c.alive), 'the terminal is the same process, held by keeper B', JSON.stringify(after))
  check(!readFileSync(windowOut, 'utf8').includes('"closed"'), 'the window was never dropped')
  await sleep(1500)
  const counted = continuous(numbers(host.screen(term.terminalId), 'C'))
  check(counted.ok, `the terminal counter is continuous across the handoff (${counted.why})`)
  check(readFileSync(join(data, 'content/highest-started'), 'utf8').trim() === '0.2.1', 'keeper B raised the floor to 0.2.1')
  check(existsSync(join(contentA, 'host/main.mjs')), 'content/0.2.0 stays while the host runs from it')

  log('\nthe 0.2.1 window switches: only the host moves, and content/0.2.0 goes once unused')
  const sw = await request(sock, switchFrom(B))
  check(sw.ok, 'the switch is accepted', JSON.stringify(sw))
  view = await waitFor(async () => {
    const v = await status(sock)
    return v?.source?.commit === B.commit && v?.status?.state === 'ready' && v?.swap?.phase === 'done' && v
  }, 60_000, 250)
  if (!check(view, 'the host is on 0.2.1', keeperLog().slice(-2500))) return
  started.add(view!.hostPid)
  check(view!.keeper.pid === keeperB, 'keeper B stays (it already runs this content)')
  check(real(view!.source?.copyDir ?? '') === real(join(contentB, 'host')), "the new host runs from content/0.2.1's host/", JSON.stringify(view!.source))
  check(alive(termPid), 'the terminal is still the same process')
  check(await waitFor(() => !existsSync(contentA), 15_000), 'content/0.2.0 was removed once nothing ran from it', contentEntries(data).join(', '))
  check(
    JSON.stringify(contentEntries(data)) === JSON.stringify(['0.2.1', 'highest-started']),
    'content/ holds the version in use and the floor, no partial copy',
    contentEntries(data).join(', '),
  )

  log('\nquit completely')
  const pids = [keeperB, view!.hostPid as number, termPid as number].filter(alive)
  host.close()
  check((await request(sock, { op: 'stop' })).ok, 'stop is accepted')
  check(await waitFor(() => pids.every((pid) => !alive(pid)), 20_000, 250), 'the keeper, the host and the terminal are gone', pids.filter(alive).join(', '))
  // The stand-in window exits by itself once the keeper closes its connection; the cleanup ends it otherwise
}

const cleanup = once((threw: boolean) => {
  if (failures > 0 || threw) printLogTails(tempDirs, log)
  killFamily([...started, ...tempDirs.flatMap((d) => successorsInLog(d))])
  if (process.env.KEEP_TEMP) log(`kept: ${tempDirs.join(' ')}`)
  else
    for (const d of tempDirs) {
      // The content copies are read-only; give the owner write back before removing them
      spawnSync('chmod', ['-R', 'u+w', d])
      rmSync(d, { recursive: true, force: true })
    }
})

async function main(): Promise<void> {
  if (!process.argv.includes('--no-build')) {
    log('bundling the host (pnpm bundle:host)')
    execFileSync('pnpm', ['bundle:host'], { cwd: ROOT, stdio: 'inherit' })
  }
  if (!existsSync(join(HOST_SRC, 'main.mjs'))) throw new Error(`no bundled host at ${HOST_SRC} (pnpm bundle:host)`)
  const key = throwawayKey()
  const testKey = rawPublicKey(key.publicKey).toString('base64')
  const work = mkdtempSync(join(tmpdir(), 'ckc-bin-'))
  tempDirs.push(work)
  log(`building a test keeper and a test shell trusting a throwaway key (target ${TARGET})`)
  const testKeeper = join(work, 'centralu-keeper-test')
  buildTestKeeper(testKey, testKeeper)
  const testShell = join(work, 'centralu-shell-test')
  copyFileSync(buildShellExe({ targetDir: TARGET, release: false, testKey }), testShell)
  chmodSync(testShell, 0o755)
  await scenario(testKeeper, testShell, key)
}

cleanupOnExit(cleanup, log)
try {
  await main()
} catch (e) {
  failures++
  log(`\nerror: ${(e as Error)?.stack ?? String(e)}`)
} finally {
  cleanup(false)
}
log(failures === 0 ? '\nall keeper content checks passed' : `\n${failures} keeper content check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
