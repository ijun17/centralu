import { z } from 'zod'
import type { AgentProcess, AgentSpawnSpec } from '../contract.js'
import { AcpConnection, AUTH_REQUIRED, METHOD_NOT_FOUND, RpcError } from '../acp/connection.js'
import { startToolProcess } from '../core/tool-process.js'
import { lineSplitter } from '../../transport/json-lines.js'
import { asObj } from '../../json-value.js'
import type { Platform } from '../../os.js'
import { browserFolder, openInBrowser, type AgyHome } from './agent-files.js'
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
 * agent's own (330 s), and the process kept until it answers. The agent never opens the browser itself, on any OS: its
 * `BROWSER` is a helper in a private folder that writes the address it is given to a file there (`browserFolder`), and
 * the host opens the browser (`openUrl`). On Windows that is through what opens things for the person outside the host's
 * job object (the terminal broker, `main.ts`), so the browser outlives a Stop, the sign-in's end and the host (review of
 * #1685: the agent's own launcher had started it as its child, inside the job). The agent's stderr line `Open the
 * following link to authenticate the ACP server: <url>` is a second source of the same address, read here and left out
 * of the log (`agyStderrLine`). The address reaches the host, never host.log.
 *
 * The address is opened once, and only the agent's own login request (`agentSignInUrl`). Where no helper can be written
 * the sign-in is refused, not started (`NO_HELPER`). A cancel ends the process, and with it the
 * listener (ACP cannot cancel `authenticate`, spike §4).
 */

/** Past the agent's own 300 s, so its "timed out" answer is the one heard */
export const SIGN_IN_TIMEOUT_MS = 330_000

export type SignInResult = { plan: { name: string; upgradeUri?: string } | null }

export type SignInDeps = {
  /** Starts the sign-in process (`startToolProcess`: it ends with the host) */
  spawn?: (spec: AgentSpawnSpec) => AgentProcess
  /**
   * Opens an address in the person's browser on this machine, outside the host's work: on Windows the host's opener that
   * starts it outside the job (`main.ts`); `openInBrowser` where no such opener is given
   */
  openUrl?: (url: string) => void
  platform?: Platform
  timeoutMs?: number
}

const Tier = z.looseObject({ name: z.string(), upgradeUri: z.string().nullish() })
const AuthResult = z.looseObject({ _meta: z.looseObject({ antigravity: z.looseObject({ tier: Tier.nullish() }).nullish() }).nullish() }).nullish()

/** Why no `BROWSER` helper could be written: the paths it is made of hold what its launcher splits at */
export const NO_HELPER =
  "the path of Centralu's data folder or of the host's Node holds a character Antigravity's browser setting cannot carry (';' on Windows, ':' elsewhere, or '%s')"

const URL_LINE = /Open the following link to authenticate the ACP server:\s*(\S+)/

/**
 * An address worth opening: https, on a Google host, with no user part (`https://someone@accounts.google.com/…` would carry
 * whatever stands before the `@`, an email included, into an event) and no port of its own. Anything else the agent hands
 * over is dropped. What is passed on is written out again from the parsed parts, never the agent's string
 */
export function signInUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null
    if (url.hostname !== 'google.com' && !url.hostname.endsWith('.google.com')) return null
    // The URL's own serialization of what it parsed: the host as parsed (lower case, punycode), never the agent's string
    return url.toString()
  } catch {
    return null
  }
}

/**
 * The OAuth client of Antigravity's ACP server 1.4.3: public, it stands in the agent's own login address (measured on
 * Windows and on Linux with a token the agent could not use). A new release must be measured again (`AGY_RELEASE`)
 */
export const AGY_OAUTH_CLIENT = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Google's v2 authorize page, whoever's client asks (only for the log: `agentSignInUrl` is what is acted on) */
export function googleAuthorizeUrl(raw: string): URL | null {
  const url = signInUrl(raw)
  if (!url) return null
  const parsed = new URL(url)
  return parsed.hostname === 'accounts.google.com' && parsed.pathname === '/o/oauth2/v2/auth' ? parsed : null
}

/**
 * The agent's own login request, and nothing else Google serves: `https://accounts.google.com/o/oauth2/v2/auth` with
 * `response_type=code`, the agent's client (`AGY_OAUTH_CLIENT`) and a `redirect_uri` on this machine's loopback (its
 * one-shot listener), each named once. `BROWSER` reaches every command the agent runs, so a Google address alone says
 * nothing (deep review of #1687: `gcloud auth login` opens Google's authorize page with gcloud's own client, a script may
 * open a Google Doc); only this one is the agent asking for a sign-in. The address passed on is `signInUrl`'s rebuilt one
 */
