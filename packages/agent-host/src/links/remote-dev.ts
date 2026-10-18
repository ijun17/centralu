import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { DATA_DIR, PROTOCOL_VERSION } from '@cc/protocol'
import { runGit } from '../dev-services/git-exec.js'
import { LinkedMachineRecords } from '../dev-services/store/linked-machines.js'
import { SettingsRecords } from '../dev-services/store/settings.js'
import { devUpdateRemote } from './dev-build.js'
import { installScript, type InstallResult } from './install.js'
import type { MachineRecord } from './link-deps.js'
import { connectionCommand, NOT_FOUND, parseConnectionLine, SshTunnel, type ConnectionLine, type RemoteSpec, type SshTunnelOptions } from './tunnel.js'
import type { HostControl, UpdateStep } from './update.js'
import { HOLD, HOLD_MS, holdCommand } from './swap-hold.js'

/**
 * `pnpm remote-dev <machine> --ref <commit> --repo <path there>` (#1036, docs/plans/remote-hub.md §10.11): a
 * maintainer's command on the hub that puts a dev build of the host, made there from one commit of a working copy
 * there, on a linked machine (dev-build.ts). It runs over the link's own ssh, the way the hub reaches that machine,
 * and is no RPC: nothing an agent or a linked machine can call gains anything.
 *
 * The machine is found in the hub's store, read only (`linked_machines`), by id, name or ssh target. The commit is
 * resolved here, in the hub's working copy, to all 40 digits; the remote's checkout must be exactly that commit. The
 * protocol it must speak is this working copy's own `PROTOCOL_VERSION`, the one the hub this command belongs to speaks.
 *
 * Before the running host is stopped, a hold is written there (swap-hold.ts): a hub's link that finds no host running
 * waits on it instead of starting the old version mid-swap. It is lifted when the command is done, whatever happened,
 * and lapses by itself if the command dies. The link reconnects to the new host by itself.
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
    // The store's own reading of the table; it only reads, so the read-only handle is enough
    const rows = new LinkedMachineRecords(db, new SettingsRecords(db)).listLinkedMachines()
    const hit = rows.find((r) => r.id === name) ?? rows.find((r) => r.name === name) ?? rows.find((r) => r.sshTarget === name)
    if (!hit) {
      const known = rows.map((r) => `${r.id} (${r.name}, ${r.sshTarget})`).join(', ')
      throw new Error(`No linked machine is called ${name}${known ? `; linked: ${known}` : '; this computer links none'}`)
    }
    return hit
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
  let held = false
  try {
    const line = await lineThere(tunnel, spec, target)
    const there = line.install
    if (!there?.current) throw new Error(`${record.name} runs no Centralu this computer installed; install the release there from the app first, so a dev build has a release to go back to`)
    log(`${record.name}: building ${commit.slice(0, 12)} from ${o.repo} there (protocol ${PROTOCOL_VERSION}), then swapping ${there.current.version} for it`)
    const c: HostControl = {
      exec: (cmd) => tunnel.exec(cmd),
      spec,
      target,
      script: installScript(),
      hold: async () => {
        const r = await tunnel.exec(holdCommand(spec, { until: Date.now() + HOLD_MS, by: 'pnpm remote-dev' }))
        if (!r.stdout.includes(`${HOLD} done`)) throw new Error(`The hold for the swap could not be written on ${target}, so nothing was stopped`)
        held = true
      },
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
      protocol: PROTOCOL_VERSION,
      there: { current: there.current, previous: there.previous },
    })
    return { ...r, machine: record.name }
  } finally {
    // The links wait no longer, whatever happened; a hold that cannot be lifted lapses by itself
    if (held) await tunnel.exec(holdCommand(spec, null)).catch(() => log(`${record.name}: the swap's hold could not be lifted; it lapses within ${HOLD_MS / 60_000} minutes`))
    await tunnel.close()
  }
}
