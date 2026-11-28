import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer as httpServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, resolveConfig, type Plugin, type ViteDevServer } from 'vite'
import { REUSE_ENV, checkoutMarker, checkoutRoot, resolvedFolder, reuseServer, servedCheckout, tellMainServer } from './dev-server-checkout.js'
import { configOf } from './e2e-affected.js'
import { freePort } from './free-port.js'

/**
 * A local e2e run reuses the server on its main port only when it serves this checkout (#2451): every worktree's
 * `pnpm dev` listens on the same port. Real vite dev servers in this process, on free ports.
 */

const servers: ViteDevServer[] = []
const plain: Server[] = []
const folders: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.resetModules()
  await Promise.all(servers.splice(0).map((s) => s.close()))
  for (const s of plain.splice(0)) {
    s.closeAllConnections()
    s.close()
  }
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true })
})

/** A folder with an index page, as the web app's */
function appFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'dev-server-checkout-'))
  folders.push(root)
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>app</title>')
  return root
}

/** A vite dev server of an app folder, as `pnpm dev` serves one, with these plugins */
async function devServer(plugins: Plugin[]): Promise<string> {
  const root = appFolder()
  const port = await freePort()
  const server = await createServer({ configFile: false, root, plugins, logLevel: 'silent', server: { host: '127.0.0.1', port, strictPort: true } })
  servers.push(server)
  await server.listen()
  return `http://127.0.0.1:${port}`
}

describe('which checkout a dev server serves (#2451)', () => {
  it("names this checkout's root from a dev server with the marker", async () => {
    const url = await devServer([checkoutMarker()])
    expect(await servedCheckout(url)).toEqual({ root: checkoutRoot() })
  })

  it('names no root for a dev server without the marker, whose page fallback answers every path', async () => {
    const url = await devServer([])
    const page = await fetch(new URL('/__centralu/checkout', url), { headers: { accept: '*/*' } })
    expect(page.status).toBe(200)
    expect(await servedCheckout(url)).toEqual({ root: null })
  })

  it('answers null when nothing listens', async () => {
    expect(await servedCheckout(`http://127.0.0.1:${await freePort()}`)).toBeNull()
  })

  it('says how long it waited for a server that never answers, so it is refused rather than taken for a free port', async () => {
    const port = await freePort()
    const hung = httpServer(() => {})
    plain.push(hung)
    await new Promise<void>((resolve) => hung.listen(port, '127.0.0.1', resolve))
    expect(await servedCheckout(`http://127.0.0.1:${port}`, 200)).toEqual({ root: null, waitedMs: 200 })
  })

  it('is the resolved root, so two spellings of one checkout (a link, a letter case, a trailing separator) compare equal', () => {
    expect(checkoutRoot()).toBe(realpathSync.native(checkoutRoot()))
    expect(checkoutRoot()).not.toMatch(/[/\\]$/)
    const real = join(appFolder(), 'Checkout')
    mkdirSync(real)
    // A junction on Windows needs no privilege; elsewhere the type is ignored and it is a folder link
    const link = join(dirname(real), 'linked')
    symlinkSync(real, link, 'junction')
    expect(resolvedFolder(link)).toBe(resolvedFolder(real))
    // macOS and Windows name a folder in any letter case
    if (process.platform !== 'linux') expect(resolvedFolder(real.toUpperCase())).toBe(resolvedFolder(real))
  })

  it('is left out of a build, so a shipped page never says where the checkout is', async () => {
    const built = await resolveConfig({ configFile: false, root: appFolder(), plugins: [checkoutMarker()], logLevel: 'silent' }, 'build')
    const served = await resolveConfig({ configFile: false, root: appFolder(), plugins: [checkoutMarker()], logLevel: 'silent' }, 'serve')
    expect(built.plugins.map((p) => p.name)).not.toContain('centralu-checkout')
    expect(served.plugins.map((p) => p.name)).toContain('centralu-checkout')
  })

  it("is in the web app's vite config, which every checkout's `pnpm dev` runs", async () => {
    const { default: config } = await import('../apps/web/vite.config.js')
    expect(config.plugins?.flat().some((p) => p && typeof p === 'object' && 'name' in p && p.name === 'centralu-checkout')).toBe(true)
  })
})

describe('whether the e2e run reuses the server on its main port (#2451)', () => {
  const url = 'http://127.0.0.1:5174'
  const own = checkoutRoot()

  it.each([
    ['nothing listens, locally', null, false, false],
    ['nothing listens, in CI', null, true, false],
    ["this checkout's dev server, locally", { root: own }, false, true],
  ] as const)('%s', (_, served, ci, reuse) => {
    expect(reuseServer(url, served, own, ci)).toBe(reuse)
  })

  it.each([false, true])("refuses another checkout's dev server, naming it (CI: %s)", (ci) => {
    expect(() => reuseServer(url, { root: join(own, '..', 'other-worktree') }, own, ci)).toThrow(
      `${url} is already served by the dev server of another checkout, ${join(own, '..', 'other-worktree')}. The e2e run would test it in place of this branch`,
    )
  })

  it("refuses this checkout's own dev server in CI, which tests a server it started itself", () => {
    expect(() => reuseServer(url, { root: own }, own, true)).toThrow(`${url} is already served by this checkout's own dev server, and a CI run never reuses a server: stop it.`)
  })

  it('refuses a server that took the connection and did not answer in time, saying so rather than calling it another program', () => {
    expect(() => reuseServer(url, { root: null, waitedMs: 2_000 }, own, false)).toThrow(`${url} takes connections but did not answer within 2 s`)
  })

  it('refuses a server that does not say which checkout it serves', () => {
    expect(() => reuseServer(url, { root: null }, own, false)).toThrow("a server that is not this checkout's dev server")
  })

  it.each([
    ['true', true],
    ['false', false],
    [undefined, false],
  ] as const)('the config reuses it as the runner says (%s), and never when unset', async (value, reuse) => {
    vi.stubEnv(REUSE_ENV, value)
    const { default: config } = await import('../e2e/playwright.config.js')
    const servers = [config.webServer].flat()
    expect(servers.find((s) => s?.url === url)?.reuseExistingServer).toBe(reuse)
  })
})

describe('what the e2e runner tells a run of the main config (#2451)', () => {
  const MAIN = ['test', '--config', 'e2e/playwright.config.ts']

  it('tells another config nothing, and drops a value set in the shell', async () => {
    const env: NodeJS.ProcessEnv = { [REUSE_ENV]: 'true' }
    await tellMainServer(['test', '--config', 'e2e/ux/playwright.config.ts'], configOf, env, `http://127.0.0.1:${await freePort()}`)
    expect(env).toEqual({})
  })

  it("reuses this checkout's dev server, and tells a run with nothing there to start its own over a value set in the shell", async () => {
    const env: NodeJS.ProcessEnv = {}
    await tellMainServer(MAIN, configOf, env, await devServer([checkoutMarker()]))
    expect(env[REUSE_ENV]).toBe('true')
    const stale: NodeJS.ProcessEnv = { [REUSE_ENV]: 'true' }
    await tellMainServer(MAIN, configOf, stale, `http://127.0.0.1:${await freePort()}`)
    expect(stale[REUSE_ENV]).toBe('false')
  })

  it("refuses another server, and this checkout's own in CI", async () => {
    await expect(tellMainServer(MAIN, configOf, {}, await devServer([]))).rejects.toThrow("a server that is not this checkout's dev server")
    await expect(tellMainServer(MAIN, configOf, { CI: '1' }, await devServer([checkoutMarker()]))).rejects.toThrow('a CI run never reuses a server')
  })
})
