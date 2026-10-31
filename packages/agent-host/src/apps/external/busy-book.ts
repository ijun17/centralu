import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** One app that held busy when it was last heard from (#1236) */
export type BusyRecord = { projectId: string | null; appId: string; reason: string; at: number }

/**
 * The apps holding busy, kept in the data folder (`app-busy.json`) so a host that restarts or takes over in a swap
 * starts them again (`ExternalApps.resumeBusy`): the idle rule's exception is meant to outlive the host, or a merge
 * queue stands still from a restart until something calls its app. Written when an app takes or releases a hold, when
 * the person stops it, and when it crashes; not when the host stops its apps on the way out, which is the case it
 * exists for. A file, not the store: it is the runtime's own state, like the notice key, and needs no store step.
 */
export class BusyBook {
  constructor(private readonly file: string) {}

  list(): BusyRecord[] {
    return Object.values(this.read())
  }

  /** Records `key` as holding (`rec`), or no longer (`null`). A write that fails is said on the console, never thrown */
  set(key: string, rec: BusyRecord | null): void {
    const all = this.read()
    if (rec === null && !(key in all)) return
    if (rec === null) delete all[key]
    else all[key] = rec
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (e) {
      rmSync(tmp, { force: true })
      console.error(`[apps] could not record which apps are busy in ${this.file}: ${(e as Error).message}`)
    }
  }

  private read(): Record<string, BusyRecord> {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return {}
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, BusyRecord> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const r = v as Partial<BusyRecord> | null
      if (r && typeof r.appId === 'string' && (r.projectId === null || typeof r.projectId === 'string') && typeof r.reason === 'string') {
        out[k] = { projectId: r.projectId, appId: r.appId, reason: r.reason, at: typeof r.at === 'number' ? r.at : 0 }
      }
    }
    return out
  }
}
