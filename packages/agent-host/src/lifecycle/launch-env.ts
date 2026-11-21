import { tryParseJson } from '../json-value.js'

/**
 * What the host's launcher hands it in the environment (lessons ST16), read once and taken out. They come as variables, never
 * arguments (`ps` shows every argument to every user, and the token is the key to every RPC), and are deleted before anything
 * is spawned: a shell in a project should not hold the token
 */

export type LaunchEnv = {
  /** Started by the keeper (#280): control lines on stdin, the activity report and start line on stdout, the turns the keeper held */
  underKeeper: boolean
  /** Where the keeper says this host's files came from, for `hello_ok` (keeper-link.ts) */
  keeperSource: string | undefined
  /**
   * The keeper's front door: the stable address every client reaches this host through. The Codex bridge gets it rather than
   * the host's own port, because a running codex keeps the bridge it started and a swap must not cut it off
   */
  frontDoor: string | undefined
  /**
   * Started by `centralu serve` (docs/agent-host/remote/serve.md), the one host `host.stop` may end: it has no keeper or window
   * to stop it, and on Windows a launcher can only be killed, which skips the shutdown
   */
  startedByServe: boolean
  /**
   * Who started this host, for `host.lock` and the conflict message of a second host on the folder: `CC_STARTED_BY=app` from
   * the window; the keeper and `serve` are told apart by their own variables. Null when nothing says
   */
  startedBy: 'app' | 'keeper' | 'serve' | null
  /**
   * Where a `centralu serve` was asked for from (`CC_SERVE_FROM`): the hub's name when a hub's link passed it, and the ssh
   * client's address in an ssh session. Null when neither
   */
  serveFrom: ServeFrom | null
  /**
   * The token handed over in the environment, by an older keeper or `serve` (and by scripts that start a host themselves);
   * under a keeper, the keeper's, the same for every host it runs
   */
  token: string | undefined
  /**
   * The launcher writes the token as the first line on stdin instead (`readHandedToken`): never in the environment, which every
   * process of this user can read while the host runs
   */
  tokenOnStdin: boolean
  /**
   * Where `centralu serve` keeps the full credentials' verifiers (`serve-credentials.ts`): set when the launcher hands this
   * host its key on stdin instead of a token; only a hello whose credential's verifier is in that file is full, read at each
   * hello
   */
  serveState: string | undefined
}

/** Where a `centralu serve` was asked for from (`LaunchEnv.serveFrom`) */
export type ServeFrom = { hub?: string; ssh?: string }

/**
 * The variables `takeLaunchEnv` reads or removes. Nothing the host spawns may see them: `CC_HOST_URL` and `CC_HOST_CREDENTIAL`
 * are what a host gives its own agents, and a host started inside one must not hand its agents the parent's
 */
export const LAUNCH_VARIABLES = [
  'CC_KEEPER',
  'CC_HOST_SOURCE',
  'CC_FRONT_DOOR',
  'CC_SERVE',
  'CC_SERVE_FROM',
  'CC_STARTED_BY',
  'CC_HOST_TOKEN',
  'CC_HOST_TOKEN_ON_STDIN',
  'CC_SERVE_STATE',
  'CC_HOST_URL',
  'CC_HOST_CREDENTIAL',
] as const

/** A hub's name or an address as the launcher passed it: short, and only characters that cannot break a sentence */
const NAME_RE = /^[A-Za-z0-9._:-]{1,64}$/

/** `CC_SERVE_FROM`, field by field; a field of the wrong shape is left out, never trusted */
export function parseServeFrom(raw: string | undefined): ServeFrom | null {
  if (!raw) return null
  const v = tryParseJson(raw)
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const from: ServeFrom = {}
  if (typeof o.hub === 'string' && NAME_RE.test(o.hub)) from.hub = o.hub
  if (typeof o.ssh === 'string' && NAME_RE.test(o.ssh)) from.ssh = o.ssh
  return from.hub || from.ssh ? from : null
}

export function takeLaunchEnv(env: Record<string, string | undefined> = process.env): LaunchEnv {
  const launch: LaunchEnv = {
    underKeeper: env.CC_KEEPER === '1',
    keeperSource: env.CC_HOST_SOURCE,
    frontDoor: env.CC_FRONT_DOOR,
    startedByServe: env.CC_SERVE === '1',
    startedBy: env.CC_KEEPER === '1' ? 'keeper' : env.CC_SERVE === '1' ? 'serve' : env.CC_STARTED_BY === 'app' ? 'app' : null,
    serveFrom: env.CC_SERVE === '1' ? parseServeFrom(env.CC_SERVE_FROM) : null,
    token: env.CC_HOST_TOKEN,
    tokenOnStdin: env.CC_HOST_TOKEN_ON_STDIN === '1',
    serveState: env.CC_SERVE === '1' ? env.CC_SERVE_STATE || undefined : undefined,
  }
  for (const name of LAUNCH_VARIABLES) delete env[name]
  return launch
}
