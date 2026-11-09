import { errorMessage, type SessionInfo, isAssistantKind } from '@cc/protocol'
import { inTurn } from '../idle.js'
import { wentWithItsProcess } from '../sessions/interruptions.js'
import type { Store } from '../dev-services/store.js'
import type { SessionManager } from '../sessions/manager.js'
import type { MailHooks } from '../sessions/mail-sessions.js'
import { PERSON, parseAddress, sessionAddress } from './address.js'
import { takeOverFromEarlierBuild } from './adoption.js'
import { askedBy, askerFacts, type AskedByHost } from './asked-by.js'
import { answerRecorder, delegationRecorder, personOwes, personReportRecorder, personWorkRecorder, reportRecorder, turnRecorder } from './delegation.js'
import { MailDelivery, type MailDeliveryOptions, type MailSessions } from './delivery.js'
import { mailCalls } from './frame.js'
import { MessageService, type HandedOverMessage } from './messages.js'
import { mailReach, type DelegationTarget, type MailReach } from './reach.js'
import { HOUR_MS, REFUSAL_TEXT, WARNING_TEXT, firstLineOf } from './rules.js'
import { MailTool } from './tool.js'
import { MailAcross } from './across.js'
import { entryOf } from './find.js'
import type { MailboxRecords } from '../dev-services/store/mailbox.js'
import { MailTurns } from './turns.js'

/**
 * What the mail of this host reads of its sessions (docs/plans/mailbox.md §16 M3a): the manager answers it in `main.ts`, and tests answer it from
 * a real manager too, so the host and its tests wire mail one way
 */
export type HostMailSessions = {
  sessionInfo(id: string): SessionInfo | undefined
  listSessions(): SessionInfo[]
  /** Whether the session's seat has the `mail` tool (`reader` or `assistant`) */
  canReadMail(id: string): boolean
  assistantId(): string | null
  /** Why sessions may not ask the Assistant now, or null when they may (§7.6) */
  assistantAsks(): string | null
  /** Whether the session reaches `mail` as a command behind `centralu_run` (the Assistant) */
  mailCommand(id: string): boolean
  /** Whether the session's turn goes on from the host before (kept, or continued after an update): its mail turn row is read back */
  keptInTurn(id: string): boolean
  /** §9.5: the old report paths still owe the owner a report of the child */
  oldOwes(ownerId: string, childId: string): boolean
  mailSessions(): MailSessions
  /** The sessions whose running work `id` waits on (`SessionProcesses.waitsOn`): a stop notice wakes a sender that waits on the stopped session (docs/plans/turn-owned-by-no-one.md Q1) */
  waitsOn?(id: string): string[]
  /** The sessions the older report path told of the quit that cut `id`'s turn, which the start found, and those it may still tell (`HostTenure.quitTold`) */
  quitTold?(id: string): { told: string[]; held: string[] }
  /** The words of the turn a stop cut, which the stop notice quotes as that session's own (`MailSessionsView.stoppedWords`) */
  stoppedWords?(id: string): string | null
  /** Whether `readerId` can read `targetId` with read_session (`MailSessionsView.readsSession`): only then is a stopped session's text quoted to it */
  readsSession?(readerId: string, targetId: string): boolean
  /** Who gave what may have entered the session's latest turn (`MailSessionsView.turnInputs`): only a turn its asker alone gave anything is quoted to it */
  turnInputs?(id: string): readonly (string | null)[]
  /** A child this host started on a linked machine, with the name its mail shows (`MailSessionsView.onLinkedMachine`, #2067); none for any other id */
  onLinkedMachine?(id: string): { name: string } | undefined
}

