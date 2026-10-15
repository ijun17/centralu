import { create } from 'zustand'
import { DEFAULT_UI_PREFERENCES, SessionInfo, SUBAGENT_STEPS_PAGE, TEXT_SIZES, parseUiPreferences } from '@cc/protocol'
import type {
  AppQuestion,
  ToolStatus,
  CommandRunInfo,
  ExternalAppInfo,
  GridPanel,
  GridSpan,
  NormalizedEvent,
  ProjectInfo,
  StoredMessage,
  ToolDefaults,
  ToolName,
  ThemeFileEntry,
  AgentVersions,
  MachineInfo,
} from '@cc/protocol'
import {
  isProposalId,
  suggestMatcher,
  DEFAULT_NOTIFY_POLICY,
  readNotifyPolicy,
  initialSession,
  markRead as markReadPure,
  rename as renamePure,
  appPanelId,
  appKeyOf,
  gridPanelKey,
  sanitizeGridSpan,
  withPanelSpan,
  gridSessionIds,
  sanitizeGridPanels,
  sanitizeArrangements,
  migrateArrangement,
  sessionPanelId,
  isAway,
  type ProjectArrangement,
  type SessionSummary,
} from '@cc/core'
import type { Platform, WorkspaceSnapshot } from '@cc/platform/ports'
import { activateTab, defaultLayout, sanitizeLayout } from './panelLayout.js'
import { closeLayer, EMPTY_NAV, sameScreen, step, visit } from './navHistory.js'
import { agentApplyVerdict } from '../features/settings/apply-offer.js'
import { FOLDED_GROUPS_MAX, deadFoldKeys, foldGroupsHiding, sameKeys } from './foldGroups.js'
import { bumpChatKeysAbove, messagesToChat, nextChatKey, type ChatAttachment, type ChatItem } from './transcript.js'
export { audienceText, compactionText, errorText, handoffText, markerText, messagesToChat, noticeLine, resetText } from './transcript.js'
export type { ChatAttachment, ChatItem, NoticeLine } from './transcript.js'
import { EMPTY_DRAFT, type AppState, type Draft, type InlineView, type Notice, type Overlay, type PinnedView } from './state.js'
export { EMPTY_DRAFT } from './state.js'
export type { AppState, Draft, InlineView, Notice, Overlay, PinnedView, SubagentSteps } from './state.js'
import { HISTORY_PAGE, SUBAGENT_STEPS_UNREAD, mergePage, prependPage, putSubagentSteps, readBack, trimWindow, withoutClosedSteps } from './historyPages.js'
import { gridAppViewKey, isApp } from './appKeys.js'
export { externalAppKey, gridAppViewKey, isApp } from './appKeys.js'
import { screenExists, screenOf } from './screens.js'
export {
  gridScreenAppKeys,
  newSessionProjectOf,
  openProjectOf,
  projectScreenAppKeys,
  projectScreenOf,
  projectScreenSessions,
  returnsToPanel,
  screenExists,
  screenOf,
} from './screens.js'
import {
  forgetSessions,
  liveFactsOf,
  mergeListedSince,
  replayPendingEvents,
  trackWorkingSince,
  watchLiveEvents,
} from './sessionList.js'
export { PENDING_EVENTS_MAX, PENDING_EVENTS_MAX_AGE_MS } from './sessionList.js'
import {
  appActions,
  holdPinnedViews,
  inlineFrameKey,
  inlineFrames,
  inlineViewsFromHistory,
  mergeInlineHistory,
  syncInlineViews,
  type InlineFrame,
} from './apps.js'
export {
  applyAppView,
  AUTO_RELOAD_WINDOW_MS,
  AUTO_RELOADS,
  inlineFrameShown,
  inlineViewsFromHistory,
  registerPinnedFrame,
} from './apps.js'
export type { InlineFrame } from './apps.js'
import { eventActions } from './events/index.js'
import { syncBadge } from './events/notices.js'

/**
 * The store only does the wiring — all state-change logic lives in core (docs/state-management.md
 * §2). Commands go out through ports, and state updates come in only as events routed through the
 * core reducer (CQRS-lite: no optimistic updates).
 */

/**
 * One higher than the last one opened. Coming from outside git resets it to 1 — panels opened
 * in between are appended fresh.
 */
const nextPick = (o: Overlay): number => (o?.kind === 'git' ? o.pick : 0) + 1

/**
 * The tab set and arrangement live in panelLayout.ts (#20) — the single `panelTab`
 * value became a group structure when the panel learned to split, and the reasoning
 * for what the tabs *are* (e.g. why `history` sits beside `git` rather than inside it,
 * #21) moved with the type. Re-exported so screens keep one import site for the store.
 */
export type { PanelGroup, PanelTab } from './panelLayout.js'

/** Limits on the evidence panel's width. Too narrow kills the path; too wide kills the conversation */
export const PANEL_MIN = 260
export const PANEL_MAX = 900
export const PANEL_DEFAULT = 340

/** Width of the session list (observation lane) */
/** The height "history" takes up in the git tab. "Changes" gets the rest */

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 480
export const SIDEBAR_DEFAULT = 240

/** The key of an answer in flight (`approvalsInFlight`): the session and the request, since ids repeat across sessions */
export function inFlightKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`
}

/**
 * The five steps of overall text size (the middle one is the default) — the protocol's
 * `TEXT_SIZES`, since the size is a preference (`UiPreferences.textSize`, #312 step 5).
 *
 * The value is the root's CSS zoom factor. The alternative of scaling only the font (switching to
 * rem) would be a full rewrite, because every bit of text in this codebase is fixed in px
 * (text-xs…), and if only the text grows while the panel does not, line wrapping breaks first
 * in a narrow grid panel. Scaling the whole screen by the same factor is predictable instead,
 * because it follows the same rule as the OS's own display scaling.
 */
export const TEXT_SCALES = TEXT_SIZES

/**
 * The minimum width the conversation lane must keep.
 *
 * Without this, stretching both side panels squeezes the center down to zero and beyond, pushing
 * the whole layout past the window edge so the entire screen scrolls horizontally (this actually
 * happened during dogfooding). Worse, in that state the handle position calculation goes wrong,
 * creating feedback where dragging it makes it grow larger still.
 */
export const CENTER_MIN = 360

/**
 * Clamps to the width that can actually fit inside the window.
 *
 * Why `zoom` is needed (for overall text size): the layout width is in zoom coordinates, while
 * `window.innerWidth` is in **real pixels**. Without dividing by it, the available width gets
 * inflated at higher zoom and the layout is pushed past the window edge. The minimum width, on
 * the other hand, is **pinned to real pixels** — if it were allowed to grow with the zoom level up
 * to the point where the panel could be narrowed, raising the zoom in a narrow window would let
 * the panel eat the whole screen (per a dogfooding request: the minimum width stays fixed).
 */
function fitWidth(px: number, minReal: number, max: number, otherLane: number, zoom = 1): number {
  const winW = (typeof window === 'undefined' ? 1280 : window.innerWidth) / zoom
  const available = winW - otherLane - CENTER_MIN / zoom
  return Math.min(max, Math.max(Math.round(minReal / zoom), Math.round(Math.min(px, available))))
}

/** Registers a drawn frame in `inlineFrames` (apps.ts, with the reason it exists); here because each change bumps the store's counter */
export function registerInlineFrame(sessionId: string, callId: string, frame: InlineFrame): () => void {
  const key = inlineFrameKey(sessionId, callId)
  inlineFrames.set(key, frame)
  useStore.setState((s) => ({ inlineFramesVersion: s.inlineFramesVersion + 1 }))
  return () => {
    if (inlineFrames.get(key) !== frame) return
    inlineFrames.delete(key)
    useStore.setState((s) => ({ inlineFramesVersion: s.inlineFramesVersion + 1 }))
  }
}

/** The current scale (a `TEXT_SCALES` value). Used to convert between real pixels and zoom coordinates */
export function useTextZoom(): number {
  return useStore((s) => s.prefs.textSize)
}

/**
 * A conversation item's unique number. This value is both the React key and the virtual scroll's
 * item key.
 *
 * **Must never overlap an item read back from the store.** An overlap means two items share the
 * same key, and the virtual scroll draws them both in the same spot, mashing the text together as
 * if it had run on. (This was in fact the reported symptom "it sometimes renders strangely": a
 * session that had loaded history — stored seq 1..N — started its own seq count over at 1 the
 * moment a new message was appended.)
 * So this number is pushed above every stored item as it is brought in.
 */
/** A new object with one key removed (never mutates state directly) */
function omitKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const next = { ...obj }
  delete next[key]
  return next
}

/**
 * A `set` that updates one session **after** awaiting an RPC (#163) — changes nothing if
 * `session_deleted` arrived in the meantime.
 *
 * The post-await `set` used to spread `{ ...s.sessions[id]!, … }`. If the session was deleted while
 * awaiting, that revived a near-empty row (`{"live":true}`), which broke code that iterates all
 * sessions (`s.touchedPaths is not iterable`). Every post-await session update now goes through this
 * gate, so any future addition gets the same rule.
 */
function ifSessionStill(
  sessionId: string,
  patch: (st: AppState, cur: AppState['sessions'][string]) => Partial<AppState>,
): (st: AppState) => Partial<AppState> {
  return (st) => {
    const cur = st.sessions[sessionId]
    return cur ? patch(st, cur) : {}
  }
}

/**
 * Of the model and effort this project has remembered for this tool, keep only what **that tool
 * still accepts** (#107).
 *
 * Saving per tool is not enough by itself: models retire. A name picked yesterday may not be on
 * today's list, and sending it as is kills the session with a 400 on the first turn — a trade that
 * loses the session to preserve one remembered value. So it is checked at the moment of use, and
 * dropped if absent.
 *
 * **Nothing is dropped if the list could not be read.** `supported: false` means "unknown right now,"
 * not "that model does not exist," and dropping it for being unknown would silently erase what the
 * person chose during a moment the tool happened not to respond.
 *
 * Effort is dropped **together with** the model. Effort is a handle on the model
 * (`ModelOption.efforts`), so leaving it behind would land a `high` of unknown origin onto the
 * tool's default model.
 */
async function usableDefaults(
  platform: Platform,
  tool: ToolName,
  saved: ToolDefaults | undefined,
  /** The project's machine (#82): the models are the ones its own CLI offers */
  machine?: string | null,
): Promise<ToolDefaults> {
  const none: ToolDefaults = { model: null, effort: null }
  if (!saved?.model) return saved ?? none
  try {
    const { supported, models } = await platform.agents.models(tool, machine)
    if (!supported || models.length === 0) return saved
    return models.some((m) => m.id === saved.model) ? saved : none
  } catch {
    return saved // Same reason as above — failing to ask is not the same as "does not exist"
  }
}

/** Projects with a one-click start (`startSessionNow`) in flight: a re-entry guard, nothing to draw from it */
const startingNow = new Set<string>()

/** A handoff in progress — calling it twice on the same session births two new sessions (module state: purely a re-entry guard, nothing to draw from it) */
const handoffInFlight = new Set<string>()
/**
 * The tickets the host gave this window for an agent's "Apply now" (#665), by request: the go names one of these. Kept
 * as the answer's promise, since the host may send the go before the answer's reply has reached this window. A ticket
 * no go came for is forgotten after a while: the host asks again after its card, so the first is never used.
 */
const applyTickets = new Map<string, Promise<string | null>>()
const APPLY_TICKET_MS = 5 * 60_000

/**
 * The handoff prompt (per a dogfooding request to "prompt it properly" — specifically, that the
 * language the user is using needs to carry over). Only the dying session has the full context, so
 * it is the one that writes the note.
 *
 * **The note is received as the reply, and the host places the file** (#142). The agent used to
 * write directly into `.centralu/handoff/` inside the project. Once the note moved outside the
 * user's repository (into the data folder), writing it directly would have meant granting both
 * tools more permissions — so the agent only replies, and after that turn ends the host takes
 * **the reply as recorded in the store** and places it as a file (`agents.exportHandoffNote`). This
 * also sidesteps a second dogfooding finding (a reply scraped from the on-screen conversation mixed
 * in streaming chunks and leftover output from the previous turn): it is read from the host's
 * record, not the screen, only the reply to this specific request, and only after the turn ends.
 *
 * Exported because the e2e tests identify the handoff message by this wording.
 */
/**
 * A project the person registered from this window (adding a folder, or making one, #515) joins the list, and is asked
 * about once for trust — unless it is already trusted (the same folder chosen again).
 */
/** What a project carries that any client may change through the host (#719); `git` and the identity stay as the window has them */
const PROJECT_SETTING_KEYS = ['trusted', 'commands', 'worktreeSetup', 'worktreeManager', 'defaultTool', 'defaultModels'] as const satisfies readonly (keyof ProjectInfo)[]

/*
 * The writes this window has made to a project and not seen settle (#719). A list read that began before a write
 * finished may carry the value from before it, and taking that over the window's own newer value would hide a command
 * just added: the next whole-list save would then drop it on the host. So a read leaves a project alone while a write
 * of its own is in flight or finished after the read began, and reads it again once the write is done.
 */
const projectWrites = { clock: 0, flying: new Map<string, number>(), last: new Map<string, number>(), held: new Set<string>() }

async function writingProject<T>(projectId: string, refresh: () => void, run: () => Promise<T>): Promise<T> {
  const w = projectWrites
  w.flying.set(projectId, (w.flying.get(projectId) ?? 0) + 1)
  w.last.set(projectId, ++w.clock)
  try {
    return await run()
  } finally {
    const left = (w.flying.get(projectId) ?? 1) - 1
    if (left) w.flying.set(projectId, left)
    else w.flying.delete(projectId)
    w.last.set(projectId, ++w.clock)
    // A read withheld this project's value meanwhile: the host's value, with this write in it, is read now
    if (!left && w.held.delete(projectId)) refresh()
  }
}

/**
 * One read of the project list, taken over the rows already listed. New projects join at the end; a listed row keeps
 * its place and takes the host's value of the settings another client can change (trust, commands, worktree setup,
 * defaults: #719) and keeps its object when none of them differs. `git` is left alone: it has its own refresh, and a
 * list read does not carry the freshest count. A project this window is writing is left as it is (`projectWrites`).
 * @returns whether a project had to be skipped after its write was already done, so one more read is due
 */
async function readProjects(platform: NonNullable<AppState['platform']>): Promise<boolean> {
  const began = projectWrites.clock
  const list = await platform.projects.list().catch(() => null)
  if (!list) return false
  let again = false
  useStore.setState((s) => {
    const next = { ...s.projects }
    let changed = false
    for (const p of list) {
      const cur = s.projects[p.id]
      if (!cur) {
        next[p.id] = p
        changed = true
      } else if (PROJECT_SETTING_KEYS.some((k) => JSON.stringify(cur[k]) !== JSON.stringify(p[k]))) {
        if (projectWrites.flying.has(p.id)) projectWrites.held.add(p.id)
        else if ((projectWrites.last.get(p.id) ?? 0) > began) again = true
        else {
          next[p.id] = { ...cur, ...Object.fromEntries(PROJECT_SETTING_KEYS.map((k) => [k, p[k]])) }
          changed = true
        }
      }
    }
    return changed ? { projects: next } : {}
  })
  return again
}

/** The one project list read at a time: a second ask waits for the first and reads once more, so reads never land out of order */
let projectsReading: { platform: unknown; done: Promise<void>; again: boolean } | null = null

function joinProject(s: Pick<AppState, 'projects' | 'trustAsk'>, p: ProjectInfo): Pick<AppState, 'projects' | 'trustAsk'> {
  return { projects: { ...s.projects, [p.id]: p }, trustAsk: p.trusted ? s.trustAsk : p.id }
}

export function handoffPrompt(): string {
  return `You are about to be replaced by a fresh session that starts with no memory of this conversation. Write a handoff note for your successor. Your final message in this turn is the note: the app saves that message to a file and hands the file to your successor. Do not write the note to a file yourself, and do not add a preamble or a closing line around it — whatever your final message says is the note.

The note is the only thing your successor receives, so make it self-contained — never reference "the conversation above". It is saved as a file, not read as a chat message: **length is not a constraint**. Write with the density of a compaction summary, not the brevity of a reply — when in doubt, include it. If your context contains compaction summaries of earlier phases, transcribe their operational content (state, decisions, tips, conventions) rather than re-summarizing it — every re-summarization loses another layer.

Cover, in this order:
1. Project & goal — what this project is and what we are working toward.
2. Current state — what is done, what is mid-flight, and the exact state of unfinished work (files, branches, commands to resume).
3. Decisions & why — choices already made, with the reasons and evidence, so your successor does not relitigate them.
4. Next steps — what should happen next, in priority order.
5. Tips & pitfalls — this section evaporates first in handoffs, so be exhaustive, not selective: every practical trick, workaround, non-obvious command, environment quirk, mistake already made, dead end, and thing that looks right but is wrong. A tip that feels too small to mention is exactly the one to write down. If earlier parts of this conversation were compacted into summaries, carry forward every lesson those summaries mention — do not let them die with this session.
6. Working with the user — the language the user speaks, their tone, the response style they prefer, and standing instructions or conventions (build commands, commit style, things never to do).

Write the note itself in the language the user has mostly used in this conversation.`
}

/** The number of lines and characters carried in the preview — just enough to tell what happened, not enough to carry the note itself */
const PREVIEW_LINES = 10
const PREVIEW_CHARS = 700

/** The note's opening lines — blank lines are skipped (markdown notes commonly start with one) */
function notePreview(note: string): string {
  const lines: string[] = []
  for (const line of note.split('\n')) {
    if (!line.trim() && lines.length === 0) continue
    lines.push(line)
    if (lines.length >= PREVIEW_LINES) break
  }
  const head = lines.join('\n').slice(0, PREVIEW_CHARS)
  return head.length < note.trim().length ? `${head.trimEnd()}\n…` : head
}

/**
 * The successor's first message (#102) — **hands over the note's location, not the note itself.**
 *
 * The full note used to be the first message verbatim. But the prompt above tells the predecessor
 * "it is a file, so length is not a constraint" — the longer the note, the more thorough it is, and
 * the more thorough it is, the larger the single message the successor received grew (measured: handing
 * a long session off to codex produced an error the moment it arrived). The file is already sitting
 * where the host placed it, so the first message only needs to point at the path — only then does
 * length stop being a constraint in fact, not merely by declaration. That location is outside the
 * project (the data folder, #142), so the path is absolute. The host opens that folder so the
 * successor can read it without asking (Claude's additional working folder — Codex does not block
 * reading it).
 *
 * Why the preview rides along too: someone who only reads the conversation record still needs to
 * know what happened. Why it **explicitly** says reading in pieces or grepping is fine: without that
 * line, the agent reads the whole file and recreates the exact problem this design just removed.
 */
function handoffOpening(predecessor: string, note: string, path: string): string {
  return [
    `You are taking over from a session named "${predecessor}". It wrote a handoff note for you and it is on disk, outside the project folder: \`${path}\`. Read it before anything else.`,
    '',
    'The note can be long. Read it in pieces (head, tail, byte offsets) or grep it for what you need — you do not have to pull the whole file into one turn.',
    '',
    'It begins:',
    '',
    notePreview(note)
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n'),
    '',
    'Reply first with a short summary of your understanding of the current state, in the language the note uses.',
  ].join('\n')
}

/** What the header's "Update idle sessions" did (#297), in one line: how many moved, and how many were busy */
export function appliedVersionsText(restarted: number, busy: number): string {
  const sessions = (n: number) => (n === 1 ? '1 session' : `${n} sessions`)
  const keep = busy === 1 ? 'keeps its version' : 'keep their version'
  if (restarted === 0 && busy === 0) return 'Every session already runs the installed version'
  if (restarted === 0) return `Nothing restarted: ${sessions(busy)} busy ${keep} for now`
  const moved = `Restarted ${sessions(restarted)} on the installed version`
  return busy === 0 ? moved : `${moved}; ${busy} busy ${keep} for now`
}

