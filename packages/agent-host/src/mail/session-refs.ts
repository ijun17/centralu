import { MACHINE_ID_RE, errorMessage, oneLineText } from '@cc/protocol'
import { PERSON, ROLE_WORDS, isPerson, isSessionId, parseAddress, sessionAddress, type RoleWord } from './address.js'
import type { FoundEntry } from './find.js'
import { refuse } from './rules.js'

/** A session of this host, as a name or id finds it */
export type HereSession = { id: string; name: string; project: string | null; state: string }

/**
 * What a tool's session argument names: a role, an address (an app's or Centralu's as given, a session's as `<computer>.<id>` names it), or a word with
 * the sessions here it names (none, one, or several of one name)
 */
export type SessionRef = { role: RoleWord } | { address: string } | { word: string; here: HereSession[] }

/** The computers a `<computer>.<id>` can name, read at each call: a hub's machines, or the hubs that link a machine */
export type RefComputers = {
  machine(id: string): boolean
  /** `you`: this machine's id there, under which that hub names this machine's sessions */
  hubs(): readonly { id: string; label: string; name: string; you: string | null }[]
  /** The sessions of this hub's machines named `name` exactly, from its mirror: no computer is asked */
  mirrored(name: string): FoundEntry[]
}

export type SessionRefsDeps = {
  hostId: string
  sessions(): HereSession[]
  assistantId(): string | null
  computers(): RefComputers
}

const FORMS = 'Name a session by its id (<id> here, <computer>.<id> on another computer), its name, or "assistant", "parent" or "person".'

const NO_ROLE: Record<RoleWord, string> = {
  assistant: 'There is no Assistant yet.',
  parent: 'No session on this computer started this one.',
  person: 'The person is not a session.',
}

/** Whether `v` has a shape `SessionRefs.shown` prints for a session: its id, behind at most two computers (`<label>.<machine>.<id>`) */
export function isShownId(v: string, computers = 2): boolean {
  const dot = v.indexOf('.')
  const [computer, rest] = [v.slice(0, dot), v.slice(dot + 1)]
  return isSessionId(v) || (computers > 0 && dot > 0 && MACHINE_ID_RE.test(computer) && isShownId(rest, computers - 1))
}

/**
 * How every tool that takes a session reads it (mail's `to`, read_session, agent_session): one set of forms, so what one tool
 * prints another takes (remote-hub.md §3.3). A session's address, whole or cut short, is refused with the id to write, never looked up as a name
 */
export class SessionRefs {
  constructor(private readonly d: SessionRefsDeps) {}

  /**
   * What `text` names for `callerId`. A session here by its id or name comes before any other reading, so a name with a dot
   * or a colon still finds its session. A word that names nothing here is left for mail to look up by name on other computers
   */
  ref(callerId: string, text: string): SessionRef {
    const t = text.trim()
    const role = ROLE_WORDS.find((r) => r === t.toLowerCase())
    if (role) return { role }
    const word = this.word(callerId, t)
    if (word.here.length > 0) return word
    const p = parseAddress(t)
    if (p?.kind === 'session') throw refuse('bad_address', `${JSON.stringify(oneLineText(t, 80))} is a mail address, which tools do not take. For that session, write ${JSON.stringify(this.shown(t))}. ${FORMS}`)
    if (p) return { address: t }
    if (/^(session|app):/i.test(t)) {
      const rest = t.slice(Math.max(t.indexOf(':'), t.lastIndexOf('/')) + 1).trim()
      const meant = this.word(callerId, rest).here.length === 1 ? ` For that session, write ${JSON.stringify(rest)}.` : ''
      throw refuse('bad_address', `${JSON.stringify(oneLineText(t, 80))} is not a session's address.${meant} ${FORMS}`)
    }
    return this.qualified(callerId, t) ?? word
  }

