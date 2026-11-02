import { parseUpdateResume, type CutTurn, type UpdateResumeFolder } from './update-resume.js'

/** A data folder's lists of the turns an update cut (#1618), played by a map; lifecycle/stopped-mark.ts reaches the real one */
export function memoryUpdateFolder(): UpdateResumeFolder & {
  /** The lists' text by name */
  readonly files: Map<string, string>
  /** The turns all the lists name, in the order written; null when there is no list */
  turns(): CutTurn[] | null
  /** The sessions they name (turns and what else the stop ended), once each */
  ids(): string[] | null
} {
  const files = new Map<string, string>()
  let made = 0
  const parsed = () => [...files.values()].flatMap((t) => { const p = parseUpdateResume(t); return typeof p === 'object' ? [p] : [] })
  const turns = () => (files.size ? parsed().flatMap((p) => p.turns) : null)
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
      return files.size ? [...new Set(parsed().flatMap((p) => [...p.turns, ...p.stopped]).map((x) => x.id))] : null
    },
  }
}