/** What the manager answers for mail (`main.ts` and the tests that run a real manager both wire mail through it) */
export function mailSessionsOf(
  mgr: Pick<SessionManager, 'sessionInfo' | 'listSessions' | 'assistantId' | 'tenure' | 'mail' | 'processes'>,
  assistantHasMailCommand: () => boolean,
): HostMailSessions {
  const seats = mgr.mail.mailSeats(assistantHasMailCommand)
  return {
    sessionInfo: (id) => mgr.sessionInfo(id),
    listSessions: () => mgr.listSessions(),
    canReadMail: (id) => seats.mailTool(id),
    assistantId: () => mgr.assistantId(),
    assistantAsks: () => mgr.mail.assistantAsks(),
    mailCommand: (id) => seats.mailCommand(id),
    keptInTurn: (id) => mgr.tenure.keptInTurn(id),
    oldOwes: (ownerId, childId) => mgr.mail.oldOwes(ownerId, childId),
    mailSessions: () => mgr.mail.mailSessions(),
    waitsOn: (id) => mgr.processes.waitsOn(id),
    quitTold: (id) => mgr.tenure.quitTold(id),
    stoppedWords: (id) => mgr.mail.stoppedWords(id),
    readsSession: (readerId, targetId) => mgr.mail.readsSession(readerId, targetId),
    turnInputs: (id) => mgr.mail.turnInputs(id),
    onLinkedMachine: (id) => mgr.mail.onLinkedMachine(id),
  }
}

export type HostMail = {
  service: MessageService
  /** The mailbox's records as the mail reads and writes them: a change to one tells `across` (#2067 item 2) */
  records: MailboxRecords
  /** Mail across linked machines (#2067 items 2 and 3): its links are given once they exist (`usePeers`) */
  across: MailAcross
  reach: MailReach
  turns: MailTurns
  delivery: MailDelivery
  tool: MailTool
  /** What the manager hears through `mgr.mail.useMail` */
  hooks: MailHooks
  /**
   * The step after the host's ready line (§6.3, §9.5), before delivery starts: the thread mail an older build left pending moves, then the report
   * marks and tasks are brought in step, then delivery starts. By then the host this one replaced is gone, so only one host delivers
   */
  afterReady(): void
}

/** When what became of crossing mail was last told to every linked side (`MailAcrossDeps.toldAt`) */
const ACROSS_TOLD_KEY = 'mail.acrossToldAt'

/**
 * The mail of this host on the message tables (M3a): the message service over `store.mailbox` with the one reach module, the turns and guards, the
 * delivery, the version-1 tool mapped onto the service, and the recorders the old report paths call. Nothing here starts until `afterReady`
 */
