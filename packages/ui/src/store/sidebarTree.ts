import type { SessionSummary } from '@cc/core'

/**
 * What a session handed to other machines: the sessions it started (`askedBy`) on a machine other than its own, by
 * machine (#1416). Such a child is drawn in the project that holds it, on the machine that holds it, so the parent's
 * row cannot hold it; this is what the parent's pointer ("2 on win-pc") counts and reveals. A child on the parent's own
 * machine, in its project or another, is not here: it hangs under the parent, or stands as an ask_project session does.
 */
export type HandedOff = { machine: string; sessions: SessionSummary[] }

/** `handedOffBy` for every session at once, built once per `sessions` object, which the rows of one render share */
const handedOffIndex = new WeakMap<object, Map<string, HandedOff[]>>()

export function handedOffBy(parentId: string, sessions: Readonly<Record<string, SessionSummary>>): readonly HandedOff[] {
  let index = handedOffIndex.get(sessions)
  if (!index) {
    index = new Map()
    for (const s of Object.values(sessions)) {
      const parent = s.askedBy ? sessions[s.askedBy] : undefined
      // A child with no machine runs here, and so does a parent with none: only a difference is "on another machine"
      if (!parent || !s.machine || s.machine === (parent.machine ?? null)) continue
      const groups = index.get(parent.id) ?? []
      const group = groups.find((g) => g.machine === s.machine)
      if (group) group.sessions.push(s)
      else groups.push({ machine: s.machine, sessions: [s] })
      index.set(parent.id, groups)
    }
    handedOffIndex.set(sessions, index)
  }
  return index.get(parentId) ?? NONE
}

const NONE: readonly HandedOff[] = []

/**
 * The session a row hangs under, among the rows the list has (`inList`): the session it was forked from, else the one
 * that held its worktree, else the one that asked for it, each only if the list has it. The tree draws a row under this
 * one (`orderAsTree`) and the fold reveal opens its group (`foldGroupsHiding`), so both ask here: a fork whose source
 * is gone hangs under its asker, and revealing it has to open the asker's children, not the missing source's.
 */
export function treeParentOf(s: SessionSummary, inList: (id: string) => boolean): string | null {
  const candidates = [s.forkedFrom, s.parentSessionId, s.askedBy]
  return candidates.find((id): id is string => !!id && id !== s.id && inList(id)) ?? null
}
