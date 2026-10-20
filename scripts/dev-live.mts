/**
 * `pnpm dev:live`: the browser dev UI (`apps/web`, live reload) against the host of the Centralu
 * app already running on this machine (#739).
 *
 *   pnpm dev:live             # http://127.0.0.1:5173/
 *   PORT=5174 pnpm dev:live   # the other origin the host accepts
 *
 * It asks the keeper for the front door's port and a credential (`<data>/keeper.sock`, op `status`)
 * and starts Vite with them in the child's environment only: `VITE_HOST_URL` and `VITE_HOST_TOKEN`.
 * The credential is never printed. It is the limited one (#1405, owner decision 2026-10-21): this
 * script is not a Centralu window, so the keeper hands it the credential every other process gets.
 * The page reads everything and does the everyday things; what cannot be undone, and the answers
 * to the person's own cards, are the app's window's: such a click raises a card there, or is refused. It only reads from the data
 * folder (`CC_DATA_DIR`, or `~/.centralu`, or `~/.centralu-dev` with `CC_DEV=1`, as the keeper
 * chooses it, `keeper/mod.rs` `data_dir`) and never writes there.
 *
 * Vite listens on 127.0.0.1, not `localhost`, which may resolve to `::1` held by another server:
 * the host accepts browser connections from `http://127.0.0.1:5173` and `:5174` only
 * (`transport/server.ts`), so the port is strict. The credential comes from the front door's token: the keeper makes
 * it once per keeper lifetime (`front_door.rs`), so it survives host swaps and changes only when
 * the app is fully quit and opened again, and the script has to be run again then.
 *
 * The page carries that credential, and a loopback port is not per user, so this is still for
 * single-user machines: another user could read every conversation and act as an everyday client
 * (docs/security-boundaries.md, "Local transport").
 *
 * The keeper is built on unix sockets, so there is nothing to read on Windows (the app runs the
 * host directly there); the script says so instead of looking for a pipe that does not exist.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import net from 'node:net'
import { constants as osConstants, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = join(ROOT, 'apps/web')

export const DEFAULT_PORT = 5173
/** The keeper drops a connection that says nothing for 5 s; wait less than that. */
const STATUS_TIMEOUT_MS = 2_000

export class LiveError extends Error {}

type Env = Record<string, string | undefined>

/** The data folder the keeper and the host choose: `CC_DATA_DIR`, else `~/.centralu` (`~/.centralu-dev` with `CC_DEV=1`). */
export function dataDir(env: Env = process.env, home: string = homedir()): string {
  const set = env.CC_DATA_DIR
  if (set && set.trim() !== '') return set
  return join(home, env.CC_DEV === '1' ? '.centralu-dev' : '.centralu')
}

export function keeperSocketPath(env: Env = process.env, home: string = homedir()): string {
  return join(dataDir(env, home), 'keeper.sock')
}

export type HostDoor = { port: number; token: string }

/** One request on the keeper's control socket: a JSON line out, a JSON line back. */
function ask(sock: string, request: unknown, timeoutMs: number): Promise<unknown> {
  return new Promise((done, fail) => {
    const conn = net.connect(sock)
    let buf = ''
    const timer = setTimeout(() => finish(new LiveError('The keeper did not answer in time; it may be updating. Try again in a moment.')), timeoutMs)
    const finish = (result: unknown) => {
      clearTimeout(timer)
      conn.destroy()
      if (result instanceof Error) fail(result)
      else done(result)
    }
    conn.on('connect', () => conn.write(`${JSON.stringify(request)}\n`))
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const end = buf.indexOf('\n')
      if (end < 0) return
      try {
        finish(JSON.parse(buf.slice(0, end)))
      } catch {
        finish(new LiveError('The keeper answered with something that is not JSON.'))
      }
    })
    conn.on('end', () => finish(new LiveError('The keeper closed the connection without an answer.')))
    conn.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') finish(new LiveError(`No Centralu app is running: no keeper socket at ${sock}. Start the app, or point CC_DATA_DIR at its data folder.`))
      else if (e.code === 'ECONNREFUSED') finish(new LiveError(`No Centralu app is running: nothing answers on ${sock} (a leftover socket). Start the app.`))
      else finish(new LiveError(`Cannot reach the keeper at ${sock}: ${e.message}`))
    })
  })
}

