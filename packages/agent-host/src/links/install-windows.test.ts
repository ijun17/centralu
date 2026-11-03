import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fakeRegistry, fakeServe, tarGz, type FakeRegistry } from './fake-registry.test-helpers.js'
import { installRemote, installScript, type RemoteRuntime } from './install.js'
import { connectionCommand, SshTunnel, SwitchUnderWay, type RemoteCommand, type RemoteSpec } from './tunnel.js'
import { readSwitchStatus, rollbackRemote, uninstallRemote, updateRemote, type HostControl, type UpdateStep } from './update.js'
import { rmFakeDir } from '../fake-exe.test-helpers.js'
import { WIN_NODE_FILE, WIN_NODE_V, windowsNodeZip, windowsPackages, windowsRemoteEnv, windowsRemoteSsh, windowsRuntime, pwsh7ModulePath, clixmlErrors, execThroughSilentDeath, remoteScriptText, nodeWithoutEnv } from './windows-remote.test-helpers.js'
import { eventually, SLOW } from '../../../../tooling/test-timing.js'

/**
 * This computer as the Windows machine a hub installs on and updates (plan §10.2, §10.5): the
 * counterpart of the `sh` suites in install.test.ts and update.test.ts. The hub's command is its real
 * `powershell -EncodedCommand`, run through cmd.exe as Windows OpenSSH runs it, so the PowerShell
 * install scripts, System32's `curl.exe` and `tar.exe`, `remote-install.mjs` on Windows, and the
 * managed `centralu.cmd` launcher all run for real (windows-remote.test-helpers.ts says what is a stand-in).
 */

const SERVE_MJS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packaging/npm/centralu/bin/serve.mjs')
const SERVE_SHIM = `export { managedLauncherScript } from ${JSON.stringify(pathToFileURL(SERVE_MJS).href)}\n`
const RUN_IT = (version: string) => `console.log(JSON.stringify({ ran: '${version}', argv: process.argv.slice(2), managed: process.env.CENTRALU_MANAGED ?? null }))\n`