/**
 * A machine row from the answer to `machines.add/reconnect/acceptVersions`, kept only when no `machine_status` got there
 * first (#82). The link moves on its own before the answer leaves the hub: `add` answers `connecting` while the version
 * check has already broadcast `versions_differ` (measured in e2e, the event arrived first). Writing the answer over the
 * event would leave the row saying connecting until the next change, which for a held link never comes.
 */
function withAnswered(machines: Record<string, MachineInfo>, m: MachineInfo): Record<string, MachineInfo> {
  return machines[m.id] ? machines : { ...machines, [m.id]: m }
}

/**
 * What the composer's text becomes relative to an open question (#125, #174) — the composer's hint
 * text and `send` use **the same decision**. While the two were decided separately (the hint
 * text did not look at attachments), a person who attached a file was told to "write an answer," and
 * the text went to a new turn instead.
 *
 *  - `answer`: exactly one question, and no attachments — the text is that question's answer.
 *  - `drops`: a question is open but the text cannot be its answer. When one request has several
 *    questions, the card requires all of them answered, and a single line of text cannot say which
 *    one it answers, nor does an answer have room for an attachment. Sending it starts a new turn and
 *    the question is dropped.
 *  - `none`: no open question.
 */
export function composerTarget(open: SessionSummary['pendingQuestions'], hasAttachments: boolean): 'answer' | 'drops' | 'none' {
  if (open.length === 0) return 'none'
  return open.length === 1 && open[0]!.questions.length === 1 && !hasAttachments ? 'answer' : 'drops'
}

/** A line left in the conversation for a question dropped by a new turn (#174) */
export function droppedQuestionsText(questions: string[]): string {
  const quoted = questions.map((q) => `"${q}"`).join(', ')
  return questions.length === 1
    ? `Question dropped — this message started a new turn instead of answering ${quoted}`
    : `Questions dropped — this message started a new turn instead of answering ${quoted}`
}

/**
 * The card that blocks asking the agent for a handoff note (#174) — `null` if there is none. The
 * store's `handoffSession` and the sidebar's confirmation window use the same decision.
 */
export function handoffBlockedBy(s: Pick<SessionSummary, 'pendingQuestions' | 'pendingApproval'>): 'question' | 'approval' | null {
  if (s.pendingQuestions.length > 0) return 'question'
  if (s.pendingApproval) return 'approval'
  return null
}

/** A message of unknown send status (#173) — bubble render key → what is needed to undo it. Cleared against the store after reconnecting */
type UnsureSend = { sessionId: string; text: string; attachments?: ChatAttachment[]; prevState?: SessionSummary['state']; prevInterruption?: SessionSummary['interruption'] }
const unsureSends = new Map<number, UnsureSend>()

/**
 * Undoes a message that failed to send — removes the bubble, returns the written text and
 * attachments to the composer, and returns "working" to its previous state.
 *
 * The written text goes back to the composer. The composer is cleared the instant a message is sent
 * (#38), so merely removing the bubble leaves the sentence **nowhere at all** — a toast reports the
 * failure but does not give the text back. If new text was written before the failure arrived, it is
 * not overwritten but prepended in front of it: in order, the failed message was written first.
 */
function unsend(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  u: UnsureSend & { seq: number },
  reason: string,
): void {
  set((s) => {
    const sessions =
      s.sessions[u.sessionId] && u.prevState
        ? { ...s.sessions, [u.sessionId]: { ...s.sessions[u.sessionId]!, state: u.prevState, interruption: u.prevInterruption ?? null } }
        : s.sessions
    const drafts = draftsWith(s.drafts, u.sessionId, u.text, u.attachments)
    return {
      chat: { ...s.chat, [u.sessionId]: (s.chat[u.sessionId] ?? []).filter((i) => i.seq !== u.seq) },
      drafts,
      // Nothing is left to wait for, so the "working" indicator comes down too
      sessions,
      // ...and the clock we started above stops with it, so a later turn cannot inherit it
      workingSince: trackWorkingSince(s.workingSince, sessions, Date.now()),
      toast: `Could not send: ${reason}`,
    }
  })
}

/** Prepends unsent text and attachments to that session's draft — text written in the meantime is not overwritten (in order, the failed message came first) */
function draftsWith(drafts: Record<string, Draft>, sessionId: string, text: string, attachments?: ChatAttachment[]): Record<string, Draft> {
  const cur = drafts[sessionId] ?? EMPTY_DRAFT
  return {
    ...drafts,
    [sessionId]: {
      text: cur.text ? `${text}\n${cur.text}` : text,
      attachments: [...(attachments ?? []), ...cur.attachments],
    },
  }
}

function restoreDraft(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  sessionId: string,
  text: string,
  attachments?: ChatAttachment[],
): void {
  set((s) => (s.sessions[sessionId] ? { drafts: draftsWith(s.drafts, sessionId, text, attachments) } : {}))
}

/**
 * Resolves messages of unknown send status after reconnecting (#173). Merging in the store's latest
 * page (`mergePage`) settles a message the host received into the stored row for that same sentence
 * — reconnect replay may already have confirmed it via `user_message` first. If it is still pending
 * even so, the host never received it, and it is undone at that point. It is also undone if history
 * could not be read at all — a message that could not be confirmed cannot be treated as sent.
 *
 * The remaining gap: if the host is in the middle of reviving a sleeping session and has not yet
 * stored the message, it arrives only after this has already undone it here.
 */
async function settleUnsureSends(get: () => AppState, set: (fn: (s: AppState) => Partial<AppState>) => void): Promise<void> {
  const mine = [...unsureSends].filter(([, u]) => get().sessions[u.sessionId])
  for (const [seq] of [...unsureSends]) if (!mine.some(([s]) => s === seq)) unsureSends.delete(seq)
  for (const id of new Set(mine.map(([, u]) => u.sessionId))) await get().loadHistory(id)
  for (const [seq, u] of mine) {
    unsureSends.delete(seq)
    const item = get().chat[u.sessionId]?.find((i) => i.seq === seq)
    if (item?.kind === 'user' && item.pending) unsend(set, { ...u, seq }, 'Connection lost')
  }
}

/**
 * Sets a new session's conversation to its opening prompt (#172) — **never overwrites.**
 *
 * The host broadcasts `session_created`, `handoff` and `user_message`, in that order, before the
 * response — the screen registers the session from the first one, so the other two are already
 * attached to this conversation by the time the response arrives. This used to overwrite the
 * conversation with a single pending opening prompt when the response came in, which erased the
 * handoff marker, and left behind a pending row whose confirming event had already passed, so the
 * same prompt appeared twice when history was later read. If the same sentence is already attached,
 * nothing new is set; if not, it is appended after what is there (an event arriving after the
 * response then confirms this row).
 */
function withOpeningPrompt(chat: Record<string, ChatItem[]>, id: string, text: string): Record<string, ChatItem[]> {
  const have = chat[id] ?? []
  if (have.some((it) => it.kind === 'user' && it.text === text)) return chat
  return { ...chat, [id]: [...have, { kind: 'user', seq: nextChatKey(), text, pending: true }] }
}

/** The attachment size cap. Above this, the app visibly freezes both during the base64 conversion and the WS send */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * Bytes → base64.
 *
 * Appending one character at a time (`binary += String.fromCharCode(b)`) rebuilds the string from
 * scratch every time, freezing the app for tens of seconds even for a single screenshot (a few MB)
 * — the screen looks as if nothing is happening. This was in fact the reported symptom "file
 * attachment does not work." Processed in chunks instead.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)))
  }
  return btoa(parts.join(''))
}

/** Makes a second search for the same row a new navigation request. */
let searchTargetAt = 0

/** The newest save of the folded groups (#666): an older one that fails must not undo what a later one is saving */
let foldSaveSeq = 0

/**
 * How long a project's git refresh waits for the next trigger before it runs (issue #41).
 *
 * The triggers arrive in bursts, not singly: three sessions in one project finishing
 * seconds apart, an approval granted and the turn it unblocked ending right after, a
 * focus and a visibilitychange for one alt-tab. Each of those would otherwise be its own
 * `git status` over the same working tree. One trailing window per project collapses a
 * burst into one measurement, and it has to be short enough that the number has already
 * moved by the time the eye goes looking for it — 800ms is under the glance.
 *
 * The delay also puts the measurement *after* the write it was told about, which matters
 * for the approval trigger: the edit lands in the moment following the "allow", not in it.
 */
const GIT_REFRESH_MS = 800

/**
 * Pending git refreshes, one timer per project — module scope for the same reason
 * `subscriptions` is: nothing on screen reads a timer, so keeping it out of the store
 * costs no renders.
 */
const gitRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Whether two git summaries say the same thing — a refresh that found nothing must not redraw */
function sameGit(a: ProjectInfo['git'], b: ProjectInfo['git']): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.branch === b.branch &&
    a.changedFiles === b.changedFiles &&
    a.isRepo === b.isRepo &&
    a.denied === b.denied
  )
}

/**
 * Which tools the Usage modal should report on — deduplicated, in screen order (#26).
 *
 * Usage is an **account** property that differs per tool, so the only honest question is
 * "which tools are on screen right now". The old picker asked a narrower one — *the*
 * focused session's tool, then the project default, then a hardcoded `'claude'` — and
 * that question has no answer in the grid: `focusedSessionId` does not name one of nine
 * panels, so a grid of Codex agents fell through to Claude's limits with nothing on
 * screen saying a substitution had happened.
 *
 * Deduplicated because usage belongs to the account, not the session: two Claude panels
 * share one number, and printing it twice would suggest they are two separate budgets.
 *
 * **An empty result is a real result.** The `'claude'` fallback is gone — it turned
 * "we cannot tell" into "here is the wrong tool", which is the failure the caller has no
 * way to detect. The modal says it does not know instead.
 */
export function usageTools(s: AppState): ToolName[] {
  const out: ToolName[] = []
  const add = (t: ToolName | undefined) => {
    if (t && !out.includes(t)) out.push(t)
  }

  // The grid is the case where "the session you are looking at" is not singular
  if (s.view === 'grid') {
    for (const id of gridSessionIds(s.gridPanels)) add(s.sessions[id]?.tool)
    return out
  }

  // Focus (and the orchestrator) still look at one conversation — unchanged behaviour
  const session = s.focusedSessionId ? s.sessions[s.focusedSessionId] : undefined
  if (session) return [session.tool]
  add(s.focusedProjectId ? (s.projects[s.focusedProjectId]?.defaultTool ?? undefined) : undefined)
  return out
}

/**
 * True while `attach` restores the workspace snapshot. `saveWorkspace` does nothing then.
 *
 * The restore goes through the same setters a person uses (`focusSession`, `setPanelWidth`,
 * `setSidebarWidth`, `openOrchestrator`), and each of them saves. A save in the middle of the restore writes
 * the half-restored state back over the snapshot being read, so every field restored after that save is
 * stored as its default, and the next launch reads the default. It hit the folded projects (#205) and
 * `introSeen` (#63), each fixed by restoring that one field earlier, and then the spinning-marker
 * settings, which are restored last: the person turned both off, and after the machine restarted both
 * were on again (2026-09-30, on the real store: the snapshot held `false` for both at 06:18 and `true`
 * after the restart, with every other field unchanged). Reordering fixes one field at a time; not saving
 * while restoring fixes the class.
 */
let restoringWorkspace = false

/**
 * The waits before reading again what a reconnect has to re-read (the session list, a conversation page) when the
 * read fails. Same steps as a failed workspace save: a host that fails every read is not helped by being asked
 * forever, and the next reconnect or opening the conversation reads again.
 */
const RECOVERY_RETRY_MS = [1_000, 5_000, 30_000] as const

/** Bumped by every reconnect recovery, so the retries of an older one stop once a newer one runs */
let recoveryGeneration = 0

/**
 * The latest workspace snapshot the host has not confirmed storing, and the one writer that sends it.
 *
 * A save used to be sent once and a failure swallowed (`.catch(() => {})`). On 2026-09-30 the machine
 * froze for hours; the person folded every project during that time, every save timed out (an RPC gives
 * up after 30 s), and after a restart the folds were gone because the stored snapshot never got them.
 * Now a failed save stays pending and goes out again: when the connection comes back, and after a short
 * backoff while connected.
 *
 * Only the **latest** snapshot is ever sent, and only one save is in flight at a time. A newer save
 * replaces the pending one instead of queueing behind it, so a retry can never write an older
 * arrangement over a newer one, and while a save is in flight the next one waits for it rather than
 * racing it.
 */
const workspaceSave = {
  pending: null as WorkspaceSnapshot | null,
  inFlight: false,
  retryTimer: null as ReturnType<typeof setTimeout> | null,
  /** Which step of `WORKSPACE_RETRY_MS` the next retry waits for. Reset by a stored save or a reconnect */
  attempt: 0,
  /** Bumped by a reset, so a save still settling from before it cannot touch the state after it */
  epoch: 0,
}

/**
 * The waits before retrying a failed save while connected. Past the last step it stops, and the
 * pending snapshot waits for the next reconnect or the next save: a host that fails every save is
 * not helped by being asked every 30 s forever.
 */
const WORKSPACE_RETRY_MS = [1_000, 5_000, 30_000] as const

function clearWorkspaceRetry(): void {
  if (workspaceSave.retryTimer) clearTimeout(workspaceSave.retryTimer)
  workspaceSave.retryTimer = null
}

/** Forgets any pending save. A new platform starts from its own stored snapshot, not the last one's leftovers */
function resetWorkspaceSave(): void {
  clearWorkspaceRetry()
  workspaceSave.pending = null
  workspaceSave.inFlight = false
  workspaceSave.attempt = 0
  workspaceSave.epoch++
}

/** Sends the pending snapshot unless one is already on its way (that one sends the newer when it settles) */
function flushWorkspace(get: () => AppState): void {
  if (restoringWorkspace || workspaceSave.inFlight) return
  const platform = get().platform
  const snap = workspaceSave.pending
  if (!platform || !snap) return
  clearWorkspaceRetry()
  workspaceSave.inFlight = true
  const epoch = workspaceSave.epoch
  platform.workspace.save(snap).then(
    () => {
      if (workspaceSave.epoch !== epoch) return // attach started over; this save belongs to before it
      workspaceSave.inFlight = false
      if (workspaceSave.pending === snap) {
        workspaceSave.pending = null
        workspaceSave.attempt = 0
      } else flushWorkspace(get) // A newer save came in meanwhile
    },
    () => {
      if (workspaceSave.epoch !== epoch) return
      workspaceSave.inFlight = false
      // A newer save came in meanwhile: it supersedes this one and goes now
      if (workspaceSave.pending !== snap) return flushWorkspace(get)
      // Disconnected: the reconnect sends it. Out of steps: the next reconnect or save does
      if (get().connection !== 'connected') return
      const wait = WORKSPACE_RETRY_MS[workspaceSave.attempt]
      if (wait === undefined) return
      workspaceSave.attempt++
      workspaceSave.retryTimer = setTimeout(() => {
        workspaceSave.retryTimer = null
        flushWorkspace(get)
      }, wait)
    },
  )
}

