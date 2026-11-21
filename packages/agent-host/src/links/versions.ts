import { isNewerVersion, isSupportedVersion, releaseOf, type MachineSide, type MachineVersions } from '@cc/protocol'

/**
 * The version check a link runs before it connects (docs/plans/remote-hub.md §4, relaxed by #689):
 * - A different protocol never connects (the host would refuse the hello, 4002), nor does a remote release older than
 *   `MIN_SUPPORTED_VERSION` (#1143: this build lacks what it needs) that this hub names as the side to update; where the hub names no update (a dev hub, two
 *   channels) it connects.
 * - One protocol connects whatever the app versions; the older side of one channel is named so the UI can offer to update it.
 * - A dev build (run from source) has no "newer". A local build (`<base>.local.N`) compares as its base release, so a remote at
 *   `<base>` is not "older" than the hub, and a dev build of the hub's release (`pnpm remote-dev`, #1036) does not make the hub "older".
 * - Releases of two channels (a beta and a stable) are not ranked against each other.
 */
export function compareVersions(hub: MachineSide, remote: MachineSide, accepted: boolean): MachineVersions {
  const hubRelease = releaseOf(hub.version)
  const remoteRelease = releaseOf(remote.version)
  const sameChannel = channel(hubRelease) === channel(remoteRelease)
  const dev = hub.dev || remote.dev
  let older: 'hub' | 'remote' | null = null
  if (!dev && sameChannel && hubRelease !== remoteRelease) {
    older = isNewerVersion(hubRelease, remoteRelease) ? 'remote' : isNewerVersion(remoteRelease, hubRelease) ? 'hub' : null
  }
  // The minimum holds a link only where this hub can name the update that lifts it; otherwise the link connects as before
  const compatible = hub.protocolVersion === remote.protocolVersion && !(older === 'remote' && !isSupportedVersion(remote.version))
  return { hub, remote, older, compatible, sameChannel, accepted: compatible && accepted }
}

/** Whether a link is held only on `MIN_SUPPORTED_VERSION` (#1143): one protocol, a remote below it, and the update named */
export function heldOnMinimum(v: MachineVersions): boolean {
  return !v.compatible && v.hub.protocolVersion === v.remote.protocolVersion
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
