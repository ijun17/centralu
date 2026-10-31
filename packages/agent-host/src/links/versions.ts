import { isNewerVersion, isSupportedVersion, releaseOf, type MachineSide, type MachineVersions } from '@cc/protocol'

/**
 * The version check a link runs before it connects (docs/plans/remote-hub.md §4, relaxed by #689):
 *
 *   - A different protocol never connects: the remote host would refuse the hello anyway (4002). Nor does a remote
 *     release older than `MIN_SUPPORTED_VERSION` (#1143): this build no longer keeps what such a remote needed.
 *   - One protocol connects, whatever the app versions. A different version of one channel still
 *     names the older side, so the UI can *offer* to bring it up (the hub through its own update,
 *     the remote over ssh); nothing waits for the person to answer.
 *   - A dev build (run from source, not from npm) has no "newer".
 *   - A local build (`<base>.local.N`) is compared as its base release: the remote at `<base>` is
 *     the version the hub installs there, so it is not "older" than the hub. On either side: a remote
 *     running a dev build of the hub's release (`pnpm remote-dev`, #1036) does not make the hub "older".
 *   - Releases of two channels (a beta and a stable) are not ranked against each other.
 */
export function compareVersions(hub: MachineSide, remote: MachineSide, accepted: boolean): MachineVersions {
  const compatible = hub.protocolVersion === remote.protocolVersion && (remote.dev || isSupportedVersion(remote.version))
  const hubRelease = releaseOf(hub.version)
  const remoteRelease = releaseOf(remote.version)
  const sameChannel = channel(hubRelease) === channel(remoteRelease)
  const dev = hub.dev || remote.dev
  let older: 'hub' | 'remote' | null = null
  if (!dev && sameChannel && hubRelease !== remoteRelease) {
    older = isNewerVersion(hubRelease, remoteRelease) ? 'remote' : isNewerVersion(remoteRelease, hubRelease) ? 'hub' : null
  }
  return { hub, remote, older, compatible, sameChannel, accepted: compatible && accepted }
}

/** Whether a link with these versions may connect now: one protocol is enough (#689) */
export function mayConnect(v: MachineVersions): boolean {
  return v.compatible
}

/** What the person accepted, kept per pair: when either side moves, the question comes again (§4) */
export function acceptanceKey(hub: MachineSide, remote: MachineSide): string {
  return `${hub.version}|${remote.version}`
}

function channel(version: string): string {
  const dash = version.indexOf('-')
  if (dash === -1) return 'stable'
  return version.slice(dash + 1).split('.')[0] ?? 'stable'
}