export function hostMail(store: Store, sessions: HostMailSessions, opts: { hostId: string; delivery?: MailDeliveryOptions; now?: () => number } ): HostMail {
  const { hostId } = opts
  const now = opts.now ?? Date.now
  const addressOf = (id: string) => sessionAddress(hostId, id)
  /** What a handoff moved, with the session a Centralu message is about as the session id the host uses (an address in the mailbox) */
  const aboutSessions = (list: HandedOverMessage[]): HandedOverMessage[] =>
    list.map(({ about, ...m }) => {
      const party = about ? parseAddress(about) : null
      return party?.kind === 'session' ? { ...m, about: party.sessionId } : m
    })
  const projects = () => store.projects.listProjects()
  // Filled once `across` exists: the reach names a session on another computer through it
  const far: { across?: MailAcross } = {}
  const records = watched(store.mailbox, () => far.across?.changed())
  const reach = mailReach({
    hostId,
    session: (id) => {
      const s = sessions.sessionInfo(id)
      if (s) return { projectId: s.projectId ?? null, askedBy: s.askedBy ?? null, here: true, canReadMail: sessions.canReadMail(id), host: 'here', name: s.name }
      // A child started on a linked machine (#2067): alive there, so not gone, and refused as elsewhere until mail crosses a link. Its
      // mail to its parent here (item 1) shows it by its name on that machine
      const linked = sessions.onLinkedMachine?.(id) ?? (id.includes('.') ? far.across?.foreignName(addressOf(id)) : undefined)
      return linked ? { projectId: null, askedBy: null, here: true, canReadMail: false, host: 'elsewhere', name: linked.name } : undefined
    },
    // A session of a hub this host is linked to (#2067 item 2), by the name it was last heard by
    foreign: (address) => far.across?.foreignName(address),
    assistantId: () => sessions.assistantId(),
    assistantAsks: () => sessions.assistantAsks() === null,
    // Nothing records an app's caller before the apps' mail API (§13) but an old thread the app wrote into: its moved mail to that session
    appCalledBy: (app, sessionId) => store.mailbox.movedTo(app, addressOf(sessionId)),
    project: (projectId) => {
      const p = projects().find((x) => x.id === projectId)
      return p && { trusted: p.trusted === true, name: p.name }
    },
    askGroupMembers: (address) => askGroupMembers(sessions, hostId, address),
  })
  // Filled once `turns` exists: the service reads a session's turn through it (§8.2 step 6)
  const box: { turns?: MailTurns } = {}
  const service = new MessageService(records, reach, {
    hostId,
    ...(opts.now ? { now: opts.now } : {}),
    turn: (address) => {
      const party = parseAddress(address)
      return (party?.kind === 'session' && box.turns?.current(party.sessionId)) || null
    },
    calls: (address) => {
      const party = parseAddress(address)
      return mailCalls(1, party?.kind === 'session' && sessions.mailCommand(party.sessionId) ? 'command' : 'plain')
    },
    personSaid: (sessionId) => store.messages.newestPersonMessage(sessionId),
    // A stop notice wakes a sender at rest; one in a turn reads it with its other mail (§4.1)
    atRest: (address) => {
      const party = parseAddress(address)
      const s = party?.kind === 'session' ? sessions.sessionInfo(party.sessionId) : undefined
      // Not one a quit cut either: it waits for the person's Continue, and a notice would start a turn with nobody there
      return !s || (!inTurn(s.state) && !wentWithItsProcess(s.interruption))
    },
    stoppedWords: (address) => {
      const party = parseAddress(address)
      return party?.kind === 'session' ? (sessions.stoppedWords?.(party.sessionId) ?? null) : null
    },
    mayRead: (reader, target) => {
      const [from, to] = [parseAddress(reader), parseAddress(target)]
      return from?.kind === 'session' && to?.kind === 'session' && sessions.readsSession?.(from.sessionId, to.sessionId) === true
    },
    ...(sessions.turnInputs ? { turnInputs: (id: string) => sessions.turnInputs?.(id) ?? [null] } : {}),
    waitsOn: (sender, stopped) => {
      const [from, to] = [parseAddress(sender), parseAddress(stopped)]
      return from?.kind === 'session' && to?.kind === 'session' && (sessions.waitsOn?.(from.sessionId) ?? []).includes(to.sessionId)
    },
  })
  box.turns = new MailTurns(store.mailbox, {
    ...(opts.now ? { now: opts.now } : {}),
    keepOpen: (id) => sessions.keptInTurn(id),
    // Whose request the turn is: the store's rows of it, not anything kept in memory (docs/plans/turn-owned-by-no-one.md §4.2)
    askerIn: (id, turn) => service.requestsIn(addressOf(id), turn)[0]?.asker ?? null,
  })
  const mailTurns = box.turns
  const across = new MailAcross({
    hostId,
    service,
    records,
    reach,
    // Kept in the store: a restart tells again what was settled since every side last heard, and nothing older
    toldAt: {
      get: () => Number(store.settings.appSetting(ACROSS_TOLD_KEY)) || null,
      set: (at) => store.settings.setAppSetting(ACROSS_TOLD_KEY, String(at)),
    },
    ...(opts.now ? { now: opts.now } : {}),
    log: (line) => console.error(line),
    ownEntries: () =>
      sessions.listSessions().map((s) => entryOf(s, { address: addressOf(s.id), project: s.projectId ? reach.projectLabel(s.projectId) : null, machine: null })),
  })
  far.across = across
  // A Centralu notice to a session on the other side is passed on there (§6)
  service.onChange((c) => {
    if (c.recipients.some((r) => across.foreign(r))) void across.passOn(c.messageId)
  })
  const delivery = new MailDelivery(service, records, sessions.mailSessions(), {
    turns: mailTurns,
    ...(opts.now ? { now: opts.now } : {}),
    // When it last ran: a host that was off a long while does not wake a crowd of sleeping sessions. A setting the previous build never reads
    heartbeat: {
      read: () => Number(store.settings.appSetting('mail.heartbeat')) || null,
      write: (ms) => store.settings.setAppSetting('mail.heartbeat', String(ms)),
    },
    across: (address) => across.foreign(address),
    ...opts.delivery,
  })
  const askedByHost: AskedByHost = {
    session: (id) => {
      const s = sessions.sessionInfo(id)
      return s && { name: s.name, projectId: s.projectId ?? null }
    },
    project: (id) => projects().find((p) => p.id === id),
    untrusted: (projectId) => reach.untrusted(projectId),
    cites: (messageId) => store.mailbox.message(messageId)?.facts.cites ?? null,
    requestsInTurn: (id) => {
      const turn = mailTurns.current(id)
      const requests = turn ? service.requestsIn(addressOf(id), turn) : []
      return turn ? { turnSeq: turn.turnSeq, requests: requests.flatMap((r) => { const party = parseAddress(r.asker); return party?.kind === 'session' ? [{ sessionId: party.sessionId, messageId: r.messageId }] : [] }) } : null
    },
  }
  const tool = new MailTool(service, records, reach, {
    personMessage: (sessionId, seq) => {
      const row = store.messages.loadMessagesFrom(sessionId, seq - 1, 1).find((r) => r.seq === seq)
      return row && typeof row.payload === 'object' && row.payload !== null && 'text' in row.payload && typeof row.payload.text === 'string' ? row.payload.text : null
    },
    caller: (id) => {
      const s = sessions.sessionInfo(id)
      return s && { address: addressOf(id), askedBy: s.askedBy ?? null, ...(s.startedFromHub ? { fromHub: true } : {}) }
    },
    assistantId: () => sessions.assistantId(),
    sessions: () => sessions.listSessions().map((s) => ({ id: s.id, name: s.name, project: s.projectId ?? null, state: s.state })),
    form: (id) => (sessions.mailCommand(id) ? 'command' : 'plain'),
    askerOf: (id) => askerFacts(askedByHost, id),
    legacyChain: (threadId, messageId, reader) => store.legacyChainFor(threadId, messageId, reader, 9),
    across,
  })
  const owedOld = (sender: string, recipient: string): boolean => {
    const owner = parseAddress(sender)
    const child = parseAddress(recipient)
    return owner?.kind === 'session' && child?.kind === 'session' && sessions.oldOwes(owner.sessionId, child.sessionId)
  }
  const waitingOn = (ownerId: string, childId: string): number => service.waitingOn(addressOf(ownerId), addressOf(childId), mailTurns.latest(childId)?.messageId ?? null, owedOld)

  const hooks: MailHooks = {
    askedBy: (id) => askedBy(askedByHost, id),
    sessionGone: (id) => service.partyGone(addressOf(id)),
    // The turn that was cut is the session's latest: the questions delivered in it are the ones it left unanswered
    stopped: (id, why, o) => void service.sessionStopped(addressOf(id), why, { turnSeq: mailTurns.latest(id)?.seq ?? null, ...(o?.quiet ? { quiet: true } : {}), ...(o?.told ? { told: o.told.map(addressOf) } : {}), ...(o?.held ? { held: o.held.map(addressOf) } : {}) }),
    oldPathEnded: (id, sender, told) => service.oldPathEnded(addressOf(id), addressOf(sender), told),
    quotes: (id, reader) => service.quotes(addressOf(id), addressOf(reader)),
    handOver: (from, to, which) => aboutSessions(service.handOver(addressOf(from), addressOf(to), which === 'all' ? 'all' : { senders: which.senders.map(addressOf) })),
    handOverPreview: (from, to) => aboutSessions(service.handOverPreview(addressOf(from), addressOf(to))),
    openWork: (id) => openWork(service, store, addressOf(id)),
    sessionChanged: (id) => delivery.poke(id),
    waiting: (id) => service.wakingFor(addressOf(id)),
    // The person's warning, written as the mailbox writes its own (delivery.ts `warnIfRunning`): one a clock hour for the session, and nothing waits for it
    compactCycles: (id, count) => {
      const hour = Math.floor(now() / HOUR_MS) * HOUR_MS
      service.notice(PERSON, { body: WARNING_TEXT.compactCycles(service.labelOf(addressOf(id)), count), facts: { compactCycles: { session: addressOf(id), count } }, dedupeKey: `compactcycles:${addressOf(id)}:${hour}` })
    },
    sessionEvent: (e, ended) => mailTurns.observe(e, ended),
    tool: (id, args) => tool.call(id, args),
    // Work a session gave another is a task, beside the old path that delivered it (§9.1)
    delegated: delegationRecorder(service, mailTurns),
    waitingOn,
    answered: answerRecorder(service, store.mailbox, mailTurns, waitingOn),
    // A session a script or the RPC started with a first message: the person's task, whose turn is reported to their Inbox (§9.6)
    personWork: { started: personWorkRecorder(service), owes: personOwes(service, store.mailbox), report: personReportRecorder(service, store.mailbox, (id) => service.waitingOn(PERSON, addressOf(id), mailTurns.latest(id)?.messageId ?? null, owedOld)) },
    // A turn's end is a report on the task, and the owner is told as mail when it can read it (§9.3)
    report: reportRecorder(service, store.mailbox, mailTurns, waitingOn),
    turnStarted: turnRecorder(service, store.mailbox, mailTurns),
    refusesDelegation: (callerId, target, call) => refusesDelegation(service, reach, callerId, target, call),
    roleMoved: (to) => {
      if (service.roleMoved(addressOf(to)) > 0) delivery.poke(to)
    },
  }

  return {
    service,
    records,
    across,
    reach,
    turns: mailTurns,
    delivery,
    tool,
    hooks,
    afterReady: () => {
      try {
        const moved = store.movePendingThreadMail(now(), (address) => reach.projectOf(address))
        if (moved.messages > 0) console.error(`[mail] moved ${moved.messages} pending message(s) an older build left in its threads`)
      } catch (e) {
        // The move is one transaction: nothing moved, and the next ready tries again
        console.error(`[mail] moving the thread mail an older build left pending failed: ${errorMessage(e)}`)
      }
      try {
        takeOverFromEarlierBuild(service, store, { info: (id) => sessions.sessionInfo(id), oldOwes: (o, c) => sessions.oldOwes(o, c) })
      } catch (e) {
        console.error(`[mail] taking over from an older build failed: ${errorMessage(e)}`)
      }
      try {
        // A turn a quit or the system's end cut, found cut at this start (§4.1): the questions it left unanswered are released and their senders told, quietly,
        // so a restart wakes none of them. Released once; a start that finds the same mark again finds nothing to release
        // One write for all of them: the person, and a session that asked several, read one notice. The cut turn is the one this host never saw end
        const open = new Map(store.mailbox.openTurns().map((t) => [t.sessionId, t.turnSeq]))
        const quitTold = (id: string) => {
          const q = sessions.quitTold?.(id) ?? { told: [], held: [] }
          return { told: q.told.map(addressOf), held: q.held.map(addressOf) }
        }
        const stops = sessions.listSessions().flatMap((s) => {
          const why = s.interruption?.reason
          return why === 'quit' || why === 'shutdown' ? [{ address: addressOf(s.id), why, turnSeq: open.get(s.id) ?? null, ...quitTold(s.id) }] : []
        })
        service.sessionsStopped(stops, true)
      } catch (e) {
        console.error(`[mail] telling the senders of the turns the last host's end cut failed: ${errorMessage(e)}`)
      }
      delivery.start()
    },
  }
}

