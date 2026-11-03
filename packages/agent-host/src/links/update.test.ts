import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fakeRegistry, fakeServe, sha256, tarGz, type FakePackage, type FakeRegistry } from './fake-registry.test-helpers.js'
import { installRemote, installScript, type RemoteRuntime } from './install.js'
import { SshTunnel, SwitchUnderWay } from './tunnel.js'
import { parseStopLine, readSwitchStatus, rollbackRemote, stopRemoteHost, uninstallRemote, updateRemote, type HostControl, type UpdateStep } from './update.js'
import { eventually, SLOW } from '../../../../tooling/test-timing.js'

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

describe('parseStopLine', () => {
  it('reads serve --stop’s line under anything else it printed, and nothing else', () => {
    expect(parseStopLine('motd\n{"v":1,"stop":{"ok":true,"wasRunning":true,"how":"asked"}}\n')).toEqual({ ok: true, wasRunning: true, message: null })
    expect(parseStopLine('{"v":1,"stop":{"ok":false,"wasRunning":true,"message":"still running"}}')).toEqual({ ok: false, wasRunning: true, message: 'still running' })
    expect(parseStopLine('{"v":1,"port":1}\nCENTRALU-NOT-FOUND\n')).toBeNull()
  })
})

describe('stopRemoteHost', () => {
  it('says what the serve there printed when it gave no stop line', async () => {
    const stop = stopRemoteHost({ exec: async () => ({ code: 2, stderr: 'unknown option for serve: --stop', stdout: '' }), spec: { shell: 'posix' }, target: 'box' }, { forUpdate: true })
    await expect(stop).rejects.toThrow('Stopping Centralu on box gave no answer: unknown option for serve: --stop')
  })
})

