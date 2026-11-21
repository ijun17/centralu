import { isAssistantKind } from '@cc/protocol/client'
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
import { fitComposerHeight } from './composerFit.js'
import { autocompleteKeyAction, isComposerSendKey } from './composerKeys.js'
import { composerFocusAnswer } from './composerFocus.js'
import { composingKey } from '../../app/keys.js'
import { appendPath, isFileDrag, isOsFileDrag, readDragPath } from '../files/dragPath.js'
import type { AppLinkDrop } from '../app-frame/dragRelay.js'
import { droppedPiece, droppedText, insertAtCaret, isTextDrag, type DroppedText } from './dragLink.js'
import { appDropVerdict, appReachNotice, droppedAppTitle } from './appReachNotice.js'
import { projectLabelOf } from '../../store/names.js'
import { usePlatform } from '../../app/PlatformProvider.js'
import { ComposerFooter } from './ComposerFooter.jsx'
import { EMPTY_CHAT, EMPTY_QUESTIONS } from './empty.js'

/**
 * Hands a drop on the pane to the composer (#116). Resolves whether something went in (a file
 * can be too large or fail to save): a folded composer opens only then, never onto an empty field.
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
 * The composer (FR-7), the only reader of the draft, which changes on every keystroke. Read in
 * SessionPane, it would re-render the header, the stream and every row per character (measured: 1.0
 * renders per character for the pane and the stream, 2.0 per row, doubled while streaming).
 * `chat` is read with `getState()` on an arrow key, never subscribed, for the same reason.
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
  /** Its own top border; false inside a folded card, whose rounded border already is the edge */
  framed?: boolean
}) {
  // What the text becomes for an open question (#125, #174): a string, not the questions array (a
  // new reference every time). Attachments count as in the store's send (`composerTarget`), so the
  // placeholder never promises an answer that would go as a new turn.
  const target = useStore((s) =>
    composerTarget(s.sessions[sessionId]?.pendingQuestions ?? EMPTY_QUESTIONS, (s.drafts[sessionId]?.attachments.length ?? 0) > 0),
  )

  // Single fields, not the session object, which changes on every streamed delta
  const alive = useStore((s) => !!s.sessions[sessionId])
  const projectId = useStore((s) => s.sessions[sessionId]?.projectId ?? '')
  const isAssistant = useStore((s) => isAssistantKind(s.sessions[sessionId]?.kind))
  const send = useStore((s) => s.send)
  const wake = useStore((s) => s.wake)
  const sendWithModifierEnter = useStore((s) => s.prefs.sendWithModifierEnter)
  const sc = useShortcut()
  // The draft is the session's (docs/state-management.md "Composer text and selection"): the focus
  // view reuses this component across sessions and the grid unmounts it
  const draft = useStore((s) => s.drafts[sessionId] ?? EMPTY_DRAFT)
  const setDraft = useStore((s) => s.setDraft)

  // A sent message recalled with the arrow keys (#38), shown over the draft, which stays untouched
  // underneath, so stepping past the newest entry brings it back
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
   * An IME is mid-composition (#12): between `compositionstart` and `compositionend`, not one key.
   * It gates autocomplete only (`한` arrives as `ㅎ`, `하`, `한`, each an `fs.search` after `@`);
   * the text and its height still update on every event. Removes work; a latency gain was never measured.
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
   * Takes the keyboard when asked through the store (#528): a session just picked in the palette or
   * created. Otherwise the first key goes nowhere (a Tab reaches the box only in WebKit on macOS).
   * Taken once nothing covers the session, as the dialog asks while still closing; rules in `composerFocusAnswer`.
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
  // Nothing sends while an attachment uploads (#180): a chip enters the draft only once stored, so
  // one finishing late would ride on the next message
  const uploading = useStore((s) => s.uploading[sessionId] ?? 0)
  // The height follows the value, whatever changed it (a send, autocomplete, a paste); measured before paint
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    fitComposerHeight(el)
  }, [text])

  // The caret lands in the commit of its text (docs/state-management.md "Composer text and selection", #368)
  useLayoutEffect(() => {
    const next = pendingSelection.current
    pendingSelection.current = null
    const el = inputRef.current
    if (!next || !el || el.value !== next.text) return
    el.focus()
    el.setSelectionRange(next.caret, next.caret)
  })

  // Another session ends a recall (#38), in layout: as an effect, A's text would flash in B's box for a frame
  useLayoutEffect(() => {
    setRecall(null)
  }, [sessionId])

  /*
   * The line under a link dropped from an app this session cannot reach (#308): it says what would
   * give the agent the app's tools. Another session, a send, a dismissal or the next drop clears it;
   * `asked` drops a late answer to an earlier drop.
   */
  const platform = usePlatform()
  const [appNotice, setAppNotice] = useState<{ text: string; reason: string } | null>(null)
  const asked = useRef(0)
  useLayoutEffect(() => {
    asked.current++
    setAppNotice(null)
  }, [sessionId])

  const suggestionsId = useId()
  const ac = useAutocomplete({
    sessionId,
    projectId,
    text,
    caret,
    // Not while composing (#12): a half-formed syllable is not a query. Closed, the arrows go back to the caret.
    enabled: alive && caret >= 0 && !composing,
    // The Assistant has no file tree: its `@` picks a session
    atSource: isAssistant ? 'sessions' : 'files',
  })

  const pick = (item: Suggestion) => {
    // A GUI command runs on the pick, not on a second Enter. A session command's value ends in a
    // space, so a real skill of the same name is not taken for one.
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
   * Recalls a sent message (#38); true when history took the key. Only with no selection and the
   * caret on the first (up) or last (down) line, wrapped lines counted. History is scanned on the
   * key, not kept: that would rescan the conversation on every streamed delta.
   */
  const recallHistory = (el: HTMLTextAreaElement, dir: -1 | 1): boolean => {
    if (el.selectionStart !== el.selectionEnd) return false
    const caret = el.selectionStart
    // Newlines first (free); only then the mirror, for a wrapped line that has none
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
    // The caret at the end, as a shell puts it: a one-line entry can keep stepping, a multi-line one stops to be edited
    requestSelection({ text: next, caret: next.length })
    setRecall(step.kind === 'draft' ? null : { at: step.at, text: step.text })
    return true
  }

  // Whether anything was attached: a folded composer opens only then (#116)
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

  // Every drop on the pane or the composer, one handling (#116); the pane reaches it through `dropRef`
  const acceptDrop = async (dt: DataTransfer) => {
    // A path from the tree goes into the sentence; its `files` is empty
    const path = readDragPath(dt)
    if (path) {
      setText((prev) => {
        const next = appendPath(prev, path)
        requestSelection({ text: next, caret: next.length })
        return next
      })
      return true
    }
    // Only a file from outside the app is attached (#286): in WebKit a session or panel dragged
    // inside the app carries the images it shows as files, and that drop is the grid's
    const types = [...dt.types]
    if (isOsFileDrag(types)) return takeFiles(dt.files)
    // A link or text at the caret (#308), after the file check: an OS file carries its `file:`
    // address as `text/uri-list` too
    if (!isTextDrag(types)) return false
    const dropped = droppedText(dt.getData('text/uri-list'), dt.getData('text/plain'))
    if (!dropped) return false
    insertDropped(dropped)
    return true
  }

  // At the end when the field does not show the composer's text yet
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
   * An item dragged out of an app view (#308): the link goes in, and the host says whether this
   * session can use the app's tools (`apps.reach`). A user-folder app on another computer is told
   * by the window (`appDropVerdict`); an older host with no answer leaves the line off.
   */
  const acceptAppLink = (drop: AppLinkDrop): boolean => {
    const dropped = droppedText(drop.uri, drop.text)
    if (!dropped) return false
    insertDropped(dropped)
    const ask = ++asked.current
    setAppNotice(null)
    const { appId, projectId: appProject } = drop.from
    const here = useStore.getState()
    const verdict = appDropVerdict(drop.from, here.sessions[sessionId]?.machine, here.externalApps, here.machines)
    if (verdict.kind === 'tell') {
      setAppNotice({ text: verdict.text, reason: verdict.reason })
      return true
    }
    platform.apps.reach(sessionId, appId, appProject).then(
      (r) => {
        if (ask !== asked.current || r.reachable) return
        const s = useStore.getState()
        const project = appProject === null ? null : projectLabelOf(s.projects, appProject) || 'another project'
        setAppNotice({ text: appReachNotice(r, droppedAppTitle(s.externalApps, drop.from), project), reason: r.reason })
      },
      () => {},
    )
    return true
  }
  // No deps: the handlers close over this render's draft
  useImperativeHandle(dropRef, () => ({ accept: acceptDrop, acceptAppLink }))

  if (!alive) return null

  return (
    <form
      className={`px-4 py-3 ${framed ? 'border-t border-line-chrome' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        const t = text.trim()
        if (!t && attachments.length === 0) return
        if (uploading > 0) return
        // A GUI command (`/usage`) opens a screen; with an attachment the person is talking to the session
        const gui = attachments.length === 0 ? guiCommandFor(t) : null
        if (gui) {
          setRecall(null)
          setDraft(sessionId, EMPTY_DRAFT)
          gui.run({ sessionId })
          return
        }
        // Both, or the cleared one's text comes back where the message was sent (#38)
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
        // Filled, so typing is on another surface than reading; the border says what is happening
        // (line-strong on focus, ink-muted under a drag)
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
          // Also fired on entering a child
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void acceptDrop(e.dataTransfer)
        }}
        data-testid="input-dropzone"
        // The input card, which `SessionView` measures as the composer at rest (`restingHeight`): what is drawn above it comes and goes
        data-composer-card
      >
        {ac.open && (
          <AutocompleteMenu
            listId={suggestionsId}
            items={ac.items}
            index={ac.index}
            loading={ac.loading}
            note={ac.note}
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
              The one wake ahead of a send (#568): the resume (about 0.7 s on Claude) happens while
              typing, and the slash list answers from the live process, not the disk cache (which
              can list an uninstalled plugin's commands). wake() dedups.
            */
          onPointerDown={() => {
            pressed.current = true
          }}
          onFocus={() => {
            /*
              Only the person's focus wakes it, a press or a Tab (#590). A focus the app gives (a
              session opened, #528, or focus returned by a palette or dialog) waits for the first key.
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
            // Also wakes a session put to sleep under a focused box (#568); after a failed wake, its Retry does
            const st = useStore.getState()
            if (st.sessions[sessionId]?.live === false && !st.wakeError[sessionId]) void wake(sessionId)
          }}
          onKeyDown={(e) => {
            const composing = composingKey(e.nativeEvent)
            // The list's keys, unless the input method is using them (#181): an `@파일` still composing
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
                While an IME composes, Enter and the arrows are the candidate list's (#38, #12): an
                Enter that commits a Korean syllable must not send. Read from the key, not `composing`,
                which a lost `compositionend` could leave stuck true, and then nothing sends;
                `composingKey` also reads WebKit's keyCode 229 on the Enter after `compositionend`.
              */
            if (!composing && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              if (recallHistory(e.currentTarget, e.key === 'ArrowUp' ? -1 : 1)) {
                e.preventDefault()
                return
              }
            }
            // With the setting on, a plain Enter is left to the textarea, which breaks the line
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
          // What a send does to an open question, said before the send (#125)
          placeholder={
            target === 'answer'
              ? 'Type your answer to the question'
              : target === 'drops'
                ? 'Sending starts a new turn and drops the question card — answer on the card instead'
                : 'Type a message'
          }
          data-testid="prompt-input"
          // Not a combobox (#842 item 7): a <textarea> may not take that role, and would lose its multi-line editing
          aria-haspopup="listbox"
          aria-expanded={ac.open}
          aria-controls={ac.open ? suggestionsId : undefined}
          aria-activedescendant={ac.open && ac.items[ac.index] ? suggestionId(suggestionsId, ac.index) : undefined}
          // Whose composer this is: that session's approval card takes mod+⇧Y/D/L from here, where y/n/a are letters
          data-composer-session={sessionId}
        />
        {/* Opened by the attach button, an IconButton as send is,
            so the two match */}
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          data-testid="attach-input"
          onChange={(e) => {
            // Cleared so the same file fires `change` again (#180); copied first, as `files` is live
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
          // The one place that names the send key
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
      {/* The settings sit under the box, chosen just before a send,
          not in the header across the screen */}
      {/* No shortcut hint: Enter to send is learned once,
          and a hint takes room every time */}
      <ComposerFooter sessionId={sessionId} onMenuOpenChange={onMenuOpenChange} />
    </form>
  )
})