/** The session addresses whose requests to the Assistant are counted together (§7.5): one project and one root of who started whom */
function askGroupMembers(sessions: HostMailSessions, hostId: string, address: string): string[] {
  const party = parseAddress(address)
  const all = sessions.listSessions()
  const root = (id: string): string => {
    let at = id
    for (let i = 0; i < 16; i++) {
      const up = all.find((s) => s.id === at)?.askedBy
      const upper = up ? all.find((s) => s.id === up) : undefined
      // The walk stops before the Assistant: it starts sessions in every project, so they are not one group (only their project is)
      if (!upper || isAssistantKind(upper.kind)) break
      at = upper.id
    }
    return at
  }
  const me = party?.kind === 'session' ? all.find((s) => s.id === party.sessionId) : undefined
  if (!me) return [address]
  const key = `${me.projectId ?? ''}|${root(me.id)}`
  return all.filter((s) => `${s.projectId ?? ''}|${root(s.id)}` === key).map((s) => sessionAddress(hostId, s.id))
}

/** What the archive card says a session holds (#1512): first lines of what waits for its answer, and of the tasks it owes a report of */
function openWork(service: MessageService, store: Store, address: string): { unanswered: string[]; owed: string[] } {
  const unanswered: string[] = []
  const owed: string[] = []
  for (const row of service.watchedTo(address)) {
    const m = store.mailbox.message(row.messageId)
    if (!m) continue
    if (m.kind === 'task') owed.push(firstLineOf(m.body, 160))
    else if (m.needsReply && row.answerId === null) unanswered.push(firstLineOf(m.body, 160))
  }
  return { unanswered, owed }
}