export const useStore = create<AppState>((set, get) => ({
  platform: null,
  connection: 'connecting',
  hostResyncs: 0,
  projects: {},
  gitEpoch: {},
  sessions: {},
  tools: [] as ToolStatus[],
  chat: {},
  drafts: {},
  stickToBottom: {},
  scrollAnchor: {},
  searchTargets: {},
  workingSince: {},
  expandedDirs: {},
  showIgnored: true,
  // Defaults to folded — the reason this feature exists at all is that a two-row grid leaves little room to read
  foldComposer: true,
  focusedSessionId: null,
  focusedProjectId: null,
  newSessionFor: null,
  newSessionWorktree: false,
  newSessionBranch: '',
  worktreeProposals: [],
  mcpProposals: [] as { name: string; command: string; args: string[]; why?: string }[],
  externalAppChanges: {},
  externalAppRunChanges: {},
  externalAppChangedBy: {},
  externalApps: [] as ExternalAppInfo[],
  themeFiles: [] as ThemeFileEntry[],
  lastGoodThemes: {} as Record<string, ThemeFileEntry>,
  appQuestions: [] as AppQuestion[],
  appQuestionsVersion: 0,
  projectConsentsVersion: 0,
  skillProposals: [] as { name: string; content: string; why?: string }[],
  history: {},
  subagentSteps: {},
  resuming: {},
  wakeError: {},
  wakeLocked: {},
  panelOpen: true,
  panelLayout: defaultLayout(),
  view: 'focus' as 'focus' | 'grid' | 'orchestrator' | 'app',
  focusedApp: null as { projectId: string | null; appId: string; machine?: string | null } | null,
  nav: EMPTY_NAV,
  pinnedViews: [] as PinnedView[],
  inlineViews: {} as Record<string, Record<string, InlineView>>,
  inlineFramesVersion: 0,
  gridPanels: [] as GridPanel[],
  builderPaneSessionId: null,
  builderPaneFor: null as string | null,
  orchestratorId: null as string | null,
  orchestratorWaking: false,
  introSeen: false,
  trustAsk: null as string | null,
  panelSplit: 0.5,
  panelWidth: PANEL_DEFAULT,
  sidebarWidth: SIDEBAR_DEFAULT,
  foldedProjects: [],
  projectPanels: {} as Record<string, ProjectArrangement>,
  appSpans: {} as Record<string, GridSpan>,
  commandRuns: {} as Record<string, Record<string, CommandRunInfo>>,
  overlay: null,
  inboxOpen: false,
  toast: null,
  appFocused: true,
  completion: null as { sessionId: string; at: number } | null,
  notices: [] as Notice[],
  viewerPath: null,
  viewerProjectId: null,
  paletteOpen: false,
  openLayers: 0,
  approvalsInFlight: {} as Record<string, true>,
  uploading: {} as Record<string, number>,
  settingsMenuRequest: null as { sessionId: string; at: number } | null,
  composerFocusFor: null as string | null,
  usageOpen: false,
  settingsOpen: false,
  notifyPolicy: DEFAULT_NOTIFY_POLICY,
  importDialog: null as { source: string; fromLink: boolean; at: number } | null,
  update: null,
  agentVersions: null,
  sleepPolicy: null,
  machines: {} as Record<string, MachineInfo>,
  machineAgentVersions: {} as Record<string, AgentVersions>,
  settingsRequest: null as { category: string; at: number } | null,
  prefs: DEFAULT_UI_PREFERENCES,

  async attach(platform) {
    /*
     * **Detach the previous subscription first.**
     *
     * A subscription is a **fresh closure** every time, so putting it in a Set never deduplicates
     * it. If `attach` runs twice, the same event is applied twice; three times, three times — the
     * screen shows text multiplied as is, arriving letter-duplicated like "호호스트가스트가" ("the
     * host is" with syllables doubled and overlapping) (this happened during dogfooding, once at ×3
     * and once at ×2).
     *
     * Streaming deltas are **cumulative**, which makes this failure mode especially bad: once it
     * goes wrong once, everything after it piles up wrong too. `attach` is built so calling it at any
     * time lands in the same state (idempotent).
     */
    detachAll()
    resetWorkspaceSave()
    set({ platform })
    subscriptions.push(
      platform.agents.subscribe((e) => get().dispatchEvent(e)),
      platform.agents.onConnectionChange((connection) => {
        const was = get().connection
        /*
         * resync_required: the connection itself is alive, but the host could not resend the
         * events that happened while it was disconnected (they fell outside the resend buffer).
         *
         * While nothing consumed this signal, two things went wrong: missed events were never
         * recovered, and the label logic drew anything other than `connected` as 'Disconnected',
         * so it **showed disconnected while actually connected**. The label is kept at `connected`,
         * and the gap is filled by a full resync (merging the session list and re-reading the
         * conversation being viewed).
         */
        const resync = connection === 'resync_required'
        if (resync) set({ connection: 'connected', hostResyncs: get().hostResyncs + 1 })
        else set({ connection })
        /*
         * Disconnected and came back. The web client says `connected` before `resync_required`, but the port does
         * not promise that order: a resync that is the first word after a drop is a reconnect too, and must not
         * skip what a reconnect does.
         */
        if ((connection === 'connected' || resync) && was !== 'connected') {
          // A save that failed while the host was away goes out now, with a fresh set of retries
          workspaceSave.attempt = 0
          flushWorkspace(get)
          // A new host (a restart, a switched build) read the installed CLIs before this window was back (#297)
          void get().checkAgentVersions(false)
          // Revive sessions that were running; a resync's own recovery below does that and more
          if (!resync) void get().recoverAfterReconnect()
        }
        if (resync) void get().recoverAfterReconnect(true)
      }),
      /*
       * A command run's outcome (#60) — `runId` rides in the `terminalId` slot. A shell terminal's
       * exit has no matching id in `commandRuns`, so it is silently ignored. Why this is listened
       * for here rather than in a screen component: the badge must turn off even when the window
       * that was showing the log is closed.
       */
      platform.terminal.onExit((e) => {
        set((s) => {
          for (const [pid, runs] of Object.entries(s.commandRuns)) {
            for (const [cmd, r] of Object.entries(runs)) {
              if (r.runId !== e.terminalId || !r.running) continue
              return {
                commandRuns: {
                  ...s.commandRuns,
                  [pid]: { ...runs, [cmd]: { ...r, running: false, exitCode: e.exitCode } },
                },
              }
            }
          }
          return {}
        })
      }),
    )

    const asked = get().sessions
    const watch = watchLiveEvents()
    const [projects, sessions, gridPanels, tools, prefs, externalApps, themeFiles, machines] = await Promise.all([
      platform.projects.list(),
      platform.agents.listSessions(),
      // The app must come up even if the layout cannot be read — the grid just looks empty
      // Sanitized: a host from before apps could stand on the grid answers bare session ids, which still read as sessions
      platform.agents.grid().then(sanitizeGridPanels).catch(() => [] as GridPanel[]),
      // Same reason: the tool list must not block the app either — if it cannot be read, only names show, with no label
      platform.agents.detect().catch(() => [] as ToolStatus[]),
      /*
        The screen settings must **never arrive later than the first screen.**

        Unlike something that is fine arriving late (like an update check), this value decides how
        the composer reads Enter. Arriving late means the send key changes while the person is
        already typing, and that mistake cannot be undone — the message is already gone.

        Even so, it must **never block**: if it cannot be read, use the default. An app that cannot
        come up because of one setting is far worse than whatever that setting does.
      */
      // Read through the schema, field by field: an older host answers without the fields it does not know
      platform.prefs.load().then(parseUiPreferences, () => DEFAULT_UI_PREFERENCES),
      // The external app list (A-8) also arrives with the first screen — so the sidebar's app rows
      // do not pop in late. The app still comes up if it cannot be read: the app rows just look
      // empty, and the next broadcast re-reads them
      platform.apps.list().catch(() => [] as ExternalAppInfo[]),
      // The theme files arrive with the preferences that choose among them, so the first screen
      // already has its theme — and a folder that cannot be read just means the presets
      platform.themes.list().catch(() => [] as ThemeFileEntry[]),
      // The linked machines (#82) name the sidebar's groups, so they come with the lists they group. A host from before them has none
      platform.machines.list().catch(() => [] as MachineInfo[]),
    ]).finally(watch.stop)
    set((st) => {
      // Recovery or re-attachment may have updated the window while startup reads were pending (#640).
      const { sessions: known } = mergeListedSince(asked, st.sessions, sessions, watch.touched)
      return {
        projects: Object.fromEntries(projects.map((p) => [p.id, p])),
        sessions: known,
        // A session can already be mid-turn when we arrive; stamp it now so the elapsed
        // line has an instant to count from instead of its own mount (issue #23)
        workingSince: trackWorkingSince(st.workingSince, known, Date.now()),
        gridPanels,
        tools,
        prefs,
        externalApps,
        themeFiles,
        lastGoodThemes: goodThemes(st.lastGoodThemes, themeFiles),
        machines: Object.fromEntries(machines.map((m) => [m.id, m])),
        connection: 'connected',
      }
    })

    // Replay events that arrived before the list was registered — the first output of a session that
    // was already running before the app was even opened is held here
    replayPendingEvents(get)
    get().pruneFoldedGroups()

    // A suggestion awaiting approval stays on the host even across the app being closed and reopened
    // — its card must reappear
    void get().refreshMcpProposals()
    // Capability questions also survive on the host (M4 D-4) — an app's call waiting for an answer hangs there
    void get().refreshAppQuestions()
    void get().refreshSkillProposals()

    /*
     * Catches up on what the host already knows (issue #43).
     *
     * **Does not wait.** If the app came up late because of a version check, the order is backwards.
     * `force: false` means this usually just receives the host's cache, but when nothing is known
     * yet, it can end up waiting on the network — those few seconds must never stand in front of the
     * screen.
     *
     * Why a subscription alone is not enough: the host's first check happens right at startup, which
     * finishes before this window even attaches. The broadcast has already passed by then, so
     * whoever arrives late has to ask once for itself.
     */
    void get().checkUpdate(false)
    // The installed agent CLIs (#297), for the same reason: the host read them before this window attached
    void get().checkAgentVersions(false)

    // Come back to where you were (C-3). A session that no longer exists is quietly skipped.
    restoringWorkspace = true
    let migratedProjectPanels = false
    try {
      const snap = await platform.workspace.load()
      if (snap) {
        /*
         * Folded projects are restored **first of all** (#205). `focusSession` right below this
         * calls `saveWorkspace`, and if this value is still its initial state ([]) at that point, it
         * writes an empty list back over the snapshot just read, erasing the fold — the same thing
         * that happens to `introSeen` (see the comment below). Anything that is not a string is
         * discarded. (Saves are now held off for the whole restore, `restoringWorkspace`, so this order
         * is no longer what protects the fold.)
         */
        const savedFolds = (snap as { foldedProjects?: unknown }).foldedProjects
        if (Array.isArray(savedFolds)) {
          set({ foldedProjects: savedFolds.filter((id): id is string => typeof id === 'string') })
        }
        // The project screens' arrangements (#203), first for the same reason as the fold above
        const arrangements = sanitizeArrangements((snap as { projectPanels?: unknown }).projectPanels)
        set({
          projectPanels: Object.fromEntries(Object.entries(arrangements).map(([pid, saved]) => {
            const present = [
              ...Object.values(get().sessions).filter((s) => s.projectId === pid).map((s) => sessionPanelId(s.id)),
              ...get().externalApps.filter((a) => a.projectId === pid)
                .sort((a, b) => (a.name ?? a.appId).localeCompare(b.name ?? b.appId) || a.appId.localeCompare(b.appId))
                .map((a) => appPanelId(a.appId)),
            ]
            return [pid, migrateArrangement(present, saved)]
          })),
        })
        // The person's span per app (#306). A snapshot from before it has none; an entry that is not a span is dropped
        const savedSpans = (snap as { appSpans?: unknown }).appSpans
        if (savedSpans && typeof savedSpans === 'object' && !Array.isArray(savedSpans)) {
          const spans: Record<string, GridSpan> = {}
          for (const [key, raw] of Object.entries(savedSpans)) {
            const span = sanitizeGridSpan(raw)
            if (span) spans[key] = span
          }
          set({ appSpans: spans })
        }
        if (snap.focusedSessionId && get().sessions[snap.focusedSessionId]) {
          /*
           * Reviving a session never unfolds it (#205). If the app was closed with the session's
           * project folded, that fold was left deliberately by the person too — unfolding it would
           * have this erase the remembered fold on every restart.
           */
          get().focusSession(snap.focusedSessionId, { reveal: false })
        }
        /*
         * The view comes back *after* the session, on purpose: focusSession forces
         * view:'focus' (selecting a session must show it), so restoring in the other
         * order would have the session restore quietly undo the view restore — the
         * exact bug being fixed, reintroduced by ordering.
         *
         * The orchestrator goes through its own door (openOrchestrator) rather than a
         * bare set: the view alone would be a "Waking the orchestrator…" screen that
         * nothing is actually waking.
         */
        /*
         * `introSeen` is restored **before** `view` (#63). `openOrchestrator` below calls
         * `saveWorkspace`, and if `introSeen` is still its initial state (`false`) at that point, it
         * writes `false` back over the snapshot just read, erasing the stored value — the next launch
         * showed the intro screen again (measured: a partial save mid-restore clobbers whichever
         * field is restored last). That class is now closed by `restoringWorkspace`.
         */
        if ((snap as { introSeen?: boolean }).introSeen === true) set({ introSeen: true })
        const savedView = (snap as { view?: unknown }).view
        if (savedView === 'grid') set({ view: 'grid' })
        else if (savedView === 'orchestrator') void get().openOrchestrator()
        else if (savedView === 'app') {
          /*
           * The app that was being viewed as a pinned view (B-2). The list is already loaded from
           * the first snapshot above — if the app no longer exists (its folder disappeared, its
           * project was deleted), it is not restored and the focus view is left as is. Opening it
           * has the host call `home`: what comes back to that spot is a single app process.
           */
          const app = snap.focusedApp
          if (app && get().externalApps.some((a) => isApp(a, app.projectId, app.appId, app.machine))) {
            get().openApp(app.projectId, app.appId, { machine: app.machine })
          }
        }
        /*
         * Layout prefs come back even when the focused session is gone (#20). They used
         * to sit inside the session check above, so a snapshot whose session had been
         * deleted threw the whole arrangement away with it — but the panel's shape is a
         * fact about the person, not about any session. (The legacy `snap.tab` field is
         * still ignored: that tab structure was replaced by the three lanes.)
         */
        if (typeof snap.panelOpen === 'boolean') set({ panelOpen: snap.panelOpen })
        /*
         * The arrangement survives restart, globally (#20 decision). `panelLayout` is
         * the arrangement; `panelTab` is the pre-#20 single-tab field, kept as the
         * fallback so a snapshot written before the arrangement existed still restores
         * the tab that was showing.
         */
        const savedLayout = (snap as { panelLayout?: unknown }).panelLayout
        if (savedLayout != null) {
          set({ panelLayout: sanitizeLayout(savedLayout) })
          // The split ratio is also part of the arrangement — it comes back alongside the arrangement itself
          const savedSplit = (snap as { panelSplit?: unknown }).panelSplit
          if (typeof savedSplit === 'number' && Number.isFinite(savedSplit)) {
            get().setPanelSplit(savedSplit)
          }
        } else if (
          snap.panelTab === 'files' ||
          snap.panelTab === 'git' ||
          snap.panelTab === 'history' ||
          snap.panelTab === 'terminal'
        ) {
          set({ panelLayout: activateTab(defaultLayout(), snap.panelTab) })
        }
        if (typeof snap.panelWidth === 'number') get().setPanelWidth(snap.panelWidth)
        if (typeof snap.sidebarWidth === 'number') get().setSidebarWidth(snap.sidebarWidth)
        const savedPolicy = (snap as { notifyPolicy?: unknown }).notifyPolicy
        if (savedPolicy != null) set({ notifyPolicy: readNotifyPolicy(savedPolicy) })
        // Whether the tree shows ignored files is a way of looking, so it comes back with
        // the rest of the panel's layout rather than being re-chosen every launch (#17).
        //
        // The `typeof` guard is what lets the default move. Reading the field as a plain
        // falsy check would make "never wrote one" indistinguishable from "turned it off",
        // and flipping the default to on would then quietly turn it back on for the one
        // person who had deliberately turned it off. An absent field takes the new default;
        // a stored `false` is a decision and outranks it.
        const savedIgnored = (snap as { showIgnored?: boolean }).showIgnored
        if (typeof savedIgnored === 'boolean') set({ showIgnored: savedIgnored })
        // The text size used to be restored here too; it is a preference now (UiPreferences.textSize),
        // and the host moved the snapshot's old step into it once (#312 step 5)
        // Same `typeof` guard — a stored `false` was the person's decision, and outranks the default
        const savedFold = (snap as { foldComposer?: boolean }).foldComposer
        if (typeof savedFold === 'boolean') set({ foldComposer: savedFold })
        migratedProjectPanels = Object.values(arrangements).some((saved) => saved.panels === undefined)
      }
    } catch {
      /* The app works normally even with no snapshot */
    } finally {
      restoringWorkspace = false
    }
    // Persist migration only after the whole restore succeeds, so a restart cannot migrate newly created sessions again.
    if (migratedProjectPanels) get().saveWorkspace()
    // History starts at the screen the restore left (#374): the steps it took to get there are not the person's
    const restored = screenOf(get())
    set({ nav: restored ? { entries: [restored], index: 0 } : EMPTY_NAV })

    /*
     * The grid's sessions are not woken at startup any more (#568). They used to be, one by one, to move a slow Codex
     * resume (7-13 s for a large thread) to a moment nobody waited on; but every panel then held its process from the
     * first second, and the host puts idle sessions to sleep after 15 minutes anyway. A panel wakes when it is used:
     * its composer taking the keyboard, or a message sent to it.
     */
  },

  /**
   * Saves every time state changes — "save on exit" is helpless against a crash.
   *
   * **This must be the only place that writes the snapshot.** The host replaces the layout whole,
   * so the moment a second writer saves a partial snapshot, each erases the other's fields — this
   * actually happened, when `setNotifyPolicy` saved separately with its own list, and the notify
   * policy and history height were quietly reset by the other save. A new field has to be
   * added **to this function**.
   *
   * The snapshot is not sent from here directly: it becomes the pending one and `flushWorkspace` sends
   * it, so a save that fails is sent again rather than dropped (see `workspaceSave`).
   */
  saveWorkspace() {
    // Nothing is saved while the snapshot is being restored: see `restoringWorkspace`
    if (restoringWorkspace) return
    const s = get()
    if (!s.platform) return
    workspaceSave.pending = {
      focusedSessionId: s.focusedSessionId,
      view: s.view,
      focusedApp: s.focusedApp,
      panelOpen: s.panelOpen,
      // The single-tab field predates the arrangement (#20). It keeps carrying the
      // top group's active tab so an older build reading this snapshot still lands
      // on the tab that was showing.
      panelTab: s.panelLayout[0]?.active,
      panelLayout: s.panelLayout,
      panelSplit: s.panelSplit,
      panelWidth: s.panelWidth,
      sidebarWidth: s.sidebarWidth,
      foldedProjects: s.foldedProjects,
      projectPanels: s.projectPanels,
      appSpans: s.appSpans,
      notifyPolicy: s.notifyPolicy,
      showIgnored: s.showIgnored,
      foldComposer: s.foldComposer,
      introSeen: s.introSeen,
    } as never
    flushWorkspace(get)
  },

  setBuilderPane(sessionId) {
    if (get().builderPaneSessionId !== sessionId) set({ builderPaneSessionId: sessionId })
  },

  setAppFocused(focused) {
    /*
     * **Only the false→true edge.** `onVisibility` fires once at mount while `appFocused`
     * is already true and `attach` has just fetched every project — refreshing on every
     * call would repeat that fetch for no new information. Focus and visibilitychange also
     * both fire for a single alt-tab; the debounce would collapse those anyway, but there
     * is no reason to arm two timers to learn one thing.
     */
    const returning = focused && !get().appFocused
    set({ appFocused: focused })
    /*
     * Coming back to the window is the only signal we get for work done **outside** the app
     * (issue #41): a commit typed in a terminal, a rebase, a `git clean`. Nothing in here
     * watched it happen, so no project is more suspect than another and all of them are
     * re-measured — refreshing only the focused one would leave every other sidebar row
     * exactly as stale as before, which is the bug.
     */
    if (returning) for (const id of Object.keys(get().projects)) get().refreshProjectGit(id)
    // The same signal for an agent CLI updated in a terminal (#297): the host reads the installed versions again
    if (returning) void get().checkAgentVersions(false)
  },

  dismissNotices(sessionIds) {
    if (sessionIds.length === 0) return
    const drop = new Set(sessionIds)
    set((s) => {
      const kept = s.notices.filter((n) => !drop.has(n.sessionId))
      // Leave it as is when nothing changed — putting in a new array reruns any effect watching this
      return kept.length === s.notices.length ? {} : { notices: kept }
    })
  },

  /** Selects only the project — git, files and the viewer can be viewed without picking a session */
  focusProject(id) {
    set(() => ({
      focusedProjectId: id,
      /*
       * Picking a project **always** releases session focus — the click was made to see the project
       * screen. This used to release it only when a *different* project was picked, so clicking that
       * same project's name while already viewing one of its sessions left the session in place,
       * looking as if nothing had happened (user report 2026-09-28). The only callers are the
       * sidebar's name and the palette when it picks a project with no session — both want the
       * project screen.
       */
      focusedSessionId: null,
      // The project screen exists only in the focus lane — what the person picked must be shown (the same
      // rule as `focusSession`). This combination actually arose once onboarding started opening the
      // orchestrator view first (#63) (caught by e2e).
      view: 'focus',
      viewerPath: null,
  viewerProjectId: null,
      overlay: null,
    }))
    get().saveWorkspace()
  },

  openSearchHit(sessionId, seq) {
    const at = ++searchTargetAt
    set((s) => ({ searchTargets: { ...s.searchTargets, [sessionId]: { seq, at } } }))
    get().focusSession(sessionId, { targetSeq: seq })
  },

  clearSearchTarget(sessionId, at) {
    set((s) => {
      if (s.searchTargets[sessionId]?.at !== at) return {}
      return { searchTargets: omitKey(s.searchTargets, sessionId) }
    })
  },

  openWaiting(id, opts) {
    // A proposal's card only stands on the orchestrator's own screen, so `preferGrid` does not apply to it
    if (isProposalId(id)) void get().openOrchestrator()
    else get().focusSession(id, opts)
  },

  focusSession(id, opts) {
    const prev = get().focusedSessionId
    const projectId = id ? get().sessions[id]?.projectId : undefined
    /*
     * Picking a session **must make that session visible.**
     *
     * With the grid left open, clicking a different session in the sidebar left the screen
     * unchanged: what was picked had changed but what was visible had not, so to the person who
     * clicked, nothing appeared to happen. This lives here because there are a dozen call sites
     * (sidebar, inbox, palette, approval banner, …) — attaching it at each call site means one of
     * them eventually gets missed.
     *
     * Deselecting (`null`) leaves the view untouched, because that is not "look at this."
     */
    /*
     * **The orchestrator goes to its own screen, not 'focus'** (a dogfooding bug).
     *
     * Turning on `view: 'focus'` unconditionally here meant clicking the orchestrator from the top
     * bar's "waiting for response" list opened the orchestrator's conversation **inside the frame of
     * the session screen.** Two symptoms came from that: the right-hand evidence lane came along
     * (`App`'s `hasEvidenceLane` decides by `view` — the orchestrator has no repository to view), and
     * the sidebar's orchestrator button looked unpressed (`active` also decides by `view`).
     *
     * The fix belongs here for the same reason as the comment above: this function has a dozen call
     * sites (inbox, notification card, palette, approval banner, shortcuts, …). Even one of them
     * meeting the orchestrator reproduces the same symptom, so the decision has to live in this one
     * place, not at each caller.
     */
    // If the session is already on the grid, the grid is the destination (see the `preferGrid` comment above)
    const onGrid = !!id && !!opts?.preferGrid && gridSessionIds(get().gridPanels).includes(id)
    const orchestrator = !!id && (id === get().orchestratorId || get().sessions[id]?.kind === 'orchestrator')
    /*
     * If the picked session's project is folded, it is unfolded (#205) — a picked session must also
     * be visible in the sidebar. The inbox, palette, notification card, next-waiting (⌘⇧A) and
     * new-session all pass through this door, so the decision lives here alone (same reason as
     * `view` above: a dozen call sites).
     *
     * **What gets unfolded is remembered** — the same as if the person had unfolded it with the
     * arrow. A path that unfolds briefly and re-folds on leaving was considered and rejected. That
     * would require a second, off-screen piece of state to decide "when to fold it back," and a
     * person cannot predict that moment — a row appearing and disappearing on its own is exactly why
     * unfolding on hover was rejected too. Remembering it means the arrow always states exactly what
     * is on screen, and reopening the app returns to exactly what was last seen.
     *
     * `reveal: false` happens in exactly two places: restoring a snapshot (a fold left there was also
     * left by the person) and clicking a grid panel (the session is already visible in its panel, and
     * if typing into a panel unfolded its project every time, folding would be pointless).
     */
    const reveal =
      opts?.reveal !== false && !!projectId && get().foldedProjects.includes(projectId)
    // The same for the group the row stands in (#666): the children of its parent, the sessions of its app
    const picked = id ? get().sessions[id] : undefined
    if (picked && opts?.reveal !== false) {
      const listed = new Set(get().externalApps.map((a) => appKeyOf(a.projectId, a.appId, a.machine)))
      const hiding = foldGroupsHiding(picked, get().sessions, (x) => appKeyOf(x.projectId, x.appId!, x.machine), listed)
      const folded = get().prefs.foldedGroups
      if (hiding.some((k) => folded.includes(k))) get().setGroupsFolded(hiding, false)
    }
    // Switching sessions clears any overlay — the new session's conversation must be visible first
    set({
      focusedSessionId: id,
      overlay: null,
      // A composer asked to take the keyboard belongs to the session asked for, not the one shown now (#528)
      ...(get().composerFocusFor !== null && get().composerFocusFor !== id ? { composerFocusFor: null } : {}),
      ...(reveal ? { foldedProjects: get().foldedProjects.filter((p) => p !== projectId) } : {}),
      ...(id
        ? {
            /*
             * The orchestrator can be placed on the grid too. If clicking its panel's composer or
             * notification got hijacked into the dedicated screen, "view side by side" would break
             * immediately. `preferGrid` is only ever the explicit intent `GridView` gives, so it is
             * the only case where the grid outranks the dedicated screen. A normal pick, like from
             * the sidebar or the palette, still goes to the orchestrator's dedicated screen.
             */
            view: onGrid ? ('grid' as const) : orchestrator ? ('orchestrator' as const) : ('focus' as const),
          }
        : {}),
      ...(projectId ? { focusedProjectId: projectId } : {}),
    })
    get().saveWorkspace()

    // Messages of a session that lost focus are trimmed (docs/state-management.md §4).
    // Holding all of ten sessions × hundreds of turns each would blow the §7.1 memory target.
    // The summary (state, unread, preview) stays intact, so the sidebar and inbox remain accurate.
    if (prev && prev !== id) {
      const items = get().chat[prev]
      const trimmed = items && trimWindow(items)
      if (trimmed) {
        set((s) => ({
          chat: { ...s.chat, [prev]: trimmed.items },
          history: {
            ...s.history,
            [prev]: { oldestSeq: trimmed.oldestSeq, more: trimmed.oldestSeq > 1, loading: false },
          },
          subagentSteps: withoutClosedSteps(s.subagentSteps, prev),
        }))
      }
    }

    if (!id) return
    void get().markRead(id)
    // If the session's conversation has not been read yet, load it from storage (history survives even a host restart)
    const cur = get()
    /*
     * "Read" means **a cursor exists** (#79). Having conversation rows does not mean it was read —
     * if an event arrives before the screen does (a session the host created in the background, like
     * an app's requested agent, or an event replayed by the initial connection), only rows appear.
     *
     * Before this (09-09), such a session's cursor used to be set from the top row on screen. The
     * reasoning was that re-reading could wipe out a still-streaming message or an optimistically
     * drawn first prompt. But that number was the render key: a stored 8-line session ended up with a
     * cursor of 48, so "earlier conversation" appended the whole conversation a second time (measured
     * 2026-09-25), and whenever the key was lower than the stored number, the entire middle went
     * missing. Now that `loadHistory` merges with history rather than clearing the screen's rows
     * (`mergePage`), it is always safe to read.
     */
    if (opts?.targetSeq !== undefined) {
      // Mark the cursor as loading before the pane observes this session. Otherwise its ordinary
      // first-open read races this targeted page and lands us back at the newest message.
      const targetSeq = opts.targetSeq
      set((s) => ({ history: { ...s.history, [id]: { oldestSeq: targetSeq, more: false, loading: true } } }))
      void get().loadHistoryAt(id, targetSeq)
    } else if (!cur.history[id]) void get().loadHistory(id)
    /*
     * Selecting a session no longer wakes it (#568). Its process starts when the person sends to it or its composer takes
     * the keyboard: reading an old conversation should not start a 250 MB process that the host puts back to sleep in
     * 15 minutes. The resume this used to hide costs about 0.7 s (p50) on Claude, and it runs while the person types.
     */
  },

  async loadHistory(sessionId) {
    const platform = get().platform
    if (!platform) return
    /*
     * A page that fails to arrive is asked for again (`RECOVERY_RETRY_MS`), and meanwhile the cursor is dropped.
     * Swallowing the failure left a re-read's gap for good: a resync re-reads sessions that already hold a cursor,
     * and a cursor is what tells the screen and `focusSession` the conversation was read, so nothing read it again
     * until the app was reopened. Without the cursor, opening the conversation reads it again too.
     */
    let msgs: StoredMessage[]
    for (let attempt = 0; ; attempt++) {
      const held = get().history[sessionId]
      try {
        msgs = await platform.agents.loadMessages(sessionId, HISTORY_PAGE)
        break
      } catch {
        // A cursor some other read set meanwhile is a successful read, and stays
        set((s) => {
          if (!held || s.history[sessionId] !== held) return {}
          const { [sessionId]: _dropped, ...history } = s.history
          return { history }
        })
        const wait = RECOVERY_RETRY_MS[attempt]
        // Even if history fails to load, a new conversation is still possible, so the last failure is not shown
        if (wait === undefined) return
        await new Promise((r) => setTimeout(r, wait))
        if (get().platform !== platform || !get().sessions[sessionId]) return
      }
    }
    try {
      const items = messagesToChat(msgs)
      bumpChatKeysAbove(items)
      set((s) => {
        /*
         * Screen rows are merged with history, never discarded (#79, `mergePage`). This used to
         * discard the page whenever rows existed on screen — setting the cursor from the discarded
         * page. Re-reads (catching up on a conversation continued elsewhere, filling a gap) go
         * through the same path: within the page's range, history is the source of truth, and only
         * whatever streams after it belongs to the screen.
         * The cursor is the stored number of the top row of the merged result: the page's first
         * row, or the cursor the person had already read back to when those rows are kept (`readBack`).
         */
        const have = s.chat[sessionId] ?? []
        const held = s.history[sessionId]
        const read = readBack(have, held, msgs)
        const merged = mergePage(have, items, msgs)
        return {
          chat: { ...s.chat, [sessionId]: read.length ? prependPage(merged, read) : merged },
          // Slots for past cards' app views (M4 B-1) — a view this UI already knows about (a live one) is left as is
          inlineViews: mergeInlineHistory(s.inlineViews, sessionId, inlineViewsFromHistory(msgs)),
          history: {
            ...s.history,
            [sessionId]:
              read.length && held
                ? { oldestSeq: held.oldestSeq, more: held.more, loading: false }
                : { oldestSeq: msgs[0]?.seq ?? 0, more: msgs.length >= HISTORY_PAGE, loading: false },
          },
        }
      })
    } catch {
      // A page that cannot be turned into rows is not worth taking the screen down for; the conversation goes on
      return
    }
    await syncInlineViews(get, set, sessionId)
  },

  async loadHistoryAt(sessionId, seq) {
    const platform = get().platform
    if (!platform) return
    try {
      // `beforeSeq` is exclusive. The first page ends on the row search named; the second
      // extends the window past it. Together they avoid walking every page from a long
      // conversation's newest message while still leaving context after the matched line.
      const [before, after] = await Promise.all([
        platform.agents.loadMessages(sessionId, HISTORY_PAGE, seq + 1),
        platform.agents.loadMessages(sessionId, HISTORY_PAGE, seq + HISTORY_PAGE + 1),
      ])
      const msgs = [...new Map([...before, ...after].map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq)
      if (get().searchTargets[sessionId]?.seq !== seq) return
      const items = messagesToChat(msgs)
      bumpChatKeysAbove(items)
      set((s) => {
        const merged = mergePage(s.chat[sessionId] ?? [], items, msgs)
        return {
          chat: { ...s.chat, [sessionId]: merged },
          inlineViews: mergeInlineHistory(s.inlineViews, sessionId, inlineViewsFromHistory(msgs)),
          history: {
            ...s.history,
            [sessionId]: { oldestSeq: msgs[0]?.seq ?? 0, more: msgs.length >= HISTORY_PAGE, loading: false },
          },
        }
      })
      await syncInlineViews(get, set, sessionId)
    } catch {
      // Remove the temporary cursor so the ordinary first-open read can recover the view.
      set((s) => ({ history: omitKey(s.history, sessionId) }))
    }
  },

  async loadOlder(sessionId) {
    const platform = get().platform
    const cur = get().history[sessionId]
    if (!platform || !cur?.more || cur.loading || cur.oldestSeq <= 1) return
    const asked = { ...cur, loading: true }
    set((s) => ({ history: { ...s.history, [sessionId]: asked } }))
    /*
     * The page is only good for the cursor it was asked from (#79). A re-read that lands while this
     * one is out (`loadHistory`: a catch-up, a resync) or a trim on leaving the session moves the
     * cursor and the rows under it; prepending the page then left the rows between it and the new
     * cursor out for good, since the cursor was set below them. Such a page is dropped: the cursor
     * that replaced it is right, and the next scroll asks again from there.
     */
    const stale = () => get().history[sessionId] !== asked
    try {
      const msgs = await platform.agents.loadMessages(sessionId, HISTORY_PAGE, cur.oldestSeq)
      if (stale()) return
      const older = messagesToChat(msgs)
      bumpChatKeysAbove(older)
      set((s) => ({
        chat: { ...s.chat, [sessionId]: prependPage(s.chat[sessionId] ?? [], older) },
        inlineViews: mergeInlineHistory(s.inlineViews, sessionId, inlineViewsFromHistory(msgs)),
        history: {
          ...s.history,
          [sessionId]: {
            oldestSeq: msgs[0]?.seq ?? cur.oldestSeq,
            more: msgs.length >= HISTORY_PAGE,
            loading: false,
          },
        },
      }))
    } catch (e) {
      // Putting the old cursor back over one a re-read set meanwhile would undo the re-read
      if (stale()) return
      set((s) => ({
        history: { ...s.history, [sessionId]: { ...cur, loading: false } },
        toast: `Could not load past conversation: ${(e as Error).message}`,
      }))
    }
  },
  toggleSubagentSteps(sessionId, callId) {
    const cur = get().subagentSteps[sessionId]?.[callId]
    const open = !cur?.open
    set((s) => putSubagentSteps(s.subagentSteps, sessionId, callId, { ...(cur ?? SUBAGENT_STEPS_UNREAD), open }))
    // Read on the first opening, and again after a failed read — never while it is closed
    if (open && (!cur || cur.error)) void get().loadMoreSubagentSteps(sessionId, callId)
  },
  async loadMoreSubagentSteps(sessionId, callId) {
    const platform = get().platform
    const cur = get().subagentSteps[sessionId]?.[callId]
    if (!platform || !cur || cur.loading) return
    const after = cur.rows.at(-1)?.seq ?? 0
    set((s) => putSubagentSteps(s.subagentSteps, sessionId, callId, { ...cur, loading: true, error: null }))
    try {
      const page = await platform.agents.loadSubagentMessages(sessionId, callId, after, SUBAGENT_STEPS_PAGE)
      set((s) => {
        const now = s.subagentSteps[sessionId]?.[callId] ?? cur
        // A live step may have joined while the page was on its way: one row per number, in order
        const rows = [...new Map([...now.rows, ...page].map((r) => [r.seq, r])).values()].sort((a, b) => a.seq - b.seq)
        return putSubagentSteps(s.subagentSteps, sessionId, callId, { ...now, rows, more: page.length >= SUBAGENT_STEPS_PAGE, loading: false })
      })
    } catch (e) {
      set((s) =>
        putSubagentSteps(s.subagentSteps, sessionId, callId, {
          ...(s.subagentSteps[sessionId]?.[callId] ?? cur),
          loading: false,
          error: (e as Error).message,
        }),
      )
    }
  },
  togglePanel(open) {
    set((s) => ({ panelOpen: open ?? !s.panelOpen }))
    get().saveWorkspace()
  },

  setPanelTab(tab) {
    set((s) => ({ panelLayout: activateTab(s.panelLayout, tab), panelOpen: true }))
    get().saveWorkspace()
  },

  setPanelLayout(panelLayout) {
    set({ panelLayout })
    get().saveWorkspace()
  },

  setPanelWidth(px) {
    const s = get()
    const sidebar = s.panelOpen ? s.sidebarWidth : s.sidebarWidth
    set({ panelWidth: fitWidth(px, PANEL_MIN, PANEL_MAX, sidebar, s.prefs.textSize) })
    get().saveWorkspace()
  },

  setPanelSplit(share) {
    // If one group drops below 15%, only the tab strip remains and it reads as "gone" — a floor is set
    const clamped = Math.min(0.85, Math.max(0.15, share))
    if (clamped === get().panelSplit) return
    set({ panelSplit: clamped })
    get().saveWorkspace()
  },

  setSidebarWidth(px) {
    const s = get()
    // If the panel is collapsed, it only occupies a 32px strip
    const panel = s.panelOpen ? s.panelWidth : 32
    set({ sidebarWidth: fitWidth(px, SIDEBAR_MIN, SIDEBAR_MAX, panel, s.prefs.textSize) })
    get().saveWorkspace()
  },

  openFile(path, projectId) {
    set({ viewerPath: path, viewerProjectId: projectId ?? null, overlay: { kind: 'viewer' } })
  },

  /*
   * Opens Finder from a right-click. The path arrives with the same credentials as a file link
   * (relative to the currently viewed session's project), and goes through the same port as the file
   * tree's reveal — a failure is loud with the same wording as the tree's.
   */
  async revealFile(path, from) {
    const s = get()
    const projectId = from ?? (s.focusedSessionId ? s.sessions[s.focusedSessionId]?.projectId : null)
    if (!projectId || !s.platform) return
    // The file manager is this computer's; a file on a linked machine is not in it (#82)
    const machine = s.projects[projectId]?.machine
    if (machine) {
      set({ toast: `${path} is on ${s.machines[machine]?.name ?? machine}, not on this computer` })
      return
    }
    try {
      const res = await s.platform.fs.reveal(projectId, path)
      if (!res.supported) set({ toast: res.reason ?? 'Showing files is not available here' })
    } catch (e) {
      set({ toast: `Could not show ${path}: ${(e as Error).message}` })
    }
  },

  openGit(path, staged) {
    // The tab is recorded explicitly — clicking a changed file while viewing history must return to changes
    set((s) => ({ overlay: { kind: 'git', path: path ?? null, staged, sub: 'changes', pick: nextPick(s.overlay) } }))
  },

  openCommit(sha) {
    set((s) => ({ overlay: { kind: 'git', sha, sub: 'history', pick: nextPick(s.overlay) } }))
  },

  openBranches() {
    set((s) => ({ overlay: { kind: 'git', sub: 'branches', pick: nextPick(s.overlay) } }))
  },

  closeOverlay() {
    set({ overlay: null })
  },
  toggleInbox(open) {
    set((s) => ({ inboxOpen: open ?? !s.inboxOpen }))
  },
  togglePalette(open) {
    set((s) => ({ paletteOpen: open ?? !s.paletteOpen }))
  },
  askComposerFocus(sessionId) {
    set({ composerFocusFor: sessionId })
  },
  toggleUsage(open) {
    set((s) => ({ usageOpen: open ?? !s.usageOpen }))
  },
  toggleSettings(open) {
    set((s) => ({ settingsOpen: open ?? !s.settingsOpen }))
  },
  openSettingsAt(category) {
    set({ settingsOpen: true, settingsRequest: { category, at: Date.now() } })
  },
  openImport(source = '', fromLink = false) {
    // `at` is needed so a new link arriving at an already-open window still makes the window stand up again for that link (a request to open the same window twice)
    set({ importDialog: { source, fromLink, at: Date.now() }, settingsOpen: false })
  },
  closeImport() {
    set({ importDialog: null })
  },
  requestSettingsMenu(sessionId) {
    set({ settingsMenuRequest: { sessionId, at: Date.now() } })
  },

  /*
   * The three below all follow the same shape: tell the host, and seat whatever state comes back as
   * is.
   *
   * **Never drawn optimistically ahead of time.** This differs from other actions, and for a reason
   * — if the screen got ahead of itself here, it could write "installing" while nothing is actually
   * happening, and that is the worst lie possible about something that cannot be undone. The host
   * keeps sending progress as events, so waiting does not freeze the screen.
   */
  async checkUpdate(force = true) {
    const platform = get().platform
    if (!platform) return
    const hostResyncs = get().hostResyncs
    try {
      const update = await platform.updates.status(force)
      if (get().platform !== platform || get().hostResyncs !== hostResyncs) return
      set({ update })
    } catch (e) {
      if (get().platform !== platform || get().hostResyncs !== hostResyncs) return
      // A version check must never break the screen — the app matters more than the check itself
      set({ toast: `Could not check for updates: ${(e as Error).message}` })
    }
  },

  async setUpdateAuto(enabled) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ update: await platform.updates.setAuto(enabled) })
    } catch (e) {
      set({ toast: `Could not save that: ${(e as Error).message}` })
    }
  },

  async setUpdateAutoApply(enabled) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ update: await platform.updates.setAutoApply(enabled) })
    } catch (e) {
      // An older host does not know the setting; say so rather than leave the box ticked
      set({ toast: `Could not save that: ${(e as Error).message}` })
    }
  },

  async loadSleepPolicy() {
    const platform = get().platform
    if (!platform) return
    try {
      set({ sleepPolicy: await platform.agents.sleepPolicy() })
    } catch {
      // An older host does not put sessions to sleep: the setting stays hidden
    }
  },

  async setSleepAfter(afterMinutes) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ sleepPolicy: await platform.agents.setSleepPolicy(afterMinutes) })
    } catch (e) {
      set({ toast: `Could not save that: ${(e as Error).message}` })
    }
  },

  async checkAgentVersions(force = false) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ agentVersions: await platform.agents.versions(force) })
    } catch {
      // An older host does not know it: the headers stay quiet rather than the screen breaking
    }
  },

  async checkMachineAgentVersions(machineId, force = false) {
    const platform = get().platform
    if (!platform) return
    try {
      const v = await platform.agents.versions(force, machineId)
      set((s) => ({ machineAgentVersions: { ...s.machineAgentVersions, [machineId]: v } }))
    } catch {
      // Away, or a host that does not know the machine parameter: the header stays quiet, as for this computer
    }
  },

  async refreshMachines() {
    const platform = get().platform
    if (!platform) return
    try {
      const list = await platform.machines.list()
      set({ machines: Object.fromEntries(list.map((m) => [m.id, m])) })
    } catch {
      /* a host from before linked machines: none */
    }
  },

  async addMachine(spec) {
    const m = await get().platform!.machines.add(spec)
    set((s) => ({ machines: withAnswered(s.machines, m) }))
    return m
  },

  async machineSshHosts() {
    try {
      return await get().platform!.machines.sshHosts()
    } catch {
      return null
    }
  },

  async probeMachine(sshTarget) {
    try {
      return await get().platform!.machines.probe(sshTarget)
    } catch {
      return null
    }
  },

  async removeMachine(machineId) {
    await get().platform!.machines.remove(machineId)
    // Its sessions and projects leave with its own resync; the row goes now
    set((s) => ({ machines: omitKey(s.machines, machineId), machineAgentVersions: omitKey(s.machineAgentVersions, machineId) }))
  },

  async reconnectMachine(machineId) {
    try {
      const m = await get().platform!.machines.reconnect(machineId)
      set((s) => ({ machines: withAnswered(s.machines, m) }))
    } catch (e) {
      set({ toast: `Could not reconnect: ${(e as Error).message}` })
    }
  },

  async changeMachineInstall(machineId, kind) {
    const port = get().platform!.machines
    try {
      const r = await port[kind](machineId)
      set((s) => ({ machines: withAnswered(s.machines, r.machine) }))
      return true
    } catch (e) {
      const what = { install: 'Install', update: 'Update', rollback: 'Rollback', uninstall: 'Uninstall' }[kind]
      set({ toast: `${what} failed: ${(e as Error).message}` })
      return false
    }
  },

  async setMachineAutostart(machineId, on) {
    try {
      const r = await get().platform!.machines.autostart(machineId, on)
      set((s) => ({ machines: withAnswered(s.machines, r.machine) }))
      return true
    } catch (e) {
      set({ toast: `Could not turn ${on ? 'on' : 'off'} starting at boot: ${(e as Error).message}` })
      return false
    }
  },

  async machineActivity(machineId) {
    try {
      return await get().platform!.machines.activity(machineId)
    } catch {
      return null
    }
  },

  async acceptMachineVersions(machineId) {
    try {
      const m = await get().platform!.machines.acceptVersions(machineId)
      set((s) => ({ machines: withAnswered(s.machines, m) }))
    } catch (e) {
      set({ toast: `Could not connect: ${(e as Error).message}` })
    }
  },

  async recoverMachine(machineId) {
    const s = get()
    if (!s.platform) return
    const ofMachine = (x: { machine?: string | null }) => (x.machine ?? null) === machineId
    // Held live before: the candidates to wake, once the fresh list says they are not
    const wasLive = Object.values(s.sessions).filter((x) => ofMachine(x) && x.live)
    const asked = s.sessions
    const watch = watchLiveEvents()
    const [fresh, projects] = await Promise.all([
      s.platform.agents.listSessions().catch(() => null),
      s.platform.projects.list().catch(() => null),
    ]).finally(watch.stop)
    if (!fresh) return
    set((st) => {
      /*
       * Only this machine's rows move. Every other row keeps its object, so nothing about this computer's sessions or
       * another machine's re-renders or loses what the reducer derived. A row of this machine the fresh list no
       * longer has (deleted there, or the machine was unlinked) leaves; a new one joins at the end. What changed
       * while the list was out is kept over its older rows, as in the reconnect recovery (`mergeListedSince`).
       * What a session that left kept is cleared as `session_deleted` clears it (#163).
       */
      const { sessions, gone } = mergeListedSince(asked, st.sessions, fresh.filter(ofMachine), watch.touched, ofMachine)
      let nextProjects = st.projects
      if (projects) {
        const theirs = new Map(projects.filter(ofMachine).map((p) => [p.id, p]))
        nextProjects = {}
        for (const [id, p] of Object.entries(st.projects)) {
          if (!ofMachine(p)) nextProjects[id] = p
          else if (theirs.has(id)) nextProjects[id] = theirs.get(id)!
        }
        for (const [id, p] of theirs) if (!nextProjects[id]) nextProjects[id] = p
      }
      return {
        sessions,
        ...forgetSessions(st, gone),
        projects: nextProjects,
        workingSince: trackWorkingSince(st.workingSince, sessions, Date.now()),
      }
    })
    replayPendingEvents(get)
    get().pruneFoldedGroups()
    // A remote's user-folder and project apps come and go with it
    void get().refreshExternalApps()
    // Its agent CLIs may have moved while it was away
    if (get().machineAgentVersions[machineId]) void get().checkMachineAgentVersions(machineId)

    /*
     * The events of the gap are not replayed through the hub (protocol.md, `machine_resync`): every conversation of
     * this machine that is open is read again, the same way a host resync reads every one held (#173).
     */
    const holding = new Set(Object.keys(get().chat))
    const focused = get().focusedSessionId
    if (focused) holding.add(focused)
    for (const id of holding) {
      const cur = get().sessions[id]
      if (cur && ofMachine(cur)) void get().loadHistory(id)
    }

    const toWake = wasLive.filter((x) => {
      const now = get().sessions[x.id]
      return now && !now.live && !isAway(now, get().machines)
    })
    if (toWake.length === 0) return
    const name = get().machines[machineId]?.name ?? machineId
    set({ toast: `${name} is back — resuming ${toWake.length} session${toWake.length > 1 ? 's' : ''}` })
    for (const x of toWake) await get().wake(x.id)
  },

  async setAgentAutoApply(enabled) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ agentVersions: await platform.agents.setAutoApplyVersions(enabled) })
    } catch (e) {
      set({ toast: `Could not save that: ${(e as Error).message}` })
    }
  },

  async applyAgentVersions(machine) {
    const platform = get().platform
    if (!platform) return
    try {
      const { restarted, busy } = await platform.agents.applyVersions(machine)
      set({ toast: appliedVersionsText(restarted.length, busy.length) })
    } catch (e) {
      set({ toast: `Could not restart the sessions: ${(e as Error).message}` })
    }
  },

  async refreshThemes() {
    const platform = get().platform
    if (!platform) return
    try {
      const themeFiles = await platform.themes.list()
      set((st) => ({ themeFiles, lastGoodThemes: goodThemes(st.lastGoodThemes, themeFiles) }))
    } catch {
      /* the folder could not be read this time — the screen keeps what it has */
    }
  },

  async setPrefs(patch) {
    const platform = get().platform
    if (!platform) return
    try {
      const saved = parseUiPreferences(await platform.prefs.save(patch))
      /*
       * Only what this patch wrote is taken from the answer (#666). The answer is the host's whole record at that
       * moment: a host from before a field answers without it (so reading it whole would reset the field to its default
       * on every unrelated save), and a fold saved meanwhile may not be in it yet.
       */
      set((s) => ({
        prefs: {
          ...s.prefs,
          ...Object.fromEntries(Object.keys(patch).filter((k) => k in saved).map((k) => [k, saved[k as keyof typeof saved]])),
        },
      }))
    } catch (e) {
      // The screen is left as is — leaving a failed setting turned on means it quietly reverts the next time it is turned on
      set({ toast: `Could not save that: ${(e as Error).message}` })
    }
  },

  async applyUpdate() {
    const platform = get().platform
    if (!platform) return
    const hostResyncs = get().hostResyncs
    try {
      const update = await platform.updates.apply()
      if (get().platform !== platform || get().hostResyncs !== hostResyncs) return
      set({ update })
    } catch (e) {
      if (get().platform !== platform || get().hostResyncs !== hostResyncs) return
      set({ toast: `Could not update: ${(e as Error).message}` })
    }
  },

  async applyUpdateNow() {
    const relaunch = get().platform?.relaunch
    if (!relaunch) return 'This window cannot relaunch itself.'
    try {
      await relaunch.relaunch()
      return null
    } catch (e) {
      set({ toast: `Could not apply the update: ${(e as Error).message}` })
      return (e as Error).message
    }
  },
  async answerApplyRequest(requestId) {
    const platform = get().platform
    if (!platform) return
    // A replayed request this window already answered is not answered twice
    if (applyTickets.has(requestId)) return
    const answer = (async () => {
      const verdict = await agentApplyVerdict(platform.relaunch, get().update)
      // A host mid-swap that still wants it asks again; this one's request is gone either way
      return (await platform.updates.answerApply({ requestId, ...verdict }).catch(() => ({ ticket: null }))).ticket
    })()
    applyTickets.set(requestId, answer)
    const ticket = await answer
    if (ticket === null) applyTickets.delete(requestId)
    else setTimeout(() => applyTickets.get(requestId) === answer && applyTickets.delete(requestId), APPLY_TICKET_MS)
  },
  async runApplyRequest(requestId, ticket) {
    // Only the window holding this ticket relaunches, and only once: a replayed go finds it gone (#665)
    const mine = applyTickets.get(requestId)
    if (!mine || (await mine) !== ticket || applyTickets.get(requestId) !== mine) return
    applyTickets.delete(requestId)
    const platform = get().platform
    if (!platform) return
    // Checked again at the go, as the shell checks again when the button is pressed: the bundle may have changed since
    const verdict = await agentApplyVerdict(platform.relaunch, get().update)
    if (!verdict.ready) return void (await platform.updates.reportApply({ requestId, ticket, error: verdict.reason }).catch(() => {}))
    /*
     * Said, and heard, before the relaunch: the host counts this window closing as the relaunch only after it (#665
     * review). Not heard (the host gone mid-swap), the relaunch goes ahead anyway, as the button's would.
     */
    await platform.updates.reportApply({ requestId, ticket, started: true }).catch(() => {})
    const error = await get().applyUpdateNow()
    await platform.updates.reportApply({ requestId, ticket, ...(error ? { error } : {}) }).catch(() => {})
  },
  setNotifyPolicy(notifyPolicy) {
    set({ notifyPolicy })
    // The policy is carried in the workspace snapshot too (E-5) — saving goes through the single writer
    get().saveWorkspace()
  },
  setDraft(sessionId, draft) {
    set((s) => {
      // An empty draft is never kept — otherwise leftovers pile up even as sessions get deleted
      if (!draft.text && draft.attachments.length === 0) {
        if (!(sessionId in s.drafts)) return {}
        const { [sessionId]: _gone, ...rest } = s.drafts
        return { drafts: rest }
      }
      return { drafts: { ...s.drafts, [sessionId]: draft } }
    })
  },
  setStickToBottom(sessionId, sticking) {
    set((s) => {
      // Scrolling fires this by the dozen; only a change is worth a new state object
      if ((s.stickToBottom[sessionId] ?? true) === sticking) return {}
      // Sticking is the default, so it is recorded by *not* being recorded — that way the
      // map only ever holds the sessions someone has actually scrolled away from
      if (sticking) return { stickToBottom: omitKey(s.stickToBottom, sessionId) }
      return { stickToBottom: { ...s.stickToBottom, [sessionId]: false } }
    })
  },
  setScrollAnchor(sessionId, anchor) {
    set((s) => {
      if (!anchor) {
        // Left at the bottom — if the previous anchor were left behind, arriving next time would go to that old spot
        if (!(sessionId in s.scrollAnchor)) return {}
        return { scrollAnchor: omitKey(s.scrollAnchor, sessionId) }
      }
      const cur = s.scrollAnchor[sessionId]
      if (cur && cur.seq === anchor.seq && cur.offset === anchor.offset) return {}
      return { scrollAnchor: { ...s.scrollAnchor, [sessionId]: anchor } }
    })
  },
  toggleDir(projectId, path) {
    set((s) => {
      const cur = s.expandedDirs[projectId] ?? []
      /*
        Closing a folder leaves its children in the list on purpose. "As you left it" means
        the whole shape comes back when you open the parent again, not just its first row.
      */
      const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]
      return { expandedDirs: { ...s.expandedDirs, [projectId]: next } }
    })
  },
  setShowIgnored(show) {
    set({ showIgnored: show })
    get().saveWorkspace()
  },
  toggleProjectFold(projectId) {
    set((s) => ({
      foldedProjects: s.foldedProjects.includes(projectId)
        ? s.foldedProjects.filter((id) => id !== projectId)
        : [...s.foldedProjects, projectId],
    }))
    get().saveWorkspace()
  },
  setGroupsFolded(keys, folded) {
    const before = get().prefs.foldedGroups
    const next = folded
      ? [...before, ...keys.filter((k, i) => !before.includes(k) && keys.indexOf(k) === i)].slice(-FOLDED_GROUPS_MAX)
      : before.filter((k) => !keys.includes(k))
    if (sameKeys(next, before)) return
    set((s) => ({ prefs: { ...s.prefs, foldedGroups: next } }))
    const platform = get().platform
    if (!platform) return
    const mine = ++foldSaveSeq
    platform.prefs.save({ foldedGroups: next }).catch((e: unknown) => {
      /*
       * Undone only when this is still the newest save and the list is still what it wrote: a later fold has its own
       * save in flight, and its state must not be rolled back by this one's failure. Compared by value, not identity:
       * a reconnect reads the preferences again and hands the screen a new array with the same keys.
       */
      if (mine === foldSaveSeq && sameKeys(get().prefs.foldedGroups, next)) {
        set((s) => ({ prefs: { ...s.prefs, foldedGroups: before } }))
      }
      set({ toast: `Could not save that: ${(e as Error).message}` })
    })
  },
  pruneFoldedGroups() {
    const s = get()
    // An empty app list may be a read that failed; it names no app, so it must not condemn every app's fold
    const apps = s.externalApps.length > 0 ? new Set(s.externalApps.map((a) => appKeyOf(a.projectId, a.appId, a.machine))) : null
    const dead = deadFoldKeys(s.prefs.foldedGroups, s.sessions, apps)
    if (dead.length > 0) get().setGroupsFolded(dead, false)
  },
  foldOtherProjects(projectId) {
    set((s) => ({ foldedProjects: Object.keys(s.projects).filter((id) => id !== projectId) }))
    get().saveWorkspace()
  },
  arrangeProject(projectId, next) {
    set((s) => ({ projectPanels: { ...s.projectPanels, [projectId]: next } }))
    get().saveWorkspace()
  },
  setAppSpan(projectId, appId, span, machine) {
    const key = appKeyOf(projectId, appId, machine)
    set((s) => {
      const { [key]: _old, ...rest } = s.appSpans
      return { appSpans: span ? { ...rest, [key]: span } : rest }
    })
    get().saveWorkspace()
  },
  async setGridPanelSpan(key, span) {
    await get().setGridPanels(withPanelSpan(get().gridPanels, key, span))
  },
  setFoldComposer(fold) {
    set({ foldComposer: fold })
    get().saveWorkspace()
  },

  setToast(toast) {
    set({ toast })
  },
  openNewSession(projectId, opts) {
    /*
     * A suggestion (#69) is consumed **at the moment it is opened** — no matter which door opens it
     * (the project's +, the manager's +, the suggestion row). Leaving it behind would contaminate an
     * unrelated window opened next.
     */
    const queue = get().worktreeProposals
    const at = projectId !== null ? queue.findIndex((p) => p.projectId === projectId) : -1
    const prop = at >= 0 ? queue[at] : undefined
    set({
      newSessionFor: projectId,
      newSessionWorktree: (opts?.worktree ?? false) || !!prop,
      newSessionBranch: prop?.branch ?? '',
      ...(prop ? { worktreeProposals: queue.filter((_, i) => i !== at) } : {}),
    })
  },

  async startSessionNow(projectId) {
    const project = get().projects[projectId]
    const platform = get().platform
    // A second click while the first is still starting would make a second session
    if (!project || !platform || startingNow.has(projectId)) return
    startingNow.add(projectId)
    try {
      let tool = project.defaultTool ?? get().tools[0]?.name ?? ''
      /*
       * The host does not check a login when it creates a session: a tool that is logged out would fail on the first
       * turn instead. So the same rule as the dialog's applies first: a remembered tool that cannot run gives way to
       * one that can, and when none can the dialog opens, which states why. Failing to ask is not "unusable".
       */
      const found = await platform.agents.detect(project.machine ?? null).catch(() => [])
      const usable = (t: string) => {
        const d = found.find((x) => x.name === t)
        return d?.installed === true && d.loggedIn
      }
      if (found.length > 0 && !usable(tool)) {
        const other = found.find((x) => x.installed && x.loggedIn)?.name
        if (!other) return get().openNewSession(projectId)
        tool = other
      }
      const created = await get().createSession(projectId, { tool })
      // What comes next is the first instruction (#528): the composer takes the keyboard, as it does after the dialog's Start
      get().askComposerFocus(created.id)
    } catch (e) {
      get().openNewSession(projectId)
      get().setToast(`Could not start a session: ${(e as Error).message}`)
    } finally {
      startingNow.delete(projectId)
    }
  },

  async setWorktreeTrunk(projectId, baseBranch) {
    const platform = get().platform
    if (!platform) return
    await writingProject(projectId, () => void get().refreshProjects(), async () => {
      try {
        await platform.projects.setWorktreeTrunk(projectId, baseBranch)
      } catch (e) {
        // Returned to the dialog, which keeps the typed branch and the reason in place (#180)
        throw new Error(`Could not set the trunk: ${(e as Error).message}`)
      }
      set((s) => {
        const p = s.projects[projectId]
        return p
          ? { projects: { ...s.projects, [projectId]: { ...p, worktreeManager: { sessionId: p.worktreeManager?.sessionId ?? '', baseBranch } } } }
          : {}
      })
    })
  },

  async addProject(path, machine) {
    const p = await get().platform!.projects.add(path, machine)
    set((s) => joinProject(s, p))
    return p
  },

  async createProject(name, parent, machine, source) {
    const p = await get().platform!.projects.create(name, parent, machine, source)
    set((s) => joinProject(s, p))
    return p
  },

  refreshProjects() {
    const platform = get().platform
    if (!platform) return Promise.resolve()
    const running = projectsReading
    if (running && running.platform === platform) {
      running.again = true
      return running.done
    }
    const mine: NonNullable<typeof projectsReading> = { platform, again: false, done: Promise.resolve() }
    mine.done = (async () => {
      try {
        do {
          mine.again = false
          if (await readProjects(platform)) mine.again = true
        } while (mine.again)
      } finally {
        if (projectsReading === mine) projectsReading = null
      }
    })()
    projectsReading = mine
    return mine.done
  },

  async answerTrustAsk(trust) {
    const id = get().trustAsk
    if (!id) return
    set({ trustAsk: null })
    if (trust) await get().setProjectTrusted(id, true)
  },

  async setProjectTrusted(projectId, trusted) {
    const platform = get().platform
    if (!platform || !get().projects[projectId]) return
    await writingProject(projectId, () => void get().refreshProjects(), async () => {
      try {
        await platform.projects.setTrusted(projectId, trusted)
        set((s) => {
          const p = s.projects[projectId]
          return p ? { projects: { ...s.projects, [projectId]: { ...p, trusted } } } : {}
        })
        const running = Object.values(get().sessions).some((x) => x.projectId === projectId && x.live)
        if (running) set({ toast: 'Running sessions here pick up the new trust when they restart or resume.' })
      } catch (e) {
        set({ toast: `Could not change trust: ${(e as Error).message}` })
      }
    })
  },

  async deleteProject(projectId, deleteFiles) {
    const platform = get().platform
    if (!platform || !get().projects[projectId]) return
    if (deleteFiles) {
      /*
       * `'.'` is the project root — the host's `resolveExisting` resolves relative to the root and
       * refuses anything outside it, so no absolute path is built and passed here. The hand that
       * deletes lives in the shell (Rust), and what that hand does is **move to trash** (the fs
       * port's rule: "Not a delete — that is the whole decision").
       */
      const r = await platform.fs.trash(projectId, '.')
      if (!r.supported) throw new Error(r.reason ?? 'This build cannot delete files')
    }
    await platform.projects.remove(projectId)
    /*
     * Sessions also disappear through the host's own `session_deleted`, but they are cleared here as
     * well: waiting for that event would leave a session row on screen for a project that no longer
     * exists.
     */
    set((s) => {
      const projects = omitKey(s.projects, projectId)
      const doomed = Object.values(s.sessions)
        .filter((x) => x.projectId === projectId)
        .map((x) => x.id)
      const sessions = { ...s.sessions }
      for (const id of doomed) delete sessions[id]
      return {
        projects,
        sessions,
        ...forgetSessions(s, new Set(doomed)),
        /*
         * What was kept per project goes with it. The id can come back (restoring one of its sessions from the trash
         * re-adds the project under its old id), and then it starts the way a newly added project does: the deletion
         * stopped its command runs, and a git epoch of 0 and folded folders are the defaults anyway.
         */
        gitEpoch: omitKey(s.gitEpoch, projectId),
        expandedDirs: omitKey(s.expandedDirs, projectId),
        commandRuns: omitKey(s.commandRuns, projectId),
        focusedProjectId: s.focusedProjectId === projectId ? null : s.focusedProjectId,
        trustAsk: s.trustAsk === projectId ? null : s.trustAsk,
        foldedProjects: s.foldedProjects.filter((id) => id !== projectId),
        projectPanels: Object.fromEntries(Object.entries(s.projectPanels).filter(([id]) => id !== projectId)),
      }
    })
    // The fold and the arrangement just dropped live in the snapshot — write it, or the next launch reads them back
    get().saveWorkspace()
    get().pruneFoldedGroups()
  },

  refreshProjectGit(projectId) {
    const pending = gitRefreshTimers.get(projectId)
    if (pending !== undefined) clearTimeout(pending)
    gitRefreshTimers.set(
      projectId,
      setTimeout(() => {
        gitRefreshTimers.delete(projectId)
        const platform = get().platform
        // The project can be gone by the time the window closes (removed, or a reconnect
        // rebuilt the list). Measuring a folder nobody is showing helps no one.
        if (!platform || !get().projects[projectId]) return
        // Makes the panel's own held list re-read at the same moment too (#160). Bumped even when
        // the summary is unchanged — editing the same file again leaves the change count the same
        // while the content has changed
        set((s) => ({ gitEpoch: { ...s.gitEpoch, [projectId]: (s.gitEpoch[projectId] ?? 0) + 1 } }))
        void platform.projects
          .gitStatus(projectId)
          .then(({ git }) =>
            set((s) => {
              const cur = s.projects[projectId]
              /*
               * Nothing new is not an update. This runs after every turn and every return to
               * the window, and "the count is the same" is the common answer — handing every
               * row a fresh object each time would re-render the whole sidebar to redraw
               * identical text.
               */
              if (!cur || sameGit(cur.git, git)) return {}
              /*
               * **Only `git` is taken from the answer.** The host rebuilds the rest of
               * ProjectInfo from its own defaults, so swallowing the whole row would let a
               * reply that landed mid-`setProjectCommands` undo the list being edited.
               * This action was asked for one field; it writes one field.
               */
              return { projects: { ...s.projects, [projectId]: { ...cur, git } } }
            }),
          )
          /*
           * Silence on failure, deliberately. This is a number in the margin that nobody
           * asked for — a repo that has just been deleted, or a host that dropped the
           * project, must not put a toast in front of someone who was doing something else.
           * The stale count stays, which is exactly where we were before.
           */
          .catch(() => {})
      }, GIT_REFRESH_MS),
    )
  },

  /*
   * The three writes (issue #49). Each does the thing, then says the tree moved — the
   * `await` matters, because a status read that overtakes its own commit measures the repo
   * as it was and writes that back as news.
   *
   * Staging is in here even though it rarely moves the number (porcelain counts one line per
   * changed path whether it is staged or not). "Rarely" is not "never" — staging a file whose
   * content matches HEAD drops it out of status entirely — and the debounce plus `sameGit`
   * mean an answer identical to the last one costs one call and re-renders nothing. The
   * alternative is a rule about which writes qualify, which is the kind of rule that is
   * silently wrong for a year.
   */
  async gitStage(projectId, paths, unstage) {
    await get().platform!.git.stage(projectId, paths, unstage)
    get().refreshProjectGit(projectId)
  },

  async gitCommit(projectId, message) {
    const res = await get().platform!.git.commit(projectId, message)
    // Refresh even when the commit was refused: git can reject *after* moving something
    // (a hook that stages, a partial index update), and the count must not be left guessing.
    get().refreshProjectGit(projectId)
    return res
  },

  async gitCheckout(projectId, branch) {
    const res = await get().platform!.git.checkout(projectId, branch)
    get().refreshProjectGit(projectId)
    return res
  },

  async saveWorktreeSetup(projectId, setup) {
    const platform = get().platform
    const before = get().projects[projectId]
    if (!platform || !before) return
    await writingProject(projectId, () => void get().refreshProjects(), async () => {
      await platform.projects.setWorktreeSetup(projectId, setup)
      // The summary line must match the next time it opens — follows the host's own normalizing rule (an empty setup means `null`)
      const clean = setup && (setup.command || setup.copyFiles.length) ? setup : null
      set((s) => {
        const now = s.projects[projectId]
        return now ? { projects: { ...s.projects, [projectId]: { ...now, worktreeSetup: clean } } } : {}
      })
    })
  },

  async setProjectCommands(projectId, commands) {
    const platform = get().platform
    const before = get().projects[projectId]
    if (!platform || !before) return
    await writingProject(projectId, () => void get().refreshProjects(), async () => {
      // Draw it first. This is a list being edited by hand, and a row that appears only after
      // a round trip reads as a click that missed.
      set((s) => ({ projects: { ...s.projects, [projectId]: { ...before, commands } } }))
      try {
        const saved = await platform.projects.setCommands(projectId, commands)
        set((s) => {
          const now = s.projects[projectId]
          // The project could have gone while we were away; nothing to correct if so
          return now ? { projects: { ...s.projects, [projectId]: { ...now, commands: saved } } } : {}
        })
      } catch (e) {
        /*
         * Put the old list back and say so. A command that looks saved and is gone at the
         * next launch is the worse half of this: the menu would then say "nothing saved yet",
         * which reads as never having added it rather than as having lost it.
         */
        set((s) => ({
          projects: { ...s.projects, [projectId]: before },
          toast: `Could not save commands: ${(e as Error).message}`,
        }))
      }
    })
  },

  async loadCommandRuns(projectId) {
    const platform = get().platform
    if (!platform) return
    try {
      const runs = await platform.commands.state(projectId)
      set((s) => ({
        commandRuns: {
          ...s.commandRuns,
          [projectId]: Object.fromEntries(runs.map((r) => [r.command, r])),
        },
      }))
    } catch {
      // If it could not be read, it is re-read the next time the panel opens — the badge is just dark for a moment
    }
  },

  async runCommand(projectId, command) {
    const platform = get().platform
    if (!platform) return
    try {
      // The size is re-measured for real once the log window (`CommandLog`) attaches — this is only a starting value
      const info = await platform.commands.run(projectId, command, 100, 30)
      set((s) => ({
        commandRuns: {
          ...s.commandRuns,
          [projectId]: { ...s.commandRuns[projectId], [command]: info },
        },
      }))
    } catch (e) {
      // No silent failures — believing it started when it did not leaves someone waiting on a log that never comes
      set({ toast: `Could not run: ${(e as Error).message}` })
    }
  },

  async stopCommand(projectId, command) {
    await get()
      .platform?.commands.stop(projectId, command)
      .catch(() => {})
  },

  async createSession(projectId, opts) {
    const platform = get().platform!
    const project = get().projects[projectId]!
    const tool = opts?.tool ?? project.defaultTool ?? get().tools[0]?.name ?? ''
    /*
     * The project's memory is pulled out **only for this tool** (#107). There used to be a single
     * model per project, and that one value was carried regardless of which tool was used — so even
     * when a handoff deliberately cleared the model on a tool switch (`sameTool ? … : undefined`),
     * this line filled it right back in.
     */
    const remembered = await usableDefaults(platform, tool, project.defaultModels?.[tool], project.machine)
    // The host records the tool as this project's default while it makes the session (#719): a list read must not undo it
    const info = await writingProject(projectId, () => void get().refreshProjects(), () => platform.agents.createSession({
      projectId,
      cwd: project.path,
      // The chosen value travels straight to the host — the preset used to be pinned to 'normal' and the model was not even passed
      tool,
      model: opts?.model ?? remembered.model ?? undefined,
      // Effort follows the memory too (#69 ⑤) — remembering only the model meant Opus came back but high still had to be pressed again
      effort: opts?.effort ?? remembered.effort ?? undefined,
      verbosity: opts?.verbosity,
      serviceTier: opts?.serviceTier,
      permissionPreset: opts?.permissionPreset ?? 'normal',
      initialPrompt: opts?.initialPrompt,
      handoff: opts?.handoff,
      resumeExternalId: opts?.resumeExternalId,
      importHistory: opts?.importHistory,
      worktree: opts?.worktree,
      worktreeBranch: opts?.worktreeBranch,
      worktreeBase: opts?.worktreeBase,
    }))
    set((s) => ({
      sessions: {
        ...s.sessions,
        [info.id]: {
          ...initialSession({
            id: info.id,
            projectId,
            name: info.name,
            tool: info.tool,
            /*
             * The settings are also taken exactly as the host answered (the other half left unfixed
             * by #37 — `attach` and the reconnect merge already receive everything, but this
             * optimistic registration alone was missing it). Measured during dogfooding: a session
             * created through a handoff had inherited its model and effort in the database, yet the
             * menu showed Default until the app restarted — reading as if the settings had not carried
             * over at all.
             */
            model: info.model,
            effort: info.effort,
            verbosity: info.verbosity,
            serviceTier: info.serviceTier,
            permissionPreset: info.permissionPreset,
            worktree: info.worktree,
            // Its parent is also decided by the host (#69) — missing this would put a session created under a manager at the top level until a restart
            parentSessionId: info.parentSessionId,
            merged: info.worktreeMerged,
            pr: info.worktreePr,
          }),
          lastSeq: info.lastSeq,
          lastReadSeq: info.lastReadSeq,
          ...liveFactsOf(info),
        },
      },
      /*
       * **The chosen tool becomes this project's default.**
       *
       * `default_tool` used to be pinned to 'claude' when a project was created and never updated
       * anywhere else — someone using codex had to re-press it forever, every time they created a new
       * session. Why there is no separate setting for this: the fact that the last choice becomes the
       * default **is already stated by the act of creating a session.** The host makes the same
       * decision in the same place (`manager.createSession`) — what happens here is an optimistic
       * update so it shows up right away in this run.
       */
      projects:
        opts?.tool && s.projects[projectId]
          ? { ...s.projects, [projectId]: { ...s.projects[projectId], defaultTool: opts.tool } }
          : s.projects,
      // The starting prompt was also said by me — it must show in the conversation (a gap caught by e2e)
      // Why `pending` is set: the host also stores the first prompt and announces it via `user_message`
      // — without this marker, the replayed event would draw the same message a second time (the same rule as `send()`)
      chat: opts?.initialPrompt ? withOpeningPrompt(s.chat, info.id, opts.initialPrompt) : s.chat,
    }))
    /*
     * `focusedSessionId` is not set directly — it goes through `focusSession` instead, where the
     * "a picked session must be shown" view enforcement lives. Setting it directly used to be fine:
     * while a dialog was in use, the screen was already the focus view. Once onboarding started
     * opening the orchestrator view first (#63), that created the combination where a session created
     * there was **never shown** (caught by e2e).
     */
    get().focusSession(info.id)

    // An imported session already has past conversation piled up on the host — pull it onto the screen
    if (opts?.importHistory && opts.resumeExternalId) {
      const msgs = await platform.agents.loadMessages(info.id)
      if (msgs.length > 0) {
        const restored = messagesToChat(msgs)
        bumpChatKeysAbove(restored)
        set((s) => ({ chat: { ...s.chat, [info.id]: restored } }))
      }
    }

    // Replays events held from before registration, in order
    replayPendingEvents(get)
    return info
  },

  /** Saves a file that came in through paste or drag to the host, and receives its attachment info (FR-13) */
  async attachFile(sessionId, file) {
    const platform = get().platform
    if (!platform) return null
    if (file.size > MAX_ATTACHMENT_BYTES) {
      set({ toast: `${file.name} is too large (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB)` })
      return null
    }
    const count = (d: number) =>
      set((s) => {
        const n = (s.uploading[sessionId] ?? 0) + d
        const { [sessionId]: _was, ...rest } = s.uploading
        return { uploading: n > 0 ? { ...rest, [sessionId]: n } : rest }
      })
    count(1)
    try {
      const buf = await file.arrayBuffer()
      const b64 = toBase64(new Uint8Array(buf))
      const saved = await platform.agents.saveAttachment(
        sessionId,
        file.name,
        file.type || 'application/octet-stream',
        b64,
      )
      // An image draws its thumbnail immediately from the bytes just read — no round trip to the host is needed
      return saved.kind === 'image' ? { ...saved, data: b64 } : saved
    } catch (e) {
      set({ toast: `Could not attach: ${(e as Error).message}` })
      return null
    } finally {
      count(-1)
    }
  },

  async send(sessionId, text, attachments) {
    /*
     * **If a question is open, the composer's text is that question's answer, not a new turn.**
     *
     * This used to not check `pendingQuestions` at all. So sending text while a card was up cut off
     * the turn in progress, and an `AskUserQuestion` that never got an answer was cleaned up as
     * **a refused tool use** — the card vanished for no visible reason and the turn broke with
     * `error_during_execution` (an actual incident, 2026-09-23: the person only typed "can you ask
     * the question again?" and the question disappeared).
     *
     * Instead of blocking it, the intent is honored. Writing an answer by hand because none of the
     * options fit is a natural thing to do, and the card already has an "Other — write your own" slot.
     * The gesture and its meaning already agree.
     *
     * This is only done **when there is exactly one question.** With several questions in one
     * request, the card requires all of them answered (sending half lets the model invent the rest),
     * and a single line of text has no way to say which one it answers. It also steps aside when
     * there is an attachment — sending it as an answer would discard the attachment.
     */
    const open = get().sessions[sessionId]?.pendingQuestions ?? []
    const target = composerTarget(open, !!attachments?.length)
    if (target === 'answer' && text.trim()) {
      const only = open[0]!
      const landed = await get().answerQuestion(sessionId, only.requestId, [
        { question: only.questions[0]!.question, answers: [text.trim()] },
      ])
      /*
       * An answer that failed to land is put back into the composer (#180) — the same rule as a
       * normal send. The composer clears the instant it is sent, and an answer never leaves a bubble
       * in the conversation, so it cannot even be pulled back with the ↑ recall. If the question has
       * already gone (the host swapped it out), its card is dismissed too, and with nothing put back,
       * the written text would be nowhere at all. Putting it back never resends anything — if the
       * answer actually did land, the person just sees the card gone and can delete the text
       * themselves.
       */
      if (!landed) restoreDraft(set, sessionId, text, attachments)
      return
    }
    /*
     * The text cannot be an answer, but a question is open (#174) — sending it starts a new turn, and
     * a question left unanswered is cleaned up as a refused tool use, so its card disappears. The
     * composer's hint text says this before sending (`composerTarget`), and after sending, a line is
     * left in the conversation saying what was dropped — a card that vanishes with no explanation
     * would leave no trace that a question ever existed.
     */
    const dropped = target === 'drops' ? open.flatMap((q) => q.questions.map((x) => x.question)) : []

    const seq = nextChatKey()
    /*
     * Marked as "working" the instant it is sent.
     *
     * The host does send a `state_change`, but a sleeping session takes a few seconds to revive its
     * process, and the screen sits completely silent during that time — it is impossible to even tell
     * whether it was sent. What we already know is already settled: **it was sent, and an answer is
     * awaited.** A failure is undone below.
     */
    const prevState = get().sessions[sessionId]?.state
    // A new turn is also the end of whatever stopped the last one (#698), as the reducer's own move to working says
    const prevInterruption = get().sessions[sessionId]?.interruption ?? null
    set((s) => {
      const sessions = s.sessions[sessionId]
        ? { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, state: 'working' as const, interruption: null } }
        : s.sessions
      return {
        /*
          pending: I just drew this and have not yet gotten the host's confirmation.
          Once the host reports the same message via `user_message`, this item is settled into it —
          without this marker, the same message would be drawn twice.
        */
        chat: {
          ...s.chat,
          [sessionId]: [
            ...(s.chat[sessionId] ?? []),
            // Attachments are never mixed into `text` as a label (a 📎 name) — an image is drawn as a
            // real thumbnail, a file as a separate chip. `text` stays exactly what was sent, so
            // matching it against the `user_message` confirmation also relies on this (#75).
            { kind: 'user', seq, text, ...(attachments?.length ? { attachments } : {}), pending: true },
          ],
        },
        sessions,
        /*
          The wait starts here, not when the host's first event lands. Waking a sleeping
          session can take seconds, and those seconds are the ones a person is staring at —
          counting from the host's reply would quietly undercount the worst waits.
        */
        workingSince: trackWorkingSince(s.workingSince, sessions, Date.now()),
      }
    })
    /*
     * A message to a sleeping session wakes it first (#568): the host resumes it before the message goes in. The
     * session reads as waking meanwhile, the same `resuming` a wake from the composer sets, so its line says so.
     */
    const waking = get().sessions[sessionId]?.live === false && !get().resuming[sessionId]
    if (waking) set((st) => ({ resuming: { ...st.resuming, [sessionId]: true } }))
    try {
      // The bytes already live in a file on the host — the send only carries the path (carrying `data` would double the payload)
      await get().platform!.agents.send(
        sessionId,
        text,
        attachments?.map(({ data: _, ...a }) => a),
      )
      if (dropped.length) {
        const mark: ChatItem = { kind: 'mark', seq: nextChatKey(), text: droppedQuestionsText(dropped) }
        set((s) => {
          const items = s.chat[sessionId] ?? []
          const at = items.findIndex((i) => i.seq === seq)
          return at < 0 ? {} : { chat: { ...s.chat, [sessionId]: [...items.slice(0, at), mark, ...items.slice(at)] } }
        })
      }
      // A successful send means the sleeping session was revived (the host resumes it on its own)
      set(
        ifSessionStill(sessionId, (s, cur) => ({
          sessions: cur.live ? s.sessions : { ...s.sessions, [sessionId]: { ...cur, live: true } },
          wakeError: omitKey(s.wakeError, sessionId),
          // Having sent successfully means the lock is gone — no reason to keep offering the fork option
          wakeLocked: omitKey(s.wakeLocked, sessionId),
        })),
      )
    } catch (err) {
      const e = err as Error & { code?: string }
      /*
       * **Unknown whether it was sent** (#173). If the socket drops, the client refuses a call that
       * never got an answer with `connection_lost` — but the host may already have received, stored
       * and broadcast that request (this is common when the connection drops while a sleeping session
       * is being revived). Reporting that as a failure and putting the text back would have the person
       * send it again, and the same instruction goes through twice. The bubble is instead left as
       * pending, and checked against the store after reconnecting (`settleUnsureSends`) — if it is
       * confirmed there, it was sent; if not, it is undone at that point.
       */
      if (e.code === 'connection_lost') {
        unsureSends.set(seq, { sessionId, text, attachments, prevState, prevInterruption })
        set({ toast: 'Connection lost while sending — checking whether it arrived once reconnected' })
        return
      }
      // Silently swallowing a send failure would leave the person standing there waiting for an
      // answer forever. The bubble that looks sent is removed and what to do is reported.
      // The host revives a sleeping session on its own before sending — reaching this point means reviving itself failed
      unsend(set, { seq, sessionId, text, attachments, prevState, prevInterruption }, e.message)
    } finally {
      if (waking) set((st) => ({ resuming: omitKey(st.resuming, sessionId) }))
    }
  },

  async resumeSession(sessionId) {
    const platform = get().platform
    if (!platform) return false
    try {
      const res = await platform.agents.resumeSession(sessionId)
      set(
        ifSessionStill(sessionId, (s, cur) => ({
          sessions: { ...s.sessions, [sessionId]: { ...cur, live: res.resumed } },
          toast: res.resumed ? null : `Could not resume: ${res.reason ?? 'unknown reason'}`,
        })),
      )
      return res.resumed
    } catch (err) {
      set({ toast: `Could not resume: ${(err as Error).message}` })
      return false
    }
  },

  async respondApproval(sessionId, requestId, decision, scope) {
    // The "always allow" pattern is computed by core (the host does not know core, so it is carried here)
    const pending = get().sessions[sessionId]?.pendingApproval
    /*
     * A request is answered exactly once (#158). If a response already sent is still in flight, or if
     * that outcome already dismissed the card, this is not sent again. A card keeps its listener alive
     * until `approval_resolved` lands and React re-renders, so a second `y` in that window became a
     * "vanished request" on the host and recorded a command that had already run as Denied. Both the
     * card's key and its buttons go through this same path.
     */
    const flight = inFlightKey(sessionId, requestId)
    if (get().approvalsInFlight[flight] || pending?.requestId !== requestId) return
    set((s) => ({ approvalsInFlight: { ...s.approvalsInFlight, [flight]: true } }))
    const matcher =
      decision === 'always' && pending
        ? pending.detail.kind === 'command'
          ? suggestMatcher(pending.detail.command)
          : pending.detail.kind === 'file_edit'
            ? pending.detail.path
            : undefined
        : undefined
    /*
     * This used to be the one action in this store that swallowed a failure. Approval is exactly the
     * spot where **pressing it and having nothing happen is worst of all** — there is no way to tell
     * whether the command ran or not.
     */
    try {
      await get().platform!.agents.respondApproval(sessionId, requestId, decision, scope, matcher)
      /*
       * What got remembered is stated using **the matcher actually sent** (#170). The card used to
       * compose its own wording separately, so even a kind with no matcher (`other`) was announced as
       * "Always allow in this session: other" — even though neither the adapter nor the store had kept
       * anything at all.
       */
      if (decision === 'always') {
        const access = pending?.detail.kind === 'project_access' ? pending.detail : null
        const agents = pending?.detail.kind === 'agent_start' ? pending.detail : null
        set({
          toast: access
            ? // A cross-project consent is remembered by the host for the pair, not by a matcher (#371)
              `Always allowed: ${access.from.name} → ${access.to.name}. Revoke it in Settings.`
            : agents
              ? // Starting agents (#561): this session while the app runs, or the whole project (stored, revocable)
                scope === 'project'
                ? `Sessions in ${agents.project.name} may start agents. Revoke it in Settings.`
                : 'This session may start agents until Centralu restarts.'
            : matcher
              ? `Always allow in ${scope === 'project' ? 'this project' : 'this session'}: ${matcher}`
              : 'Allowed once — this kind of request cannot be always-allowed yet',
        })
      }
      /*
       * Letting an edit or a command through means the tree is **about to** move (issue #41).
       *
       * Waiting for `turn_complete` alone would freeze the count for as long as the turn
       * runs — ten minutes of watching an agent edit twenty files while the sidebar insists
       * nothing has changed. A denial changes nothing, so it buys no refresh, and neither
       * does an `other` approval, which is by definition something we cannot read.
       *
       * The debounce is what makes this affordable: a run of approvals costs one status.
       */
      const changing =
        decision !== 'deny' && (pending?.detail.kind === 'file_edit' || pending?.detail.kind === 'command')
      const projectId = get().sessions[sessionId]?.projectId
      if (changing && projectId) get().refreshProjectGit(projectId)
    } catch (e) {
      set({ toast: (e as Error).message || 'Could not send the approval' })
    } finally {
      // A failure must allow pressing it again. A success already dismissed the card, so the `pendingApproval` check above blocks a repeat
      set((s) => {
        const { [flight]: _done, ...rest } = s.approvalsInFlight
        return { approvalsInFlight: rest }
      })
    }
  },

  /** Answers a set of options — the answer reaches the model as that tool's result */
  async answerQuestion(sessionId, requestId, answers) {
    try {
      await get().platform!.agents.answerQuestion(sessionId, requestId, answers)
      return true
    } catch (e) {
      set({ toast: (e as Error).message || 'Could not send the answer' })
      return false
    }
  },

  async interrupt(sessionId) {
    try {
      await get().platform!.agents.interrupt(sessionId)
    } catch (err) {
      // Silence after failing to stop would leave someone believing it stopped and waiting — the exact kind of failure this project forbids
      set({ toast: `Could not stop: ${(err as Error).message}` })
    }
  },

  async stopBackgroundTask(sessionId, taskId) {
    try {
      await get().platform!.agents.stopBackgroundTask(sessionId, taskId)
    } catch (err) {
      // The same rule as interrupt: a task that did not stop must not look stopped
      set({ toast: `Could not stop the task: ${(err as Error).message}` })
    }
  },

  async clearBackgroundTasks(sessionId) {
    try {
      await get().platform!.agents.clearBackgroundTasks(sessionId)
    } catch (err) {
      set({ toast: `Could not clear the list: ${(err as Error).message}` })
    }
  },

  /**
   * Moves a session to the trash (#204). The toast says where it went: a session that leaves the sidebar with no word
   * about where is the retired archive again (FR-20).
   */
  async deleteSession(sessionId, deleteWorktree, deleteExternal) {
    const platform = get().platform
    if (!platform) return
    const name = get().sessions[sessionId]?.name ?? 'Session'
    try {
      await platform.agents.deleteSession(sessionId, deleteWorktree, deleteExternal)
      set({ toast: `Moved to the trash: ${name} — Settings → Trash restores it` })
    } catch (e) {
      set({ toast: `Could not delete: ${(e as Error).message}` })
    }
  },

  async restoreFromTrash(sessionId) {
    const platform = get().platform
    if (!platform) return 'Not connected'
    try {
      const { session, project } = await platform.trash.restore(sessionId)
      if (project && !get().projects[project.id]) {
        set((s) => ({
          projects: { ...s.projects, [project.id]: project },
          trustAsk: project.trusted ? s.trustAsk : project.id,
        }))
      }
      // The host announces it too; this is the same path, so hearing it twice registers it once
      get().dispatchEvent({ type: 'session_created', sessionId: session.id, session } as NormalizedEvent)
      set({ toast: `Restored: ${session.name}` })
      return null
    } catch (e) {
      return (e as Error).message
    }
  },

  async refreshMcpProposals() {
    const platform = get().platform
    if (!platform) return
    try {
      const r = await platform.agents.mcpProposals()
      set({ mcpProposals: r.proposals })
      syncBadge(get)
    } catch {
      /* The app is fine even if the suggestion list fails to load — the next event calls it again */
    }
  },

  async resolveMcpProposal(name, approve) {
    const platform = get().platform
    if (!platform) return
    try {
      await platform.agents.resolveMcpProposal(name, approve)
      set({
        toast: approve
          ? `Installing ${name} — restarting the orchestrator so it can use the new tools`
          : `Dismissed MCP proposal: ${name}`,
      })
    } catch (e) {
      set({ toast: `Could not resolve the proposal: ${(e as Error).message}` })
    }
    await get().refreshMcpProposals()
  },

  async refreshSkillProposals() {
    const platform = get().platform
    if (!platform) return
    try {
      const r = await platform.agents.skillProposals()
      set({ skillProposals: r.proposals })
      syncBadge(get)
    } catch {
      /* The app is fine even if this fails to load — the next event calls it again */
    }
  },

  async resolveSkillProposal(name, approve) {
    const platform = get().platform
    if (!platform) return
    try {
      await platform.agents.resolveSkillProposal(name, approve)
      set({
        toast: approve
          ? `Skill saved: ${name} — restarting the orchestrator so it takes effect`
          : `Dismissed skill proposal: ${name}`,
      })
    } catch (e) {
      set({ toast: `Could not resolve the proposal: ${(e as Error).message}` })
    }
    await get().refreshSkillProposals()
  },

  async handoffSession(sessionId, opts) {
    const s = get()
    const session = s.sessions[sessionId]
    const project = session?.projectId ? s.projects[session.projectId] : null
    if (!s.platform || !session || !project || handoffInFlight.has(sessionId)) return
    const heirTool = opts?.tool ?? session.tool
    const mode = opts?.mode ?? 'agent'
    // The record mode's default is to **preserve** — the original of a session that cannot respond is kept until its successor is confirmed (#78)
    const deleteOld = opts?.deleteOld ?? mode === 'agent'
    // A worktree session cannot hand off yet. A session with worktree children can since #561: they outlive it (they
    // used to pin a worktree manager, whose delete refused while one was unmerged)
    if (session.worktree) {
      set({ toast: 'Worktree sessions cannot hand off yet — merge or delete them first' })
      return
    }
    /*
     * The path that asks the agent for a note **never starts while a card is up** (#174). The request
     * travels as an ordinary message, so if exactly one question is open, that message becomes the
     * question's answer (`send`), and the agent would receive the handoff request text as the answer
     * to "Which DB?" — an answer that has already reached the agent cannot be taken back. With several
     * questions open, or an approval pending, it becomes a new turn instead and the card is dropped.
     * Record mode never asks the agent, so it proceeds regardless. The sidebar's confirmation window
     * checks the same condition (`handoffBlockedBy`).
     */
    const blocked = mode === 'agent' ? handoffBlockedBy(session) : null
    if (blocked) {
      set({ toast: `Answer the open ${blocked} first, or hand off from the record` })
      return
    }
    handoffInFlight.add(sessionId)
    try {
      /*
       * The note's location is decided and written by the host (#142) — under the data folder, at
       * `handoff/<project id>/<departing session id>.md`. This used to clear that spot inside the
       * project first (#104: a file left by a past failure was then delivered as if it were the
       * freshly written note). Now the file is only returned as a path **after** the host has
       * overwritten it with this handoff's text, so there is no way to read a leftover file.
       */
      let note = ''
      let notePath = ''
      if (mode === 'record') {
        /*
         * Record mode (#78): asks the agent **nothing at all** — the reason this mode exists is
         * precisely that the agent cannot respond. The host builds the record from the store's own
         * transcript (plus, for a codex rollout, its compaction summaries).
         *
         * The host writes this to **the same file** as agent mode (#102) — only the producer differs,
         * and the first message the successor receives is identical between the two modes. The `text`
         * returned here is only for the preview.
         */
        const record = await s.platform.agents.exportHandoffRecord(sessionId, heirTool)
        note = record.text
        notePath = record.path
      } else {
      /*
       * If a turn is running, the request **waits for it to finish** first (measured in the Mea session: a
       * handoff where the prompt merged into (steered) the turn already in progress, so the report of the
       * work just done ended up glued to the top of the handoff note. Nothing was actually lost, but it read
       * as "a note with its beginning cut off"). Sending only after the turn boundary makes sure the reply
       * that follows is the handoff, whole.
       */
      const quietBy = Date.now() + 10 * 60_000
      while (get().sessions[sessionId]?.state === 'working') {
        if (Date.now() > quietBy) throw new Error('the session never finished its current turn')
        await new Promise((r) => setTimeout(r, 500))
      }
      if (!get().sessions[sessionId]) throw new Error('the session disappeared')

      const prompt = handoffPrompt()
      /*
       * The last recorded point right before sending the request — the host reads the first human
       * message after this point as the request, and the reply after that as the note. Even if a
       * past handoff failed and the same request and its reply are still sitting in the conversation,
       * they are before this point. The point is asked of the host's own record: the screen's
       * `lastSeq` does not count a sent message until its confirmation (`user_message`) arrives, so it
       * can lag, and the first human message after a lagging point would not be this request.
       */
      const before = (await s.platform.agents.loadMessages(sessionId, 1)).at(-1)?.seq ?? 0
      await get().send(sessionId, prompt)
      // A send failure flows through the composer-restore path and leaves the prompt in the draft — since this was never written by the person, it is cleared
      if (!(get().chat[sessionId] ?? []).some((i) => i.kind === 'user' && i.text === prompt)) {
        if (get().drafts[sessionId]?.text.includes(prompt)) get().setDraft(sessionId, EMPTY_DRAFT)
        throw new Error('could not reach the session')
      }

      /*
       * **Waits for the turn to finish, then receives the note from the host** (#142) — never
       * scraped from the on-screen conversation (measured: leftover output from a turn still in
       * progress mixed into the top of the text and read as "cut off"). The host reads the last reply
       * after the request message from its own record and places it as a file. If the turn is still
       * running or there is no reply yet, it returns `null` and this asks again. Nothing is cleared if
       * no reply ever arrives.
       *
       * The received text is never sent whole to the successor (#102) — a preview is extracted, and
       * the full text is embedded in the record instead, because this text cannot be recreated once
       * the predecessor is gone.
       */
      const deadline = Date.now() + 10 * 60_000
      for (;;) {
        await new Promise((r) => setTimeout(r, 500))
        const st = get()
        const cur = st.sessions[sessionId]
        if (!cur) throw new Error('the session disappeared while writing the note')
        if (cur.state === 'error') throw new Error('the session hit an error while writing the note')
        if (Date.now() > deadline) throw new Error('timed out waiting for the handoff note')
        if (st.connection !== 'connected') continue // No decision is made while disconnected
        if (cur.state === 'working' || cur.state === 'waiting_approval') continue
        const got = await s.platform.agents.exportHandoffNote(sessionId, before).catch(() => null)
        if (got) {
          note = got.text
          notePath = got.path
          break
        }
      }
      }

      /*
       * The new session inherits **every one** of the dying session's settings (the rule #37 taught:
       * carrying over only one leaves the rest born fresh with defaults). Except **when the tool
       * changes, nothing is carried over** — model, effort, verbosity and speed are all tool-specific
       * values, and passing them across tools either kills session creation outright or leaves a
       * setting silently wrong. The name is always inherited, regardless.
       */
      const sameTool = heirTool === session.tool
      const info = await get().createSession(session.projectId!, {
        tool: heirTool,
        model: sameTool ? (session.model ?? undefined) : undefined,
        effort: sameTool ? (session.effort ?? undefined) : undefined,
        verbosity: sameTool ? (session.verbosity ?? undefined) : undefined,
        serviceTier: sameTool ? (session.serviceTier ?? undefined) : undefined,
        permissionPreset: session.permissionPreset,
        initialPrompt: handoffOpening(session.name, note, notePath),
        // The note's full text goes into the record (#102), along with the id (#106) — that id is
        // what tells the host's cleanup this note still has an owner; without it, deleting the
        // predecessor is the same as deleting the note. Saying the predecessor goes next gives this session all of
        // its children, settled ones too, and the note lists them (#738)
        handoff: { from: session.name, note, fromSessionId: sessionId, ...(deleteOld ? { removesOriginal: true } : {}) },
      })
      await get().rename(info.id, session.name)

      /*
       * Grid slot succession (a dogfooding request, 2026-09-04): if the dying session was on the grid,
       * the successor takes its place at **the same index**. Emptying the slot with the delete and
       * then reinserting it would make the panel flicker away and reappear, shifting the order along
       * the way — so the swap happens before destruction. It swaps even with `deleteOld: false`: the
       * grid is a place for "sessions working right now," and the one that continues that work is the
       * successor — the surviving original is still reachable from the sidebar. `createSession` has
       * already focused the successor, so this only fixes up the lane (making it visible inside the
       * grid if it was on the grid).
       */
      const grid = get().gridPanels
      if (gridSessionIds(grid).includes(sessionId)) {
        await get().setGridPanels(
          grid.map((p) => (p.kind === 'session' && p.sessionId === sessionId ? { kind: 'session', sessionId: info.id } : p)),
        )
        get().focusSession(info.id, { preferGrid: true })
      }

      /*
       * **Nothing is cleaned up here** (#106).
       *
       * Cleanup has moved twice. The first time it was right here, right after `createSession` — the
       * successor had not even opened the file yet. #102 moved it to **the instant the successor's
       * first turn ends**, but that condition asks neither whether the turn succeeded nor whether the
       * note was ever read: in an actual incident, the first turn died with a 400 in under a second,
       * and the directory was empty within three minutes. What the successor received was a path to a
       * file that no longer existed, and that text can never be recreated — the predecessor who wrote
       * it had just been replaced.
       *
       * "Was it read" is not a fact we can observe. So the whole approach of hanging cleanup off a
       * turn is abandoned, and the two moments that cannot race the reader (session deletion, and
       * startup) are handed to the host instead (`manager.sweepOrphanHandoffNotes`). The cost of
       * leaving one extra file behind is close to zero — the note lives in the data folder, not the
       * user's repository (#142).
       */

      if (deleteOld) {
        // Destruction comes last — if this fails, both sessions are left standing (better than half deleted)
        await s.platform.agents.deleteSession(sessionId, false, true)
      }
      set({ toast: `Handed off: ${session.name}` })
    } catch (e) {
      // The next card after a live failure is record mode — the app tells the person instead of switching silently on its own (#78)
      const hint = mode === 'agent' ? ' — if the agent cannot respond, retry with "From the record"' : ''
      set({ toast: `Handoff failed: ${(e as Error).message}${hint}` })
    } finally {
      handoffInFlight.delete(sessionId)
    }
  },

  async switchTool(sessionId, tool) {
    const platform = get().platform
    if (!platform) return
    try {
      const info = await platform.agents.switchTool(sessionId, tool)
      set((s) => ({
        sessions: s.sessions[sessionId]
          ? {
              ...s.sessions,
              [sessionId]: {
                ...s.sessions[sessionId]!,
                tool: info.tool,
                /*
                 * The model and its dependent settings are decided by the host (see the comment on
                 * `manager.switchTool`) — if the screen did not follow along, the menu would keep
                 * showing 'sonnet' turned on while the session itself actually ran on codex's default,
                 * a screen that gets more wrong the more it is read.
                 */
                model: info.model,
                effort: info.effort,
                verbosity: info.verbosity,
                serviceTier: info.serviceTier,
                live: false,
              },
            }
          : s.sessions,
      }))
    } catch (e) {
      set({ toast: `Could not switch the agent: ${(e as Error).message}` })
    }
  },

  async updateSessionSettings(sessionId, s) {
    const platform = get().platform
    if (!platform) return
    try {
      const info = await platform.agents.updateSettings(sessionId, s)
      set(ifSessionStill(sessionId, (st, cur) => ({
        sessions: {
          ...st.sessions,
          [sessionId]: {
            ...cur,
            model: info.model,
            effort: info.effort,
            verbosity: info.verbosity,
            serviceTier: info.serviceTier,
            permissionPreset: info.permissionPreset,
            worktree: info.worktree,
          },
        },
      })))
      /*
       * States exactly what changed. This used to say "Perms:" for anything that was not the model —
       * so even changing effort showed "Perms: normal," and what the screen said no longer matched
       * what had just been done. (Adding verbosity, #54, created a third place to lie, which is why
       * this is being fixed now.)
       */
      const changed =
        s.model !== undefined
          ? `Model: ${info.model ?? 'Default'}`
          : s.effort !== undefined
            ? `Effort: ${info.effort ?? 'default'}`
            : s.verbosity !== undefined
              ? `Verbosity: ${info.verbosity ?? 'default'}`
              : s.serviceTier !== undefined
                ? `Speed: ${info.serviceTier ?? 'default'}`
                : `Perms: ${info.permissionPreset}`
      /*
       * When it takes effect is also stated as it actually happened (#164). This used to always say
       * "(from next turn)," but the host could replace the process mid-turn on the spot and lose the
       * turn in progress. It now returns what the host actually did.
       */
      const when =
        info.applied === 'restarted' ? 'agent restarted'
        : info.applied === 'after_turn' ? 'applies when this turn ends'
        : 'from next turn'
      set({ toast: `${changed} (${when})` })
    } catch (e) {
      set({ toast: `Could not change settings: ${(e as Error).message}` })
    }
  },


  /**
   * Restarts only the agent. The conversation record is left as is; only the process is replaced —
   * creating a new session when a tool goes unresponsive would cut off the context.
   */
  /**
   * Wakes a sleeping session ahead of time (the instant it is picked).
   *
   * **A failure leaves its reason behind.** It is not raised as a toast — that would make the screen
   * noisy while someone is scanning through the list. Instead it is written onto that session's own
   * hint line, so whoever is looking can see why it is not resuming.
   */
  /**
   * After reconnecting, **revives sessions that were running.**
   *
   * When the host dies, the supervisor brings it back up (up to five times, with exponential
   * backoff), but that new host **knows none of the agent processes that were alive** — they died
   * along with it, and the new host's memory starts empty. So every session was left sitting asleep
   * on screen, and the person had to press each one by hand to wake it (dogfooding: "the session
   * connection drops in other places too").
   *
   * **The UI knows** what was running — the live state from right before the disconnect is right
   * here, and revival works from that. An archived session and one that was already asleep to begin
   * with are left untouched: using the disconnect as an excuse to turn on something the person never
   * turned on would not be recovery, it would be a different action entirely.
   */
  /**
   * Sidebar order.
   *
   * **The screen changes first, and the save follows.** If a dragged item waited for a round trip to
   * the server before moving, the hand would feel like it stumbled. If saving fails, it reverts to
   * whatever the host says is true — it is never left silently out of sync.
   */
  async reorderProjects(orderedIds) {
    const platform = get().platform
    if (!platform) return
    const before = get().projects
    set({ projects: Object.fromEntries(orderedIds.map((id) => [id, before[id]!]).filter(([, v]) => v)) })
    try {
      const fresh = await platform.projects.reorder(orderedIds)
      set({ projects: Object.fromEntries(fresh.map((p) => [p.id, p])) })
    } catch (e) {
      set({ projects: before, toast: `Could not save order: ${(e as Error).message}` })
    }
  },

  goBack() {
    navigate(get, set, -1)
  },

  goForward() {
    navigate(get, set, 1)
  },

  setView(view) {
    /*
     * Picking a screen = having passed the intro (#63).
     *
     * A person who clicks the grid or the orchestrator from the sidebar beside the intro screen is
     * saying "enough explaining, I want to use the app." If that click did not change the screen, the
     * button would look broken; hiding the button instead would force reading the intro — squarely
     * against this onboarding's premise of never forcing a conversation.
     */
    set({ view, introSeen: true })
    get().saveWorkspace()
  },

  async openOrchestrator() {
    const platform = get().platform
    if (!platform) return
    /*
     * The screen changes first. Even if the lookup is slow, if nothing happens in the meantime, the
     * person who clicked assumes the button is dead — the same reason a message is marked "working"
     * the instant it is sent.
     */
    // Landing here also counts as having passed the intro (the same reason as `setView`, #63)
    set({ view: 'orchestrator', introSeen: true })
    get().saveWorkspace()
    try {
      /*
       * **Only asks — never creates** (#63, deferred startup). Opening the screen and creating the
       * process are now separate: if there is none, an empty conversation (with suggested-question
       * cards) stands, and creation happens only in `askOrchestrator`, at the moment the first
       * question is asked. Creating it here as before would bring up a tool process for a person who
       * never even asked for it.
       */
      const info = await platform.agents.orchestratorPeek()
      if (!info) return
      set((s) => ({
        orchestratorId: info.id,
        sessions: {
          ...s.sessions,
          [info.id]: s.sessions[info.id] ?? initialSession({ ...info, projectId: null }),
        },
      }))
      // This is also a point where a session is first registered — replays any events held in the pen
      replayPendingEvents(get)
      if (!get().chat[info.id]) void get().loadHistory(info.id)
    } catch (e) {
      // If it could not be opened, the view reverts — the worst outcome is leaving an empty screen up with no explanation
      set({ view: 'focus', toast: `Could not open the orchestrator: ${(e as Error).message}` })
    }
  },

  async askOrchestrator(text) {
    const platform = get().platform
    if (!platform) return false
    let id = get().orchestratorId
    if (!id) {
      // The first question is the birth itself (#63) — the process comes up only the instant a card is pressed
      set({ orchestratorWaking: true })
      try {
        const info = await platform.agents.orchestrator()
        set((s) => ({
          orchestratorId: info.id,
          sessions: {
            ...s.sessions,
            [info.id]: s.sessions[info.id] ?? initialSession({ ...info, projectId: null }),
          },
        }))
        replayPendingEvents(get)
        id = info.id
      } catch (e) {
        set({ toast: `Could not start the orchestrator: ${(e as Error).message}` })
        return false
      } finally {
        set({ orchestratorWaking: false })
      }
    }
    // A failure from this point on has `send` put the text back into the composer (now the draft of a real session)
    await get().send(id, text)
    return true
  },

  async completeIntro(tool) {
    const platform = get().platform
    /*
     * The screen is passed through first — a failed setting save must not trap the person on the intro
     * screen (it runs on the default, claude). Clicking the card only records the setting; no process
     * comes up.
     */
    set({ introSeen: true })
    get().saveWorkspace()
    try {
      await platform?.agents.configureOrchestrator(tool)
    } catch (e) {
      set({ toast: `Could not save the choice: ${(e as Error).message}` })
    }
    void get().openOrchestrator()
  },

  /**
   * Saves the whole arrangement (adding, removing and reordering all arrive as this one action).
   *
   * The screen changes first and the save follows — if a dropped panel waited for a round trip to
   * the server before settling into place, the hand would feel like it stumbled. A failure reverts to
   * whatever the host says is true.
   */
  async setGridPanels(panels) {
    const platform = get().platform
    if (!platform) return
    const before = get().gridPanels
    /*
     * An app panel taken off the grid closes its view, teardown first — the project screen's × rule (#288). Here
     * rather than at the grid's ×, so every way a panel leaves the list (the ×, a test, a future caller) takes its view
     * with it instead of leaving a frame alive behind a screen that no longer shows it. The view is not inside the
     * panel (it is laid over it from PinnedApps), so the panel leaving first does not cut teardown off: the frame stays
     * in the document, hidden, until `dismissPinnedView` has had its answer.
     */
    const kept = new Set(panels.map(gridPanelKey))
    for (const p of before) {
      if (p.kind === 'app' && !kept.has(gridPanelKey(p))) void get().dismissPinnedView(gridAppViewKey(p.projectId, p.appId, p.machine))
    }
    set({ gridPanels: panels })
    try {
      set({ gridPanels: sanitizeGridPanels(await platform.agents.setGridView(panels)) })
    } catch (e) {
      set({ gridPanels: before, toast: `Could not save layout: ${(e as Error).message}` })
    }
  },

  async reorderSessions(projectId, orderedIds) {
    const platform = get().platform
    if (!platform) return
    const before = get().sessions
    // Only this project's sessions get the new order; everything else stays exactly where it was
    const mine = new Set(orderedIds)
    const reordered: typeof before = {}
    for (const [id, s] of Object.entries(before)) {
      if (!mine.has(id)) reordered[id] = s
    }
    for (const id of orderedIds) if (before[id]) reordered[id] = before[id]!
    set({ sessions: reordered })
    try {
      await platform.agents.reorderSessions(projectId, orderedIds)
    } catch (e) {
      set({ sessions: before, toast: `Could not save order: ${(e as Error).message}` })
    }
  },

  async recoverAfterReconnect(resync = false) {
    const s = get()
    if (!s.platform) return
    // An install/check can end on the outgoing host without its final event reaching this window.
    // Re-read only: replaying an install after a swap could run it twice.
    void get().checkUpdate(false)
    // Resolves whether a message being sent at the moment of disconnect reached the host (#173)
    void settleUnsureSends(get, set)
    // Broadcasts from the gap while disconnected never come again — the app list (A-8) is also aligned to whatever the host currently knows
    void get().refreshExternalApps()
    void get().refreshAppQuestions()
    // So is a proposal list change (#703): a missed `orchestrator_proposals_changed` leaves a card, the count and the badge stale
    void get().refreshMcpProposals()
    void get().refreshSkillProposals()
    // So are the links' states (#82): a machine that went away or came back during the gap
    void get().refreshMachines()
    // The pinned views this window shows are leased to its connection, which just ended (#392)
    void holdPinnedViews(get, set)

    const wasLive = Object.values(s.sessions).filter((x) => x.live)
    const platform = s.platform
    const generation = ++recoveryGeneration

    /*
     * A failed read is tried again while this connection lasts (`RECOVERY_RETRY_MS`). Giving up at once left the
     * gap unrecovered until the next reconnect: no session created or deleted meanwhile, no conversation re-read.
     * A newer recovery, a drop (the reconnect recovers again) or a new platform ends the retries.
     */
    let fresh: SessionInfo[] | null = null
    let asked: Record<string, SessionSummary> = {}
    const watch = watchLiveEvents()
    try {
      for (let attempt = 0; ; attempt++) {
        asked = get().sessions
        watch.touched.clear()
        fresh = await platform.agents.listSessions().catch(() => null)
        if (fresh) break
        const wait = RECOVERY_RETRY_MS[attempt]
        if (wait === undefined) return
        await new Promise((r) => setTimeout(r, wait))
        if (generation !== recoveryGeneration || get().platform !== platform || get().connection !== 'connected') return
      }
    } finally {
      watch.stop()
    }
    const listed = fresh

    /*
     * **The new host's list is merged in, never discarded.**
     *
     * This used to use `fresh` only to decide `live` and throw the rest away — a session created,
     * renamed or deleted elsewhere (a different app, a terminal) while disconnected stayed invisible
     * until the app was closed and reopened. Only the facts the host knows (name, state, read
     * position, approval/questions/limit, …) are overwritten; local derived state (preview,
     * `touchedPaths`, …) belongs to the reducer and is preserved.
     * Approval and questions also have the host as their source of truth — they could have been
     * resolved or newly arrived while disconnected, and keeping the local ones would leave behind a
     * card for a dead `requestId`.
     */
    set((st) => {
      /*
       * The remains of a session deleted while disconnected are cleared the way `session_deleted` clears them: that
       * event fell into the gap and is never replayed, so this is the only place they can go (#163). What changed
       * while the list was out is kept over the list's older rows (`mergeListedSince`).
       */
      const { sessions, gone } = mergeListedSince(asked, st.sessions, listed, watch.touched)
      return {
        sessions,
        ...forgetSessions(st, gone),
        // Same reason as attach: a session may have been working across the gap, and the
        // sessions that vanished should not leave their instants behind (issue #23)
        workingSince: trackWorkingSince(st.workingSince, sessions, Date.now()),
      }
    })
    // If the merge registered a session for the first time, replay any events held in the pen from before it was registered
    replayPendingEvents(get)
    get().pruneFoldedGroups()

    /*
     * Resync: events from the gap never come again — the screen's conversation is merged with the
     * store's own truth (`mergePage` fills the gap).
     *
     * **Every session holding a conversation, not just the one being viewed** (#173). This used to
     * re-read only the focused session, leaving every other session's conversation holding onto its
     * gap. Opening that session later would not re-read history, since a cursor already exists, so
     * the gap stayed unfilled until the app itself was reopened. A resync is rare, so the cost of
     * reading one page per session is affordable.
     */
    const focused = get().focusedSessionId
    if (resync) {
      const holding = new Set(Object.keys(get().chat))
      if (focused) holding.add(focused)
      for (const id of holding) if (get().sessions[id]) void get().loadHistory(id)
    }

    // Only revives a process that was running right before the disconnect but that the new host does not know about
    const alive = new Set(listed.filter((x) => x.live).map((x) => x.id))
    /*
     * Never one on a machine that is away (#82): the hub listed it from its mirror, and waking it would only fail there.
     * That machine's own `machine_resync` wakes what has to be woken once it is back (`recoverMachine`).
     */
    const toWake = wasLive.filter(
      (x) => !alive.has(x.id) && get().sessions[x.id] && !isAway(get().sessions[x.id], get().machines),
    )
    if (toWake.length === 0) return

    set({ toast: `Reconnected — resuming ${toWake.length} session${toWake.length > 1 ? 's' : ''}` })
    // The merge already reflects the host's `live: false`, so `wake` never mistakenly thinks it is already alive
    for (const x of toWake) await get().wake(x.id)
  },

  async wake(sessionId) {
    const s = get()
    const session = s.sessions[sessionId]
    if (!s.platform || !session || session.live || s.resuming[sessionId]) return
    // A session on a machine that is away is never woken (#82): only its machine's resync does that, once it is back
    if (isAway(session, s.machines)) return

    set((st) => ({ resuming: { ...st.resuming, [sessionId]: true } }))
    try {
      const res = await s.platform.agents.resumeSession(sessionId)
      set(
        ifSessionStill(sessionId, (st, cur) => ({
          sessions: { ...st.sessions, [sessionId]: { ...cur, live: res.resumed } },
          wakeError: res.resumed
            ? omitKey(st.wakeError, sessionId)
            : { ...st.wakeError, [sessionId]: res.reason ?? 'unknown reason' },
          wakeLocked:
            res.resumed || !res.lockedElsewhere
              ? omitKey(st.wakeLocked, sessionId)
              : { ...st.wakeLocked, [sessionId]: true },
        })),
      )
    } catch (e) {
      set(
        ifSessionStill(sessionId, (st) => ({
          wakeError: { ...st.wakeError, [sessionId]: (e as Error).message },
          wakeLocked: omitKey(st.wakeLocked, sessionId),
        })),
      )
    } finally {
      set((st) => {
        const next = { ...st.resuming }
        delete next[sessionId]
        return { resuming: next }
      })
    }
  },

  async forkConversation(sessionId) {
    const s = get()
    if (!s.platform || s.resuming[sessionId]) return
    set((st) => ({ resuming: { ...st.resuming, [sessionId]: true } }))
    try {
      const res = await s.platform.agents.forkConversation(sessionId)
      set(ifSessionStill(sessionId, (st, cur) => ({
        sessions: { ...st.sessions, [sessionId]: { ...cur, live: res.resumed } },
        wakeError: res.resumed
          ? omitKey(st.wakeError, sessionId)
          : { ...st.wakeError, [sessionId]: res.reason ?? '' },
        // Once forked, it is no longer locked — if it failed, the fork option is left standing
        wakeLocked: res.resumed ? omitKey(st.wakeLocked, sessionId) : st.wakeLocked,
        toast: res.resumed
          ? 'Continuing in a forked conversation — the original is untouched'
          : `Could not fork: ${res.reason ?? 'unknown reason'}`,
      })))
    } catch (e) {
      set({ toast: `Could not fork: ${(e as Error).message}` })
    } finally {
      set((st) => {
        const next = { ...st.resuming }
        delete next[sessionId]
        return { resuming: next }
      })
    }
  },

  async restartSession(sessionId) {
    const platform = get().platform
    /*
     * **Prevents a second press** (dogfooding).
     *
     * Restarting kills the process and brings it back up, which takes a few seconds, and the screen
     * stayed silent through it. So the person pressed it again, and the second press **killed the
     * process that had just come up** — the exact button pressed to fix something was the one causing
     * the breakage.
     *
     * The lock is the same `resuming` that `wake` and `fork` use. All three state the same fact — "this
     * session's process is being replaced right now" — so keeping a separate indicator for each would
     * leave one button looking fine while another was mid-flight.
     */
    if (!platform || get().resuming[sessionId]) return false
    set((s) => {
      const sessions = { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, state: 'idle' as const } }
      // Restarting ends whatever turn was running — its clock goes with it (issue #23)
      return {
        sessions,
        workingSince: trackWorkingSince(s.workingSince, sessions, Date.now()),
        resuming: { ...s.resuming, [sessionId]: true },
      }
    })
    try {
      const r = await platform.agents.restartSession(sessionId)
      set(
        ifSessionStill(sessionId, (s, cur) => ({
          sessions: { ...s.sessions, [sessionId]: { ...cur, live: r.resumed } },
          wakeError: r.resumed
            ? omitKey(s.wakeError, sessionId)
            : { ...s.wakeError, [sessionId]: r.reason ?? '' },
          toast: r.resumed ? 'Agent restarted' : `Could not restart: ${r.reason ?? ''}`,
        })),
      )
      return r.resumed
    } catch (e) {
      // Letting this throw and stop here would leave the lock stuck forever — the button would stay dead
      set({ toast: `Could not restart: ${(e as Error).message}` })
      return false
    } finally {
      set((s) => ({ resuming: omitKey(s.resuming, sessionId) }))
    }
  },

  /**
   * Renaming a session (issue #5).
   *
   * **Passed to the host first, and the screen is fixed only after.** Drawing it optimistically first
   * would leave the new name on screen and the old one in the database on failure — the moment the
   * list is re-fetched, the name would revert with no explanation. This is a kind of mistake this
   * store has been burned by more than once. A failure is raised as a toast the same way as
   * `respondApproval`/`answerQuestion`.
   */
  async rename(sessionId, name) {
    const next = name.trim()
    if (!next) {
      set({ toast: 'Session name cannot be empty' })
      return
    }
    try {
      await get().platform!.agents.rename(sessionId, next)
    } catch (e) {
      set({ toast: `Could not rename: ${(e as Error).message}` })
      return
    }
    set(ifSessionStill(sessionId, (s, cur) => ({ sessions: { ...s.sessions, [sessionId]: renamePure(cur, next) } })))
  },

  async markRead(sessionId) {
    const s = get().sessions[sessionId]
    if (!s || s.lastReadSeq >= s.lastSeq) return
    await get().platform!.agents.markRead(sessionId, s.lastSeq)
    set(ifSessionStill(sessionId, (st, cur) => ({ sessions: { ...st.sessions, [sessionId]: markReadPure(cur, s.lastSeq) } })))
  },
  ...appActions(set, get),
  ...eventActions(set, get),
}))

