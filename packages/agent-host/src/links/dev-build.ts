import { isLocalBuildVersion, type InstalledVersion } from '@cc/protocol'
import { hostname } from 'node:os'
import { installCommand, readStep, type InstallResult } from './install.js'
import { switchRemote, type HostControl } from './update.js'

/**
 * A dev build of the host on a linked machine, from a git commit (#1036, docs/plans/remote-hub.md §10.11): the way to
 * try an unreleased host change on a Windows or Linux machine in minutes instead of a whole beta.
 *
 *   build   `remote-install.mjs`'s `dev` action, on the Node `current` runs on there: the working copy there must be at
 *           exactly `commit`, clean unless `allowDirty`, on the hub's protocol and within its Node floor; its own
 *           `bundle.mjs` builds the host into `<data>/remote/versions/<base>.local.N/`, marked `source: { kind: 'dev' }`
 *           in its `install.json`. Nothing runs that is not already there: no file crosses the link but the installer,
 *           as for every update, and the build is the working copy's own
 *   swap    the update's own steps (update.ts `switchRemote`): stop, switch, start, a hello from `<base>.local.N`
 *           within 30 s, or the old version put back
 *
 * `previous` stays the release: a dev build over a dev build keeps the release before both, so `machines.rollback`
 * (or `machines.update`, which takes `<base>.local.N` to `<base>`) always leads back to something a release produced.
 *
 * Started from the hub by a maintainer's command (`pnpm remote-dev`, remote-dev.ts) over the link's own ssh, never by
 * an RPC: agents and linked machines gain nothing new.
 */

export type DevBuildOptions = {
  /** The working copy on the remote, as an absolute path there */
  repo: string
  /** The commit, all 40 hex digits: the working copy's HEAD must be exactly this */
  commit: string
  /** Build uncommitted changes too (marked `dirty`) instead of refusing them */
  allowDirty: boolean
  /** The protocol the hub links on: a build that speaks another is refused before it is built */
  protocol: number
  /** What is installed there now (the connection line's `install`) */
  there: { current: InstalledVersion; previous: InstalledVersion | null }
}

/** A version no release produced: a dev build (marked so), or any `<base>.local.N` */
export function isDevVersion(v: InstalledVersion | null | undefined): boolean {
  return !!v && (v.source?.kind === 'dev' || isLocalBuildVersion(v.version))
}

/** Builds the commit there and switches to it, or rejects with one sentence and the machine as it was */
export async function devUpdateRemote(c: HostControl, o: DevBuildOptions): Promise<InstallResult> {
  c.step('build')
  const out = readStep(
    await c.exec(
      installCommand(c.spec, c.script, {
        action: 'dev',
        version: o.there.current.version,
        node: o.there.current.node,
        repo: o.repo,
        commit: o.commit,
        allowDirty: o.allowDirty,
        protocol: o.protocol,
        hub: `${hostname()} (pnpm remote-dev)`,
      }),
    ),
    'done',
    c.target,
  )
  const placed = JSON.parse(out) as Partial<InstallResult>
  const next = placed.installed
  if (!next) throw new Error(`Building on ${c.target} answered without saying what it placed`)
  const was = { current: placed.current ?? o.there.current, previous: placed.previous ?? o.there.previous }
  // A dev build over a dev build keeps the release before both as the way back
  const keep = isDevVersion(was.current) ? was.previous : was.current
  return switchRemote(c, next, was, keep)
}
