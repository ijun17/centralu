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
}

/** The highest slot ever handed to a linked machine (#82) */
const LINK_SLOT_KEY = 'links.slotHighWater'

/** Marks that a machine's list was mirrored at least once, so an empty mirror reads as empty rather than unknown */
const MIRRORED_KEY = 'links.mirrored.'

/** Linked machines (#82, v46) and the session and project headers mirrored from them */
export class LinkedMachineRecords {
  constructor(private readonly db: Database.Database, private readonly settings: SettingsRecords) {}

  // ── Linked machines (#82, v46) ─────────────────────────────────────────────────────────────

  listLinkedMachines(): LinkedMachineRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, ssh_target, shell, wsl_distro, command, slot, added_at, accepted_versions
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
    }[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      sshTarget: r.ssh_target,
      remote: { shell: r.shell === 'powershell' || r.shell === 'wsl' ? r.shell : 'posix', wslDistro: r.wsl_distro, command: r.command },
      slot: r.slot,
      addedAt: r.added_at,
      acceptedVersions: r.accepted_versions,
    }))
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
          `INSERT INTO linked_machines (id, name, ssh_target, shell, wsl_distro, command, slot, added_at, accepted_versions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(m.id, m.name, m.sshTarget, m.remote.shell, m.remote.wslDistro ?? null, m.remote.command ?? null, slot, m.addedAt, m.acceptedVersions)
      this.settings.setAppSetting(LINK_SLOT_KEY, String(slot))
      return { ...m, slot }
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
      this.db.prepare(`DELETE FROM grid_layout WHERE remote_session_id IS NOT NULL AND substr(remote_session_id, 1, ?) = ?`).run(id.length + 1, `${id}.`)
      this.db.prepare(`DELETE FROM grid_layout WHERE remote_app_id IS NOT NULL AND app_machine = ?`).run(id)
      this.db.prepare(`DELETE FROM linked_machines WHERE id = ?`).run(id)
      this.settings.deleteAppSetting(`${MIRRORED_KEY}${id}.session`)
      this.settings.deleteAppSetting(`${MIRRORED_KEY}${id}.project`)
    })()
  }

  setLinkedMachineAcceptedVersions(id: string, key: string | null): void {
    this.db.prepare(`UPDATE linked_machines SET accepted_versions = ? WHERE id = ?`).run(key, id)
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
