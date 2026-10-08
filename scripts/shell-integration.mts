/**
 * The shell end to end (docs/plans/thin-shell.md §3), with the real binary.
 *
 *   pnpm exec tsx scripts/shell-integration.mts [--target-dir <dir>]
 *
 * Makes a throwaway ed25519 key in memory, builds two debug shells with `cargo build -p
 * centralu-shell` (one with the `test-key` feature trusting that key's public half, one exactly as
 * people get it, trusting packaging/shell/keys.json alone), signs content with
 * `scripts/content-manifest.mts` whose `centralu-keeper` is `scripts/shell-fake-keeper.cjs`, and
 * runs the shell binary directly, as LaunchServices would start it, against temporary data folders.
 * Never `open`, never LaunchServices: nothing here can raise a permission prompt.
 *
 * Checked:
 *   - the shell links nothing that can reach the window server (libSystem and libiconv only), so
 *     it cannot be shown as "not responding" (thin-shell.md §3);
 *   - a start copies the content into `<data>/content/<version>/`, read-only, and starts the keeper
 *     from that copy, never from the content it was given, with the window's command line; the
 *     keeper answers on its socket before the shell exits 0, and the status file says so;
 *   - content changed after signing (a host file, the keeper) is refused with exit 10 and status
 *     `content`, nothing is copied and no keeper starts;
 *   - the shell people get refuses content signed with a key outside keys.json, and says it is
 *     not a test build;
 *   - content that needs a newer shell: exit 11, `shell-too-old`;
 *   - an older version than one that started here: exit 12, `downgrade`, no keeper; the same with
 *     `--rollback` starts it from its own copy and lowers the floor;
 *   - a keeper already answering: exit 0, nothing started;
 *   - a keeper that exits before answering: exit 15, `keeper-exited`;
 *   - a bad command line: exit 2, and its status still reaches a data folder it names.
 *
 * CI runs it in the `keeper e2e` job (.github/workflows/build.yml). Every keeper the shell starts
 * is stopped through its socket, and killed if it does not go, before this exits.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { rawPublicKey, throwawayKey, writeContentManifest, type SigningKey } from './content-manifest.mjs'
import { buildShellExe } from './shell-bundle.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FAKE_KEEPER = join(ROOT, 'scripts/shell-fake-keeper.cjs')
const PLATFORM = `${process.platform}-${process.arch}`
const flag = (name: string) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}
const TARGET = flag('--target-dir') ?? process.env.KEEPER_TARGET_DIR ?? join(tmpdir(), 'centralu-shell-target')

let failures = 0
const log = (msg: string) => process.stdout.write(`${msg}\n`)
function check(cond: boolean, what: string, detail = ''): boolean {
  if (cond) log(`  ok   ${what}`)
  else {
    failures++
    log(`  FAIL ${what}${detail ? `\n       ${detail}` : ''}`)
  }
  return cond
}

const work = mkdtempSync(join(tmpdir(), 'centralu-shell-it-'))
// Never the real data folder (AGENTS.md): whatever the keepers start inherits this.
process.env.CC_DATA_DIR = join(work, 'cc-data-dir')
const dataDirs: string[] = []

interface FakeRun {
  pid: number
  script: string
  args: string[]
  mode: string
}
const keepersIn = (data: string): FakeRun[] =>
  existsSync(join(data, 'fake-keepers.jsonl'))
    ? readFileSync(join(data, 'fake-keepers.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as FakeRun)
    : []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** One request on a keeper socket, as `client::request` sends it. */
