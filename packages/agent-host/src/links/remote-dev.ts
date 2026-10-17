import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { DATA_DIR } from '@cc/protocol'
import { runGit } from '../dev-services/git-exec.js'
import { devUpdateRemote } from './dev-build.js'
import { installScript, type InstallResult } from './install.js'
import type { MachineRecord } from './link-deps.js'
import { connectionCommand, NOT_FOUND, parseConnectionLine, SshTunnel, type ConnectionLine, type RemoteSpec, type SshTunnelOptions } from './tunnel.js'
import type { HostControl, UpdateStep } from './update.js'

/**
 * `pnpm remote-dev <machine> --ref <commit> --repo <path there>` (#1036, docs/plans/remote-hub.md §10.11): a
 * maintainer's command on the hub that puts a dev build of the host, made there from one commit of a working copy
 * there, on a linked machine (dev-build.ts). It runs over the link's own ssh, the way the hub reaches that machine,
 * and is no RPC: nothing an agent or a linked machine can call gains anything.
 *
 * The machine is found in the hub's store, read only (`linked_machines`), by id, name or ssh target. The commit is
 * resolved here, in the hub's working copy, to all 40 digits; the remote's checkout must be exactly that commit. The
 * protocol it must speak is the one the running remote host speaks now, which is the hub's while the link is connected.
 *
 * The hub's own link to that machine is not held meanwhile (only an RPC could hold it): while the host is down it may
 * start one itself. Started after the switch, that is the new version and the check passes; started before it, the old
 * one answers and the old version is put back, with a sentence. The link reconnects by itself once the swap is done.
 */

export type RemoteDevOptions = {
  machine: string
  /** A commit, branch or tag of the hub's working copy (`cwd`) */
  ref: string
  /** The working copy on the remote, as an absolute path there */
  repo: string
  allowDirty?: boolean
  /** The hub's data folder, whose store lists the linked machines */
  dataDir?: string
  /** The hub's working copy, where `ref` is resolved */
  cwd?: string
  log?: (line: string) => void
  /** For tests: the ssh binary, config and environment, and a shorter check */
  ssh?: Pick<SshTunnelOptions, 'ssh' | 'configFile' | 'env'>
  checkMs?: number
}

/** The hub's data folder: `CC_DATA_DIR`, else `~/.centralu`, as the host's */
export function hubDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CC_DATA_DIR || join(homedir(), DATA_DIR)
}

/** The linked machine named `name` (its id, its name or its ssh target) in the hub's store, opened read only */
export function findMachine(dataDir: string, name: string): MachineRecord {
  const file = join(dataDir, 'store.db')
  if (!existsSync(file)) throw new Error(`No Centralu store at ${file}; set CC_DATA_DIR to the hub's data folder`)
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const rows = db
      .prepare(`SELECT id, name, ssh_target, shell, wsl_distro, command, slot, added_at, accepted_versions FROM linked_machines ORDER BY added_at, id`)
      .all() as { id: string; name: string; ssh_target: string; shell: string; wsl_distro: string | null; command: string | null; slot: number; added_at: number; accepted_versions: string | null }[]
    const hit = rows.find((r) => r.id === name) ?? rows.find((r) => r.name === name) ?? rows.find((r) => r.ssh_target === name)
    if (!hit) {
      const known = rows.map((r) => `${r.id} (${r.name}, ${r.ssh_target})`).join(', ')
      throw new Error(`No linked machine is called ${name}${known ? `; linked: ${known}` : '; this computer links none'}`)
    }
    const shell = hit.shell === 'powershell' || hit.shell === 'wsl' ? hit.shell : 'posix'
    return {
      id: hit.id,
      name: hit.name,
      sshTarget: hit.ssh_target,
      remote: { shell, wslDistro: hit.wsl_distro, command: hit.command },
      slot: hit.slot,
      addedAt: hit.added_at,
      acceptedVersions: hit.accepted_versions,
    }
  } finally {
    db.close()
  }
}

/** `ref` as the commit it names in the hub's working copy, all 40 digits */
export async function resolveCommit(ref: string, cwd: string): Promise<string> {
  if (!ref || ref.startsWith('-')) throw new Error(`Not a commit: ${ref || '(none)'}`)
  try {
    return (await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim()
  } catch {
    throw new Error(`${ref} is no commit this working copy knows; fetch it first`)
  }
}

/** The remote's connection line, asked over ssh as the link asks it */
async function lineThere(tunnel: SshTunnel, spec: RemoteSpec, target: string): Promise<ConnectionLine> {
  const r = await tunnel.exec(connectionCommand(spec))
  if (r.stdout.includes(NOT_FOUND)) throw new Error(`Centralu is not installed on ${target}`)
  return parseConnectionLine(r.stdout)
}

/** Builds `ref` there and swaps to it (dev-build.ts); rejects with one sentence, the machine as it was */
export async function remoteDev(o: RemoteDevOptions): Promise<InstallResult & { machine: string }> {
  const log = o.log ?? (() => {})
  const record = findMachine(o.dataDir ?? hubDataDir(), o.machine)
  if (record.remote.command) throw new Error(`${record.name} runs a command of its own in place of centralu; a dev build goes through the installed one`)
  const commit = await resolveCommit(o.ref, o.cwd ?? process.cwd())
  const target = record.sshTarget
  const spec = record.remote
  const tunnel = new SshTunnel({ target, remote: spec, ...o.ssh, log })
  try {
    const line = await lineThere(tunnel, spec, target)
    const there = line.install
    if (!there?.current) throw new Error(`${record.name} runs no Centralu this computer installed; install the release there from the app first, so a dev build has a release to go back to`)
    log(`${record.name}: building ${commit.slice(0, 12)} from ${o.repo} there (protocol ${line.protocolVersion}), then swapping ${there.current.version} for it`)
    const c: HostControl = {
      exec: (cmd) => tunnel.exec(cmd),
      spec,
      target,
      script: installScript(),
      hold: () => log(`${record.name}: this computer's link is not held; it reconnects by itself once the new host answers`),
      start: async () => {
        const how = await tunnel.startHost()
        if (how.how !== 'detached') throw new Error(`Centralu on ${target} can only run inside an ssh session there (${how.note ?? 'WMI is blocked'}); a dev build cannot be checked from here`)
      },
      answers: async (version, ms) => {
        const deadline = Date.now() + (o.checkMs ?? ms)
        for (;;) {
          const now = await lineThere(tunnel, spec, target).catch(() => null)
          if (now?.hostRunning && now.version === version) return true
          if (Date.now() > deadline) return false
          await new Promise((r) => setTimeout(r, 1_000))
        }
      },
      step: (s: UpdateStep) => log(`${record.name}: ${s}`),
    }
    const r = await devUpdateRemote(c, {
      repo: o.repo,
      commit,
      allowDirty: o.allowDirty === true,
      protocol: line.protocolVersion,
      there: { current: there.current, previous: there.previous },
    })
    return { ...r, machine: record.name }
  } finally {
    await tunnel.close()
  }
}
