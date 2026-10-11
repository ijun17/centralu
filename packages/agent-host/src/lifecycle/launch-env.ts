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
  /** The token handed over in the environment; under a keeper the keeper's, the same for every host it runs */
  token: string | undefined
}

/** The variables `takeLaunchEnv` reads and removes. Nothing the host spawns may see any of them */
export const LAUNCH_VARIABLES = ['CC_KEEPER', 'CC_HOST_SOURCE', 'CC_FRONT_DOOR', 'CC_SERVE', 'CC_HOST_TOKEN'] as const

export function takeLaunchEnv(env: Record<string, string | undefined> = process.env): LaunchEnv {
  const launch: LaunchEnv = {
    underKeeper: env.CC_KEEPER === '1',
    keeperSource: env.CC_HOST_SOURCE,
    frontDoor: env.CC_FRONT_DOOR,
    startedByServe: env.CC_SERVE === '1',
    token: env.CC_HOST_TOKEN,
  }
  for (const name of LAUNCH_VARIABLES) delete env[name]
  return launch
}
