import { z } from 'zod'
import type { AgentProcess, AgentSpawnSpec } from '../contract.js'
import { AcpConnection, AUTH_REQUIRED, METHOD_NOT_FOUND, RpcError } from '../acp/connection.js'
import { startToolProcess } from '../core/tool-process.js'
import { lineSplitter } from '../../transport/json-lines.js'
import { asObj } from '../../json-value.js'
import type { Platform } from '../../os.js'
import { hostOpensSignIn, openInBrowser, signInFolder, type AgyHome } from './agent-files.js'
import { InstallFailure } from './failure.js'
import { agyLaunch } from './launch.js'
import type { AgyArchive } from './release.js'
import { agyStderrLine } from './shape.js'

/**
 * Antigravity's sign-in, inside Centralu (#59, owner 2026-10-27; docs/plans/antigravity-adapter.md §4). The agent has no
 * terminal sign-in: ACP `authenticate {methodId: "oauth-personal"}` opens a one-shot listener on `127.0.0.1` of the machine
 * it runs on, hands a Google address to the platform's browser launcher, and answers once the person has signed in there
 * (measured: 14 s after the address was opened) or after 300 s ("Timed out waiting for the authentication flow").
 *
 * So the sign-in is a process of its own, tied to no session: `initialize`, then `authenticate` with a bound past the
 * agent's own (330 s), and the process kept until it answers. The address reaches the host, never host.log:
 * - **macOS and Linux**: `BROWSER` names a small script in a private folder that writes the address it is given to a file
 *   there (measured on macOS: the launcher honours it, and no browser opens by itself); the host opens the browser
 * - **Every system**: the agent's stderr line `Open the following link to authenticate the ACP server: <url>`, read here
 *   and left out of the log (`agyStderrLine`); on Windows it is the only source, and the agent's own launcher opens the
 *   browser there (to be checked live, plan §9)
 *
 * The address is opened once, and only an `https` address on a Google host. A cancel ends the process, and with it the
 * listener (ACP cannot cancel `authenticate`, spike §4).
 */

/** Past the agent's own 300 s, so its "timed out" answer is the one heard */
export const SIGN_IN_TIMEOUT_MS = 330_000

export type SignInResult = { plan: { name: string; upgradeUri?: string } | null }

export type SignInDeps = {
  /** Starts the sign-in process (`startToolProcess`: it ends with the host) */
  spawn?: (spec: AgentSpawnSpec) => AgentProcess
  /** Opens an address in the person's browser on this machine */
  openUrl?: (url: string) => void
  platform?: Platform
  timeoutMs?: number
}

const Tier = z.looseObject({ name: z.string(), upgradeUri: z.string().nullish() })
const AuthResult = z.looseObject({ _meta: z.looseObject({ antigravity: z.looseObject({ tier: Tier.nullish() }).nullish() }).nullish() }).nullish()

const URL_LINE = /Open the following link to authenticate the ACP server:\s*(\S+)/

/** An address worth opening: https, on a Google host. Anything else the agent hands over is dropped */
export function signInUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'https:') return null
    return url.hostname === 'google.com' || url.hostname.endsWith('.google.com') ? url.toString() : null
  } catch {
    return null
  }
}

export async function runSignIn(home: AgyHome, archive: AgyArchive, signal: AbortSignal, deps: SignInDeps = {}): Promise<SignInResult> {
  const folder = await signInFolder(home, deps.platform)
  const openUrl = deps.openUrl ?? ((url: string) => openInBrowser(url, deps.platform))
  let opened = false
  const offer = (raw: string) => {
    const url = signInUrl(raw)
    if (!url || opened) return
    opened = true
    if (hostOpensSignIn(folder)) openUrl(url)
  }
  const launch = agyLaunch(home, archive)
  const spec: AgentSpawnSpec = { ...launch, cwd: home.root, env: { ...process.env, ...launch.env, ...(folder.helper ? { BROWSER: folder.helper } : {}) } }
  const proc = startToolProcess(spec, deps.spawn ? { spawn: deps.spawn } : {})
  const lines = lineSplitter((line) => {
    const m = URL_LINE.exec(line)
    if (m?.[1]) offer(m[1])
  })
  proc.stderr?.on('data', (chunk: Buffer | string) => lines.push(chunk))
  folder.watch(offer)
  const conn = new AcpConnection(
    proc,
    {
      onNotification: () => {},
      onRequest: async (_id, method) => {
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
      },
      onExit: () => {},
    },
    'Antigravity sign-in',
    agyStderrLine,
  )
  const abort = () => void conn.dispose(500)
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) throw new InstallFailure('cancelled', 'The sign-in was cancelled')
    await conn.request('initialize', { protocolVersion: 1, clientInfo: { name: 'centralu', version: '1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 60_000)
    const answer = AuthResult.parse(await conn.request('authenticate', { methodId: 'oauth-personal' }, deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS))
    const tier = answer?._meta?.antigravity?.tier
    return { plan: tier ? { name: tier.name, ...(tier.upgradeUri ? { upgradeUri: tier.upgradeUri } : {}) } : null }
  } catch (err) {
    throw signInFailure(err, signal)
  } finally {
    signal.removeEventListener('abort', abort)
    await conn.dispose(1000).catch(() => {})
    await folder.remove()
  }
}

/** Why a sign-in ended without one, as a word for the screen */
export function signInFailure(err: unknown, signal: AbortSignal): InstallFailure {
  if (err instanceof InstallFailure) return err
  if (signal.aborted) return new InstallFailure('cancelled', 'The sign-in was cancelled')
  const timedOut = new InstallFailure('timed_out', 'Sign-in timed out: the browser did not finish within 5 minutes')
  if (err instanceof RpcError) {
    if (err.code === AUTH_REQUIRED && asObj(err.data).reason === 'onboarding_failed') {
      return new InstallFailure('ineligible', 'Google did not set up Antigravity for this account')
    }
    if (/timed out/i.test(err.message)) return timedOut
    return new InstallFailure('failed', `Antigravity's sign-in failed: ${err.message}`)
  }
  const message = err instanceof Error ? err.message : String(err)
  if (/^No response for authenticate/.test(message)) return timedOut
  return new InstallFailure('failed', `Antigravity's sign-in failed: ${message}`)
}
