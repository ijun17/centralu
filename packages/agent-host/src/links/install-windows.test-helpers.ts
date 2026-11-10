import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fakeRegistry, fakeServe, type FakeRegistry } from './fake-registry.test-helpers.js'
import { installRemote, installScript, type RemoteRuntime } from './install.js'
import { SshTunnel, type RemoteCommand, type RemoteSpec } from './tunnel.js'
import { updateRemote, type HostControl, type UpdateStep } from './update.js'
import { WIN_NODE_FILE, WIN_NODE_V, windowsNodeZip, windowsPackages, windowsRemoteEnv, windowsRemoteSsh, windowsRuntime, clixmlErrors, execThroughSilentDeath, remoteScriptText, nodeWithoutEnv } from './windows-remote.test-helpers.js'
import { eventually, SLOW } from '../../../../tooling/test-timing.js'
import { removeTree } from '../temp-dir.test-helpers.js'


/**
 * The setup and helpers the install-windows tests share: this computer as the Windows machine a hub installs on and updates (plan §10.2, §10.5): the
 * counterpart of the `sh` suites in install.test.ts and update.test.ts. The hub's command is its real
 * `powershell -EncodedCommand`, run through cmd.exe as Windows OpenSSH runs it, so the PowerShell
 * install scripts, System32's `curl.exe` and `tar.exe`, `remote-install.mjs` on Windows, and the
 * managed `centralu.cmd` launcher all run for real (windows-remote.test-helpers.ts says what is a stand-in).
 */

export const SERVE_MJS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packaging/npm/centralu/bin/serve.mjs')
export const SERVE_SHIM = `export { managedLauncherScript } from ${JSON.stringify(pathToFileURL(SERVE_MJS).href)}\n`
export const RUN_IT = (version: string) => `console.log(JSON.stringify({ ran: '${version}', argv: process.argv.slice(2), managed: process.env.CENTRALU_MANAGED ?? null }))\n`

/** The fake registry, the Windows "remote" and the commands the hub runs there; call it inside the suite that uses them (it adds that suite's hooks) */
export function windowsRemote() {
  let root: string
  let home: string
  let reg: FakeRegistry
  let runtime: RemoteRuntime

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-winremote-'))
    home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    windowsRemoteSsh(root)
    const zip = await windowsNodeZip()
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
  })
  afterEach(() => removeTree(join(home, '.centralu')))

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
  return {
    get root() {
      return root
    },
    get home() {
      return home
    },
    get reg() {
      return reg
    },
    get runtime() {
      return runtime
    },
    ran,
    recorded,
    data,
    remote,
    events,
    running,
    tunnel,
    install,
    control,
    tell,
    update,
    startThere,
    installedAndRunning,
    switchNow,
    goneAfterHandover,
    killSwitcher,
  }
}
