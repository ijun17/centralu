#!/usr/bin/env node
/* global process, Buffer, setTimeout, clearTimeout, WebSocket */
/**
 * Probe 4 of docs/plans/remote-hub.md (§10.6): where the hub's ssh should live across a blue-green hub swap.
 *
 *   node probe4-swap.mjs --keeper <centralu-keeper> --host <resources/host> --target <user@host>
 *        --identity <key> --command <remote command> [--shell powershell|posix] [--mode child|persist]
 *        [--swaps 5]
 *
 * A real keeper (`--keeper`, the released executable or a `cargo build`) runs the real bundled host on a
 * temporary CC_DATA_DIR; through the front door the probe links that hub to a remote `centralu serve`
 * over the real ssh, then asks the keeper to swap the host between two builds (the same host folder
 * under two commits) and times, for every swap:
 *
 *   door closed   the old host drained (the front door closed the probe's connection)
 *   host serving  a new connection through the front door got hello_ok from the new host
 *   link up       the new host's `machines.list` says the machine is connected
 *
 * Modes, through an `ssh` wrapper first on the hub's PATH (the host runs `ssh` by name):
 *   child    phase 1 as built: plain ssh, children of the host, ended with it
 *   persist  the same commands with OpenSSH ControlMaster=auto and ControlPersist: the first ssh
 *            becomes a master that backgrounds itself; later ones are its mux clients
 *
 * The keeper-child option has no code yet, so it is estimated: with the forward of the current link
 * left up, a fresh hello plus `sessions.list` and `projects.list` over it, which is what a new host
 * would pay if the forward had survived (`--reuse 10` repetitions, after the swaps).
 *
 * Starts nothing outside its temporary folders, and at the end stops the keeper and everything it
 * started (`keeper-test-processes.mjs`), and in persist mode asks the master to exit. Prints no token.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { cleanupOnExit, familyOf, killFamily, once } from '../../../scripts/keeper-test-processes.mjs'

const { values: a } = parseArgs({
  options: {
    keeper: { type: 'string' },
    host: { type: 'string' },
    target: { type: 'string' },
    identity: { type: 'string' },
    command: { type: 'string' },
    shell: { type: 'string', default: 'powershell' },
    mode: { type: 'string', default: 'child' },
    swaps: { type: 'string', default: '5' },
    reuse: { type: 'string', default: '10' },
  },
})
for (const k of ['keeper', 'host', 'target', 'identity', 'command']) if (!a[k]) throw new Error(`--${k} is required`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => process.stdout.write(`${s}\n`)
async function waitFor(fn, ms, step = 50) {
  const end = Date.now() + ms
  for (;;) {
    let v
    try {
      v = await fn()
    } catch {
      v = undefined
    }
    if (v) return v
    if (Date.now() > end) return undefined
    await sleep(step)
  }
}

// Short: unix socket paths are limited to 104 bytes on macOS
const work = mkdtempSync('/tmp/c4-')
const data = join(work, 'd')
const bin = join(work, 'bin')
mkdirSync(data)
mkdirSync(bin)
const controlPath = join(work, 'cm-%C')
const mux = a.mode === 'persist' ? `-o ControlMaster=auto -o ControlPath=${controlPath} -o ControlPersist=300` : ''
writeFileSync(
  join(bin, 'ssh'),
  `#!/bin/sh\nexec /usr/bin/ssh -i '${a.identity}' -o IdentitiesOnly=yes ${mux} "$@"\n`,
)
chmodSync(join(bin, 'ssh'), 0o755)

// Two builds of one host: the keeper swaps only between different commits
const info = JSON.parse(readFileSync(join(a.host, 'bundle-info.json'), 'utf8'))
const builds = ['p4a', 'p4b'].map((commit) => {
  const dir = join(work, `src-${commit}`)
  cpSync(a.host, dir, { recursive: true })
  writeFileSync(join(dir, 'bundle-info.json'), JSON.stringify({ ...info, commit }))
  return { commit, dir }
})

const started = []
const cleanup = once(() => {
  if (a.mode === 'persist') {
    // The master backgrounded itself out of the keeper's family; ask it to go
    spawnSync('/usr/bin/ssh', ['-o', `ControlPath=${controlPath}`, '-O', 'exit', a.target], { stdio: 'ignore' })
  }
  killFamily(started)
  rmSync(work, { recursive: true, force: true })
})
cleanupOnExit(cleanup, log)

function request(sock, body, ms = 5000) {
  return new Promise((resolve, reject) => {
    const c = createConnection(sock)
    let buf = ''
    const t = setTimeout(() => (c.destroy(), reject(new Error('timeout'))), ms)
    c.on('connect', () => c.write(`${JSON.stringify(body)}\n`))
    c.on('data', (d) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        clearTimeout(t)
        c.end()
        resolve(JSON.parse(buf.slice(0, nl)))
      }
    })
    c.on('error', (e) => (clearTimeout(t), reject(e)))
  })
}

async function client(port, token, ms = 8000) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const pending = new Map()
  let next = 1
  let onClose
  const closed = new Promise((r) => (onClose = r))
  const hello = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no hello_ok')), ms)
    ws.onopen = () => ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: 1 }))
    ws.onmessage = (e) => {
      const f = JSON.parse(String(e.data))
      if (f.kind === 'hello_ok') {
        clearTimeout(t)
        resolve(f)
      } else if (f.kind === 'res' && pending.has(f.id)) {
        const p = pending.get(f.id)
        pending.delete(f.id)
        f.ok ? p.resolve(f.result) : p.reject(new Error(f.error?.message ?? 'rpc failed'))
      }
    }
    ws.onerror = () => (clearTimeout(t), reject(new Error('websocket error')))
  })
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error('closed'))
    onClose(Date.now())
  }
  return {
    hello,
    closed,
    call: (method, params) =>
      new Promise((resolve, reject) => {
        const id = String(next++)
        pending.set(id, { resolve, reject })
        if (ws.readyState !== WebSocket.OPEN) return reject(new Error('closed'))
        ws.send(JSON.stringify({ kind: 'rpc', id, method, params }))
      }),
    close: () => ws.close(),
  }
}

async function reconnect(port, token) {
  const end = Date.now() + 60_000
  for (;;) {
    try {
      return await client(port, token, 15_000)
    } catch (e) {
      if (Date.now() > end) throw e
      await sleep(50)
    }
  }
}

/** The ssh processes of this probe: under the keeper, or (persist) carrying this probe's ControlPath */
function sshProcs() {
  const out = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' }).stdout
  const family = new Set(familyOf(started))
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /\bssh\b/.test(l) && (l.includes(work) || family.has(Number(l.split(/\s+/, 1)[0]))))
    .map((l) => {
      const [pid, ppid, pgid] = l.split(/\s+/, 3).map(Number)
      const kind = l.includes('[mux]') ? 'master' : l.includes(' -N ') ? 'forward' : l.includes(' -L ') ? 'forward(-T)' : 'ask'
      return { pid, ppid, pgid, kind }
    })
}
const describe = (ps) => ps.map((p) => `${p.kind}:${p.pid}(pg ${p.pgid})`).join(' ') || 'none'

