import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

/**
 * Which checkout a dev server on a shared port serves (#2451). Every worktree's `pnpm dev` and the e2e suite's main server
 * listen on 5174, so a local `pnpm e2e` that reused whatever answers there could test another worktree's code. The web dev
 * server answers `CHECKOUT_PATH` with its checkout's root; the e2e runner reuses a server only when that root is its own.
 * A vite config runs in Node, so this file imports nothing from the repository.
 */
export const CHECKOUT_PATH = '/__centralu/checkout'
/** The e2e suite's main server (e2e/playwright.config.ts), on the port `pnpm dev` takes too */
export const MAIN_URL = 'http://127.0.0.1:5174'
/** How the e2e runner tells the config whether to reuse a server there: `true`, or anything else for never */
export const REUSE_ENV = 'E2E_REUSE_MAIN_SERVER'

/** A folder as one string for every way of naming it: through a link, in another letter case, with a trailing separator */
export const resolvedFolder = (dir: string): string => realpathSync.native(dir)

/** This checkout's root, resolved, so two processes of one checkout give the same string */
export const checkoutRoot = (): string => resolvedFolder(fileURLToPath(new URL('..', import.meta.url)))

/** The dev server's answer at `CHECKOUT_PATH`; only `vite serve` has it, never a build */
export function checkoutMarker(): Plugin {
  const body = JSON.stringify({ root: checkoutRoot() })
  return {
    name: 'centralu-checkout',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(CHECKOUT_PATH, (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(body)
      })
    },
  }
}

/** What answers at a dev server's port: the checkout root it names, null for one that does not say, or `waitedMs` for none in time */
export type Served = { root: string | null; waitedMs?: number }

/**
 * What answers at `url`: null when nothing does, else the checkout root it names, or null `root` for a server that does
 * not say (another program, or a `pnpm dev` of a checkout without the marker, whose page fallback answers every path).
 * One that takes the connection and does not answer within `timeoutMs` (hung, or busy) is said as such
 */
export async function servedCheckout(url: string, timeoutMs = 2_000): Promise<Served | null> {
  let res: Response
  try {
    res = await fetch(new URL(CHECKOUT_PATH, url), { signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    return e instanceof Error && e.name === 'TimeoutError' ? { root: null, waitedMs: timeoutMs } : null
  }
  const body: unknown = await res.json().catch(() => null)
  const root = typeof body === 'object' && body !== null && 'root' in body && typeof body.root === 'string' ? body.root : null
  return { root }
}

/**
 * Whether the e2e run reuses the server at `url`: only one of this checkout, and never in CI, which tests a server it
 * started itself. Any other is refused with the line that says what it is, rather than left to Playwright's "already used"
 */
export function reuseServer(url: string, served: Served | null, own: string, ci: boolean): boolean {
  if (served === null) return false
  if (served.waitedMs !== undefined) throw new Error(`${url} takes connections but did not answer within ${served.waitedMs / 1000} s, so this run cannot tell whose server it is (a hung one, or this checkout's own under load): stop it, or run again.`)
  if (served.root === own && !ci) return true
  if (served.root === own) throw new Error(`${url} is already served by this checkout's own dev server, and a CI run never reuses a server: stop it.`)
  const tested = 'The e2e run would test it in place of this branch: stop it'
  if (served.root) throw new Error(`${url} is already served by the dev server of another checkout, ${served.root}. ${tested}, or run e2e from that checkout.`)
  throw new Error(`${url} is already served by a server that is not this checkout's dev server (another program, or the \`pnpm dev\` of a checkout without its marker). ${tested}.`)
}

/**
 * What the e2e runner tells a Playwright run of `args` (tooling/with-e2e-lock.ts), asked once the lock is held so no other
 * run's own server is there: for the main config, `REUSE_ENV` in `env` says whether to reuse the server at `url`, or this
 * throws the line that refuses it. Any other run gets none: a value set in the shell would reuse whatever answers there
 */
export async function tellMainServer(args: readonly string[], configOf: (args: string[]) => string, env: NodeJS.ProcessEnv, url = MAIN_URL): Promise<void> {
  delete env[REUSE_ENV]
  if (resolve(configOf([...args])) !== resolve('e2e/playwright.config.ts')) return
  env[REUSE_ENV] = String(reuseServer(url, await servedCheckout(url), checkoutRoot(), !!env.CI))
}
