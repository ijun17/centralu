import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, normalize, sep } from 'node:path'
import type { NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { CrossAdapter } from './cross-project.test-helpers.js'
import { SLOW } from '../../../../tooling/test-timing.js'

/**
 * Cloning a repository as a new project (#515), end to end with the machine's real git: a local bare repository is
 * served over https (git's "dumb" protocol, which a static file server is enough for), from a server whose
 * self-signed certificate git is told to trust. A path that asks for a password stands for a private repository this
 * machine has no sign-in for. Nothing outside a temp root is touched, and the person's git configuration is left out.
 */
let root: string
let served: string
let server: Server
let base: string
const saved: Record<string, string | undefined> = {}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' })

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-clone-')))
  // The person's own git configuration stays out; the test's certificate is the only one trusted
  const gitconfig = join(root, 'gitconfig')
  writeFileSync(gitconfig, '')
  const ca = join(root, 'ca.pem')
  writeFileSync(ca, TEST_TLS_CERT)
  const env: Record<string, string> = {
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_SSL_CAINFO: ca,
    /*
     * Windows' git may check certificates with schannel, which reads no CA file; OpenSSL does. Windows only: a Linux git
     * built on one TLS library dies on the setting ("remote helper 'https' aborted session", measured in CI)
     */
    ...(process.platform === 'win32' ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.sslBackend', GIT_CONFIG_VALUE_0: 'openssl' } : {}),
  }
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  // The source: a bare repository with main (a README) and a dev branch (one more file)
  served = join(root, 'served')
  mkdirSync(served)
  const work = join(root, 'work')
  mkdirSync(work)
  git(work, 'init')
  writeFileSync(join(work, 'README.md'), 'hello\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'first')
  git(work, 'checkout', '-b', 'dev')
  writeFileSync(join(work, 'dev.txt'), 'dev\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'dev')
  git(work, 'checkout', 'main')
  git(served, 'clone', '--bare', work, 'game.git')
  git(join(served, 'game.git'), 'update-server-info')

  server = createServer({ cert: TEST_TLS_CERT, key: TEST_TLS_KEY }, (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!)
    if (path.startsWith('/private/')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="private"' }).end()
      return
    }
    const file = normalize(join(served, path))
    if (!file.startsWith(served + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200).end(readFileSync(file))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((r) => server.close(r))
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
})

let centralu: string
let store: Store
let events: NormalizedEvent[]
let mgr: SessionManager
let rpc: (method: string, params: unknown) => Promise<unknown>

beforeEach(() => {
  centralu = mkdtempSync(join(root, 'Centralu-'))
  store = new Store()
  events = []
  const agents = new Map<ToolName, CrossAdapter>([['claude', new CrossAdapter('claude')]]) as unknown as Map<ToolName, AgentAdapter>
  mgr = new SessionManager(store, agents, (e) => events.push(e))
  mgr.useProjectsHome(() => centralu)
  const handler = createRpcHandler(mgr, agents)
  rpc = (method, params) => handler(method, params)
})
afterEach(async () => {
  await mgr.disposeAll()
  store.close()
})

const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('projects.create with a git source', () => {
  it('clones over https into a folder named after the repository, and registers it', async () => {
    const info = (await rpc('projects.create', { name: '', source: { git: `${base}/game.git` } })) as { name: string; path: string }
    expect(info.name).toBe('game')
    expect(info.path).toBe(join(centralu, 'game'))
    expect(readFileSync(join(info.path, 'README.md'), 'utf8')).toBe('hello\n')
    expect(existsSync(join(info.path, 'dev.txt'))).toBe(false)
    expect(((await rpc('projects.list', {})) as { path: string }[]).map((p) => p.path)).toEqual([info.path])
    expect(events.some((e) => e.type === 'projects_changed')).toBe(true)
  }, 30_000 * SLOW)

  it('registers a clone as untrusted: its contents come from outside, so the person decides (#655)', async () => {
    const info = (await rpc('projects.create', { name: '', source: { git: `${base}/game.git` } })) as { id: string; trusted: boolean }
    expect(info.trusted).toBe(false)
    expect(((await rpc('projects.list', {})) as { id: string; trusted: boolean }[]).find((p) => p.id === info.id)?.trusted).toBe(false)
  }, 30_000 * SLOW)

  it('checks out the branch asked for, under the name given', async () => {
    const info = (await rpc('projects.create', { name: 'game-dev', source: { git: `${base}/game.git`, branch: 'dev' } })) as { path: string }
    expect(info.path).toBe(join(centralu, 'game-dev'))
    expect(readFileSync(join(info.path, 'dev.txt'), 'utf8')).toBe('dev\n')
  }, 30_000 * SLOW)

  it('a repository that needs a sign-in fails at once with one sentence, never asking, and leaves nothing', async () => {
    await expect(rpc('projects.create', { name: '', source: { git: `${base}/private/secret.git` } })).rejects.toThrow(/needs a sign-in this machine does not have saved/)
    expect(readdirSync(centralu)).toEqual([])
    expect((await rpc('projects.list', {})) as unknown[]).toEqual([])
  }, 30_000 * SLOW)

  it('a failed clone removes the folder it made and registers nothing', async () => {
    await expect(rpc('projects.create', { name: 'gone', source: { git: `${base}/nothing-here.git` } })).rejects.toThrow(/no repository at/)
    await expect(rpc('projects.create', { name: 'nobranch', source: { git: `${base}/game.git`, branch: 'nope' } })).rejects.toThrow()
    expect(readdirSync(centralu)).toEqual([])
    expect((await rpc('projects.list', {})) as unknown[]).toEqual([])
  }, 30_000 * SLOW)

  it('never clones into a folder that is there', async () => {
    mkdirSync(join(centralu, 'game'))
    writeFileSync(join(centralu, 'game', 'mine.txt'), 'mine')
    await expect(rpc('projects.create', { name: '', source: { git: `${base}/game.git` } })).rejects.toThrow(/already in/)
    expect(readdirSync(join(centralu, 'game'))).toEqual(['mine.txt'])
  })

  it('refuses ext::, file://, local paths and a bad branch before anything is made', async () => {
    for (const git of ['ext::sh -c touch% /tmp/pwned', `file://${served}/game.git`, join(served, 'game.git'), `http://127.0.0.1/game.git`]) {
      await expect(rpc('projects.create', { name: 'x', source: { git } }), git).rejects.toThrow()
    }
    await expect(rpc('projects.create', { name: 'x', source: { git: `${base}/game.git`, branch: '-x' } })).rejects.toThrow(/not a branch name/)
    expect(readdirSync(centralu)).toEqual([])
  })

  it('the preview names the folder after the repository and refuses what create would', async () => {
    expect(await rpc('projects.createPreview', { name: '', source: { git: `${base}/game.git` } })).toEqual({
      parent: centralu,
      path: join(centralu, 'game'),
      error: null,
    })
    expect(((await rpc('projects.createPreview', { name: '', source: { git: 'ext::sh' } })) as { error: string }).error).toMatch(/ext::/)
  })
})

describe('create_project with git (the orchestrator)', () => {
  it('the card names the repository and where it goes; the clone runs only after Create, said in the conversation', async () => {
    const orc = await mgr.orchestrator()
    const call = mgr.runOrchestratorTool(orc.id, 'create_project', { git: `${base}/game.git`, branch: 'dev' })
    await until(() => mgr.listSessions().find((s) => s.id === orc.id)?.pendingApproval?.detail.kind === 'project_create')
    const pending = mgr.listSessions().find((s) => s.id === orc.id)!.pendingApproval!
    expect(pending.detail).toEqual({ kind: 'project_create', name: 'game', path: join(centralu, 'game'), source: { git: `${base}/game.git`, branch: 'dev' } })
    expect(readdirSync(centralu)).toEqual([])

    mgr.respondApproval(orc.id, pending.requestId, 'allow')
    const r = await call
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('a clone of')
    expect(readFileSync(join(centralu, 'game', 'dev.txt'), 'utf8')).toBe('dev\n')
    expect(events.some((e) => e.type === 'notice' && e.sessionId === orc.id && /Cloning/.test(e.text))).toBe(true)
  }, 30_000 * SLOW)
})
/**
 * A TLS certificate and key for tests only (#515): a self-signed `localhost` / `127.0.0.1` certificate valid until
 * 2126, so a clone can be tested over real https against a local server without openssl on the test machine. It
 * protects nothing; the clone tests trust it through `GIT_SSL_CAINFO` and nothing else ever does.
 */
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDATCCAemgAwIBAgIJAOnd5rKxpKzBMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCWxvY2FsaG9zdDAgFw0yNjEwMTExNzAwMzdaGA8yMTI2MDkxNzE3MDAzN1ow
FDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIB
CgKCAQEA4S3aMCMCFMBkWLPYRYGWHVXUJTZUSxaVxpdDt6e9p9+9PklKT5XfY6r9
8jFbuyEtQFt/RX38ZdLBSswmcjhTqdPWDH/3c/IuloSWJ8jONHZVrCpUV8kdexiZ
aaIYKi9k830cXzCpWTxGxurTSqPqBVjYI8jvlkvMb+K8mRAi057fBzcqY+MykWyM
TTgYRS+WA9G4WoCiaqcDjZlbdIuybX4wZDnFelaze4FTki82tc1pVeoR9edcoFTR
PsMNYkY0xkQcHOqVs9/zjjgwEvH0E4Zbay2BtBx7Nb8HcDoAvhclF8YRayi6nFSl
WkkWf8lrLW9IX/G806nh5O8S4lTQnwIDAQABo1QwUjAaBgNVHREEEzARgglsb2Nh
bGhvc3SHBH8AAAEwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAoQwEwYD
VR0lBAwwCgYIKwYBBQUHAwEwDQYJKoZIhvcNAQELBQADggEBACyC6agm9xe2Wadr
Yr85/OkRM6ps+qc3ph8VCFQb0IQcpulFlnVAa9bge1mTaVnywV8Kal13udJKaGoX
MqeT5Q61dz4GU353S6ZMCjOB7o34kzMNr7uYu8FYx1fx9+Dqiw98NCZvY7ZDInf6
4qs9rWcxrx9zYQJOhBqX5APwPEBlZdScgjo3I4r6JyY7ap7fVJuskny4HCWc0O9C
JbF5l30frg54nj8xWgCE8W7fwvVdBq97SOSpHqW1dJEvafOngqmNW0yUhsHfgF9T
Wywboy7NdEq+NRo1jBprBHbdMK23nVwb1ZyRiqgmmf4eMesHoH+bIUrkGv77Nrmn
/18edI8=
-----END CERTIFICATE-----\n`

const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDhLdowIwIUwGRY
s9hFgZYdVdQlNlRLFpXGl0O3p72n370+SUpPld9jqv3yMVu7IS1AW39Fffxl0sFK
zCZyOFOp09YMf/dz8i6WhJYnyM40dlWsKlRXyR17GJlpohgqL2TzfRxfMKlZPEbG
6tNKo+oFWNgjyO+WS8xv4ryZECLTnt8HNypj4zKRbIxNOBhFL5YD0bhagKJqpwON
mVt0i7JtfjBkOcV6VrN7gVOSLza1zWlV6hH151ygVNE+ww1iRjTGRBwc6pWz3/OO
ODAS8fQThltrLYG0HHs1vwdwOgC+FyUXxhFrKLqcVKVaSRZ/yWstb0hf8bzTqeHk
7xLiVNCfAgMBAAECggEAJP2xUCMQHnSUh3XT22c0T9FfrlVEd6lYJW2H9E2b/E3m
+qpziKtoLSlT2kt9dDo5As+FEtdldRywICd1UWIrbESebyM+dU+dk6BoQlTcewXN
gSDbBijFrQkXeqDkM1nhzZYJ6SFHUJ90SQ0edK6ErSgxKX/Cy//br62hqctazUSH
ELj2d37oQoRGQ95XWIIuwAOMu34DAJOJHBsi9XskJRU6IkMcUqH7C45dNQuZj6Uc
v+wQyBA/hafqPVWBvUQxJ1N+G5J77EARq4mW4kU7MzvODICGYhCtPSSMT3FrmXTd
YHQF71kbKGSIzrb7PHoiQQ3qPBgX9NS3GjTPEsSTAQKBgQD5zDL6C+O4qTUFEVxL
81iUhea1RBPhZk9cHMsBKZyZ8f2seAjsnmaGsUaRjjq1PQGycUjcSdWUwpFg3VkH
lvdtL+PNuiY5a/cET3o7HQTE8d2LdxJlLH9RRveIgWlS2ZzP0hWquaPw1zonjRkE
GjEFrO9Bz2/I9cVttBPUVY5nXwKBgQDmxStM0c5/iFQ78o8DFdWAasr9BeehPB02
vSEf1I/Y/QPW06tXISBn0cHx0wwUZM5F65nqq+b9OkaCR6Trno7gbHaHYai95fFC
SgfZwuUcqxNbepV0cubAUAnmCXQbuoV9PIZZ9owBO8QNND/EUijPYieWF3eJURt6
ov7hunxewQKBgQDkIf7IaEVgJ4CZkUJWxva2JhgOog76AqMlv9ISzLsNyXjgo3ub
BgsiphKJ6nhpfz7mhhmBvhjGVG/LJDwj91cfK+aDw6cXOCgPkrpR9G2fpDiuH1/4
cIwSYZq921qiZMWW8woAsqwrz5R3/J/FJFpzEX4s/1LbGMJnL1gQytZURwKBgALZ
QjyThnIKk8edqehG17jbGKBg90gFPvMTCJqk/BWYofh/6miL7yN48mTyzv5ddDJm
wyKjdpl/o6kuCzohXfAlRp1LNlMJyJ2h3lDw1/Uvo3CIpdmnJXQQSN7/FODWv5kZ
KytnILlPLI9hKrxYq0pMEuMGbSJTzvwHkQ/mRmzBAoGANEYP23pxXs8DPq/KAOkE
jcAEozu4ULvnujp9eeIbthSpHDBpvW1MgKR3LHmg76IK1f41rPOOJVStGMG18ybu
kQBJbs6lmHr0mZ8sSNpMPQd/50w4Md/b8dd+23Jo+tfGc2w/lRTLEk8FN/hA/Wfj
MbRqlWZwayhU6gjovkrdPtY=
-----END PRIVATE KEY-----\n`
