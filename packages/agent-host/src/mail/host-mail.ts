import { prChecks } from '../dev-services/git-pr.js'
import { errorMessage, type SessionInfo, inboxListing, isAssistantKind, turnStop, workTasks } from '@cc/protocol'
import { bytesText } from '../bytes-text.js'
import { inTurn } from '../idle.js'
import { heldToContinue, wentWithItsProcess } from '../sessions/interruptions.js'
import { labelOf } from '../sessions/transcript-view.js'
import { liveHeirOf } from '../sessions/handoff-heirs.js'
import type { Store } from '../dev-services/store.js'
import type { SessionManager } from '../sessions/manager.js'
import type { MailHooks } from '../sessions/mail-sessions.js'
import { PERSON, parseAddress, sessionAddress } from './address.js'
import { answerRecorder, delegationRecorder, linkedTasksOf, openTaskParties, personWorkRecorder, personWorkWithdrawer, requestTurnRecorder, taskSender, taskWithdrawer, turnRecorder } from './delegation.js'
import { cardGivers, tellCard, withdrawEndedCards } from './card-notices.js'
import { MailDelivery, type MailDeliveryOptions, type MailSessions } from './delivery.js'
import { mailCalls } from './frame.js'
import { MessageService, type HandedOverMessage } from './messages.js'
import { mailReach, type DelegationTarget, type MailReach } from './reach.js'
import { REFUSAL_TEXT, WARNING_TEXT, firstLineOf, hourlyKey } from './rules.js'
import { MailTool, type MailToolHost } from './tool.js'
import { SessionRefs } from './session-refs.js'
import { MailAcross } from './across.js'
import { entryOf } from './find.js'
import type { MailboxRecords } from '../dev-services/store/mailbox.js'
import { MailTurns } from './turns.js'
import type { StopWhy } from './stop-notices.js'
import { Watches } from './watches.js'
import { MailReminders } from './reminders.js'
import type { RestFacts } from './rest.js'

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
  /** Whether the session reaches `mail` as a command behind `centralu_run` (the Assistant) */
  mailCommand(id: string): boolean
  /** Whether the session's turn goes on from the host before (kept, or continued after an update): its mail turn row is read back */
  keptInTurn(id: string): boolean
  mailSessions(): MailSessions
  /** Whether the project is trusted, read now (`ProjectRegistry.projectTrusted`, #2159): what the reach's hold reads */
  projectTrusted(projectId: string): boolean
  /** The words of the turn a stop cut, which the stop notice quotes as that session's own (`MailSessionsView.stoppedWords`) */
  stoppedWords?(id: string): string | null
  /**
   * Whether `readerId` can read `targetId` (this host's session, or a linked machine's as `m1.<id>`) with read_session, and whether its lines are marked
   * untrusted; null when it cannot (`MailSessionsView.readsSession`): only then is a session's text quoted to it
   */
  readsSession?(readerId: string, targetId: string): { untrusted: boolean } | null
  /** Who gave what may have entered the session's latest turn (`MailSessionsView.turnInputs`): only a turn its asker alone gave anything is quoted to it */
  turnInputs?(id: string): readonly (string | null)[]
  /** A session this start found at rest answers the tasks it did not answer once it is settled (`ChildReports.settleAtRest`, mailbox.md §10.6.3) */
  settleAtRest?(id: string): void
  /** A question the session asked a giver was settled with no answer to it: the report it held is owed now (`ChildReports.questionSettled`, #2348) */
  questionSettled?(id: string): void
  /** Tells `receiverId`, whose seat cannot read mail, of `stoppedId`'s stop in the relayed report's words for that ending (`ChildReports.relayStop`); `told` once it went in */
  relayStop?(receiverId: string, stoppedId: string, why: StopWhy, told: () => void): void
  /** A send to a session the caller gives work, answered (`MailSessionsView.work`, #1948), or null for plain mail */
  work?: MailToolHost['work']
  /** A note for a session the caller started (`MailToolHost.note`, #2493) */
  note?: MailToolHost['note']
  /** A child this host started on a linked machine, with the name its mail shows (`MailSessionsView.onLinkedMachine`, #2067); none for any other id */
  onLinkedMachine?(id: string): { name: string } | undefined
  /** Whether the session's background work is known: false for an adopted process whose tool has not listed it yet (`RestartPolicy.backgroundKnown`); known when absent */
  backgroundKnown?(id: string): boolean
}

