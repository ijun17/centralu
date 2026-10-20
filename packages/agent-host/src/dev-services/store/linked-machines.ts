import type Database from 'better-sqlite3'
import { isObj } from '../../json-value.js'
import { parseJson } from './json.js'
import { type SettingsRecords } from './settings.js'

/** One linked machine as stored (#82, v46): the registry's record (links/links.ts `MachineRecord`) */
export type LinkedMachineRow = {
  id: string
  name: string
  sshTarget: string
  remote: { shell: 'posix' | 'powershell' | 'wsl'; wslDistro?: string | null; command?: string | null }
  slot: number
  addedAt: number
  acceptedVersions: string | null
  /** Auto reconnect (#1341), on by default; kept in the `connect` column (v59), see `connectColumn` */
  autoReconnect?: boolean
  /** Whether this machine's sessions may ask this computer's projects (#550, v60); off by default */
  asks?: boolean
  /** When the link to it was last up (#1398), from `app_settings` (`SEEN_KEY`); absent when it never was */
  lastConnectedAt?: number
}

/** A pair the person approved for the reverse direction (#550, v60): a session of a linked machine, a project here */
export type MachineAskConsentRow = {
  machineId: string
  /** The session's own id on that machine (not qualified) */
  sessionId: string
  /** Its name when the pair was approved, for Settings */
  sessionName: string
  projectId: string
  decidedAt: number
}

/** The highest slot ever handed to a linked machine (#82) */
const LINK_SLOT_KEY = 'links.slotHighWater'

/**
 * When a machine's link was last up (#1398), in ms, kept per machine so a machine that is away reads "last connected" across
 * a restart of this host. A setting the previous build never reads, so it needs no migration step
 */
const SEEN_KEY = 'links.lastConnected.'

/** Marks that a machine's list was mirrored at least once, so an empty mirror reads as empty rather than unknown */
const MIRRORED_KEY = 'links.mirrored.'

/**
 * Auto reconnect as the `connect` column keeps it (#1341; v59 added the column for the connect mode, #1134): null for on,
 * the default, and `when_needed` for off. No new migration step: the column already holds exactly this, so a machine
 * that connected when needed reads back with the switch off, and an older build still serving during a host swap reads the
 * same value as it always did (a machine with the switch off is parked at its start there, and is connected by Connect).
 * A later release may add a column named for the switch and drop this one (add first, remove later, docs/agent-host.md)
 */
const connectColumn = (autoReconnect: boolean | undefined): string | null => (autoReconnect === false ? 'when_needed' : null)

/** Linked machines (#82, v46) and the session and project headers mirrored from them */
export class LinkedMachineRecords {
  constructor(private readonly db: Database.Database, private readonly settings: SettingsRecords) {}

  // ── Linked machines (#82, v46) ─────────────────────────────────────────────────────────────

