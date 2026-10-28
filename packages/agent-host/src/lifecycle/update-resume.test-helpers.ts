import { parseUpdateResume, type CutTurn, type UpdateResumeFolder } from './update-resume.js'

/** A data folder's lists of the turns an update cut (#1618), played by a map; lifecycle/stopped-mark.ts reaches the real one */
export function memoryUpdateFolder(): UpdateResumeFolder & {
  /** The lists' text by name */
  readonly files: Map<string, string>
  /** The turns all the lists name, in the order written; null when there is no list */
  turns(): CutTurn[] | null
  /** The sessions they name, once each */
  ids(): string[] | null
} {
  const files = new Map<string, string>()
  let made = 0
  const turns = () => (files.size ? [...files.values()].flatMap((t) => { const p = parseUpdateResume(t); return Array.isArray(p) ? p : [] }) : null)
  return {
    files,
    names: () => [...files.keys()],
    read: (name) => files.get(name) ?? null,
    add: (text) => {
      files.set(`update-resume.${String(++made).padStart(8, '0')}.json`, text)
    },
    remove: (name) => {
      files.delete(name)
    },
    turns,
    ids: () => {
      const t = turns()
      return t === null ? null : [...new Set(t.map((x) => x.id))]
    },
  }
}