// A Linux remote played by this machine's sh (see install.test.ts); the Windows counterpart is install-windows.test.ts.
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
        'bin/centralu.mjs': fakeServe(version, { realServe: pathToFileURL(SERVE_MJS).href }),
        'bin/serve.mjs': `export { managedLauncherScript } from ${JSON.stringify(pathToFileURL(SERVE_MJS).href)}\n`,
        // How the hub tells a version that runs its own switch (update.ts `switchCommand`); its --switch is the real launcher's
        'bin/serve-switch.mjs': '// the fake centralu.mjs runs the real launcher\'s serve --switch\n',
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
  const control = (env: Record<string, string> = {}, o: { exec?: HostControl['exec']; followMs?: number } = {}) => {
    const t = new SshTunnel({ target: 'box', ssh: join(root, 'ssh'), env: { HOME: home, PATH: `${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, ...env } })
    const seen: string[] = []
    const c: HostControl = {
      exec: o.exec ?? ((cmd) => t.exec(cmd)),
      spec: { shell: 'posix' },
      target: 'box',
      script: installScript(),
      hold: () => void seen.push('hold'),
      step: (s: UpdateStep) => void (seen.at(-1) !== s && seen.push(s)),
      pollMs: 100,
      ...(o.followMs ? { followMs: o.followMs } : {}),
    }
    return { c, seen, t }
  }
  /** What the fake versions are told (`FAKE_*`), in the data folder as well as the session's environment */
  const tell = (env: Record<string, string>) => {
    mkdirSync(data(), { recursive: true })
    writeFileSync(data('fake-env.json'), JSON.stringify(env))
  }
  const update = (version: string, env: Record<string, string> = {}, o: { exec?: HostControl['exec']; followMs?: number } = {}) => {
    tell(env)
    const { c, seen } = control(env, o)
    return { seen, done: updateRemote(c, { version, runtime, registry: { registry: reg.url }, nodeDist: `${reg.url}/dist` }) }
  }
  /** `serve --detach` through the link's lookup, as a reconnecting hub runs it */
  const startThere = async () => {
    const how = await control().t.startHost()
    expect(how.how).toBe('detached')
  }
  /** 9.9.1 installed by the hub and running, as after an earlier install and a link that started it */
  const installedAndRunning = async () => {
    const { c } = control()
    await installRemote({ exec: c.exec, spec: c.spec, target: 'box', version: '9.9.1', runtime, script: c.script, registry: { registry: reg.url }, nodeDist: `${reg.url}/dist` })
    await startThere()
    expect(running()).toBe('9.9.1')
    rmSync(data('events'))
  }
  const switchNow = () => JSON.parse(readFileSync(remote('switch.json'), 'utf8')) as { id: string; pid: number; step: string; outcome?: string; interrupted?: boolean; seen?: boolean }
  /** A hub that asks nothing more once it handed the switch over: gone, as one that died or lost its link for good */
  const goneAfterHandover = (): HostControl['exec'] => {
    const { t } = control()
    let gone = false
    return async (cmd) => {
      if (gone) return new Promise<never>(() => {})
      const r = await t.exec(cmd)
      gone = r.stdout.includes('"switch":{')
      return r
    }
  }
  /** Ends the switcher held at `step` (its pid in switch.json, a process this test's fakes started), then what it held */
  const killSwitcher = async (step: string) => {
    await eventually(() => existsSync(data('holding')), 30_000)
    expect(switchNow().step).toBe(step)
    const pid = switchNow().pid
    process.kill(pid, 'SIGKILL')
    await eventually(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    })
    // What it held ends having done nothing, if it outlived it
    writeFileSync(data('release'), 'quit')
  }

  it('installs beside, hands the switch to the machine, which stops the old host, switches, starts and checks the new one, then prunes', async () => {
    await installedAndRunning()
    const { seen, done } = update('9.9.2')
    const r = await done
    expect(r).toMatchObject({ current: { version: '9.9.2', node: NODE_V }, previous: { version: '9.9.1', node: NODE_V } })
    // The old version stopped itself (its own serve), then the new one started: the stop ran before the switch
    expect(events()).toEqual(['stop 9.9.1 (for update)', 'start 9.9.2'])
    expect(running()).toBe('9.9.2')
    expect(seen.slice(0, 6)).toEqual(['preflight', 'registry', 'node', 'centralu', 'hold', 'stop'])
    expect(seen.at(-1)).toBe('prune')
    expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.2 ${NODE_V}\n`)
    expect(readFileSync(remote('previous'), 'utf8')).toBe(`9.9.1 ${NODE_V}\n`)
    // A third version removes the first only once it answered
    expect(await update('9.9.3').done).toMatchObject({ current: { version: '9.9.3' }, previous: { version: '9.9.2' }, removed: ['9.9.1'] })
    expect(readdirSync(remote('versions')).sort()).toEqual(['9.9.2', '9.9.3'])
  }, 90_000 * SLOW)

  it('touches nothing that runs when the old host will not stop: the new version waits beside', async () => {
    await installedAndRunning()
    await expect(update('9.9.2', { FAKE_STOP_FAILS: '1' }).done).rejects.toThrow(/Centralu on box could not be stopped: the host on 127\.0\.0\.1:4141 is still running/)
    expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${NODE_V}\n`)
    expect(existsSync(remote('previous'))).toBe(false)
    expect(existsSync(remote('versions', '9.9.2', 'install.json'))).toBe(true)
    expect(events()).toEqual(['stop 9.9.1 (for update)'])
  }, 60_000 * SLOW)

  it('puts the old version back and starts it when the new one does not answer, with the end of its log', async () => {
    await installedAndRunning()
    const { seen, done } = update('9.9.2', { FAKE_BROKEN: '9.9.2' })
    await expect(done).rejects.toThrow(
      /Centralu 9\.9\.2 did not start on box \(the host exited before it answered\); it runs Centralu 9\.9\.1 again\. The end of its host\.log: host 9\.9\.2: the store was written by a newer Centralu/,
    )
    expect(seen).toContain('roll_back')
    expect(events()).toEqual(['stop 9.9.1 (for update)', 'start 9.9.2', 'stop - (for update)', 'start 9.9.1'])
    expect(running()).toBe('9.9.1')
    // The pointers are what they were, and nothing was removed: both versions are still there
    expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${NODE_V}\n`)
    expect(existsSync(remote('previous'))).toBe(false)
    expect(readdirSync(remote('versions')).sort()).toEqual(['9.9.1', '9.9.2'])
  }, 60_000 * SLOW)

  /*
   * #1903: the new version's host took host.lock and hung before it listened. The put-back's stop found nothing on the
   * port and signalled nothing, and the old version then failed on the lock: no host at all
   */
  it('ends a new version that took the lock and hung, by the pid its lock names, and the old one runs again', async () => {
    await installedAndRunning()
    const { done } = update('9.9.2', { FAKE_HANGS: '9.9.2' })
    const hung = () => Number(readFileSync(data('hung'), 'utf8'))
    try {
      await expect(done).rejects.toThrow(/Centralu 9\.9\.2 did not start on box \(the host did not answer within 30 s\); it runs Centralu 9\.9\.1 again\./)
      expect(events()).toEqual(['stop 9.9.1 (for update)', 'start 9.9.2', 'stop hung (for update)', 'start 9.9.1'])
      expect(running()).toBe('9.9.1')
      expect(() => process.kill(hung(), 0)).toThrow()
    } finally {
      // Only the process this test's fake started
      if (existsSync(data('hung'))) {
        try {
          process.kill(hung(), 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
  }, 90_000 * SLOW)

  it('does not say the old version runs again before it said hello, and says the stop before it failed', async () => {
    await installedAndRunning()
    const { done } = update('9.9.2', { FAKE_BROKEN: '9.9.2', FAKE_STOP_FAILS: '-', FAKE_SILENT: '9.9.1' })
    await expect(done).rejects.toThrow(
      /Centralu 9\.9\.2 did not start on box \(the host exited before it answered\), and putting back Centralu 9\.9\.1 failed too: it did not answer within 30 s either \(after Centralu on box could not be stopped: the host on 127\.0\.0\.1:4141 is still running\)\./,
    )
    expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${NODE_V}\n`)
  }, 90_000 * SLOW)

  // #1903: the link dropped between the stop and the start; every command after the stop fails, and the machine ends on the new version
  it('ends on the new version when the link drops once the old host stopped, with no command from the hub after it', async () => {
    await installedAndRunning()
    let down = false
    const { t } = control()
    const exec: HostControl['exec'] = async (cmd) => {
      if (down) throw new Error('ssh: connect to host box port 22: Connection timed out')
      const r = await t.exec(cmd)
      if (events().some((e) => e.startsWith('stop'))) down = true
      return r
    }
    await expect(update('9.9.2', {}, { exec, followMs: 3_000 }).done).rejects.toThrow(/could not be followed to its end from this computer/)
    await eventually(() => running() === '9.9.2' && switchNow().outcome === 'done', 30_000)
    expect(events()).toEqual(['stop 9.9.1 (for update)', 'start 9.9.2'])
  }, 90_000 * SLOW)

  // #1903: the hub died mid-update; the machine finishes, and the next hub that links reads how it ended, once
  it('finishes when the hub is gone after the handover, and a hub that links later reads the outcome, once', async () => {
    await installedAndRunning()
    void update('9.9.2', {}, { exec: goneAfterHandover() }).done.catch(() => undefined)
    await eventually(() => existsSync(remote('switch.json')) && switchNow().outcome === 'done', 30_000)
    expect(running()).toBe('9.9.2')
    const next = control().c
    const first = await readSwitchStatus(next)
    expect(first).toMatchObject({ outcome: 'done', to: { version: '9.9.2' } })
    expect(first?.seen).toBeUndefined()
    await readSwitchStatus(next, first!.id)
    expect(await readSwitchStatus(next)).toMatchObject({ outcome: 'done', seen: true })
  }, 90_000 * SLOW)

  it('a switcher killed before the switch is finished by the next start: nothing was switched, the old version runs', async () => {
    await installedAndRunning()
    void update('9.9.2', { FAKE_HOLD: 'stop' }, { exec: goneAfterHandover() }).done.catch(() => undefined)
    await killSwitcher('stop')
    tell({})
    await startThere()
    expect(switchNow()).toMatchObject({ outcome: 'failed', interrupted: true })
    expect(running()).toBe('9.9.1')
    expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${NODE_V}\n`)
  }, 90_000 * SLOW)

  it('a switcher killed between the switch and the check is finished by the next start: the old version is put back and runs', async () => {
    await installedAndRunning()
    void update('9.9.2', { FAKE_HOLD: 'start 9.9.2' }, { exec: goneAfterHandover() }).done.catch(() => undefined)
    await killSwitcher('start')
    expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.2 ${NODE_V}\n`)
    tell({})
    await startThere()
    expect(switchNow()).toMatchObject({ outcome: 'put_back', interrupted: true })
    expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${NODE_V}\n`)
    expect(running()).toBe('9.9.1')
  }, 90_000 * SLOW)

  it('refuses a second update, and starts no host, while a live switcher is between its stop and its start', async () => {
    await installedAndRunning()
    const first = update('9.9.2', { FAKE_HOLD: 'stop' })
    await eventually(() => existsSync(data('holding')), 30_000)
    await expect(update('9.9.3', { FAKE_HOLD: 'stop' }).done).rejects.toThrow(/^An update of box started from \S+ at \d\d:\d\d is still running; try again when it ends$/)
    await expect(control().t.startHost()).rejects.toBeInstanceOf(SwitchUnderWay)
    writeFileSync(data('release'), 'go')
    expect(await first.done).toMatchObject({ current: { version: '9.9.2' } })
    expect(running()).toBe('9.9.2')
  }, 120_000 * SLOW)

  it('rolls back one step, run by the version that runs now: previous becomes current, and there is no previous left to go back to', async () => {
    await installedAndRunning()
    await update('9.9.2').done
    rmSync(data('events'))
    const { c, seen } = control()
    const r = await rollbackRemote(c, { current: { version: '9.9.2', node: NODE_V }, previous: { version: '9.9.1', node: NODE_V } })
    expect(r).toMatchObject({ current: { version: '9.9.1', node: NODE_V }, previous: null })
    expect(seen.at(0)).toBe('hold')
    expect(events()).toEqual(['stop 9.9.2 (for update)', 'start 9.9.1'])
    expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${NODE_V}\n`)
    expect(existsSync(remote('previous'))).toBe(false)
    // The newer version stays on disk, so updating again does not download it again
    expect(existsSync(remote('versions', '9.9.2', 'install.json'))).toBe(true)
    const hits = reg.hits.length
    await update('9.9.2').done
    expect(reg.hits.slice(hits).filter((h) => h.endsWith('.tgz'))).toEqual([])
  }, 90_000 * SLOW)

  it('a first update over an install of its own (npm) leaves nothing to point back to when it fails', async () => {
    const { seen, done } = update('9.9.2', { FAKE_BROKEN: '9.9.2' })
    await expect(done).rejects.toThrow(/did not start on box .*; the Centralu that was there is back in place/)
    expect(seen).toContain('roll_back')
    // No pointer and no launcher: the lookup finds whatever ran there before
    expect(existsSync(remote('current'))).toBe(false)
    expect(existsSync(remote('bin', 'centralu'))).toBe(false)
  }, 60_000 * SLOW)

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
    expect(events()).toEqual(['stop 9.9.1', 'autostart remove'])
    expect(existsSync(data('autostart'))).toBe(false)
    expect(existsSync(remote())).toBe(false)
    expect(existsSync(data('serve.json'))).toBe(true)
    expect(running()).toBeNull()
  }, 60_000 * SLOW)

  it('does not uninstall when the boot entry would not go: it would start a launcher that is gone at every boot', async () => {
    await installedAndRunning()
    writeFileSync(data('autostart'), 'on')
    await expect(uninstallRemote(control({ FAKE_AUTOSTART_FAILS: '1' }).c)).rejects.toThrow('Centralu on box could not remove its start at boot: Failed to connect to bus')
    expect(existsSync(remote('versions', '9.9.1', 'install.json'))).toBe(true)
    expect(existsSync(data('autostart'))).toBe(true)
  }, 60_000 * SLOW)

  it('uninstalls a version that predates --autostart: it cannot have written an entry from here', async () => {
    await installedAndRunning()
    const { c, seen } = control({ FAKE_NO_AUTOSTART: '1' })
    expect(await uninstallRemote(c)).toEqual({ stopped: true })
    expect(seen).toEqual(['hold', 'stop', 'autostart', 'remove'])
    expect(existsSync(remote())).toBe(false)
  }, 60_000 * SLOW)
})
