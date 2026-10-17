import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SLOW } from './test-timing.js'
import reportServerDeaths, { deathLines, readDeaths } from '../e2e/web-server-report.js'

/*
 * The e2e dev servers' keeper (scripts/e2e-web-server.mjs, #651). Playwright starts a `webServer` once, so a vite
 * that died mid-run (a V8 abort under Node 26.9) failed every later test with ERR_CONNECTION_RESET. These run the
 * script against a stand-in server that dies when asked to.
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(root, 'scripts', 'e2e-web-server.mjs')

const dirs: string[] = []
const running: ChildProcess[] = []
const urls: string[] = []
afterEach(async () => {
  for (const c of running.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  // The stand-in outlives a killed keeper (a shell stands between them): asked to die, it ends with nobody to restart it
  for (const u of urls.splice(0)) await fetch(`${u}/die`).catch(() => {})
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as { port: number }).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

/** A server that answers with its life number, and exits with 134 (an abort's code) when asked for /die */
function standIn(dir: string): string {
  const file = join(dir, 'server.mjs')
  writeFileSync(
    file,
    [
      "import { createServer } from 'node:http'",
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs'",
      'const [port, lives, mode] = process.argv.slice(2)',
      "if (mode === 'never') process.exit(7)",
      "const life = (existsSync(lives) ? Number(readFileSync(lives, 'utf8')) : 0) + 1",
      'writeFileSync(lives, String(life))',
      'createServer((req, res) => {',
      '  res.end(String(life))',
      "  if (req.url === '/die') setImmediate(() => process.exit(134))",
      "}).listen(Number(port), '127.0.0.1')",
    ].join('\n'),
  )
  return file
}

function supervise(args: string[], env: NodeJS.ProcessEnv = {}): { child: ChildProcess; stderr: () => string; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } })
  running.push(child)
  let err = ''
  child.stderr!.on('data', (b: Buffer) => (err += b.toString()))
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
  return { child, stderr: () => err, exited }
}

/** The life number the server answers with, or 0 while nothing answers */
const lifeAt = (url: string): Promise<number> =>
  fetch(url)
    .then((r) => r.text())
    .then(Number)
    .catch(() => 0)

const node = `"${process.execPath}"`

describe('the e2e dev server keeper (#651)', () => {
  it('starts a server that died mid-run again, and says how it died', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-e2e-web-'))
    dirs.push(dir)
    const port = await freePort()
    const url = `http://127.0.0.1:${port}`
    urls.push(url)
    const events = join(dir, 'events.jsonl')
    const s = supervise(['--url', url, '--', node, `"${standIn(dir)}"`, String(port), `"${join(dir, 'lives')}"`], { E2E_WEB_SERVER_EVENTS: events })
    await expect.poll(() => lifeAt(url), { timeout: 15_000 * SLOW }).toBe(1)
    // The ready check has to have seen it before the death counts as mid-run
    await new Promise((r) => setTimeout(r, 600))
    await fetch(`${url}/die`).catch(() => {})
    await expect.poll(() => lifeAt(url), { timeout: 15_000 * SLOW }).toBe(2)
    expect(s.stderr()).toMatch(/died mid-run \(exit code 134\).*Starting it again \(1 of 3\)/)
    expect(readFileSync(join(dir, 'lives'), 'utf8')).toBe('2')
    // Recorded for the report after the run
    expect(readDeaths(events)).toEqual([{ url, how: 'exit code 134', restarted: true }])
  }, 30_000 * SLOW)

  it('ends with the server, not in a loop, when it ends before it ever answered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-e2e-web-'))
    dirs.push(dir)
    const port = await freePort()
    const s = supervise(['--url', `http://127.0.0.1:${port}`, '--', node, `"${standIn(dir)}"`, String(port), `"${join(dir, 'lives')}"`, 'never'])
    expect(await s.exited).toBe(7)
    expect(s.stderr()).toMatch(/ended \(exit code 7\) before it answered/)
  }, 30_000 * SLOW)

  it('gives up after its restarts, so a server that keeps dying still fails the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-e2e-web-'))
    dirs.push(dir)
    const port = await freePort()
    const url = `http://127.0.0.1:${port}`
    const s = supervise(['--url', url, '--restarts', '0', '--', node, `"${standIn(dir)}"`, String(port), `"${join(dir, 'lives')}"`])
    await expect.poll(() => lifeAt(url), { timeout: 15_000 * SLOW }).toBe(1)
    await new Promise((r) => setTimeout(r, 600))
    await fetch(`${url}/die`).catch(() => {})
    expect(await s.exited).toBe(134)
    expect(s.stderr()).toMatch(/giving up/)
  }, 30_000 * SLOW)

  it('runs every dev server of the e2e suite', async () => {
    const { default: config } = await import('../e2e/playwright.config.js')
    const servers = [config.webServer ?? []].flat()
    expect(servers.length).toBeGreaterThanOrEqual(4)
    for (const w of servers) {
      expect(w.command).toMatch(new RegExp(`^node \\.\\./scripts/e2e-web-server\\.mjs --url ${w.url} -- pnpm --filter @cc/web exec vite `))
      // A webServer command runs in the config's folder, e2e/, unless it says otherwise
      expect(w.cwd).toBeUndefined()
    }
  })
})

describe('the report of dev servers that died, after the run (#651)', () => {
  const death = { url: 'http://127.0.0.1:5174', how: 'exit code 134', restarted: true }

  it('is a warning annotation on GitHub Actions, and a plain line elsewhere', () => {
    expect(deathLines([death], true)).toEqual([
      '::warning title=e2e dev server died::the dev server at http://127.0.0.1:5174 died mid-run (exit code 134) and was started again; the tests talking to it then may have failed for that (#651)',
    ])
    expect(deathLines([{ ...death, restarted: false }], false)[0]).toMatch(/^\[e2e\] the dev server .* was not started again;/)
  })

  it('prints each recorded death once, from the runner, and says nothing when there was none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-e2e-web-'))
    dirs.push(dir)
    const file = join(dir, 'events.jsonl')
    writeFileSync(file, `${JSON.stringify(death)}\n`)
    vi.stubEnv('E2E_WEB_SERVER_EVENTS', file)
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await reportServerDeaths()
      await reportServerDeaths()
      expect(log.mock.calls.map(([l]) => String(l))).toEqual([expect.stringMatching(/^::warning title=e2e dev server died::/)])
    } finally {
      log.mockRestore()
    }
  })
})
