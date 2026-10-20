/**
 * What the host's launcher hands it in the environment (lessons ST16), read once and taken out.
 *
 * The keeper, the window and `centralu serve` pass these as variables, never as arguments: `ps`
 * shows every argument to every user of the machine, and the token is the key to every RPC
 * (85c5b37b, #390). Everything this host spawns (agents, terminals, commands, app processes)
 * inherits `process.env`, and none of them has any use for these: a shell in a project should not
 * hold the token. So they are read here, before anything is spawned, and deleted.
 */

export type LaunchEnv = {
  /** Started by the keeper (#280): control lines on stdin, the child service, a swap's standby */
  underKeeper: boolean
  /** Where the keeper says this host's files came from, for `hello_ok` (keeper-link.ts) */
  keeperSource: string | undefined
  /**
   * The keeper's front door (#280 step 3): the stable address every client reaches this host
   * through, whichever host is current. The Codex bridge is given this rather than the host's own
   * port, because a running codex keeps the bridge it started and a swap must not cut it off.
   */
  frontDoor: string | undefined
  /**
   * Started by `centralu serve` (docs/agent-host.md §4.7), the one host `host.stop` may end: it has
   * no keeper or window to stop it, and on Windows a launcher can only be killed, which skips the
   * shutdown.
   */
  startedByServe: boolean
  /**
   * Who started this host, for `host.lock` and the conflict message a second host on the folder prints (#1223):
   * `CC_STARTED_BY=app` from the desktop window; the keeper and `centralu serve` are told apart by their own
   * variables. Null when nothing says (a host from source, a script)
   */
  startedBy: 'app' | 'keeper' | 'serve' | null
  /**
   * Where a `centralu serve` was asked for from (`CC_SERVE_FROM`, #1223): the hub's name when a hub's link passed it
   * (`serve --detach --from <hub>`), and the ssh client's address when it ran in an ssh session. Null when neither
   */
  serveFrom: ServeFrom | null
  /**
   * The token handed over in the environment, by a keeper or `centralu serve` older than #538 (and by scripts that
   * start a host themselves). Under a keeper the keeper's, the same for every host it runs
   */
  token: string | undefined
  /**
   * The launcher writes the token as the first line on stdin instead (#538, `readHandedToken`): never in the
   * environment, which every process of this user can read for as long as the host runs
   */
  tokenOnStdin: boolean
  /**
   * Where `centralu serve` keeps the full credentials' verifiers (#1405, `serve-credentials.ts`): set when the launcher
   * hands this host its key on stdin instead of a token. The host then takes as full only a hello whose credential's
   * verifier is in that file, read at each hello
   */
  serveState: string | undefined
}

/** Where a `centralu serve` was asked for from (`LaunchEnv.serveFrom`) */
export type ServeFrom = { hub?: string; ssh?: string }

/** The variables `takeLaunchEnv` reads and removes. Nothing the host spawns may see any of them */
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
] as const

/** A hub's name or an address as the launcher passed it: short, and only characters that cannot break a sentence */
const NAME_RE = /^[A-Za-z0-9._:-]{1,64}$/

/** `CC_SERVE_FROM`, field by field; a field of the wrong shape is left out, never trusted */
export function parseServeFrom(raw: string | undefined): ServeFrom | null {
  if (!raw) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
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