export function agentSignInUrl(raw: string): string | null {
  const parsed = googleAuthorizeUrl(raw)
  if (!parsed) return null
  const url = parsed.toString()
  const one = (name: string) => {
    const all = parsed.searchParams.getAll(name)
    return all.length === 1 ? (all[0] ?? null) : null
  }
  if (one('response_type') !== 'code' || one('client_id') !== AGY_OAUTH_CLIENT) return null
  try {
    const back = new URL(one('redirect_uri') ?? '')
    if (back.protocol !== 'http:' || !LOOPBACK.has(back.hostname) || back.username !== '' || back.password !== '') return null
  } catch {
    return null
  }
  return url
}

export async function runSignIn(home: AgyHome, archive: AgyArchive, signal: AbortSignal, deps: SignInDeps = {}): Promise<SignInResult> {
  const folder = await browserFolder(home, deps.platform)
  // No helper could be written (`browserFolder`): the agent's own launcher would start the browser, on Windows inside the
  // host's job, so a Stop or the host's exit would end it with every tab. Refused rather than started
  if (folder.browser === '') {
    await folder.remove()
    console.error(`[Antigravity] sign-in refused: ${NO_HELPER}`)
    throw new InstallFailure('failed', `Antigravity cannot sign in here: ${NO_HELPER}`)
  }
  const openUrl = deps.openUrl ?? ((url: string) => openInBrowser(url, deps.platform))
  let opened = false
  const offer = (raw: string) => {
    if (opened) return
    // Only the agent's own login request (`agentSignInUrl`): the folder is under the data folder, where an agent of
    // another session could write (deep review of #1687, follow-up 5)
    const url = agentSignInUrl(raw)
    if (!url) {
      console.error('[Antigravity] the sign-in was handed an address that is not its own login request; not opened')
      return
    }
    opened = true
    openUrl(url)
  }
  const launch = agyLaunch(home, archive, folder.browser)
  const spec: AgentSpawnSpec = { ...launch, cwd: home.root, env: { ...process.env, ...launch.env } }
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

/**
 * Why a sign-in ended without one, as a word for the screen. The agent answers both a sign-in that timed out and an account
 * Google will not serve with `-32000` and `data.reason: "onboarding_failed"` (both measured on 1.4.3: "Onboarding failed:
 * Timed out waiting for the authentication flow to complete." and "Onboarding failed: User is ineligible for free-tier. …
 * Verification URL: <address>"), so the words tell them apart, the timeout first, by the agent's words for its own wait (another error that says "timed out" keeps its reason). The verification page is carried apart
 * (`verifyUri`); no address or email in the agent's words reaches the message
 */
export function signInFailure(err: unknown, signal: AbortSignal): InstallFailure {
  if (err instanceof InstallFailure) return err
  if (signal.aborted) return new InstallFailure('cancelled', 'The sign-in was cancelled')
  const timedOut = new InstallFailure('timed_out', 'Sign-in timed out: the browser did not finish within 5 minutes')
  if (err instanceof RpcError) {
    // Only the agent's own wait for the browser; any other timeout keeps its own reason and words
    if (AUTH_FLOW_TIMED_OUT.test(err.message)) return timedOut
    if (err.code === AUTH_REQUIRED && asObj(err.data).reason === 'onboarding_failed') {
      const verify = VERIFY_URL.exec(err.message)?.[1]
      const url = verify ? signInUrl(verify) : null
      return new InstallFailure('ineligible', 'Google did not set up Antigravity for this account', url ?? undefined)
    }
    return new InstallFailure('failed', `Antigravity's sign-in failed: ${scrubbed(err.message)}`)
  }
  const message = err instanceof Error ? err.message : String(err)
  // Centralu's bound past the agent's own (`SIGN_IN_TIMEOUT_MS`) on the authenticate call
  if (/^No response for authenticate$/.test(message)) return timedOut
  return new InstallFailure('failed', `Antigravity's sign-in failed: ${scrubbed(message)}`)
}

const VERIFY_URL = /Verification URL:\s*(\S+)/i

/** The agent's answer when nobody finished the browser's sign-in within its 300 s (measured on 1.4.3, inside "Onboarding failed: …") */
const AUTH_FLOW_TIMED_OUT = /Timed out waiting for the authentication flow/i

/** The agent's words without the addresses and emails they may carry (its answers name the account's verification page) */
function scrubbed(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, '(address)').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '(email)')
}