/** The front door's port and token from the keeper's `status` (`{ok, view: {status: {state: 'ready', port, token}}}`). */
export async function readHostDoor(env: Env = process.env, opts: { platform?: string; home?: string; timeoutMs?: number } = {}): Promise<HostDoor> {
  if ((opts.platform ?? process.platform) === 'win32') {
    throw new LiveError('Windows has no keeper (the app runs the host directly), so there is no running host to read here. Start one with `pnpm host` and see CONTRIBUTING.')
  }
  const sock = keeperSocketPath(env, opts.home)
  const reply = (await ask(sock, { op: 'status' }, opts.timeoutMs ?? STATUS_TIMEOUT_MS)) as {
    ok?: boolean
    error?: unknown
    view?: { status?: { state?: string; port?: unknown; token?: unknown; message?: unknown } }
  } | null
  if (!reply || reply.ok !== true) {
    const why = typeof reply?.error === 'string' ? `: ${reply.error}` : ''
    throw new LiveError(`The keeper refused the status request${why}`)
  }
  const status = reply.view?.status
  const state = status?.state
  if (state === 'ready' && typeof status?.port === 'number' && typeof status.token === 'string' && status.token !== '') {
    return { port: status.port, token: status.token }
  }
  if (state === 'failed') {
    const message = typeof status?.message === 'string' ? ` (${status.message})` : ''
    throw new LiveError(`The keeper has no host: it gave up starting it${message}. Restart the Centralu app.`)
  }
  if (state === 'starting' || state === 'restarting') {
    throw new LiveError(`The keeper has no host yet (${state}). Wait a moment and run this again.`)
  }
  throw new LiveError('The keeper has no host yet, or answered in a shape this script does not know. Update the repository or restart the Centralu app.')
}

/** The port to serve on: `PORT`, else 5173. */
export function servePort(env: Env = process.env): number {
  const raw = env.PORT
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT
  const n = Number(raw)
  if (!/^\d+$/.test(raw.trim()) || n < 1 || n > 65535) throw new LiveError(`PORT must be a number from 1 to 65535, got "${raw}".`)
  return n
}

/** Whether `127.0.0.1:port` can be bound right now. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = net.createServer()
    probe.once('error', () => done(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)))
  })
}

/** Vite's entry script, found from `apps/web` so that Windows needs no `.cmd` shim. */
function viteEntry(): string {
  const require = createRequire(join(WEB, 'package.json'))
  const pkgPath = require.resolve('vite/package.json')
  const bin = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin: string | { vite: string } }).bin
  return join(dirname(pkgPath), typeof bin === 'string' ? bin : bin.vite)
}

export type Launch = { args: string[]; cwd: string; env: Env }

/** Starts Vite and resolves with its exit code. Replaceable in tests. */
export type StartVite = (launch: Launch) => Promise<number>

/** The exit code a shell reports for a process a signal ended: 128 plus the signal number. */
function codeAfter(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code
  return 128 + (signal ? (osConstants.signals[signal] ?? 1) : 0)
}

/** Signals a person or a terminal sends to stop the command; Vite gets each one too. */
const FORWARDED: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/** Runs Vite from `entry` with `launch`, passes the stop signals on to it, and resolves with its exit code. */
export function launchVite({ args, cwd, env }: Launch, entry: string = viteEntry()): Promise<number> {
  return new Promise((done) => {
    const child: ChildProcess = spawn(process.execPath, [entry, ...args], { cwd, env: env as NodeJS.ProcessEnv, stdio: 'inherit' })
    const handlers = FORWARDED.map((sig) => {
      const forward = () => child.kill(sig)
      process.on(sig, forward)
      return [sig, forward] as const
    })
    const release = () => { for (const [sig, forward] of handlers) process.off(sig, forward) }
    child.on('exit', (code, signal) => { release(); done(codeAfter(code, signal)) })
    child.on('error', (e) => {
      release()
      console.error(`dev:live: Could not start Vite: ${e.message}`)
      done(1)
    })
  })
}

const startVite: StartVite = (launch) => launchVite(launch)

export type Deps = { startVite?: StartVite; log?: (line: string) => void; err?: (line: string) => void; platform?: string; home?: string }

/** The whole command. Returns the exit code; every failure is one line on stderr. */
export async function run(env: Env = process.env, deps: Deps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const err = deps.err ?? ((line: string) => console.error(line))
  try {
    const port = servePort(env)
    const door = await readHostDoor(env, { platform: deps.platform, home: deps.home })
    if (!(await portIsFree(port))) {
      throw new LiveError(`Port ${port} on 127.0.0.1 is already in use. The host accepts only 5173 and 5174: free it, or use PORT=${port === 5173 ? 5174 : 5173}.`)
    }
    log(`Open http://127.0.0.1:${port}/  (127.0.0.1, not localhost)`)
    log('Warning: the page carries a credential to this app\'s host (it reads every conversation), and any user of this machine can read it from there. Use this on a single-user machine only.')
    log('The credential stays the same until the app is fully quit and opened again: run this again then.')
    return await (deps.startVite ?? startVite)({
      args: ['--config', 'vite.config.ts', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      cwd: WEB,
      env: { ...env, VITE_HOST_URL: `ws://127.0.0.1:${door.port}`, VITE_HOST_TOKEN: door.token },
    })
  } catch (e) {
    if (e instanceof LiveError) {
      err(`dev:live: ${e.message}`)
      return 1
    }
    throw e
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run()
}