/**
 * Live subscriptions. Kept at module scope rather than in the store's state — a value the screen has
 * no reason to re-render on, so putting it in state would only add unnecessary renders.
 */
const subscriptions: (() => void)[] = []

function detachAll(): void {
  for (const off of subscriptions.splice(0)) off()
}

/** The last clean read of each theme file: a clean entry replaces it, a broken one leaves it (see `lastGoodThemes`) */
function goodThemes(prev: Record<string, ThemeFileEntry>, files: readonly ThemeFileEntry[]): Record<string, ThemeFileEntry> {
  const next: Record<string, ThemeFileEntry> = {}
  for (const f of files) {
    const good = f.broken ? prev[f.id] : f
    if (good) next[f.id] = good
  }
  return next
}

/** The theme files to apply: a broken one stands in as its last clean version, if it ever had one */
export function usableThemeFiles(s: { themeFiles: ThemeFileEntry[]; lastGoodThemes: Record<string, ThemeFileEntry> }): ThemeFileEntry[] {
  return s.themeFiles.map((f) => (f.broken ? (s.lastGoodThemes[f.id] ?? f) : f))
}

/** True while `navigate` puts a recorded screen back, so `recordScreen` does not record it as a new visit */
let navigating = false

function navigate(get: () => AppState, set: (partial: Partial<AppState>) => void, dir: -1 | 1): void {
  const st = get()
  const { history, screen } = step(st.nav, dir, (x) => screenExists(st, x))
  navigating = true
  try {
    if (history !== st.nav) set({ nav: history })
    if (!screen) return
    /*
     * Through the same doors a click uses, so a screen comes back exactly as it opens: a session unfolds its
     * project, an app gets its pinned view, Settings opens on the category it was left on.
     */
    if (screen.kind === 'settings') {
      st.toggleSettings(true)
      return
    }
    if (get().settingsOpen) st.toggleSettings(false)
    switch (screen.kind) {
      case 'session':
        st.focusSession(screen.id)
        break
      case 'project':
        st.focusProject(screen.id)
        break
      case 'app':
        st.openApp(screen.projectId, screen.appId, { machine: screen.machine })
        break
      case 'grid':
      case 'orchestrator':
        st.setView(screen.kind)
        break
    }
  } finally {
    navigating = false
  }
}

/**
 * Records every screen change (#374), from whatever action made it — the one place history is written. A change
 * inside a screen (a keystroke, a session picked inside the grid, a panel moved) leaves the screen the same and adds
 * nothing (`visit` folds a repeat). Closing Settings steps back over it (`closeLayer`).
 */
function recordScreen(next: AppState, prev: AppState): void {
  if (navigating || restoringWorkspace) return
  const now = screenOf(next)
  if (!now || sameScreen(now, screenOf(prev) ?? undefined)) return
  const nav = prev.settingsOpen && !next.settingsOpen ? closeLayer(next.nav, now) : visit(next.nav, now)
  if (nav !== next.nav) useStore.setState({ nav })
}

useStore.subscribe(recordScreen)
