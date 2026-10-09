import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fakeRegistry, sha256, tarGz, type FakePackage, type FakeRegistry } from './fake-registry.test-helpers.js'
import { installRemote, installScript, type RemoteRuntime } from './install.js'
import { SshTunnel } from './tunnel.js'
import { parseStopLine, rollbackRemote, uninstallRemote, updateRemote, type HostControl, type UpdateStep } from './update.js'

/**
 * Update, rollback and uninstall (plan §10.5, phase 3 step 4) against the installer's harness: a fake
 * `ssh` hands each command to this machine's `sh` under a fake HOME, packages and Node come from a
 * fake registry, and the scripts and `remote-install.mjs` run for real. Each fake `centralu.mjs`
 * plays its version's `serve`: `--stop` and `--detach` write what happened to `<data>/events` and
 * which version runs to `<data>/running`; `FAKE_BROKEN=<version>` makes that version fail to start
 * and leave a line in `host.log`. `--autostart off` removes `<data>/autostart`, the stand-in for a boot
 * entry; `FAKE_AUTOSTART_FAILS` makes it refuse, `FAKE_NO_AUTOSTART` plays a version that predates it.
 */

const SERVE_MJS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packaging/npm/centralu/bin/serve.mjs')
const NODE_V = '24.21.0'
const NODE_FILE = `node-v${NODE_V}-linux-x64.tar.gz`

const fakeServe = (version: string) => `import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
const d = process.env.CC_DATA_DIR || process.env.HOME + '/.centralu'
const a = process.argv.slice(2).join(' ')
const log = (s) => appendFileSync(d + '/events', s + '\\n')
if (a === 'serve --stop') {
  const was = existsSync(d + '/running')
  log('stop ' + (was ? readFileSync(d + '/running', 'utf8') : '-'))
  rmSync(d + '/running', { force: true })
  console.log(JSON.stringify({ v: 1, stop: process.env.FAKE_STOP_FAILS ? { ok: false, wasRunning: true, message: 'the host on 127.0.0.1:4141 is still running' } : { ok: true, wasRunning: was } }))
} else if (a === 'serve --detach') {
  log('start ${version}')
  if (process.env.FAKE_BROKEN === '${version}') {
    appendFileSync(d + '/host.log', 'host ${version}: the store was written by a newer Centralu\\n')
    console.log(JSON.stringify({ v: 1, detach: { ok: false, reason: 'exited', message: 'the host exited before it answered' } }))
  } else {
    writeFileSync(d + '/running', '${version}')
    console.log(JSON.stringify({ v: 1, port: 4141, token: 't', version: '${version}', protocolVersion: 1, dataDir: d, hostRunning: true, detach: { ok: true, how: 'setsid' } }))
  }
} else if (a === 'serve --autostart off') {
  log('autostart off')
  if (process.env.FAKE_NO_AUTOSTART) {
    console.error('unknown option for serve: --autostart')
    process.exitCode = 2
  } else if (process.env.FAKE_AUTOSTART_FAILS) {
    console.log(JSON.stringify({ v: 1, autostart: { ok: false, on: true, how: 'systemd', linger: null, message: 'Failed to connect to bus' } }))
  } else {
    rmSync(d + '/autostart', { force: true })
    console.log(JSON.stringify({ v: 1, autostart: { ok: true, on: false, how: 'systemd', linger: null } }))
  }
} else console.log('unexpected ' + a)
`