  /**
   * The id read_session and agent_session take for `text`: a role's session, a session here, or one of a machine this hub links
   * (`<machine>.<id>`). A word that names no session goes on as it is (an archived session's id, a start request's handle), for
   * the tool to judge
   */
  sessionId(caller: { id: string; askedBy: string | null }, text: string): { ok: true; id: string } | { ok: false; error: string } {
    try {
      const ref = this.ref(caller.id, text)
      if ('role' in ref) {
        const id = ref.role === 'assistant' ? this.d.assistantId() : ref.role === 'parent' ? caller.askedBy : null
        return id ? { ok: true, id } : { ok: false, error: NO_ROLE[ref.role] }
      }
      if ('address' in ref) return this.idOf(ref.address)
      // An id here is the one session; a name is looked for on this hub's machines too, as mail looks for it on every computer
      const exact = ref.here.length === 1 && ref.here[0]?.id === ref.word
      const found: { id?: string; address?: string; line: string }[] = [
        ...ref.here.map((s) => ({ id: s.id, line: `${s.id} (${s.state})` })),
        ...(exact ? [] : this.d.computers().mirrored(ref.word)).map((e) => ({ address: e.address, line: `${this.shown(e.address)} (${e.machine ?? 'another computer'}, ${e.state})` })),
      ]
      const [only] = found
      if (!only) return { ok: true, id: ref.word }
      if (found.length > 1) return { ok: false, error: `${found.length} sessions are named ${JSON.stringify(ref.word)}: ${found.slice(0, 8).map((f) => f.line).join(', ')}. Give the id of one.` }
      return only.id !== undefined ? { ok: true, id: only.id } : this.idOf(only.address ?? '')
    } catch (e) {
      return { ok: false, error: errorMessage(e) }
    }
  }

  /** An address as these tools' id: this host's session, or a machine's as this hub names it; a hub's session is out of their reach */
  private idOf(address: string): { ok: true; id: string } | { ok: false; error: string } {
    const p = parseAddress(address)
    if (p?.kind === 'session' && p.host === this.d.hostId) return { ok: true, id: p.sessionId }
    const hub = p?.kind === 'session' ? this.d.computers().hubs().find((h) => h.id === p.host) : undefined
    const where = !hub ? 'not a session' : p?.kind === 'session' && p.sessionId.includes('.') ? `a session on a machine ${hub.name} links` : `a session on ${hub.name}`
    return { ok: false, error: `${JSON.stringify(oneLineText(this.shown(address), 120))} is ${where}, which this tool does not reach from this computer. Mail reaches a session on another computer.` }
  }

  /**
   * How a tool prints `address`, in the form `ref` reads back: a session here by its id, one on another computer as `<computer>.<id>`
   * (a hub by its label; another machine of a hub under that hub's label too while several hubs link this one), the person as
   * `person`. An app's address stays as it is. A hub this computer no longer links has no label left: its id stands in, and reads
   * back as no session
   */
  shown(address: string): string {
    if (isPerson(address)) return PERSON
    const p = parseAddress(address)
    if (p?.kind !== 'session') return address
    if (p.host === this.d.hostId) return p.sessionId
    const hubs = this.d.computers().hubs()
    const hub = hubs.find((h) => h.id === p.host)
    const dot = p.sessionId.indexOf('.')
    if (dot > 0 && hub?.you === p.sessionId.slice(0, dot)) return p.sessionId.slice(dot + 1)
    if (dot > 0 && hub && hubs.length === 1) return p.sessionId
    return `${hub?.label ?? p.host}.${p.sessionId}`
  }

  /** The sessions here a word names: the one with that id, else those of that name but the caller (an heir has the name of the session it replaced) */
  private word(callerId: string, w: string): { word: string; here: HereSession[] } {
    const here = this.d.sessions()
    const exact = here.find((s) => s.id === w)
    return { word: w, here: exact ? [exact] : here.filter((s) => s.id !== callerId && s.name.trim().toLowerCase() === w.toLowerCase()) }
  }

  /**
   * `<computer>.<id>` as what it names: a machine this hub links, this machine's own session as a hub names it, a hub that links
   * this machine by its label (or its id, which older builds printed), another machine of the one hub there is, as that hub names
   * it, or else a machine of this host's, linked or not: mail across says which. null for a text of another shape
   */
  private qualified(callerId: string, t: string): SessionRef | null {
    const dot = t.indexOf('.')
    const computer = t.slice(0, dot)
    const id = t.slice(dot + 1)
    const c = this.d.computers()
    if (dot <= 0 || !MACHINE_ID_RE.test(computer) || !isSessionId(id)) return null
    if (c.machine(computer)) return { address: sessionAddress(this.d.hostId, t) }
    const hubs = c.hubs()
    if (hubs.some((h) => h.you === computer)) return this.word(callerId, id)
    const named = hubs.filter((h) => h.label === computer || h.id === computer)
    if (named.length > 1) throw refuse('ambiguous', `${named.length} computers that link this one go by ${computer}: ${named.map((h) => JSON.stringify(h.name)).join(' and ')}. Write to the session by its name.`)
    const [hub] = named
    if (hub) return { address: sessionAddress(hub.id, id) }
    const [only] = hubs
    return { address: sessionAddress(only && hubs.length === 1 ? only.id : this.d.hostId, t) }
  }
}
