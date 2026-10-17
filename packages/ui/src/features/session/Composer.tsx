import { memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { Ref } from 'react'
import {
  EMPTY_DRAFT,
  composerTarget,
  useStore,
  type ChatAttachment,
  type Draft,
} from '../../store/store.js'
import { useShortcut } from '../../app/shortcut.js'
import { approvalCardCovered } from '../approval/ApprovalCard.jsx'
import { CloseIcon, PlusIcon, SendIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { AttachmentStrip } from './chat-rows/attachments.jsx'
import { AutocompleteMenu, suggestionId, useAutocomplete, type Suggestion } from './Autocomplete.jsx'
import { guiCommandFor } from './guiCommands.js'
import { onFirstLine, onLastLine, sentMessages, stepHistory } from './history.js'
import { onFirstVisualLine, onLastVisualLine } from './caret.js'
import { fitHeight } from './composerFit.js'
import { autocompleteKeyAction, isComposerSendKey } from './composerKeys.js'
import { composerFocusAnswer } from './composerFocus.js'
import { composingKey } from '../../app/keys.js'
import { appendPath, isFileDrag, isOsFileDrag, readDragPath } from '../files/dragPath.js'
import type { AppLinkDrop } from '../app-frame/dragRelay.js'
import { droppedPiece, droppedText, insertAtCaret, isTextDrag, type DroppedText } from './dragLink.js'
import { appReachNotice } from './appReachNotice.js'
import { usePlatform } from '../../app/PlatformProvider.js'
import { ComposerFooter } from './ComposerFooter.jsx'
import { EMPTY_CHAT, EMPTY_QUESTIONS } from './empty.js'

/** The maximum height the composer can grow to. Must match CSS's max-h-40 */
const COMPOSER_MAX_H = 160

/**
 * A handle that lets the composer take over handling a drop received from outside it (#116).
 *
 * What it returns is "did something actually go in" — if a file is too large or saving fails,
 * nothing goes in. Expanding a collapsed composer before that check would bring up an empty
 * field that looks as if something had happened.
 */
export type ComposerDrop = {
  accept: (dt: DataTransfer) => Promise<boolean>
  /** An item dragged out of an app view and dropped on the pane (#308, app-frame/dragRelay.ts) */
  acceptAppLink: (drop: AppLinkDrop) => boolean
}

/** When the person last pressed Tab: a focus that follows it is theirs (#590) */
let lastTabAt = 0
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') lastTabAt = performance.now()
  }, true)
}
function tabbedRecently(): boolean {
  return performance.now() - lastTabAt < 500
}

/**
 * The composer (FR-7).
 *
 * **There is exactly one reason this is a separate component: the draft lives in the global
 * store.** An unsent draft belongs to the session, so it has to live in the store (see the
 * `draft` comment below), which means the store changes on every keystroke. While this code
 * lived inside SessionPane, that one keystroke re-rendered **the header, the chat stream, and
 * every message bubble on screen** (measured: 1.0 renders per character for the pane, 1.0 for
 * the stream, 2.0 for each row — doubled while a response was streaming). Typing has no reason
 * to cost something proportional to the size of the conversation.
 *
 * So the place that reads the draft has been narrowed down to just this one. Everything above
 * it now passes down only `sessionId`.
 *
 * Not subscribing to the conversation (`chat`) either, for the same reason — the only place
 * that needs it is recalling with the arrow keys, and that reads it with `getState()` at the
 * moment of the keypress. Subscribing to it would re-render the composer on every streaming
 * delta, undoing exactly the cost that was just moved out of it.
 */