/** What the manager answers for mail (`main.ts` and the tests that run a real manager both wire mail through it) */
export function mailSessionsOf(
  mgr: Pick<SessionManager, 'sessionInfo' | 'listSessions' | 'assistantId' | 'tenure' | 'mail' | 'projectRegistry'>,
  assistantHasMailCommand: () => boolean,
): HostMailSessions {
  const seats = mgr.mail.mailSeats(assistantHasMailCommand)
  return {
    sessionInfo: (id) => mgr.sessionInfo(id),
    listSessions: () => mgr.listSessions(),
    canReadMail: (id) => seats.mailTool(id),
    assistantId: () => mgr.assistantId(),
    mailCommand: (id) => seats.mailCommand(id),
    keptInTurn: (id) => mgr.tenure.keptInTurn(id),
    mailSessions: () => mgr.mail.mailSessions(),
    projectTrusted: (projectId) => mgr.projectRegistry.projectTrusted(projectId),
    stoppedWords: (id) => mgr.mail.stoppedWords(id),
    readsSession: (readerId, targetId) => mgr.mail.readsSession(readerId, targetId),
    turnInputs: (id) => mgr.mail.turnInputs(id),
    onLinkedMachine: (id) => mgr.mail.onLinkedMachine(id),
    work: (...a) => mgr.mail.work(...a),
    note: (...a) => mgr.mail.note(...a),
    settleAtRest: (id) => mgr.mail.settleAtRest(id),
    questionSettled: (id) => mgr.mail.questionSettled(id),
    relayStop: (receiverId, stoppedId, why, told) => mgr.mail.relayStop(receiverId, stoppedId, why, told),
    backgroundKnown: (id) => mgr.mail.backgroundKnown(id),
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
  /** The watches sessions keep (docs/plans/mailbox.md §18): the person's list and cancel, and `watches_changed` */
  watches: Watches
  tool: MailTool
  /** What the manager hears through `mgr.mail.useMail` */
  hooks: MailHooks
  /**
   * The step after the host's ready line (§10.6.3), before delivery starts: the notices of cards the last host's end took are withdrawn, the turns that end cut are told (the
   * stop notice), then delivery starts and each session at rest answers its open tasks once settled. By then the host this one replaced is gone, so only one
   * host delivers
   */
  afterReady(): void
}

/** When what became of crossing mail was last told to every linked side (`MailAcrossDeps.toldAt`) */
const ACROSS_TOLD_KEY = 'mail.acrossToldAt'

/**
 * The mail of this host on the message tables (M3a): the message service over `store.mailbox` with the one reach module, the turns and guards, the
 * delivery, the `mail` tool on the service, and the recorders the old report paths call. Nothing here starts until `afterReady`
 */
export function hostMail(store: Store, sessions: HostMailSessions, opts: { hostId: string; delivery?: MailDeliveryOptions; now?: () => number } ): HostMail {
  const { hostId } = opts
  const now = opts.now ?? Date.now
  const addressOf = (id: string) => sessionAddress(hostId, id)
  /**
   * Whether the session at `reader` reads the one at `target` with read_session, and whether its lines are marked untrusted; null when it does not
   * (`HostMailSessions.readsSession`). Both are addresses of this host: a session here, or a linked machine's as this host names it (`m1.<id>`); a
   * session another host names is none of this host's to read
   */
  const readsAs = (reader: string, target: string): { untrusted: boolean } | null => {
    const [from, to] = [parseAddress(reader), parseAddress(target)]
    if (from?.kind !== 'session' || to?.kind !== 'session' || from.host !== hostId || to.host !== hostId) return null
    return sessions.readsSession?.(from.sessionId, to.sessionId) ?? null
  }
  /** What a handoff moved, with the session a Centralu message is about as the session id the host uses (an address in the mailbox) */
  const aboutSessions = (list: HandedOverMessage[]): HandedOverMessage[] =>
    list.map(({ about, ...m }) => {
      const party = about ? parseAddress(about) : null
      return party?.kind === 'session' ? { ...m, about: party.sessionId } : m
    })
  const projects = () => store.projects.listProjects()
  // Filled once `across` exists: the reach names a session on another computer through it
  const far: { across?: MailAcross } = {}
  /** Who hears each change of the mail (`LinkedTasks.onChange`) */
  const changes = new Set<() => void>()
  const records = watched(store.mailbox, () => {
    far.across?.changed()
    for (const listener of changes) listener()
  })
  const reach = mailReach({
    hostId,
    session: (id) => {
      const s = sessions.sessionInfo(id)
      // Named as read_session lists it: a conversation compaction renamed goes by its first instruction
      if (s) return { projectId: s.projectId ?? null, askedBy: s.askedBy ?? null, here: true, canReadMail: sessions.canReadMail(id), host: 'here', name: labelOf(store.messages, s) }
      // A child started on a linked machine (#2067): alive there, so not gone, and refused as elsewhere until mail crosses a link. Its
      // mail to its parent here (item 1) shows it by its name on that machine
      const linked = sessions.onLinkedMachine?.(id) ?? (id.includes('.') ? far.across?.foreignName(addressOf(id)) : undefined)
      return linked ? { projectId: null, askedBy: null, here: true, canReadMail: false, host: 'elsewhere', name: linked.name } : undefined
    },
    // A session of a hub this host is linked to (#2067 item 2), by the name it was last heard by
    foreign: (address) => far.across?.foreignName(address),
    /*
     * A session a hub's session started here keeps no parent here (#2520): its start_agent task names that session, by its address there, and a handoff
     * there moves it (`host.mailMove`). Read as its parent, its replies wake the session as a parent's do (`quietAnswer`)
     */
    starterElsewhere: (id) => {
      if (!sessions.sessionInfo(id)?.startedFromHub) return null
      const sender = store.mailbox.firstTask(addressOf(id), 'start_agent')?.sender
      const party = sender ? parseAddress(sender) : null
      return sender && party?.kind === 'session' && party.host !== hostId ? sender : null
    },
    hubPerson: (hostId) => far.across?.isHub(hostId) === true,
    shown: (address, reader) => refs.shown(address, reader),
    assistantId: () => sessions.assistantId(),
    // Nothing records an app's caller before the apps' mail API (§13) but an old thread the app wrote into: its moved mail to that session
    appCalledBy: (app, sessionId) => store.mailbox.movedTo(app, addressOf(sessionId)),
    project: (projectId) => {
      const p = projects().find((x) => x.id === projectId)
      return p && { trusted: sessions.projectTrusted(projectId), name: p.name }
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
      return mailCalls(party?.kind === 'session' && sessions.mailCommand(party.sessionId) ? 'command' : 'plain')
    },
    personSaid: (sessionId) => store.messages.newestPersonMessage(sessionId),
    heirOf: (address) => {
      const party = parseAddress(address)
      const heir = party?.kind === 'session' && party.host === hostId ? liveHeirOf(store, party.sessionId, (id) => sessions.sessionInfo(id) !== undefined) : null
      return heir ? addressOf(heir) : null
    },
    questionSettled: (address) => {
      const party = parseAddress(address)
      if (party?.kind === 'session' && party.host === hostId) sessions.questionSettled?.(party.sessionId)
    },
    standing: (address) => {
      const party = parseAddress(address)
      const s = party?.kind === 'session' ? sessions.sessionInfo(party.sessionId) : undefined
      return !s ? 'rest' : wentWithItsProcess(s.interruption) ? 'cut' : inTurn(s.state) ? 'turn' : 'rest'
    },
    stopShown: (address) => {
      const party = parseAddress(address)
      const s = party?.kind === 'session' && party.host === hostId ? sessions.sessionInfo(party.sessionId) : undefined
      return !!s && turnStop(s) !== null && inboxListing(s) !== 'never'
    },
    stoppedWords: (address) => {
      const party = parseAddress(address)
      return party?.kind === 'session' ? (sessions.stoppedWords?.(party.sessionId) ?? null) : null
    },
    readsAs,
    ...(sessions.turnInputs ? { turnInputs: (id: string) => sessions.turnInputs?.(id) ?? [null] } : {}),
    // A session whose seat cannot read mail is refused the stop notice (`no_mailbox`): it is told the old way (mailbox.md §10.6.3)
    relayToMailless: (session, stopped, why, told) => {
      const [to, about] = [parseAddress(session), parseAddress(stopped)]
      if (to?.kind !== 'session' || about?.kind !== 'session' || sessions.canReadMail(to.sessionId) || !sessions.relayStop) return false
      sessions.relayStop(to.sessionId, about.sessionId, why, told)
      return true
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
  const watches = new Watches({
    hostId,
    service,
    records,
    now,
    session: (address) => {
      const party = parseAddress(address)
      const s = party?.kind === 'session' ? sessions.sessionInfo(party.sessionId) : undefined
      const cards = s ? [...s.pendingQuestions.map((q) => q.requestId), ...(s.pendingApproval ? [s.pendingApproval.requestId] : [])] : []
      return s && { working: inTurn(s.state), cards, interrupted: (s.interruption ?? null) !== null, held: heldToContinue(s.interruption) }
    },
    mayRead: (reader, target) => readsAs(reader, target) !== null,
    elsewhere: (address) => {
      const party = parseAddress(address)
      return party?.kind !== 'session' || party.host !== hostId || reach.elsewhere(address)
    },
    archived: (address) => {
      const party = parseAddress(address)
      return party?.kind === 'session' && party.host === hostId && store.trash.isTrashed(party.sessionId)
    },
    projectOf: (address) => reach.projectOf(address),
    prChecks: async (project, number, signal) => {
      const path = projects().find((p) => p.id === project)?.path
      return path ? prChecks(path, number, signal) : null
    },
  })
  const mailSessions = sessions.mailSessions()
  /**
   * A session of this host as the unanswered reminder's rest rule reads it (docs/plans/mailbox.md §10.1); null for an address another host decides
   * for, another computer's session, whose own host reminds it. A linked machine's session on a hub has no session here, so it reads as gone
   */
  const restFacts = (address: string): RestFacts | null => {
    const party = parseAddress(address)
    if (party?.kind !== 'session' || party.host !== hostId || across.foreign(address)) return null
    const s = sessions.sessionInfo(party.sessionId)
    return {
      receiver: mailSessions.receiver(party.sessionId),
      error: s?.state === 'error',
      interrupted: (s?.interruption ?? null) !== null,
      work: workTasks(s?.backgroundTasks ?? []).length,
      workKnown: sessions.backgroundKnown?.(party.sessionId) ?? true,
      mailWaiting: service.wakingFor(address),
      lastTurn: records.lastTurnEnded(party.sessionId),
    }
  }
  const reminders = new MailReminders(service, records, restFacts, { now })
  const delivery = new MailDelivery(service, records, mailSessions, {
    watches,
    reminders,
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
  const refs = new SessionRefs({
    hostId,
    sessions: () => sessions.listSessions().map((s) => ({ id: s.id, name: s.name, project: s.projectId ?? null, state: s.state })),
    assistantId: () => sessions.assistantId(),
    computers: () => across.refComputers(),
  })
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
    refs,
    form: (id) => (sessions.mailCommand(id) ? 'command' : 'plain'),
    // The host's record, never anything the session wrote; a gone session's project is unknown, so it is not trusted (fail closed)
    askerOf: (id) => {
      const s = sessions.sessionInfo(id)
      const projectId = s ? (s.projectId ?? null) : 'gone'
      const project = projectId === null ? undefined : projects().find((p) => p.id === projectId)
      return { name: s?.name ?? id.slice(0, 8), project: project?.name ?? null, trusted: !reach.untrusted(projectId) }
    },
    across,
    watches,
    claim: (address, id) => delivery.claim(address, id),
    ...(sessions.work ? { work: sessions.work } : {}),
    ...(sessions.note ? { note: sessions.note } : {}),
  })
  /** Whether the card a notice names stands in its session still: the session holds that question or approval (mailbox.md §10.6.4) */
  const cardStands = (session: string, requestId: string): boolean => {
    const party = parseAddress(session)
    const s = party?.kind === 'session' ? sessions.sessionInfo(party.sessionId) : undefined
    return s !== undefined && (s.pendingQuestions.some((q) => q.requestId === requestId) || s.pendingApproval?.requestId === requestId)
  }
  const hooks: MailHooks = {
    address: addressOf,
    sessionGone: (id) => {
      service.stops.partyGone(addressOf(id))
      watches.gone(addressOf(id))
    },
    // The turn that was cut is the session's latest: the questions delivered in it are the ones it left unanswered
    stopped: (id, why, o) => {
      // The turn it cut keeps how: no reminder follows a Stop or a failure until the session's next turn (mailbox.md §10.1)
      const cut = mailTurns.latest(id)
      if (cut) records.setTurnEndedHow(id, cut.seq, why)
      void service.stops.sessionStopped(addressOf(id), why, { turnSeq: cut?.seq ?? null, ...(o?.told ? { told: o.told.map(addressOf) } : {}), ...(o?.starter ? { starter: addressOf(o.starter) } : {}), ...(o?.held ? { held: true } : {}) })
      // A stop Centralu holds to continue (#1415) is a stop only if its wait ends without going on, as its senders are told (`waitEnded`)
      if (!o?.held) watches.changed(addressOf(id), 'stopped')
    },
    waitEnded: (id, why, starter, end) => {
      service.stops.stopWaitEnded(addressOf(id), why, starter ? addressOf(starter) : null, end)
      if (!end.continued) watches.changed(addressOf(id), 'stopped')
    },
    handOver: (from, to, which, children) => {
      const moveMail = () => {
        const moved = service.handOver(addressOf(from), addressOf(to), which === 'all' ? 'all' : { senders: which.senders.map(addressOf) }, children.map(addressOf))
        // Tasks given across a link keep their id there: the machines are told whose they are now (#1948 step 6)
        void across.movedAcross(service.takeMoves())
        return moved
      }
      return aboutSessions(which === 'all' ? watches.handOver(addressOf(from), addressOf(to), moveMail) : moveMail())
    },
    handOverPreview: (from, to) => aboutSessions(service.handOverPreview(addressOf(from), addressOf(to))),
    openWork: (id) => openWork(service, store, addressOf(id)),
    sessionChanged: (id) => delivery.poke(id),
    notice: (id, body, dedupeKey) => {
      service.notice(addressOf(id), { body, facts: {}, dedupeKey })
    },
    waiting: (id) => service.wakingFor(addressOf(id)),
    // The person's warning, written as the mailbox writes its own (delivery.ts `warnIfRunning`): one a clock hour for the session, and nothing waits for it
    compactCycles: (id, count) => service.notice(PERSON, { body: WARNING_TEXT.compactCycles(service.labelOf(addressOf(id)), count), facts: { compactCycles: { session: addressOf(id), count } }, dedupeKey: hourlyKey(`compactcycles:${addressOf(id)}`, now()) }),
    sessionEvent: (e, ended) => {
      mailTurns.observe(e, ended)
      if ((e.type === 'question_request' || e.type === 'approval_request') && e.sessionId) watches.changed(addressOf(e.sessionId), 'asked', e.requestId)
    },
    tool: (id, args, signal) => tool.call(id, args, signal),
    session: (id, text) => refs.sessionId({ id, askedBy: sessions.sessionInfo(id)?.askedBy ?? null }, text),
    // Work a session gave another is a task, beside the old path that delivered it (§9.1)
    delegated: delegationRecorder(service, mailTurns),
    sendTask: taskSender(service),
    // Work given a session on a linked machine crosses as a task, and its report comes back (#1948 step 6)
    linkedTasks: linkedTasksOf(service, records, across, (listener) => {
      changes.add(listener)
      return () => void changes.delete(listener)
    }),
    withdrawTasks: taskWithdrawer(service, store.mailbox),
    answered: answerRecorder(service, store.mailbox),
    // A session a script or the RPC started with a first message: the person's task, answered as any task is (§9.6, §10.6.3)
    personWork: { started: personWorkRecorder(service), withdrawn: personWorkWithdrawer(service, store.mailbox) },
    // A session at rest answers the tasks it did not answer by a reply with its last response (§10.6.3): a session's and the person's alike
    lastResponse: (id, { relay, ...last }) => {
      const answered = service.lastResponse(addressOf(id), {
        ...last,
        body: (sender) => {
          const party = parseAddress(sender)
          return last.body(party?.kind === 'session' ? party.sessionId : null)
        },
        answers: (sender) => sender === PERSON || parseAddress(sender)?.kind === 'session',
        queued: delivery.queuedFor(addressOf(id)),
      })
      // A sender whose seat cannot read mail (an older build's coordinator, a builder) is refused it (`no_mailbox`): it is told in its conversation, as
      // it was before step 3, and the report is marked delivered and read once that went in, so the Inbox reads it as told
      try {
        for (const taskId of answered) {
          const owner = records.message(taskId)?.sender ?? ''
          const party = parseAddress(owner)
          const report = records.reportsOn(taskId).at(-1)
          if (party?.kind !== 'session' || sessions.canReadMail(party.sessionId) || !report) continue
          relay(party.sessionId, () => {
            const at = now()
            records.markDelivered(owner, [report.id], at, null)
            records.markRead(owner, [report.id], at)
          })
        }
      } finally {
        // The watches on it hear the end whatever became of the relay, and theirs never stops it (`Watches.changed` keeps each apart)
        watches.changed(addressOf(id), 'turn_ended')
      }
    },
    requestTurnEnded: requestTurnRecorder(service, mailTurns, addressOf),
    openTasks: (id, side) => openTaskParties(store.mailbox, addressOf(id), side),
    watchedAtRest: (id) => watches.waitsForRest(addressOf(id)),
    // A card a session raised is told to the givers of its open work, and answered by one of them only as the gate allows (§10.6.4)
    cards: {
      // Every giver hears of it; the one giver answers only in a turn its work alone started: a question in one its send or its task the mailbox
      // delivered started, an approval only in one its own send started (`gaveIt`, §10.6.4). A giver on another computer is named by its address
      givers: (id) => cardGivers(store.mailbox, addressOf(id), (giver, gaveIt) => giver !== PERSON && service.stops.alone(addressOf(id), parseAddress(giver) ? giver : addressOf(giver), { gaveIt })),
      // The person has the card itself: nothing is written for them. A giver on another computer (an address) reads it through that computer's call
      tell: (giverId, card, body, delivered) => (giverId === PERSON || parseAddress(giverId) ? null : tellCard(service, addressOf(giverId), { ...card, session: addressOf(card.session) }, body, delivered)),
      turn: (id) => store.mailbox.nextTurnSeq(id) - 1,
      ended: (id) => withdrawEndedCards(store.mailbox, addressOf(id), cardStands),
    },
    turnInputs: (id, turn) => delivery.turnInputs(addressOf(id), turn),
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
    watches,
    tool,
    hooks,
    afterReady: () => {
      try {
        // A card the last host's end took with it (a quit, an update, a swap) no longer stands here: its notice not given yet goes
        withdrawEndedCards(store.mailbox, null, cardStands)
      } catch (e) {
        console.error(`[mail] taking back the notices of ended cards failed: ${errorMessage(e)}`)
      }
      try {
        // A turn a quit or the system's end cut, found cut at this start (mailbox.md "The stop notice"): what it left unanswered is released and its senders
        // told, so a restart wakes only a sender owed a reply. Released once; a start that finds the same mark again finds nothing to release
        // One write for all of them: the person, and a session that asked several, read one notice. The cut turn is the one this host never saw end
        const open = new Map(store.mailbox.openTurns().map((t) => [t.sessionId, t.turnSeq]))
        const stops = sessions.listSessions().flatMap((s) => {
          const why = s.interruption?.reason
          if (why !== 'quit' && why !== 'shutdown') return []
          // The session that started it is told once (the notice's key): a later start that finds the same mark tells no one again
          const starter = s.askedBy && sessions.sessionInfo(s.askedBy) ? addressOf(s.askedBy) : null
          return [{ address: addressOf(s.id), why, turnSeq: open.get(s.id) ?? null, starter }]
        })
        service.stops.sessionsStopped(stops)
      } catch (e) {
        console.error(`[mail] telling the senders of the turns the last host's end cut failed: ${errorMessage(e)}`)
      }
      try {
        // A step that breaks older readers ran at this start without the copy kept before it (#2304): the person hears of it once
        const skipped = store.copySkipped
        if (skipped) {
          const short = skipped.reason === 'low_disk' ? { free: bytesText(skipped.free), needed: bytesText(skipped.needed) } : null
          service.notice(PERSON, { body: WARNING_TEXT.noStoreCopy(short), facts: { storeCopySkipped: { step: skipped.step, reason: skipped.reason } }, dedupeKey: `storecopy:${skipped.step}` })
        }
      } catch (e) {
        console.error(`[mail] telling the person that the store was changed without a copy failed: ${errorMessage(e)}`)
      }
      delivery.start()
      // No process outlives its host: a session the last host left at rest after a turn that ended as turns do, with tasks it did not answer,
      // answers them with its last response once settled, as when its own background work ends (§10.6.3)
      for (const s of sessions.listSessions()) sessions.settleAtRest?.(s.id)
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
