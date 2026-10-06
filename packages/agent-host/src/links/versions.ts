import { isNewerVersion, type MachineSide, type MachineVersions } from '@cc/protocol'

/**
 * The version check a link runs before it connects (docs/plans/remote-hub.md §4, owner's decision
 * 5 of 2026-10-05): the two sides are aligned first, and the link does not connect until they match
 * or the person declines.
 *
 *   - A different protocol never connects: the remote host would refuse the hello anyway (4002).
 *   - A different version of one channel names the older side, so the prompt can offer to bring
 *     it up (the hub through its own update, the remote over ssh in phase 3).
 *   - A dev build (run from source, not from npm) has no "newer"; with one protocol it connects,
 *     and the UI warns.
 *   - Releases of two channels (a beta and a stable) are not ranked against each other.
 */
export function compareVersions(hub: MachineSide, remote: MachineSide, accepted: boolean): MachineVersions {
  const compatible = hub.protocolVersion === remote.protocolVersion
  const sameChannel = channel(hub.version) === channel(remote.version)
  const dev = hub.dev || remote.dev
  let older: 'hub' | 'remote' | null = null
  if (!dev && sameChannel && hub.version !== remote.version) {
    older = isNewerVersion(hub.version, remote.version) ? 'remote' : isNewerVersion(remote.version, hub.version) ? 'hub' : null
  }
  return { hub, remote, older, compatible, sameChannel, accepted: compatible && accepted }
}

/** Whether a link with these versions may connect now */
export function mayConnect(v: MachineVersions): boolean {
  if (!v.compatible) return false
  if (v.hub.dev || v.remote.dev) return true
  return v.hub.version === v.remote.version || v.accepted
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