  listLinkedMachines(): LinkedMachineRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, ssh_target, shell, wsl_distro, command, slot, added_at, accepted_versions, connect, asks
           FROM linked_machines ORDER BY added_at, id`,
      )
      .all() as {
      id: string
      name: string
      ssh_target: string
      shell: string
      wsl_distro: string | null
      command: string | null
      slot: number
      added_at: number
      accepted_versions: string | null
      connect: string | null
      asks: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      sshTarget: r.ssh_target,
      remote: { shell: r.shell === 'powershell' || r.shell === 'wsl' ? r.shell : 'posix', wslDistro: r.wsl_distro, command: r.command },
      slot: r.slot,
      addedAt: r.added_at,
      acceptedVersions: r.accepted_versions,
      // Anything but the one value for off is on, as a window reads an unknown one
      autoReconnect: r.connect !== 'when_needed',
      asks: r.asks === 1,
      ...this.lastSeen(r.id),
    }))
  }

  /** When the link to the machine was last up, as `{ lastConnectedAt }`, or nothing when it never was or the setting is not a time */
  private lastSeen(id: string): { lastConnectedAt?: number } {
    const at = Number(this.settings.appSetting(`${SEEN_KEY}${id}`))
    return Number.isSafeInteger(at) && at > 0 ? { lastConnectedAt: at } : {}
  }

  /** The link to the machine was up at `at` (#1398) */
  setLinkedMachineSeen(id: string, at: number): void {
    if (this.db.prepare(`SELECT 1 FROM linked_machines WHERE id = ?`).get(id)) this.settings.setAppSetting(`${SEEN_KEY}${id}`, String(Math.floor(at)))
  }

  /**
   * Adds a linked machine with the next slot. A slot is never handed out twice, even after its machine is removed:
   * an approval rule id folded with it may still be on a screen (links/machine-ids.ts), and must not come to name a
   * rule of the next machine. The high-water mark lives in app_settings.
   */
  addLinkedMachine(m: Omit<LinkedMachineRow, 'slot'>): LinkedMachineRow {
    return this.db.transaction(() => {
      const used = (this.db.prepare(`SELECT MAX(slot) AS s FROM linked_machines`).get() as { s: number | null }).s ?? 0
      const slot = Math.max(used, this.slotHighWater()) + 1
      this.db
        .prepare(
          `INSERT INTO linked_machines (id, name, ssh_target, shell, wsl_distro, command, slot, added_at, accepted_versions, connect)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(m.id, m.name, m.sshTarget, m.remote.shell, m.remote.wslDistro ?? null, m.remote.command ?? null, slot, m.addedAt, m.acceptedVersions, connectColumn(m.autoReconnect))
      this.settings.setAppSetting(LINK_SLOT_KEY, String(slot))
      return { ...m, autoReconnect: m.autoReconnect !== false, slot }
    })()
  }

  /**
   * The mark, or 0 for none. One that is not a whole number (#384) made the next slot NaN, and every add failed on the
   * table's NOT NULL with an error that named nothing. It reads as 0, so the highest slot in use decides, and is named
   * on stderr: a slot of a machine removed since may come back, which only an approval id still on a screen would see.
   */
  private slotHighWater(): number {
    const raw = this.settings.appSetting(LINK_SLOT_KEY)
    if (raw === null) return 0
    const n = Number(raw)
    if (raw.trim() !== '' && Number.isSafeInteger(n) && n >= 0) return n
    console.error(`[store] app_settings.${LINK_SLOT_KEY} holds ${JSON.stringify(raw.slice(0, 40))}, not a slot; the next linked machine takes the slot after the highest in use`)
    return 0
  }

  /** Removes a machine with its mirrored headers and its grid panels */
  removeLinkedMachine(id: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM machine_headers WHERE machine_id = ?`).run(id)
      this.db.prepare(`DELETE FROM machine_ask_consents WHERE machine_id = ?`).run(id)
      this.db.prepare(`DELETE FROM grid_layout WHERE remote_session_id IS NOT NULL AND substr(remote_session_id, 1, ?) = ?`).run(id.length + 1, `${id}.`)
      this.db.prepare(`DELETE FROM grid_layout WHERE remote_app_id IS NOT NULL AND app_machine = ?`).run(id)
      this.db.prepare(`DELETE FROM linked_machines WHERE id = ?`).run(id)
      this.settings.deleteAppSetting(`${SEEN_KEY}${id}`)
      this.settings.deleteAppSetting(`${MIRRORED_KEY}${id}.session`)
      this.settings.deleteAppSetting(`${MIRRORED_KEY}${id}.project`)
    })()
  }

  setLinkedMachineAcceptedVersions(id: string, key: string | null): void {
    this.db.prepare(`UPDATE linked_machines SET accepted_versions = ? WHERE id = ?`).run(key, id)
  }

  /** Auto reconnect for the machine's link (#1341) */
  setLinkedMachineAutoReconnect(id: string, autoReconnect: boolean): void {
    this.db.prepare(`UPDATE linked_machines SET connect = ? WHERE id = ?`).run(connectColumn(autoReconnect), id)
  }

  // ── The reverse direction (#550, v60) ───────────────────────────────────────────────────────

  /**
   * Turns a machine's switch on or off. Off also forgets every pair approved for it: turning the switch on again is a
   * new consent, and must not bring back pairs the person approved before they turned it off
   */
  setLinkedMachineAsks(id: string, on: boolean): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE linked_machines SET asks = ? WHERE id = ?`).run(on ? 1 : 0, id)
      if (!on) this.db.prepare(`DELETE FROM machine_ask_consents WHERE machine_id = ?`).run(id)
    })()
  }

  /** Whether a machine's switch is on, read from the row each time; false for a machine no longer linked */
  linkedMachineAsks(id: string): boolean {
    const row = this.db.prepare(`SELECT asks FROM linked_machines WHERE id = ?`).get(id) as { asks: number } | undefined
    return row?.asks === 1
  }

  machineAskConsent(machineId: string, sessionId: string, projectId: string): MachineAskConsentRow | null {
    const row = this.db
      .prepare(
        `SELECT machine_id as machineId, session_id as sessionId, session_name as sessionName, project_id as projectId, decided_at as decidedAt
           FROM machine_ask_consents WHERE machine_id = ? AND session_id = ? AND project_id = ?`,
      )
      .get(machineId, sessionId, projectId) as MachineAskConsentRow | undefined
    return row ?? null
  }

  /** Records an approved pair; false when the machine is no longer linked, its switch is off, or the project is gone */
  setMachineAskConsent(c: Omit<MachineAskConsentRow, 'decidedAt'>): boolean {
    return this.db.transaction(() => {
      if (!this.linkedMachineAsks(c.machineId)) return false
      if (!this.db.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(c.projectId)) return false
      this.db
        .prepare(
          `INSERT INTO machine_ask_consents (machine_id, session_id, session_name, project_id, decided_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (machine_id, session_id, project_id) DO UPDATE SET session_name = excluded.session_name, decided_at = excluded.decided_at`,
        )
        .run(c.machineId, c.sessionId, c.sessionName, c.projectId, Date.now())
      return true
    })()
  }

  /** The approved pairs, newest first; one machine's when `machineId` is given */
  listMachineAskConsents(machineId?: string): MachineAskConsentRow[] {
    const cols = `machine_id as machineId, session_id as sessionId, session_name as sessionName, project_id as projectId, decided_at as decidedAt`
    return (
      machineId === undefined
        ? this.db.prepare(`SELECT ${cols} FROM machine_ask_consents ORDER BY decided_at DESC`).all()
        : this.db.prepare(`SELECT ${cols} FROM machine_ask_consents WHERE machine_id = ? ORDER BY decided_at DESC`).all(machineId)
    ) as MachineAskConsentRow[]
  }

  /** Withdraws one pair; true when there was one */
  forgetMachineAskConsent(machineId: string, sessionId: string, projectId: string): boolean {
    return (
      this.db.prepare(`DELETE FROM machine_ask_consents WHERE machine_id = ? AND session_id = ? AND project_id = ?`).run(machineId, sessionId, projectId)
        .changes > 0
    )
  }

  /**
   * One machine's mirrored sessions or projects, in the order it last listed them; null when never mirrored. A header
   * that is not JSON is skipped rather than failing the list (#850); the next full mirror writes it again.
   */
  machineHeaders(machineId: string, kind: 'session' | 'project'): unknown[] | null {
    if (this.settings.appSetting(`${MIRRORED_KEY}${machineId}.${kind}`) === null) return null
    const rows = this.db
      .prepare(`SELECT info FROM machine_headers WHERE machine_id = ? AND kind = ? ORDER BY position, item_id`)
      .all(machineId, kind) as { info: string }[]
    return rows.flatMap((r) => {
      const info = parseJson(r.info)
      return info === undefined ? [] : [info]
    })
  }

  /** Replaces one machine's mirrored list whole, as it was just read */
  replaceMachineHeaders(machineId: string, kind: 'session' | 'project', items: readonly { id: string }[]): void {
    const del = this.db.prepare(`DELETE FROM machine_headers WHERE machine_id = ? AND kind = ?`)
    const ins = this.db.prepare(`INSERT OR REPLACE INTO machine_headers (machine_id, kind, item_id, info, position) VALUES (?, ?, ?, ?, ?)`)
    this.db.transaction(() => {
      // A machine removed meanwhile has no row to hang headers on
      if (!this.db.prepare(`SELECT 1 FROM linked_machines WHERE id = ?`).get(machineId)) return
      del.run(machineId, kind)
      items.forEach((item, i) => ins.run(machineId, kind, item.id, JSON.stringify(item), i))
      this.settings.setAppSetting(`${MIRRORED_KEY}${machineId}.${kind}`, '1')
    })()
  }

  /** One session header, added or replaced; a new one goes last */
  upsertMachineSession(machineId: string, item: { id: string }): void {
    if (!this.db.prepare(`SELECT 1 FROM linked_machines WHERE id = ?`).get(machineId)) return
    const pos = (
      this.db
        .prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM machine_headers WHERE machine_id = ? AND kind = 'session'`)
        .get(machineId) as { p: number }
    ).p
    this.db
      .prepare(
        `INSERT INTO machine_headers (machine_id, kind, item_id, info, position) VALUES (?, 'session', ?, ?, ?)
         ON CONFLICT (machine_id, kind, item_id) DO UPDATE SET info = excluded.info`,
      )
      .run(machineId, item.id, JSON.stringify(item), pos)
  }

  /** Changes a few fields of one mirrored session (its name, its state); one that cannot be read is left for the next full mirror */
  patchMachineSession(machineId: string, sessionId: string, patch: Record<string, unknown>): void {
    const row = this.db
      .prepare(`SELECT info FROM machine_headers WHERE machine_id = ? AND kind = 'session' AND item_id = ?`)
      .get(machineId, sessionId) as { info: string } | undefined
    const info = parseJson(row?.info)
    if (!isObj(info)) return
    const next = { ...info, ...patch }
    this.db
      .prepare(`UPDATE machine_headers SET info = ? WHERE machine_id = ? AND kind = 'session' AND item_id = ?`)
      .run(JSON.stringify(next), machineId, sessionId)
  }

  removeMachineSession(machineId: string, sessionId: string): void {
    this.db.prepare(`DELETE FROM machine_headers WHERE machine_id = ? AND kind = 'session' AND item_id = ?`).run(machineId, sessionId)
  }
}