// The install scripts ask the machine for its architecture, and only x64 Windows has a build
describe.runIf(process.platform === 'win32' && process.arch === 'x64')('installing on and updating a Windows machine over a fake ssh into a real PowerShell', () => {
  let root: string
  let home: string
  let reg: FakeRegistry
  let runtime: RemoteRuntime

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-winremote-'))
    home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    windowsRemoteSsh(root)
    const zip = windowsNodeZip()
    // 9.9.1 to 9.9.3 as published before the host-only packages; 9.9.4 and 9.9.5 with one
    const serve = (v: string, switcher = true) => ({ mjs: fakeServe(v, { realServe: pathToFileURL(SERVE_MJS).href }), serve: SERVE_SHIM, switcher })
    reg = await fakeRegistry([
      ...windowsPackages('9.9.1', serve('9.9.1'), false),
      ...windowsPackages('9.9.2', serve('9.9.2'), false),
      ...windowsPackages('9.9.3', serve('9.9.3'), false),
      // Two from before the machine ran its own switch
      ...windowsPackages('9.9.8', serve('9.9.8', false), false),
      ...windowsPackages('9.9.9', serve('9.9.9', false), false),
      // The one whose tarball a test swaps: its bytes are not the ones the signed metadata names afterwards
      ...windowsPackages('9.9.6', serve('9.9.6'), false),
      // The one whose metadata a test forges, for good
      ...windowsPackages('9.9.7', serve('9.9.7'), false),
      ...windowsPackages('9.9.4', { mjs: RUN_IT('9.9.4'), serve: SERVE_SHIM }, true),
      ...windowsPackages('9.9.5', { mjs: RUN_IT('9.9.5'), serve: SERVE_SHIM }, true),
      // The lookup test runs this one: a version whose centralu.mjs only says it ran
      ...windowsPackages('9.8.0', { mjs: RUN_IT('9.8.0'), serve: SERVE_SHIM }, false),
    ])
    reg.addNodeArchive(WIN_NODE_V, WIN_NODE_FILE, zip)
    runtime = windowsRuntime(zip)
  }, 120_000 * SLOW)
  afterAll(async () => {
    await reg.close()
    rmFakeDir(root)
  })
  afterEach(() => rmFakeDir(join(home, '.centralu')))

  /*
   * What each command the hub ran there answered, printed when a test fails (#845). On loaded windows-2022 runners a
   * step sometimes got no answer: "The remote did not answer the install check", "Stopping Centralu on box gave no
   * answer (exit 1)". Those reasons leave out what the remote printed, and Windows PowerShell started with
   * -EncodedCommand writes its own errors to stderr as CLIXML, which the reason drops as noise, so the CI logs said
   * nothing about why.
   */
  const ran: string[] = []
  beforeEach(({ onTestFailed }) => {
    ran.length = 0
    onTestFailed(() => console.error(`The commands this test ran on the "remote", last ${ran.length > 6 ? 6 : ran.length}:\n${ran.slice(-6).join('\n')}`))
  })
  const recorded = (t: SshTunnel) => async (c: RemoteCommand) => {
    const what = remoteScriptText(c)
    try {
      const r = await execThroughSilentDeath((x) => t.exec(x), c, {
        onDied: (died, attempt) => {
          // Seen in the log of a passing test too: how often it happens is worth knowing (#1244)
          const why = JSON.stringify(clixmlErrors(died.stderr).slice(-500))
          ran.push(`- ${what}\n  exit ${died.code} with nothing printed (stderr ${why}), run ${attempt}; run again`)
          console.warn(`The remote ended without a word (exit ${died.code}, stderr ${why}), running: ${what}\nRun again.`)
        },
      })
      ran.push(`- ${what}\n  exit ${r.code}\n  stdout: ${JSON.stringify(r.stdout.slice(-1_000))}\n  stderr: ${JSON.stringify(clixmlErrors(r.stderr).slice(-2_000))}`)
      return r
    } catch (e) {
      ran.push(`- ${what}\n  rejected: ${(e as Error).message}`)
      throw e
    }
  }

  const data = (...p: string[]) => join(home, '.centralu', ...p)
  const remote = (...p: string[]) => data('remote', ...p)
  const events = () => (existsSync(data('events')) ? readFileSync(data('events'), 'utf8').trim().split('\n') : [])
  const running = () => (existsSync(data('running')) ? readFileSync(data('running'), 'utf8') : null)
  const tunnel = (env: Record<string, string> = {}, remote: RemoteSpec = { shell: 'powershell' }) => new SshTunnel({ target: 'box', remote, ssh: join(root, 'ssh.exe'), env: windowsRemoteEnv(home, env) })
  const install = (version: string, o: { runtime?: RemoteRuntime; env?: Record<string, string> } = {}) => {
    const t = tunnel(o.env)
    return installRemote({ exec: recorded(t), spec: { shell: 'powershell' }, target: 'box', version, runtime: o.runtime ?? runtime, script: installScript(), registry: { registry: reg.url }, nodeDist: `${reg.url}/dist` })
  }

  describe('installing', () => {
    it('installs Node pruned and the packages beside it, writes the .cmd launcher and current, and the lookup runs it', async () => {
      const r = await install('9.8.0')
      expect(r).toEqual({ current: { version: '9.8.0', node: WIN_NODE_V }, previous: null, removed: [], left: [] })
      // Node: the binary and its licence, nothing of npm (plan S6)
      expect(readdirSync(remote('node', `v${WIN_NODE_V}`)).sort()).toEqual(['LICENSE', 'node.exe'])
      // A version published before the host-only packages: the platform package, its window thrown away
      const pkg = remote('versions', '9.8.0', 'node_modules', '@centralu', 'win32-x64', 'Centralu')
      expect(existsSync(join(pkg, 'resources', 'host', 'main.mjs'))).toBe(true)
      expect(existsSync(join(pkg, 'centralu.exe'))).toBe(false)
      expect(JSON.parse(readFileSync(remote('versions', '9.8.0', 'install.json'), 'utf8'))).toMatchObject({ version: '9.8.0', node: WIN_NODE_V, platform: 'win32-x64' })
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.8.0 ${WIN_NODE_V}\n`)
      expect(existsSync(remote('bin', 'centralu.cmd'))).toBe(true)
      // Nothing half-done is left behind
      expect(readdirSync(remote()).filter((n) => n.startsWith('.'))).toEqual([])
      // The hub's lookup, in PowerShell as ssh would start it, now finds the managed launcher, which
      // runs current's centralu.mjs on the Node current names
      const out = execFileSync(connectionCommand({ shell: 'powershell' }), { shell: true, env: windowsRemoteEnv(home), encoding: 'utf8' })
      expect(JSON.parse(out.trim().split(/\r?\n/).at(-1)!)).toEqual({ ran: '9.8.0', argv: ['serve', '--connection'], managed: '1' })
    }, 120_000 * SLOW)

    it('installs when Windows PowerShell was started from PowerShell 7 and inherited its module path (GitHub runners, an OpenSSH DefaultShell of pwsh)', async () => {
      // Without the reset the install script's Get-FileHash was "found in the module … but the module could not be loaded"
      const r = await install('9.9.4', { env: { PSModulePath: pwsh7ModulePath(root) } })
      expect(r.current).toEqual({ version: '9.9.4', node: WIN_NODE_V })
      expect(existsSync(remote('node', `v${WIN_NODE_V}`, 'node.exe'))).toBe(true)
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.4 ${WIN_NODE_V}\n`)
    }, 120_000 * SLOW)

    it('a version with a host-only package installs that one and never downloads the platform package (owner decision 2)', async () => {
      const hits = reg.hits.length
      const r = await install('9.9.4')
      expect(r.current).toEqual({ version: '9.9.4', node: WIN_NODE_V })
      const asked = reg.hits.slice(hits)
      expect(asked).toContain('/@centralu/host-win32-x64/-/host-win32-x64-9.9.4.tgz')
      expect(asked.filter((h) => h.startsWith('/@centralu/win32-x64/'))).toEqual([])
      expect(existsSync(remote('versions', '9.9.4', 'node_modules', '@centralu', 'host-win32-x64', 'host', 'main.mjs'))).toBe(true)
      expect(existsSync(remote('versions', '9.9.4', 'node_modules', '@centralu', 'win32-x64'))).toBe(false)
    }, 120_000 * SLOW)

    it('refuses a Node archive whose SHA-256 is not the pinned one, and leaves nothing', async () => {
      const wrong = { node: { version: WIN_NODE_V, archives: { 'win32-x64': { file: WIN_NODE_FILE, sha256: 'f'.repeat(64) } } } }
      await expect(install('9.9.4', { runtime: wrong })).rejects.toThrow(/does not match the SHA-256 this Centralu release pinned/)
      expect(existsSync(remote('node'))).toBe(false)
      expect(existsSync(remote('current'))).toBe(false)
      expect(readdirSync(remote()).filter((n) => n.startsWith('.'))).toEqual([])
    }, 120_000 * SLOW)

    it('refuses a package whose bytes are not what the signed metadata names, and keeps what runs', async () => {
      await install('9.9.1')
      reg.swapTarball('@centralu/win32-x64@9.9.6', tarGz('package', { 'Centralu/resources/host/main.mjs': 'someone else’s host' }))
      try {
        await expect(install('9.9.6')).rejects.toThrow(/@centralu\/win32-x64 downloaded on box does not match the integrity the npm registry signed/)
      } finally {
        reg.swapTarball('@centralu/win32-x64@9.9.6', tarGz('package', windowsPackages('9.9.6', { mjs: fakeServe('9.9.6'), serve: SERVE_SHIM }, false)[1]!.files))
      }
      expect(existsSync(remote('versions', '9.9.6'))).toBe(false)
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
      expect(readdirSync(remote()).filter((n) => n.startsWith('.'))).toEqual([])
    }, 120_000 * SLOW)

    it('refuses before downloading anything when registry metadata fails its signature', async () => {
      const hits = reg.hits.length
      reg.forgeSignature('centralu@9.9.7')
      await expect(install('9.9.7')).rejects.toThrow(/signature on centralu@9\.9\.7 does not check out/)
      expect(reg.hits.slice(hits).filter((h) => h.startsWith('/dist/') || h.endsWith('.tgz'))).toEqual([])
      expect(existsSync(remote('node'))).toBe(false)
    }, 120_000 * SLOW)
  })

  describe('updating, rolling back and uninstalling', () => {
    /** A HostControl as LinkedMachine gives one, with this machine as the remote; what it saw is kept */
    const control = (env: Record<string, string> = {}, o: { spec?: RemoteSpec; exec?: HostControl['exec']; followMs?: number } = {}) => {
      const spec: RemoteSpec = o.spec ?? { shell: 'powershell' }
      const t = tunnel(env, spec)
      const seen: string[] = []
      const c: HostControl = {
        exec: o.exec ?? recorded(t),
        spec,
        target: 'box',
        script: installScript(),
        hold: () => void seen.push('hold'),
        step: (s: UpdateStep) => void (seen.at(-1) !== s && seen.push(s)),
        pollMs: 100,
        ...(o.followMs ? { followMs: o.followMs } : {}),
      }
      return { c, seen, t }
    }
    /**
     * What the fake versions are told (`FAKE_*`), in the data folder as well as the session's environment: a switcher
     * started through WMI gets the account's environment, not the test's
     */
    const tell = (env: Record<string, string>, dir = data()) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'fake-env.json'), JSON.stringify(env))
    }
    const update = (version: string, env: Record<string, string> = {}, o: { exec?: HostControl['exec']; followMs?: number } = {}) => {
      tell(env)
      const { c, seen } = control(env, o)
      return { seen, done: updateRemote(c, { version, runtime, registry: { registry: reg.url }, nodeDist: `${reg.url}/dist` }) }
    }
    /** `serve --detach` through the link's lookup, as a reconnecting hub runs it */
    const startThere = async (spec?: RemoteSpec) => {
      const how = await tunnel({}, spec).startHost()
      expect(how.how).toBe('detached')
    }
    /** 9.9.1 (or `version`) installed by the hub and running, as after an earlier install and a link that started it */
    const installedAndRunning = async (version = '9.9.1') => {
      await install(version)
      nodeWithoutEnv(data())
      await startThere()
      expect(running()).toBe(version)
      rmSync(data('events'))
    }
    const switchNow = () => JSON.parse(readFileSync(remote('switch.json'), 'utf8')) as { id: string; pid: number; step: string; outcome?: string; interrupted?: boolean; seen?: boolean }
    /** A hub that asks nothing more once it handed the switch over: gone, as one that died or lost its link for good */
    const goneAfterHandover = (): HostControl['exec'] => {
      const t = tunnel()
      let gone = false
      return async (cmd) => {
        if (gone) return new Promise<never>(() => {})
        const r = await recorded(t)(cmd)
        gone = r.stdout.includes('"switch":{')
        return r
      }
    }
    /** Ends the switcher held at `step` (its pid in switch.json, a process this test's fakes started), then what it held */
    const killSwitcher = async (step: string) => {
      await eventually(() => existsSync(data('holding')), 60_000)
      expect(switchNow().step).toBe(step)
      const pid = switchNow().pid
      process.kill(pid)
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
      expect(await done).toMatchObject({ current: { version: '9.9.2', node: WIN_NODE_V }, previous: { version: '9.9.1', node: WIN_NODE_V } })
      // The old version stopped itself, through its own launcher, then the new one started
      expect(events()).toEqual(['stop 9.9.1 (for update)', 'start 9.9.2'])
      expect(running()).toBe('9.9.2')
      expect(seen.slice(0, 6)).toEqual(['preflight', 'registry', 'node', 'centralu', 'hold', 'stop'])
      expect(seen.at(-1)).toBe('prune')
      expect(switchNow()).toMatchObject({ outcome: 'done', seen: true })
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.2 ${WIN_NODE_V}\n`)
      expect(readFileSync(remote('previous'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
      // A third version removes the first only once it answered
      expect(await update('9.9.3').done).toMatchObject({ current: { version: '9.9.3' }, previous: { version: '9.9.2' }, removed: ['9.9.1'] })
      expect(readdirSync(remote('versions')).sort()).toEqual(['9.9.2', '9.9.3'])
    }, 180_000 * SLOW)

    it('names a version folder a running program holds, instead of failing, and removes it once the program is gone', async () => {
      await installedAndRunning()
      await update('9.9.2').done
      // A program running from 9.9.1's folder, as a host that has not yet stopped is: Windows will not remove a folder that is some program's working directory
      const holder = (await import('node:child_process')).spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: remote('versions', '9.9.1'), stdio: 'ignore' })
      try {
        const r = await update('9.9.3').done
        expect(r).toMatchObject({ current: { version: '9.9.3' }, previous: { version: '9.9.2' } })
        expect(r.removed).not.toContain('9.9.1')
        expect(r.left).toContain('9.9.1')
        expect(existsSync(remote('versions', '9.9.3', 'install.json'))).toBe(true)
      } finally {
        holder.kill()
        await new Promise((r) => (holder.exitCode !== null ? r(null) : holder.once('exit', r)))
      }
      // The next update's prune takes it
      expect(await update('9.9.1').done).toMatchObject({ current: { version: '9.9.1' } })
    }, 240_000 * SLOW)

    it('puts the old version back and starts it when the new one does not answer, with the end of its log', async () => {
      await installedAndRunning()
      const { seen, done } = update('9.9.2', { FAKE_BROKEN: '9.9.2' })
      await expect(done).rejects.toThrow(
        /Centralu 9\.9\.2 did not start on box \(the host exited before it answered\); it runs Centralu 9\.9\.1 again\. The end of its host\.log: host 9\.9\.2: the store was written by a newer Centralu/,
      )
      expect(seen).toContain('roll_back')
      expect(events()).toEqual(['stop 9.9.1 (for update)', 'start 9.9.2', 'stop - (for update)', 'start 9.9.1'])
      expect(running()).toBe('9.9.1')
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
      expect(existsSync(remote('previous'))).toBe(false)
      expect(readdirSync(remote('versions')).sort()).toEqual(['9.9.1', '9.9.2'])
    }, 180_000 * SLOW)

    /*
     * #1903: the new version's host took host.lock and hung before it listened. The put-back's stop found nothing on
     * the port and signalled nothing, and the old version then failed on the lock: no host at all
     */
    it('ends a new version that took the lock and hung, by the pid its lock names, and the old one runs again', async () => {
      await installedAndRunning()
      // Under PowerShell 7's module path, as the ssh session of a CI runner has it: the lock's holder must still be told
      const { done } = update('9.9.2', { FAKE_HANGS: '9.9.2', PSModulePath: pwsh7ModulePath(root) })
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
            process.kill(hung())
          } catch {
            // already gone
          }
        }
      }
    }, 180_000 * SLOW)

    it('does not say the old version runs again before it said hello, and says the stop before it failed', async () => {
      await installedAndRunning()
      const { done } = update('9.9.2', { FAKE_BROKEN: '9.9.2', FAKE_STOP_FAILS: '-', FAKE_SILENT: '9.9.1' })
      await expect(done).rejects.toThrow(
        /Centralu 9\.9\.2 did not start on box \(the host exited before it answered\), and putting back Centralu 9\.9\.1 failed too: it did not answer within 30 s either \(after Centralu on box could not be stopped: the host on 127\.0\.0\.1:4141 is still running\)\./,
      )
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
    }, 180_000 * SLOW)

    /*
     * #1903: the link dropped between the stop and the start. With the hub running each step, no host ran until ssh came
     * back and the link started one. The machine runs the switch now: every command after the stop fails, as on a link
     * that is down for good, and the machine ends on the new version all the same
     */
    it('ends on the new version when the link drops once the old host stopped, with no command from the hub after it', async () => {
      await installedAndRunning()
      let down = false
      const t = tunnel()
      const exec: HostControl['exec'] = async (cmd) => {
        if (down) throw new Error('ssh: connect to host box port 22: Connection timed out')
        const r = await recorded(t)(cmd)
        // The link goes down once the stop has happened there, whichever command did it
        if (events().some((e) => e.startsWith('stop'))) down = true
        return r
      }
      const { done } = update('9.9.2', {}, { exec, followMs: 3_000 })
      await expect(done).rejects.toThrow(/could not be followed to its end from this computer; how it ended is shown once box is reached again/)
      await eventually(() => running() === '9.9.2' && switchNow().outcome === 'done', 60_000)
      expect(events()).toEqual(['stop 9.9.1 (for update)', 'start 9.9.2'])
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.2 ${WIN_NODE_V}\n`)
    }, 180_000 * SLOW)

    /*
     * #1903: the hub died mid-update. Once the switch is handed over it never asks again; the machine finishes, and the
     * next hub that links reads how it ended, reported once
     */
    it('finishes when the hub is gone after the handover, and a hub that links later reads the outcome, once', async () => {
      await installedAndRunning()
      let gone = false
      const t = tunnel()
      const exec: HostControl['exec'] = async (cmd) => {
        if (gone) return new Promise<never>(() => {})
        const r = await recorded(t)(cmd)
        if (existsSync(remote('switch.json'))) gone = true
        return r
      }
      void update('9.9.2', {}, { exec }).done.catch(() => undefined)
      await eventually(() => existsSync(remote('switch.json')) && switchNow().outcome === 'done', 60_000)
      expect(running()).toBe('9.9.2')
      const next = control().c
      const first = await readSwitchStatus(next)
      expect(first).toMatchObject({ outcome: 'done', to: { version: '9.9.2' } })
      expect(first?.seen).toBeUndefined()
      // Reported: the hub marks it, and it is not reported again
      await readSwitchStatus(next, first!.id)
      expect(await readSwitchStatus(next)).toMatchObject({ outcome: 'done', seen: true })
    }, 180_000 * SLOW)

    // §10.5a: a switcher that dies leaves its step; the next start there finishes it before it starts anything
    it('a switcher killed before the switch is finished by the next start: nothing was switched, the old version runs', async () => {
      await installedAndRunning()
      void update('9.9.2', { FAKE_HOLD: 'stop' }, { exec: goneAfterHandover() }).done.catch(() => undefined)
      await killSwitcher('stop')
      tell({})
      await startThere()
      expect(switchNow()).toMatchObject({ outcome: 'failed', interrupted: true })
      expect(running()).toBe('9.9.1')
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
    }, 180_000 * SLOW)

    it('a switcher killed between the switch and the check is finished by the next start: the old version is put back and runs', async () => {
      await installedAndRunning()
      void update('9.9.2', { FAKE_HOLD: 'start 9.9.2' }, { exec: goneAfterHandover() }).done.catch(() => undefined)
      await killSwitcher('start')
      // `current` names the new version, whose --detach finishes the switch and has the old one serve
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.2 ${WIN_NODE_V}\n`)
      tell({})
      await startThere()
      expect(switchNow()).toMatchObject({ outcome: 'put_back', interrupted: true })
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
      expect(running()).toBe('9.9.1')
      expect(events().at(-1)).toBe('start 9.9.1')
    }, 180_000 * SLOW)

    it('refuses a second update, and starts no host, while a live switcher is between its stop and its start', async () => {
      await installedAndRunning()
      const first = update('9.9.2', { FAKE_HOLD: 'stop' })
      await eventually(() => existsSync(data('holding')), 60_000)
      await expect(update('9.9.3', { FAKE_HOLD: 'stop' }).done).rejects.toThrow(/^An update of box started from \S+ at \d\d:\d\d is still running; try again when it ends$/)
      await expect(tunnel().startHost()).rejects.toBeInstanceOf(SwitchUnderWay)
      writeFileSync(data('release'), 'go')
      expect(await first.done).toMatchObject({ current: { version: '9.9.2' } })
      expect(running()).toBe('9.9.2')
    }, 240_000 * SLOW)

    // WMI blocked: the switch runs in the ssh session, and a link drop ends it like a crash; the reconnect brings a host back
    it('where nothing starts outside the session, a switch that ends with the session is finished by the reconnect', async () => {
      await installedAndRunning()
      void update('9.9.2', { FAKE_WMI_BLOCKED: '1', FAKE_HOLD: 'start 9.9.2' }, { exec: goneAfterHandover() }).done.catch(() => undefined)
      await killSwitcher('start')
      tell({})
      await startThere()
      expect(switchNow()).toMatchObject({ outcome: 'put_back', interrupted: true })
      expect(running()).toBe('9.9.1')
    }, 180_000 * SLOW)

    it('refuses to switch between two versions from before the machine ran its own switch, and leaves both as they were', async () => {
      await installedAndRunning('9.9.8')
      await expect(update('9.9.9').done).rejects.toThrow('Update box first: both versions there predate updates the machine runs itself')
      expect(running()).toBe('9.9.8')
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.8 ${WIN_NODE_V}\n`)
      expect(events()).toEqual([])
    }, 180_000 * SLOW)

    // So a link can drive a temporary folder on a machine whose own installation it must not touch
    it('installs, starts and updates in the data folder the link names, not the one its ssh session has (#1903)', async () => {
      // Named as a Windows temp folder may be: an 8.3 short name (a CI runner's), `$` and parentheses, read as written
      const other = join(root, 'OTHER~1 $data (1)')
      try {
        const spec: RemoteSpec = { shell: 'powershell', dataDir: other }
        const first = control({}, { spec })
        await installRemote({ exec: first.c.exec, spec, target: 'box', version: '9.9.1', runtime, script: installScript(), registry: { registry: reg.url }, nodeDist: `${reg.url}/dist` })
        nodeWithoutEnv(other)
        await startThere(spec)
        tell({}, other)
        const { c } = control({}, { spec })
        expect(await updateRemote(c, { version: '9.9.2', runtime, registry: { registry: reg.url }, nodeDist: `${reg.url}/dist` })).toMatchObject({ current: { version: '9.9.2' } })
        expect(readFileSync(join(other, 'events'), 'utf8').trim().split('\n')).toEqual(['start 9.9.1', 'stop 9.9.1 (for update)', 'start 9.9.2'])
        expect(readFileSync(join(other, 'remote', 'current'), 'utf8')).toBe(`9.9.2 ${WIN_NODE_V}\n`)
        // The folder the ssh session names (its CC_DATA_DIR) was not touched
        expect(existsSync(data())).toBe(false)
      } finally {
        rmFakeDir(other)
      }
    }, 180_000 * SLOW)

    it('rolls back one step, run by the version that runs now: previous becomes current, and there is no previous left to go back to', async () => {
      await installedAndRunning()
      await update('9.9.2').done
      rmSync(data('events'))
      const { c, seen } = control()
      const r = await rollbackRemote(c, { current: { version: '9.9.2', node: WIN_NODE_V }, previous: { version: '9.9.1', node: WIN_NODE_V } })
      expect(r).toMatchObject({ current: { version: '9.9.1', node: WIN_NODE_V }, previous: null })
      expect(seen.at(0)).toBe('hold')
      expect(events()).toEqual(['stop 9.9.2 (for update)', 'start 9.9.1'])
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
      expect(existsSync(remote('previous'))).toBe(false)
      expect(readFileSync(remote('switch.runner'), 'utf8')).toBe(`9.9.2 ${WIN_NODE_V}\n`)
    }, 180_000 * SLOW)

    it('uninstalls: stops the host, removes <data>\\remote, keeps the rest of the data', async () => {
      await installedAndRunning()
      writeFileSync(data('serve.json'), '{"token":"t"}')
      writeFileSync(data('autostart'), 'on')
      const { c, seen } = control()
      expect(await uninstallRemote(c)).toEqual({ stopped: true })
      expect(seen).toEqual(['hold', 'stop', 'autostart', 'remove'])
      // The boot entry goes, through the Centralu it would start, after the host stopped and before its files go
      expect(events()).toEqual(['stop 9.9.1', 'autostart remove'])
      expect(existsSync(data('autostart'))).toBe(false)
      expect(existsSync(remote())).toBe(false)
      expect(existsSync(data('serve.json'))).toBe(true)
      expect(running()).toBeNull()
    }, 120_000 * SLOW)
  })
})