const keeperLog = openSync(join(data, 'keeper.log'), 'a')
const keeper = spawn(
  a.keeper,
  ['--keeper', '--data-dir', data, '--host-source', builds[0].dir, '--bundle-path', '/tmp/Probe4.app', '--app-version', info.version ?? '0.0.0-probe'],
  {
    detached: true,
    stdio: ['ignore', keeperLog, keeperLog],
    env: { ...process.env, CC_DATA_DIR: data, PATH: `${bin}:${process.env.PATH}` },
  },
)
started.push(keeper.pid)
const sock = join(data, 'keeper.sock')
try {
  const view = await waitFor(async () => {
    const v = (await request(sock, { op: 'status' })).view
    return v?.status?.state === 'ready' && v
  }, 60_000)
  if (!view) throw new Error(`the keeper did not bring its host up:\n${readFileSync(join(data, 'keeper.log'), 'utf8').slice(-3000)}`)
  // A window stand-in: an attach connection held open, so the keeper does not end for lack of one
  const attach = createConnection(sock)
  attach.on('connect', () => attach.write(`${JSON.stringify({ op: 'attach', protocol: 1, build: { commit: builds[0].commit } })}\n`))
  attach.on('data', () => {})
  const { port, token } = view.status
  log(`mode ${a.mode}; keeper ${keeper.pid}, front door ${port}, data ${data}`)

  let c = await client(port, token)
  const t0 = Date.now()
  const added = await c.call('machines.add', { name: 'Probe', sshTarget: a.target, shell: a.shell, command: a.command })
  const first = await waitFor(async () => {
    const m = (await c.call('machines.list', {})).find((x) => x.id === added.id)
    return m?.status === 'connected' ? m : null
  }, 60_000)
  if (!first) {
    const m = (await c.call('machines.list', {})).find((x) => x.id === added.id)
    throw new Error(`the link did not connect: ${m?.status} ${m?.error}`)
  }
  log(`first link: connected in ${Date.now() - t0} ms, local port ${first.localPort}; ssh ${describe(sshProcs())}`)

  const rows = []
  for (let i = 0; i < Number(a.swaps); i++) {
    const to = builds[(i + 1) % 2]
    const before = sshProcs()
    const s0 = Date.now()
    const sw = await request(sock, { op: 'switch', source: { commit: to.commit, hostDir: to.dir, bundlePath: '/tmp/Probe4.app' } })
    if (!sw.ok) throw new Error(`switch refused: ${JSON.stringify(sw)}`)
    const doorClosed = await Promise.race([c.closed, sleep(60_000).then(() => null)])
    c = await reconnect(port, token)
    const serving = Date.now()
    // hello_ok.build.commit is the host's compiled-in commit; the keeper's view names the build it runs
    const runs = (await request(sock, { op: 'status' })).view?.source?.commit
    if (runs !== to.commit) log(`  (the keeper runs ${runs}, expected ${to.commit})`)
    let seen = null
    const up = await waitFor(async () => {
      const m = (await c.call('machines.list', {})).find((x) => x.id === added.id)
      seen = m
      return m?.status === 'connected' ? Date.now() : null
    }, 60_000, 25)
    const after = sshProcs()
    const kept = before.filter((p) => after.some((q) => q.pid === p.pid))
    const row = {
      swap: i + 1,
      doorClosedMs: doorClosed ? doorClosed - s0 : null,
      hostServingMs: serving - s0,
      linkUpMs: up ? up - s0 : null,
      linkAfterServingMs: up ? up - serving : null,
      gapMs: up && doorClosed ? up - doorClosed : null,
      localPort: seen?.localPort ?? null,
      sshKept: describe(kept),
      sshNow: describe(after),
    }
    rows.push(row)
    log(`swap ${row.swap}: door closed +${row.doorClosedMs} ms, new host serving +${row.hostServingMs} ms, link up +${row.linkUpMs} ms (${row.linkAfterServingMs} ms after serving; link away ${row.gapMs} ms), local port ${row.localPort}`)
    log(`  ssh kept across the swap: ${row.sshKept}; ssh now: ${row.sshNow}`)
    if (!up) log(`  link status: ${seen?.status} ${seen?.error}`)
    await sleep(1500)
  }
  const med = (k) => {
    const v = rows.map((r) => r[k]).filter((x) => x !== null).sort((x, y) => x - y)
    return v.length ? `${v[Math.floor(v.length / 2)]} (min ${v[0]}, max ${v[v.length - 1]})` : 'n/a'
  }
  log(`\nmedian over ${rows.length} swaps: door closed ${med('doorClosedMs')}, host serving ${med('hostServingMs')}, link up ${med('linkUpMs')}, link after serving ${med('linkAfterServingMs')}, link away ${med('gapMs')}`)

  // The keeper-child estimate: the forward of the current link stays; a fresh client over it
  const m = (await c.call('machines.list', {})).find((x) => x.id === added.id)
  const ask = spawnSync(join(bin, 'ssh'), ['-T', '-o', 'BatchMode=yes', '--', a.target, connectionCommand()], { encoding: 'utf8' })
  const line = JSON.parse(ask.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop() ?? '{}')
  const reuse = []
  for (let i = 0; i < Number(a.reuse) && m?.localPort && line.token; i++) {
    const r0 = Date.now()
    const rc = await client(m.localPort, line.token)
    await Promise.all([rc.call('sessions.list', {}), rc.call('projects.list', {})])
    reuse.push(Date.now() - r0)
    rc.close()
    await sleep(200)
  }
  reuse.sort((x, y) => x - y)
  log(`over a forward that survived: hello + sessions.list + projects.list ${reuse.length ? `median ${reuse[Math.floor(reuse.length / 2)]} ms (min ${reuse[0]}, max ${reuse.at(-1)})` : 'not measured'}`)
  for (const p of sshProcs().filter((x) => x.kind === 'master')) {
    // Every forward a host asked the master for, still listening after that host is gone?
    const l = spawnSync('lsof', ['-nP', '-a', '-p', String(p.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' }).stdout
    const ports = [...new Set(l.split('\n').filter((x) => x.startsWith('n')).map((x) => x.split(':').pop()))]
    log(`master ${p.pid} listens on ${ports.length} ports: ${ports.join(', ')}`)
  }
  c.close()
  attach.destroy()
  await request(sock, { op: 'stop' }).catch(() => {})
  await sleep(1000)
  log(`after stop: ssh ${describe(sshProcs())}`)
} finally {
  cleanup()
  log(`after cleanup: ssh ${describe(sshProcs())}`)
}

/** The remote's connection command, as tunnel.ts builds it for this shell and `--command` */
function connectionCommand() {
  if (a.shell === 'posix') return `${a.command} serve --connection`
  const full = `[Console]::OutputEncoding=[Text.Encoding]::UTF8\n${a.command} serve --connection`
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(full, 'utf16le').toString('base64')}`
}