function ask(sock: string, op: string): Promise<{ ok?: boolean } | undefined> {
  return new Promise((resolve) => {
    const c = createConnection(sock)
    let buf = ''
    const done = (v: { ok?: boolean } | undefined) => {
      c.destroy()
      resolve(v)
    }
    c.setTimeout(2000, () => done(undefined))
    c.on('error', () => done(undefined))
    c.on('connect', () => c.write(`${JSON.stringify({ op })}\n`))
    c.on('data', (d) => {
      buf += String(d)
      const i = buf.indexOf('\n')
      if (i >= 0) done(JSON.parse(buf.slice(0, i)) as { ok?: boolean })
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Stops every keeper the shell started in `data`: by its socket, then by its pid (ours to end). */
async function stopKeepers(data: string): Promise<void> {
  await ask(join(data, 'keeper.sock'), 'stop')
  for (const k of keepersIn(data)) {
    for (let i = 0; i < 30 && alive(k.pid); i++) await sleep(100)
    if (alive(k.pid)) process.kill(k.pid, 'SIGKILL')
  }
}

async function cleanup(): Promise<void> {
  for (const d of dataDirs) await stopKeepers(d)
  // The copies are read-only; give the owner write back before removing them.
  spawnSync('chmod', ['-R', 'u+w', work])
  rmSync(work, { recursive: true, force: true })
}

/** Content for `version` in a fresh folder, signed by `key`. */
function makeContent(version: string, key: SigningKey, opts: { minShellVersion?: number } = {}): string {
  const dir = mkdtempSync(join(work, `content-${version}-`))
  copyFileSync(FAKE_KEEPER, join(dir, 'centralu-keeper'))
  chmodSync(join(dir, 'centralu-keeper'), 0o755)
  mkdirSync(join(dir, 'host'))
  writeFileSync(join(dir, 'host/main.mjs'), `// the host of ${version}\n`)
  writeFileSync(join(dir, 'host/bundle-info.json'), `${JSON.stringify({ commit: 'abc1234', version })}\n`)
  writeContentManifest(dir, { appVersion: version, platform: PLATFORM, minShellVersion: opts.minShellVersion }, key, [])
  return dir
}

function newData(): string {
  const d = mkdtempSync(join(work, 'data-'))
  dataDirs.push(d)
  return d
}

interface Run {
  code: number | null
  stderr: string
  status: Record<string, unknown> | undefined
}
function runShell(exe: string, args: string[], data?: string): Run {
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 60_000 })
  const statusFile = data ? join(data, 'shell-status.json') : undefined
  const status = statusFile && existsSync(statusFile) ? (JSON.parse(readFileSync(statusFile, 'utf8')) as Record<string, unknown>) : undefined
  return { code: r.status, stderr: r.stderr, status }
}
const start = (exe: string, content: string, data: string, nonce: string, ...more: string[]) =>
  runShell(exe, ['--content', content, '--data-dir', data, '--bundle-path', '/Applications/Centralu.app', '--nonce', nonce, ...more], data)

const real = (p: string) => realpathSync(p)

/** The status, the exit code and no keeper and no copy: what every refusal must leave. */
function refused(r: Run, data: string, code: number, reason: string, nonce: string, version: string): void {
  check(r.code === code, `exits ${code}`, `exit ${r.code}; stderr: ${r.stderr.trim()}`)
  check(r.status?.result === 'refused' && r.status?.reason === reason, `the status says refused (${reason})`, JSON.stringify(r.status))
  check(r.status?.nonce === nonce, 'the status carries the nonce the window passed')
  check(r.stderr.includes(`refused (${reason})`), 'one line on stderr says why', r.stderr.trim())
  check(keepersIn(data).length === 0, 'no keeper was started', JSON.stringify(keepersIn(data)))
  check(!existsSync(join(data, 'content', version)), `nothing was copied into content/${version}`)
}

async function main(): Promise<void> {
  const key = throwawayKey()
  const other = throwawayKey()
  log(`building the shell into ${TARGET}`)
  const plainExe = join(work, 'centralu-shell-plain')
  copyFileSync(buildShellExe({ targetDir: TARGET, release: false }), plainExe)
  const testExe = join(work, 'centralu-shell-test')
  copyFileSync(buildShellExe({ targetDir: TARGET, release: false, testKey: rawPublicKey(key.publicKey).toString('base64') }), testExe)
  chmodSync(plainExe, 0o755)
  chmodSync(testExe, 0o755)

  log('\nlinkage')
  for (const exe of [plainExe, testExe]) {
    const libs = execFileSync('otool', ['-L', exe], { encoding: 'utf8' })
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(' ')[0])
      .filter(Boolean)
    const allowed = new Set(['/usr/lib/libSystem.B.dylib', '/usr/lib/libiconv.2.dylib'])
    check(
      libs.every((l) => allowed.has(l)),
      'links libSystem and libiconv only: no AppKit, CoreGraphics or SkyLight, so no window server connection',
      libs.join(', '),
    )
  }

  log('\na start copies, verifies and starts the keeper from the copy')
  {
    const src = makeContent('0.2.0', key)
    const data = newData()
    const r = start(testExe, src, data, 'n-start')
    check(r.code === 0, 'exits 0', `exit ${r.code}; stderr: ${r.stderr.trim()}`)
    const copy = join(data, 'content', '0.2.0')
    check(r.status?.result === 'started' && r.status?.appVersion === '0.2.0', 'the status says started 0.2.0', JSON.stringify(r.status))
    check(r.status?.testBuild === true && r.status?.nonce === 'n-start', 'the status names a test build and the nonce')
    const runs = keepersIn(data)
    check(runs.length === 1, 'exactly one keeper started', JSON.stringify(runs))
    const k = runs[0]
    if (k) {
      check(real(k.script) === real(join(copy, 'centralu-keeper')), 'the keeper ran from <data>/content/0.2.0/', k.script)
      check(!real(k.script).startsWith(real(src)), 'the keeper never ran from the content the shell was given')
      check(
        JSON.stringify(k.args) ===
          JSON.stringify(['--keeper', '--data-dir', data, '--host-source', join(copy, 'host'), '--bundle-path', '/Applications/Centralu.app', '--app-version', '0.2.0']),
        "with the window's command line",
        JSON.stringify(k.args),
      )
      check(r.status?.keeperPid === k.pid, 'the status names the keeper pid')
      check(alive(k.pid), 'the keeper outlives the shell')
    }
    check((await ask(join(data, 'keeper.sock'), 'status'))?.ok === true, 'the keeper answers on keeper.sock')
    check((statSync(copy).mode & 0o222) === 0 && (statSync(join(copy, 'centralu-keeper')).mode & 0o222) === 0, 'the copy is read-only')
    check(readFileSync(join(data, 'content', 'highest-started'), 'utf8').trim() === '0.2.0', 'the floor is 0.2.0')
    const keeperLog = readFileSync(join(data, 'keeper.log'), 'utf8')
    check(keeperLog.includes('[shell] verified and copied') && keeperLog.includes('fake keeper stdout'), "keeper.log has the shell's lines and the keeper's output")

    log('\na keeper already answering: nothing is started')
    const again = start(testExe, src, data, 'n-again')
    check(again.code === 0 && again.status?.alreadyRunning === true, 'exits 0, already running', `${again.code} ${JSON.stringify(again.status)}`)
    check(keepersIn(data).length === 1, 'no second keeper')
    await stopKeepers(data)

    log('\nan older version is refused, and starts when rolled back on purpose')
    const old = makeContent('0.1.9', key)
    const before = keepersIn(data).length
    const down = start(testExe, old, data, 'n-down')
    check(down.code === 12 && down.status?.reason === 'downgrade', 'exits 12 with status downgrade', `${down.code} ${JSON.stringify(down.status)}`)
    check(keepersIn(data).length === before, 'no keeper was started')
    check(!existsSync(join(data, 'content', '0.1.9')), 'nothing was copied')
    const back = start(testExe, old, data, 'n-back', '--rollback')
    check(back.code === 0 && back.status?.appVersion === '0.1.9', 'with --rollback: exits 0 and starts 0.1.9', `${back.code} ${back.stderr.trim()}`)
    const last = keepersIn(data).at(-1)
    check(
      keepersIn(data).length === before + 1 && !!last && real(last.script) === real(join(data, 'content', '0.1.9', 'centralu-keeper')),
      'the rolled-back keeper ran from its own copy',
      last?.script,
    )
    check(readFileSync(join(data, 'content', 'highest-started'), 'utf8').trim() === '0.1.9', 'the rollback lowered the floor to 0.1.9')
    await stopKeepers(data)
  }

  log('\ncontent changed after signing is refused')
  for (const [what, spoil] of [
    ['a host file', (dir: string) => writeFileSync(join(dir, 'host/main.mjs'), '// not what was signed\n')],
    ['the keeper', (dir: string) => writeFileSync(join(dir, 'centralu-keeper'), '#!/bin/sh\necho tampered\n')],
  ] as const) {
    log(`  (${what})`)
    const src = makeContent('0.2.0', key)
    spoil(src)
    const data = newData()
    refused(start(testExe, src, data, 'n-tamper'), data, 10, 'content', 'n-tamper', '0.2.0')
  }

  log('\ncontent signed by a key the shell does not trust is refused')
  {
    const data = newData()
    refused(start(testExe, makeContent('0.2.0', other), data, 'n-other'), data, 10, 'content', 'n-other', '0.2.0')
  }

  log('\nthe shell people get trusts keys.json alone')
  {
    const data = newData()
    const r = start(plainExe, makeContent('0.2.0', key), data, 'n-plain')
    refused(r, data, 10, 'content', 'n-plain', '0.2.0')
    check(r.status?.testBuild === false, 'its status says it is not a test build')
  }

  log('\ncontent that needs a newer shell is refused')
  {
    const data = newData()
    refused(start(testExe, makeContent('0.2.0', key, { minShellVersion: 2 }), data, 'n-old-shell'), data, 11, 'shell-too-old', 'n-old-shell', '0.2.0')
  }

  log('\na keeper that exits before answering')
  {
    const data = newData()
    writeFileSync(join(data, 'fake-mode'), 'exit1\n')
    const r = start(testExe, makeContent('0.2.0', key), data, 'n-exit')
    check(r.code === 15 && r.status?.reason === 'keeper-exited', 'exits 15 with status keeper-exited', `${r.code} ${JSON.stringify(r.status)}`)
    check(!existsSync(join(data, 'content', 'highest-started')), 'the floor did not rise')
  }

  log('\na bad command line')
  {
    const data = newData()
    const r = runShell(testExe, ['--data-dir', data, '--nonce', 'n-usage', '--bogus'], data)
    check(r.code === 2 && r.status?.reason === 'usage' && r.status?.nonce === 'n-usage', 'exits 2, and the status reaches the data folder', `${r.code} ${JSON.stringify(r.status)}`)
    const missing = join(work, 'no-such-data')
    const m = runShell(testExe, ['--content', makeContent('0.2.0', key), '--data-dir', missing])
    check(m.code === 2 && !existsSync(missing), 'a data folder that does not exist: exits 2 and is not created', `${m.code} ${m.stderr.trim()}`)
  }
}

try {
  await main()
} catch (e) {
  failures++
  log(`error: ${(e as Error)?.stack ?? String(e)}`)
} finally {
  await cleanup()
}
log(failures === 0 ? '\nall shell checks passed' : `\n${failures} shell check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