describe('parseStopLine', () => {
  it('reads serve --stop’s line under anything else it printed, and nothing else', () => {
    expect(parseStopLine('motd\n{"v":1,"stop":{"ok":true,"wasRunning":true,"how":"asked"}}\n')).toEqual({ ok: true, wasRunning: true, message: null })
    expect(parseStopLine('{"v":1,"stop":{"ok":false,"wasRunning":true,"message":"still running"}}')).toEqual({ ok: false, wasRunning: true, message: 'still running' })
    expect(parseStopLine('{"v":1,"port":1}\nCENTRALU-NOT-FOUND\n')).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('update, rollback and uninstall over a fake ssh into a real sh (plan §10.5)', () => {
  let root: string
  let home: string
  let reg: FakeRegistry
  let runtime: RemoteRuntime

  const pkgs = (version: string): FakePackage[] => [
    {
      name: 'centralu',
      version,
      files: {
        'package.json': JSON.stringify({ name: 'centralu', version }),
        'bin/centralu.mjs': fakeServe(version),
        'bin/serve.mjs': `export { managedLauncherScript } from ${JSON.stringify(pathToFileURL(SERVE_MJS).href)}\n`,
      },
    },
    { name: '@centralu/linux-x64', version, files: { 'package.json': '{}', 'host/main.mjs': 'export {}\n' } },
  ]

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-update-'))
    home = join(root, 'home')
    const bin = join(root, 'bin')
    mkdirSync(home, { recursive: true })
    mkdirSync(bin, { recursive: true })
    const tool = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(bin, name), 0o755)
    }
    tool('uname', 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) /usr/bin/uname "$@" ;; esac')
    tool('getconf', 'echo "glibc 2.39"')
    writeFileSync(
      join(root, 'ssh'),
      `#!${process.execPath}\nconst r = require('node:child_process').spawnSync('/bin/sh', ['-c', process.argv.at(-1)], { stdio: 'inherit' })\nprocess.exit(r.status ?? 1)\n`,
    )
    chmodSync(join(root, 'ssh'), 0o755)
    const archive = tarGz(`node-v${NODE_V}-linux-x64`, { 'bin/node': { text: `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, mode: 0o755 }, LICENSE: 'MIT' })
    reg = await fakeRegistry([...pkgs('9.9.1'), ...pkgs('9.9.2'), ...pkgs('9.9.3')])
    reg.addNodeArchive(NODE_V, NODE_FILE, archive)
    runtime = { node: { version: NODE_V, archives: { 'linux-x64': { file: NODE_FILE, sha256: sha256(archive) } } } }
  })
  afterAll(async () => {
    await reg.close()
    rmSync(root, { recursive: true, force: true })
  })
  afterEach(() => rmSync(join(home, '.centralu'), { recursive: true, force: true }))

  const data = (...p: string[]) => join(home, '.centralu', ...p)
  const remote = (...p: string[]) => data('remote', ...p)
  const events = () => (existsSync(data('events')) ? readFileSync(data('events'), 'utf8').trim().split('\n') : [])
  const running = () => (existsSync(data('running')) ? readFileSync(data('running'), 'utf8') : null)

  /** A HostControl as LinkedMachine gives one, with this machine as the remote; what it saw is kept */
  const control = (env: Record<string, string> = {}) => {
    const t = new SshTunnel({ target: 'box', ssh: join(root, 'ssh'), env: { HOME: home, PATH: `${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, ...env } })
    const seen: string[] = []
    const c: HostControl = {
      exec: (cmd) => t.exec(cmd),
      spec: { shell: 'posix' },
      target: 'box',
      script: installScript(),
      hold: () => void seen.push('hold'),
      start: async () => {
        const how = await t.startHost()
        if (how.how !== 'detached') throw new Error('not detached')
      },
      answers: async (version) => {
        seen.push(`answers ${version}`)
        return running() === version
      },
      step: (s: UpdateStep) => void seen.push(s),
    }
    return { c, seen }
  }
  const update = (version: string, env?: Record<string, string>) => {
    const { c, seen } = control(env)
    return { seen, done: updateRemote(c, { version, runtime, registry: { registry: reg.url }, nodeDist: `${reg.url}/dist` }) }
  }
  /** 9.9.1 installed by the hub and running, as after an earlier install and a link that started it */
  const installedAndRunning = async () => {
    const { c } = control()
    await installRemote({ exec: c.exec, spec: c.spec, target: 'box', version: '9.9.1', runtime, script: c.script, registry: { registry: reg.url }, nodeDist: `${reg.url}/dist` })
    await c.start()
    expect(running()).toBe('9.9.1')
    rmSync(data('events'))
  }

  it('installs beside, stops the old host before switching, starts the new one, checks it, then prunes', async () => {
    await installedAndRunning()
    const { seen, done } = update('9.9.2')
    const r = await done
    expect(r).toMatchObject({ current: { version: '9.9.2', node: NODE_V }, previous: { version: '9.9.1', node: NODE_V } })
    // The old version stopped itself (its own serve), then the new one started: the stop ran before the switch
    expect(events()).toEqual(['stop 9.9.1', 'start 9.9.2'])
    expect(running()).toBe('9.9.2')
    expect(seen).toEqual(['preflight', 'registry', 'node', 'centralu', 'hold', 'stop', 'switch', 'start', 'check', 'answers 9.9.2', 'prune'])
    expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.2 ${NODE_V}\n`)
    expect(readFileSync(remote('previous'), 'utf8')).toBe(`9.9.1 ${NODE_V}\n`)
    // A third version removes the first only once it answered
    expect(await update('9.9.3').done).toMatchObject({ current: { version: '9.9.3' }, previous: { version: '9.9.2' }, removed: ['9.9.1'] })
    expect(readdirSync(remote('versions')).sort()).toEqual(['9.9.2', '9.9.3'])
  }, 90_000)

  it('touches nothing that runs when the old host will not stop: the new version waits beside', async () => {
    await installedAndRunning()
    await expect(update('9.9.2', { FAKE_STOP_FAILS: '1' }).done).rejects.toThrow(/Centralu on box could not be stopped: the host on 127\.0\.0\.1:4141 is still running/)
    expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${NODE_V}\n`)
    expect(existsSync(remote('previous'))).toBe(false)
    expect(existsSync(remote('versions', '9.9.2', 'install.json'))).toBe(true)
    expect(events()).toEqual(['stop 9.9.1'])
  }, 60_000)

  it('puts the old version back and starts it when the new one does not answer, with the end of its log', async () => {
    await installedAndRunning()
    const { seen, done } = update('9.9.2', { FAKE_BROKEN: '9.9.2' })
    await expect(done).rejects.toThrow(
      /Centralu 9\.9\.2 did not start on box \(the host exited before it answered\); it runs Centralu 9\.9\.1 again\. The end of its host\.log: host 9\.9\.2: the store was written by a newer Centralu/,
    )
    expect(seen.slice(-5)).toEqual(['hold', 'stop', 'switch', 'start', 'roll_back'])
    expect(events()).toEqual(['stop 9.9.1', 'start 9.9.2', 'stop -', 'start 9.9.1'])
    expect(running()).toBe('9.9.1')
    // The pointers are what they were, and nothing was removed: both versions are still there
    expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${NODE_V}\n`)
    expect(existsSync(remote('previous'))).toBe(false)
    expect(readdirSync(remote('versions')).sort()).toEqual(['9.9.1', '9.9.2'])
  }, 60_000)

  it('rolls back one step: previous becomes current, and there is no previous left to go back to', async () => {
    await installedAndRunning()
    await update('9.9.2').done
    rmSync(data('events'))
    const { c, seen } = control()
    const r = await rollbackRemote(c, { current: { version: '9.9.2', node: NODE_V }, previous: { version: '9.9.1', node: NODE_V } })
    expect(r).toEqual({ current: { version: '9.9.1', node: NODE_V }, previous: null, removed: [], left: [] })
    expect(seen).toEqual(['hold', 'stop', 'switch', 'start', 'check', 'answers 9.9.1'])
    expect(events()).toEqual(['stop 9.9.2', 'start 9.9.1'])
    expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${NODE_V}\n`)
    expect(existsSync(remote('previous'))).toBe(false)
    // The newer version stays on disk, so updating again does not download it again
    expect(existsSync(remote('versions', '9.9.2', 'install.json'))).toBe(true)
    const hits = reg.hits.length
    await update('9.9.2').done
    expect(reg.hits.slice(hits).filter((h) => h.endsWith('.tgz'))).toEqual([])
  }, 90_000)

  it('a first update over an install of its own (npm) leaves nothing to point back to when it fails', async () => {
    const { seen, done } = update('9.9.2', { FAKE_BROKEN: '9.9.2' })
    await expect(done).rejects.toThrow(/did not start on box .*; the Centralu that was there is back in place/)
    expect(seen).toContain('roll_back')
    // No pointer and no launcher: the lookup finds whatever ran there before
    expect(existsSync(remote('current'))).toBe(false)
    expect(existsSync(remote('bin', 'centralu'))).toBe(false)
  }, 60_000)

  it('uninstalls: stops the host, removes <data>/remote, keeps the rest of the data', async () => {
    await installedAndRunning()
    writeFileSync(data('serve.json'), '{"token":"t"}')
    // A host that will not stop keeps its files: on Windows they could not all be removed anyway
    await expect(uninstallRemote(control({ FAKE_STOP_FAILS: '1' }).c)).rejects.toThrow(/could not be stopped/)
    expect(existsSync(remote('versions', '9.9.1', 'install.json'))).toBe(true)
    writeFileSync(data('running'), '9.9.1')
    writeFileSync(data('autostart'), 'on')
    rmSync(data('events'))
    const { c, seen } = control()
    expect(await uninstallRemote(c)).toEqual({ stopped: true })
    expect(seen).toEqual(['hold', 'stop', 'autostart', 'remove'])
    // The boot entry goes, through the Centralu it would start, after the host stopped and before its files go
    expect(events()).toEqual(['stop 9.9.1', 'autostart off'])
    expect(existsSync(data('autostart'))).toBe(false)
    expect(existsSync(remote())).toBe(false)
    expect(existsSync(data('serve.json'))).toBe(true)
    expect(running()).toBeNull()
  }, 60_000)

  it('does not uninstall when the boot entry would not go: it would start a launcher that is gone at every boot', async () => {
    await installedAndRunning()
    writeFileSync(data('autostart'), 'on')
    await expect(uninstallRemote(control({ FAKE_AUTOSTART_FAILS: '1' }).c)).rejects.toThrow('Centralu on box could not stop starting at boot: Failed to connect to bus')
    expect(existsSync(remote('versions', '9.9.1', 'install.json'))).toBe(true)
    expect(existsSync(data('autostart'))).toBe(true)
  }, 60_000)

  it('uninstalls a version that predates --autostart: it cannot have written an entry from here', async () => {
    await installedAndRunning()
    const { c, seen } = control({ FAKE_NO_AUTOSTART: '1' })
    expect(await uninstallRemote(c)).toEqual({ stopped: true })
    expect(seen).toEqual(['hold', 'stop', 'autostart', 'remove'])
    expect(existsSync(remote())).toBe(false)
  }, 60_000)
})