export const Composer = memo(function Composer({
  sessionId,
  onMenuOpenChange,
  dropRef,
  framed = true,
}: {
  sessionId: string
  /** Whether the row's menu below is open — a collapsed composer must not fold away while it is (fold) */
  onMenuOpenChange?: (open: boolean) => void
  /** A handle that hands off anything dropped anywhere on the pane to this composer's own handling (#116) */
  dropRef?: Ref<ComposerDrop>
  /**
   * Whether to draw its own top border.
   *
   * When it sits directly below the conversation, that line is **the boundary between the
   * conversation and the composer.** But inside a collapsed card, the card's rounded border is
   * already the boundary, and a straight line drawn right below it looks like the corner ending
   * twice (reported by a user on 2026-09-10).
   */
  framed?: boolean
}) {
  /**
   * What the composer's text becomes for an open question (#125, #174).
   *
   * This subscribes to a narrowed-down string rather than the full array — subscribing to the
   * questions array directly would deliver a new reference every time, undoing exactly the
   * re-render this component was built to avoid. The judgment is the same one the store's send
   * uses (`composerTarget`): back when attachments were not looked at, attaching a file under
   * the "write an answer" prompt sent the text as a new turn instead, and the question was
   * dropped.
   */
  const target = useStore((s) =>
    composerTarget(s.sessions[sessionId]?.pendingQuestions ?? EMPTY_QUESTIONS, (s.drafts[sessionId]?.attachments.length ?? 0) > 0),
  )

  /*
   * Picks up **only what this actually needs** from the session.
   *
   * Subscribing to the whole session object would re-render the entire composer (the attachment
   * list, even the autocomplete menu) on every delta while a response streams — yet this
   * component only reads three things from the session, and none of the three ever changes
   * mid-conversation. Values that actually change, like model, permissions, and context, are
   * subscribed to separately by ComposerFooter (ComposerFooter.tsx).
   */
  const alive = useStore((s) => !!s.sessions[sessionId])
  const projectId = useStore((s) => s.sessions[sessionId]?.projectId ?? '')
  const isOrchestrator = useStore((s) => s.sessions[sessionId]?.kind === 'orchestrator')
  const send = useStore((s) => s.send)
  const wake = useStore((s) => s.wake)
  // Pulls out just this one setting — subscribing to the whole preferences record would
  // re-render the composer whenever any setting changes
  const sendWithModifierEnter = useStore((s) => s.prefs.sendWithModifierEnter)
  const sc = useShortcut()
  /*
   * An unsent draft belongs to **the session**, not to this component.
   *
   * Holding it with useState left the text stuck to that spot on screen. Since the focus view
   * reuses the same component when the session changes, whatever was being typed for session A
   * stayed sitting in session B's composer, and sending it went to the wrong session. In the
   * grid it was the opposite problem: switching screens unmounts the component, so the text
   * disappeared along with it — two symptoms of the same underlying cause.
   */
  const draft = useStore((s) => s.drafts[sessionId] ?? EMPTY_DRAFT)
  const setDraft = useStore((s) => s.setDraft)

  /*
   * An older message recalled with the arrow keys (#38). `at` is its position in history,
   * `text` is what is currently shown.
   *
   * **This never overwrites the unsent draft.** While browsing history, the composer shows this
   * value instead, and the session's draft is left untouched underneath. So stepping down once
   * more past the most recent entry brings the unsent draft right back — if this had instead
   * kept a separate copy of the draft, there would inevitably come a day (switching sessions,
   * a failed send) when that copy and the real draft fell out of sync.
   *
   * It is correctly component state: "which entry in history is being viewed" is a decision
   * made in this exact moment, not a fact about the session. It is cleared below whenever the
   * session changes.
   */
  const [recall, setRecall] = useState<{ at: number; text: string } | null>(null)
  const text = recall ? recall.text : draft.text
  const attachments = draft.attachments

  const patchDraft = useCallback(
    (patch: (cur: Draft) => Draft) => {
      setDraft(sessionId, patch(useStore.getState().drafts[sessionId] ?? EMPTY_DRAFT))
    },
    [sessionId, setDraft],
  )
  const setText = useCallback(
    (next: string | ((prev: string) => string)) => {
      // While editing a recalled message, edit that message — the draft is still left untouched
      if (recall) {
        setRecall({ ...recall, text: typeof next === 'function' ? next(recall.text) : next })
        return
      }
      patchDraft((cur) => ({ ...cur, text: typeof next === 'function' ? next(cur.text) : next }))
    },
    [patchDraft, recall],
  )
  const setAttachments = useCallback(
    (next: ChatAttachment[] | ((prev: ChatAttachment[]) => ChatAttachment[])) => {
      patchDraft((cur) => ({
        ...cur,
        attachments: typeof next === 'function' ? next(cur.attachments) : next,
      }))
    },
    [patchDraft],
  )
  // Stable, so the memoised attachment strip does not re-render on every keystroke
  const removeAttachment = useCallback(
    (index: number) => setAttachments((p) => p.filter((_, j) => j !== index)),
    [setAttachments],
  )
  const [dragging, setDragging] = useState(false)
  const [caret, setCaret] = useState(0)
  /*
   * Whether an IME is mid-composition (issue #12).
   *
   * This is the same fact #38 already reads off a `keydown`, held for longer. A key event can
   * only answer "is this keystroke the IME's"; the question here is "is the value in the box
   * finished", and that spans every event between `compositionstart` and `compositionend` —
   * a dozen of them for five Korean syllables.
   *
   * It gates autocomplete and nothing else. `한` arrives as `ㅎ`, `하`, `한`, and with `@` in
   * front each of those is an `fs.search` for a query the person never asked for. The text is
   * deliberately *not* gated: a composing character has to appear as it is typed, so the store
   * write behind `value` stays on every event, and so does the height measurement that keeps
   * that character from being clipped.
   *
   * Note this is not a claim about latency. It removes work; whether that is visible was never
   * measured (see the investigation on #12, which could not separate render cost from the
   * frame it was waiting for).
   */
  const [composing, setComposing] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pendingSelection = useRef<{ text: string; caret: number } | null>(null)
  const requestSelection = (next: { text: string; caret: number }) => {
    pendingSelection.current = next
    setCaret(next.caret)
  }
  /** The person pressed the composer, so the focus that follows is theirs (#590) */
  const pressed = useRef(false)
  const fileRef = useRef<HTMLInputElement>(null)
  /*
   * Takes the keyboard when asked to (#528): the session was just picked in the palette or created,
   * and what the person does next is type to it. Without this the palette's field and the dialog's
   * button left the keyboard on the page, and the first key went nowhere until a click in the box;
   * a Tab reached it only in WebKit on macOS. Asked through the store, since the palette and the
   * dialog never hold this element, and taken here once nothing covers the session: the dialog asks
   * while it is still closing. The rules (an approval card's keys, a field being typed in) are
   * `composerFocusAnswer`'s.
   */
  const focusAsked = useStore((s) => s.composerFocusFor === sessionId)
  const focusCovered = useStore((s) => s.composerFocusFor === sessionId && approvalCardCovered(s, sessionId))
  const focusApproval = useStore((s) => s.composerFocusFor === sessionId && !!s.sessions[sessionId]?.pendingApproval)
  useEffect(() => {
    const input = inputRef.current
    const answer = composerFocusAnswer({
      asked: focusAsked,
      covered: focusCovered,
      approval: focusApproval,
      holder: document.activeElement,
      input,
    })
    if (answer === 'wait') return
    if (answer === 'take') {
      // The app gives the keyboard here, the person did not ask to type yet: this focus does not wake (#590)
      input?.focus({ preventScroll: true })
    }
    if (useStore.getState().composerFocusFor === sessionId) useStore.getState().askComposerFocus(null)
  }, [sessionId, focusAsked, focusCovered, focusApproval])
  const attachFile = useStore((s) => s.attachFile)
  /*
   * Attachments still uploading (#180). A chip only enters the draft once the host has finished
   * storing it — sending before that only sent the text, and a chip that finished late got
   * attached to the draft afterward and rode along on the *next* message instead. While
   * something is uploading, nothing sends, and the list shows what it is waiting on.
   */
  const uploading = useStore((s) => s.uploading[sessionId] ?? 0)
  /*
   * The composer's height comes **from the value.**
   *
   * This used to touch `style.height` directly in onChange, which only kept the height correct
   * when the value changed through typing. After sending, `setText('')` cleared the value but
   * left the height standing, so an empty composer sat there tall — tall with nothing written
   * in it, and back to normal the moment anything was typed (found in dogfooding). Inserting a
   * long path through autocomplete had the opposite problem: it did not grow at all.
   *
   * The number of paths that change the value will only keep growing (paste, restoring a draft,
   * switching sessions...). Instead of re-fitting the height on every one of those paths, this
   * only ever watches the single value. It is a useLayoutEffect that measures before paint, so
   * there is no flicker.
   */
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    // Not off the box's own scrollHeight, which can come out a row too many in WebKit (#744)
    const wanted = fitHeight(el)
    if (wanted === null) el.style.height = 'auto'
    el.style.height = `${Math.min(wanted ?? el.scrollHeight, COMPOSER_MAX_H)}px`
  }, [text])

  // Apply the requested caret with its value, before another input event. A next-frame move
  // can collapse a newer selection (#368), making replacement text append to the old draft.
  // Consume on every commit: recalled entries can share both their text and their caret.
  useLayoutEffect(() => {
    const next = pendingSelection.current
    pendingSelection.current = null
    const el = inputRef.current
    if (!next || !el || el.value !== next.text) return
    el.focus()
    el.setSelectionRange(next.caret, next.caret)
  })

  /*
   * A switch to a different session undoes any recall in progress (#38).
   *
   * The focus view reuses this same component when the session changes. Without clearing it,
   * text recalled from A's history would still be sitting in B's composer, and that is exactly
   * the situation an unsent draft was moved to the session to prevent — sending it as-is would
   * go to the wrong session.
   *
   * Cleared before render (layout). As an effect, someone else's text would flash for one frame.
   */
  useLayoutEffect(() => setRecall(null), [sessionId])

  /*
   * The quiet line under a link dropped from an app this session cannot reach (#308): the link went
   * in, but the agent will not have the app's tools, and the line says what would give them. It is
   * about this session, so another session in the same composer (the focus view reuses it) clears
   * it, as does sending, dismissing it, or the next drop. `asked` drops a late answer to an earlier
   * drop.
   */
  const platform = usePlatform()
  const [appNotice, setAppNotice] = useState<{ text: string; reason: string } | null>(null)
  const asked = useRef(0)
  useLayoutEffect(() => {
    asked.current++
    setAppNotice(null)
  }, [sessionId])

  // Autocomplete: `/` for skills, `@` for files
  const suggestionsId = useId()
  const ac = useAutocomplete({
    sessionId,
    projectId,
    text,
    caret,
    // Not while composing (#12) — a half-formed syllable is not a query. Closing the menu also
    // hands the arrow keys back: the branch below that spends them on the list is behind `open`.
    enabled: alive && caret >= 0 && !composing,
    // The orchestrator's `@` picks a session — what it targets is a session, not a file.
    // Judged by an explicit marker (kind): the orchestrator has no file tree to pick from
    atSource: isOrchestrator ? 'sessions' : 'files',
  })

  const pick = (item: Suggestion) => {
    /*
     * A GUI command (2026-09-07): the moment it is picked from the list is the execution
     * itself — filling '/usage' into the composer and then requiring another Enter would turn
     * the promise "pressing Enter opens the screen" into two presses of Enter. This clears the
     * text and opens the screen instead.
     */
    // A session command's value has a trailing space — this does not intercept it when a real
    // skill of the same name is picked
    const gui = item.value.endsWith(' ') ? null : guiCommandFor(item.value)
    if (gui) {
      setRecall(null)
      setDraft(sessionId, EMPTY_DRAFT)
      gui.run({ sessionId })
      return
    }
    const next = ac.apply(item)
    requestSelection(next)
    setText(next.text)
  }

  /**
   * Recalls a sent message with the arrow keys (#38). Returns true when history took over —
   * in that case the caret does not move.
   *
   * The judgment lives in history.ts; the caret rule lives here. History only takes over when
   * all three hold:
   *  - autocomplete is closed (if it is open, the arrow key belongs to the list — the caller
   *    has already filtered that out)
   *  - no text is selected (an arrow key with a selection is a key that clears the selection)
   *  - the caret is on the first line for the up arrow, or the last line for the down arrow —
   *    **counting wrapped lines too**
   *
   * History is scanned from the conversation fresh each time. Precomputing it would mean
   * rescanning thousands of rows on every streaming delta, when it is only ever actually used
   * at the moment an arrow key is pressed.
   */
  const recallHistory = (el: HTMLTextAreaElement, dir: -1 | 1): boolean => {
    if (el.selectionStart !== el.selectionEnd) return false
    const caret = el.selectionStart
    /*
     * Newlines are checked first (a value comparison, free). Only what passes that gets
     * measured with the mirror — a long line that has wrapped has no newline, yet looks like
     * several lines, and an arrow key pressed in the middle of it belongs to the caret, not to
     * history (reported by a user on 2026-09-07).
     */
    const onEdge =
      dir === -1
        ? onFirstLine(text, caret) && onFirstVisualLine(el)
        : onLastLine(text, caret) && onLastVisualLine(el)
    if (!onEdge) return false

    const step = stepHistory({
      history: sentMessages(useStore.getState().chat[sessionId] ?? EMPTY_CHAT),
      at: recall?.at ?? null,
      dir,
    })
    if (step.kind === 'none') return false

    const next = step.kind === 'draft' ? draft.text : step.text
    /*
     * The caret goes to the end. A shell does the same, and for a single-line history entry,
     * that spot is both the first line and the last, so it can still keep scrolling up and
     * down. Recalling a multi-line entry stops there, and that is the right behavior — it was
     * pulled up to be read and edited.
     */
    requestSelection({ text: next, caret: next.length })
    setRecall(step.kind === 'draft' ? null : { at: step.at, text: step.text })
    return true
  }

  // Pasting a screenshot is the most common flow here (FR-13)
  // Returns "did at least one thing get attached" — the side that expands a collapsed composer
  // decides based on this (#116).
  // Expanding it when nothing was attached would bring up an empty field, lying that something happened.
  const takeFiles = async (files: FileList | File[] | null) => {
    if (!files || !alive) return false
    let added = false
    for (const f of Array.from(files)) {
      const att = await attachFile(sessionId, f)
      if (att) {
        setAttachments((prev) => [...prev, att])
        added = true
      }
    }
    return added
  }

  /*
   * All the handling for accepting a drop (#116).
   *
   * Dropping **anywhere on the pane**, not just this composer, needs to do the same thing, and
   * having two separate copies of that judgment and handling would eventually mean only one of
   * them getting fixed — a path dragged from the tree ending up in the sentence when dropped on
   * the composer, but silently disappearing when dropped elsewhere on the pane. So there is
   * exactly one place that handles it, and the pane calls into it through a handle (dropRef).
   */
  const acceptDrop = async (dt: DataTransfer) => {
    // A path dragged from the tree goes into the sentence, not into an attachment.
    // Without telling them apart, `files` would be empty and nothing would happen.
    const path = readDragPath(dt)
    if (path) {
      setText((prev) => {
        const next = appendPath(prev, path)
        requestSelection({ text: next, caret: next.length })
        return next
      })
      return true
    }
    /*
     * Only a file from outside the app is attached (#286). A session or panel dragged inside the
     * app can carry the images it shows as files in WebKit; dropped here, that is the grid's drop,
     * and attaching the screenshot it happened to show is the bug. Checked here, in the one place
     * both the pane and the composer hand their drop to, so neither can miss it.
     */
    const types = [...dt.types]
    if (isOsFileDrag(types)) return takeFiles(dt.files)
    /*
     * A link or text goes into the sentence at the caret (#308) — after the file check, since a
     * file dragged in from the OS can carry its `file:` address as `text/uri-list` too. A drag
     * with a session, panel or project type is still the grid's, as above (`isTextDrag`).
     */
    if (!isTextDrag(types)) return false
    const dropped = droppedText(dt.getData('text/uri-list'), dt.getData('text/plain'))
    if (!dropped) return false
    insertDropped(dropped)
    return true
  }

  /**
   * Puts a dropped link or text at the caret: in place of the selection, or at the end when the
   * composer's text is not what the field shows yet. The caret goes right after it, and the field
   * takes focus, so typing goes on from there.
   */
  const insertDropped = (dropped: DroppedText) => {
    const piece = droppedPiece(dropped)
    setText((prev) => {
      const el = inputRef.current
      const sel = el && el.value === prev ? [el.selectionStart, el.selectionEnd] : [prev.length, prev.length]
      const { text: next, caret } = insertAtCaret(prev, sel[0] ?? prev.length, sel[1] ?? prev.length, piece)
      requestSelection({ text: next, caret })
      return next
    })
  }

  /**
   * An item dragged out of an app view (#308). The link goes in whatever the answer, and the host
   * says whether this session can use that app's tools (`apps.reach`); if not, the quiet line says
   * why. An older host that has no answer leaves the line off rather than guess.
   */
  const acceptAppLink = (drop: AppLinkDrop): boolean => {
    const dropped = droppedText(drop.uri, drop.text)
    if (!dropped) return false
    insertDropped(dropped)
    const ask = ++asked.current
    setAppNotice(null)
    const { appId, projectId: appProject } = drop.from
    platform.apps.reach(sessionId, appId, appProject).then(
      (r) => {
        if (ask !== asked.current || r.reachable) return
        const s = useStore.getState()
        const app = s.externalApps.find((a) => a.appId === appId && a.projectId === appProject)
        const project = appProject === null ? null : (s.projects[appProject]?.name ?? 'another project')
        setAppNotice({ text: appReachNotice(r, app?.name ?? appId, project), reason: r.reason })
      },
      () => {},
    )
    return true
  }
  // No deps here — the closure above needs to see each render's draft and state, so the handle
  // must be recreated every render too
  useImperativeHandle(dropRef, () => ({ accept: acceptDrop, acceptAppLink }))

  /*
   * The pane rendering a conversation is what fetches it.
   *
   * This used to be loaded only by focusSession. In the focus view, selecting and viewing were
   * the same action, so this never showed — but the grid is a screen that **views without
   * selecting**. Putting a session that had never once been opened from the sidebar into a grid
   * cell rendered an empty pane (found in dogfooding). It is right for the component rendering
   * a single session to be the one that fetches its conversation.
   */

  // Avoid rendering even at the moment the session disappears (deleted, archived) — this is
  // decided after every hook has run
  if (!alive) return null

  return (
    <form
      className={`px-4 py-3 ${framed ? 'border-t border-line' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        const t = text.trim()
        if (!t && attachments.length === 0) return
        if (uploading > 0) return
        /*
          A GUI command (2026-09-07): a name like `/usage` has no response in the protocol to
          send to the session — Enter opens an app screen instead of a message. This does not
          intercept it if there is an attachment: attaching something means the person is
          talking to the session.
        */
        const gui = attachments.length === 0 ? guiCommandFor(t) : null
        if (gui) {
          setRecall(null)
          setDraft(sessionId, EMPTY_DRAFT)
          gui.run({ sessionId })
          return
        }
        /*
            After sending, the composer really does go empty (#38).
            **Both** the recall state and the draft have to be cleared — clearing only one
            would bring the earlier unsent text back to life right where the message was just
            sent. The message just sent is now at the top of history, so one press of the
            arrow key brings it back if needed.
          */
        setRecall(null)
        setDraft(sessionId, EMPTY_DRAFT)
        asked.current++
        setAppNotice(null)
        void send(sessionId, t, attachments)
      }}
    >
      {(attachments.length > 0 || uploading > 0) && (
        <AttachmentStrip attachments={attachments} uploading={uploading} onRemove={removeAttachment} />
      )}
      {appNotice && (
        <div className="mb-2 flex items-start gap-2 text-sm text-ink-muted" role="status" data-testid="composer-app-notice" data-reason={appNotice.reason}>
          <span className="min-w-0 flex-1">{appNotice.text}</span>
          <button
            type="button"
            className="shrink-0 rounded-sm p-0.5 text-ink-faint hover:text-ink"
            aria-label="Dismiss"
            data-testid="composer-app-notice-dismiss"
            onClick={() => setAppNotice(null)}
          >
            <CloseIcon />
          </button>
        </div>
      )}
      <div
        /*
         * The input field is filled in **again** (reported by a user on 2026-09-11).
         *
         * It was cleared on 09-10 because "a resting input field is brighter than the
         * conversation". That diagnosis overlapped with a separate issue, where one row of
         * panel peeked out above the pane's floor as the card collapsed and looked like a hole
         * — now that the collapsed height has been lowered enough to hide the input field
         * itself, that side effect is gone. What remains is only the original purpose: the
         * surface for typing has to be **a different surface** from the one for reading.
         *
         * The rule that brightness marks something currently happening is still kept by the
         * border — line-strong on focus, ink-muted when a file is dragged over it.
         */
        className={`relative flex items-end gap-2 rounded-md border bg-surface-raised px-3 py-2 transition-colors focus-within:border-line-strong ${
          dragging ? 'border-ink-muted' : 'border-line'
        }`}
        onDragEnter={(e) => {
          e.preventDefault()
          // Lit only for what it would take — a session dragged over it is the grid's (#286)
          if (isFileDrag(e.dataTransfer.types) || isTextDrag(e.dataTransfer.types)) setDragging(true)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          // A leave event also fires when moving into a child, so this only reacts to actually leaving
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void acceptDrop(e.dataTransfer)
        }}
        data-testid="input-dropzone"
      >
        {ac.open && (
          <AutocompleteMenu
            listId={suggestionsId}
            items={ac.items}
            index={ac.index}
            loading={ac.loading}
            kind={ac.kind}
            onPick={pick}
          />
        )}
        <textarea
          ref={inputRef}
          className="max-h-40 min-h-[22px] flex-1 resize-none bg-transparent text-md leading-body text-ink placeholder:text-ink-faint focus:outline-none"
          rows={1}
          value={text}
          /*
              Focusing here wakes the session, and since #568 this is the one place that does
              ahead of a send: selecting a session in the sidebar only shows it, and the grid's
              panels stay asleep until used. Waking here moves the resume (about 0.7 s on Claude)
              into the typing instead of after the send button, and lets the slash list answer
              from the live process rather than the disk cache (which kept serving an
              uninstalled plugin's commands). wake() dedups and stays quiet, so a second call on
              an already-live session costs nothing.
            */
          onPointerDown={() => {
            pressed.current = true
          }}
          onFocus={() => {
            /*
              Only the person's focus wakes it, a press on the composer or a Tab to it (#590). The app also moves the
              keyboard here, when a session is opened from the sidebar or a search hit (#528) and when a closing
              palette or dialog returns focus (focusReturn.ts); an asleep session that is only being looked at stays
              asleep. A focus the app gave is caught by the first key instead (onChange below).
            */
            if (pressed.current || tabbedRecently()) void wake(sessionId)
            pressed.current = false
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
            /*
              A composer that kept the keyboard while the host put its session to sleep (#568) wakes
              on the first key, not only on the next focus. Not after a failed wake: that one waits
              for its Retry rather than a request per keystroke.
            */
            const st = useStore.getState()
            if (st.sessions[sessionId]?.live === false && !st.wakeError[sessionId]) void wake(sessionId)
          }}
          onKeyDown={(e) => {
            const composing = composingKey(e.nativeEvent)
            // While autocomplete is open, the arrow keys, Enter and Tab belong to the list — unless
            // the input method is using them (#181): an `@파일` still being composed
            if (ac.open && !composing) {
              const action = autocompleteKeyAction(e)
              if (action === 'down') return (e.preventDefault(), ac.move(1))
              if (action === 'up') return (e.preventDefault(), ac.move(-1))
              if (action === 'close') return (e.preventDefault(), setCaret(-1))
              if (action === 'pick') {
                // The list on screen answers the previous keystroke: wait for this one's answer, never send meanwhile
                if (ac.stale) return void e.preventDefault()
                const item = ac.items[ac.index]
                if (item) {
                  e.preventDefault()
                  pick(item)
                  return
                }
              }
            }
            /*
                While an IME is composing, Enter and the arrows belong to **the candidate list**,
                not to us (#38, #12). The arrows move through candidates; Enter commits the
                syllable being formed. Enter is the worse one to take: our answer to Enter is to
                send, so the keystroke that was meant to finish a word posts a half-written
                message instead — and Korean needs that keystroke far more often than English,
                which is the shape of "this only happens in Korean".

                This reads the key event rather than the `composing` state above, on purpose. The
                state answers "is the value still forming", which is the right question for
                autocomplete and the wrong one for a keystroke: it is set from an event that in
                principle might not arrive, and a stuck `true` there would mean a message that
                cannot be sent at all. These flags are scoped to this one key and cannot go stale.
                `composingKey` (app/keys.ts) reads all three signals engines use, including
                WebKit's keyCode 229 on the Enter it dispatches after `compositionend`.
              */
            if (!composing && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              if (recallHistory(e.currentTarget, e.key === 'ArrowUp' ? -1 : 1)) {
                e.preventDefault()
                return
              }
            }
            /*
                What counts as sending is decided by the setting (composerKeys.ts). This does
                not judge it directly here because the combination of cases it is tangled up
                with, together with the composition check (composing) above, needs to live
                somewhere testable without a browser.

                For someone who has turned the setting on, a plain Enter does nothing here — it
                is not intercepted, so the textarea just breaks the line as usual. That is the
                entire effect of the setting.
              */
            const sendKey = { key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, composing }
            if (isComposerSendKey(sendKey, sendWithModifierEnter)) {
              e.preventDefault()
              e.currentTarget.form?.requestSubmit()
            }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files)
            if (files.length > 0) {
              e.preventDefault()
              void takeFiles(files)
            }
          }}
          /*
           * With a question open, **whatever is typed here goes as the answer to that
           * question** (#125). That fact needs to be known before pressing send — this used to
           * silently drop the question, and the person did not even know what they had just
           * gotten rid of.
           */
          placeholder={
            target === 'answer'
              ? 'Type your answer to the question'
              : target === 'drops'
                ? 'Sending starts a new turn and drops the question card — answer on the card instead'
                : 'Type a message'
          }
          data-testid="prompt-input"
          // The box drives the suggestion list while it is open, and names the option under the cursor (#842 item 7)
          role="combobox"
          aria-expanded={ac.open}
          aria-controls={ac.open ? suggestionsId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={ac.open && ac.items[ac.index] ? suggestionId(suggestionsId, ac.index) : undefined}
          // Whose composer this is: that session's approval card takes mod+⇧Y/D/L from here, where y/n/a are letters
          data-composer-session={sessionId}
        />
        {/*
            The attach button uses **the same component** as send. It used to be a separate one
            built from a label, with different inner padding (6px vs 4px) and icon size (16 vs
            15), so the two buttons standing side by side looked mismatched in size and height
            (found in dogfooding). The file picker is opened by clicking a hidden input — it
            does the same job without a label.
          */}
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          data-testid="attach-input"
          onChange={(e) => {
            /*
             * The chosen files are copied out before the field is cleared (#180). If the value
             * were left as-is, the browser would not fire `change` again for picking the same
             * file a second time, so removing the chip (or sending it) meant the same file could
             * never be attached again. `files` is a live list, so clearing the value clears it
             * too — this copies it into an array first, then clears.
             */
            const files = Array.from(e.currentTarget.files ?? [])
            e.currentTarget.value = ''
            void takeFiles(files)
          }}
        />
        <IconButton
          label="Attach file"
          onClick={() => fileRef.current?.click()}
          testId="attach-open"
          placement="top"
          className="shrink-0"
        >
          <PlusIcon size={15} />
        </IconButton>
        <IconButton
          type="submit"
          /*
            The label follows the setting, since the send key itself changes with it. This is
            **the only place in the app that names that key**, so getting it wrong leaves
            someone who turned the setting on with no way to know what to press the first time.
            Whether it reads `⌘` or `Ctrl` is answered by the keyboard.
          */
          label={`Send (${sendWithModifierEnter ? sc('mod', 'Enter') : 'Enter'})`}
          disabled={(!text.trim() && attachments.length === 0) || uploading > 0}
          testId="send"
          placement="top"
          align="right"
          className="shrink-0"
        >
          <SendIcon />
        </IconButton>
      </div>
      {/*
          Model, effort and permissions are decided **right before sending**, so they sit below
          the composer. In the header they were at the opposite end of the screen, so what was
          being sent and under which settings never showed together at a glance. Here, the hand
          and the eye stay in the same spot.
        */}
      {/*
          The shortcut hint was removed. Sending with Enter and breaking the line with
          Shift+Enter is the default for a chat composer — learned once and done — but a hint
          takes up space every single time. Once read, it is noise from then on (dogfooding:
          "because these are obvious").
        */}
      <ComposerFooter sessionId={sessionId} onMenuOpenChange={onMenuOpenChange} />
    </form>
  )
})