/** §7.4: a delegation out of the caller's untrusted project is refused (S15), and the record S16 is built from is written */
function refusesDelegation(
  service: MessageService,
  reach: MailReach,
  callerId: string,
  target: DelegationTarget,
  call: { tool: string; target: string; text: string },
): string | null {
  const projectId = reach.refusesDelegation(callerId, target)
  if (projectId === null) return null
  service.refused(callerId, { tool: call.tool, target: call.target, firstLine: firstLineOf(call.text), projectId })
  return `Refused (untrusted_project): ${REFUSAL_TEXT.untrusted_project(reach.projectLabel(projectId), call.target)}`
}

/** The record methods that change a row or a message: after each, the rows that crossed a link are compared again (`MailAcross.changed`) */
const MUTATORS = new Set([
  'insert', 'markAttempt', 'markDelivered', 'hold', 'letGo', 'markRead', 'release', 'closeFor', 'dismiss', 'failedTry', 'takeBack', 'undeliver',
  'markUncertain', 'markMaybeRepeated', 'deleteHeld', 'deleteRows', 'settle', 'answerHeld', 'answerDropped', 'markReleased', 'markTold',
  'moveRows', 'moveRole', 'purgeParty', 'sweep', 'mergeAcross',
])

/** The records, telling `changed` after each change (#2067 item 2): the one place every change of the mail passes */
function watched(records: MailboxRecords, changed: () => void): MailboxRecords {
  return new Proxy(records, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      if (typeof key !== 'string' || !MUTATORS.has(key)) return (...args: unknown[]): unknown => Reflect.apply(value, target, args)
      return (...args: unknown[]): unknown => {
        const out: unknown = Reflect.apply(value, target, args)
        changed()
        return out
      }
    },
  })
}
