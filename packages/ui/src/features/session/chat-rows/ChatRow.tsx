import { memo, useMemo, useState } from 'react'
import { splitRunTogetherHeadings } from '@cc/core'
import { centraluCallOf, launchesSubagent } from '@cc/protocol/client'
import { messagesToChat, useStore, type ChatItem } from '../../../store/store.js'
import { ChevronIcon, FromArrowIcon, MarkIcon } from '../../../components/icons.jsx'
import { MarkLine } from '../../../components/MarkLine.jsx'
import { ZoomableImage } from '../ZoomableImage.jsx'
import { FileLink, Markdown } from '../Markdown.jsx'
import { titlePieces } from '../filePath.js'
import { formatCount, formatSaidAt } from '../../../app/format.js'
import { InlineViewSlot } from '../InlineView.jsx'
import { NoticeMark } from '../NoticeMark.jsx'
import { UserAttachment } from './attachments.jsx'
import { isRelayed, mineBubbleAttrs, mineBubbleLook } from './bubbleLook.js'
import { WorktreeProposalRow } from './delegation.jsx'
import { CentraluCallHeader } from './CentraluCall.jsx'
import { CentraluCallBody } from './CentraluCallBody.jsx'
import { Badge } from '../../../components/Badge.jsx'

/*
 * One row of the conversation (#428). `ToolCard` and `SubagentSteps` stay in this file: a launch card
 * draws its subagent's steps with `ChatRow`, and split out the three would import each other in a
 * circle (tooling/dependency-cruiser.cjs forbids one).
 */

/** Memo, as a delta changes only the last row: without it every visible row re-renders (measured: 2.7 renders per character) */
export const ChatRow = memo(function ChatRow({
  item,
  projectRoot,
  projectId = null,
  sessionId,
  leaving = false,
  nested = false,
}: {
  item: ChatItem
  projectRoot: string | null
  /** projectRoot's project, so file links open in this pane's (#182) */
  projectId?: string | null
  sessionId: string
  /** The list is about to detach the row: an app view in it is torn down (M4 B-1) */
  leaving?: boolean
  /** A subagent's step in its launch card (#222); the host opens no app view for one */
  nested?: boolean
}) {
  if (item.kind === 'user') {
    const relayed = isRelayed(item)
    return (
      <div className="flex flex-col items-end" data-testid="msg-user">
        {/* A delegated message (FR-11): on the person's side, as a directive received,
            under its source (docs/design-system.md §7) */}
        {item.from && (
          <div className="pb-0.5 text-xs text-ink-muted" data-testid="msg-user-from">
            {item.from.name} <FromArrowIcon />
          </div>
        )}
        {/* An app view's message (M4 B-1): the person chose to send it,
            the app wrote it */}
        {item.fromApp && (
          <div className="pb-0.5 text-xs text-ink-muted" data-testid="msg-user-from-app">
            {item.fromApp.name} app <FromArrowIcon />
          </div>
        )}
        {/* A first message a script wrote (§8.1): the person set the script up, but did not type this */}
        {item.fromScript && (
          <div className="pb-0.5 text-xs text-ink-muted" data-testid="msg-user-from-script">
            script {item.fromScript.credential} <FromArrowIcon />
          </div>
        )}
        {/* break-words: a long URL or path
            would widen the conversation */}
        {/* The person's own on surface-hover: surface-raised and line are too close to the floor
            in a dark theme to tell what I said (design-system §7) */}
        {/* Above the text as objects, not "📎 name" in it,
            which would differ from what was sent (#75) */}
        {item.attachments && item.attachments.length > 0 && (
          <div className="flex max-w-[75%] flex-wrap justify-end gap-1.5 pb-0.5">
            {item.attachments.map((a, i) => (
              <UserAttachment key={`${a.path}-${i}`} att={a} />
            ))}
          </div>
        )}
        {/* A relayed message is drawn as the agent's bubble, solid: dashed
            means failed or unknown (#1629) */}
        {/* No empty bubble for a message that only sent an image */}
        {(item.text || !item.attachments?.length) && (
          <div
            {...mineBubbleAttrs(relayed)}
            className={`max-w-[75%] whitespace-pre-wrap break-words rounded-bubble border px-3 py-2 ${mineBubbleLook(relayed)}`}
          >
            {item.text}
          </div>
        )}
        {item.at !== undefined && <SaidAt at={item.at} className="pr-2" />}
      </div>
    )
  }
  if (item.kind === 'assistant') {
    return (
      <div className="min-w-0" data-testid="msg-assistant">
        <Markdown text={item.text} projectRoot={projectRoot} projectId={projectId} sessionId={sessionId} linkSessionId={sessionId} />
      </div>
    )
  }
  if (item.kind === 'reasoning') {
    /*
     * A reasoning summary (#58), ink-muted as the path to the body (docs/themes.md "The urgency order"). Markdown,
     * as Codex sends bold headings; the tone is Markdown's, whose root sets the ink, not this wrapper's.
     */
    return (
      <div className="min-w-0" data-testid="msg-reasoning">
        {/* A row stored before the host kept two reasoning items apart has their headings run together (#1464) */}
        <Markdown text={splitRunTogetherHeadings(item.text)} projectRoot={projectRoot} projectId={projectId} linkSessionId={sessionId} tone="muted" />
      </div>
    )
  }
  if (item.kind === 'approval') {
    // Until decided, the approval card below shows it
    if (!item.decision) return null
    return (
      <p className="readout text-xs text-ink-faint" data-testid="msg-approval-log">
        {item.decision === 'deny' ? 'Denied' : 'Allowed'} · {item.summary}
      </p>
    )
  }
  if (item.kind === 'mark') {
    // A tool's notice (#342) or a line in a capsule, a failure in a dashed box (docs/design-system.md §7); a failed
    // turn's long sentence (#107) wraps in MarkLine rather than widening the conversation
    if (item.notice) return <NoticeMark notice={item.notice} />
    return (
      <MarkLine
        icon={<MarkIcon kind={item.mark} />}
        failed={item.mark === 'failed'}
        data-mark={item.mark}
      >
        {item.text}
      </MarkLine>
    )
  }
  if (item.kind === 'image') {
    // The agent's image (#40): the host's copy can be swept by the size cap, and then the note says why
    if (!item.data) return <ImageNote path={item.path} name={item.name} note={item.note} />
    return <ImageMessage mime={item.mime} data={item.data} path={item.path} name={item.name} />
  }
  // A worktree proposal (#69): a line with the branch filled into the window, not a tool card
  if (/propose_worktree_session$/.test(item.tool)) return <WorktreeProposalRow item={item} />
  return (
    <>
      <ToolCard item={item} sessionId={sessionId} projectRoot={projectRoot} projectId={projectId} />
      {/* The app view this call opened (M4 B-1),
          if any */}
      {item.callId && !nested && (
        <InlineViewSlot sessionId={sessionId} callId={item.callId} leaving={leaving} />
      )}
    </>
  )
})

/** Zoomable (#62), as max-h-80 leaves a screenshot's text unreadable */
function ImageMessage({ mime, data, path, name }: { mime?: string; data: string; path?: string; name?: string }) {
  // Bytes the window cannot decode draw as an empty framed box (WebKit paints not even the alt text, #1464): say so instead
  const [undrawable, setUndrawable] = useState(false)
  if (undrawable) return <ImageNote path={path} name={name} note="the window could not draw it" />
  return (
    <div className="min-w-0" data-testid="msg-image">
      <ZoomableImage
        src={`data:${mime};base64,${data}`}
        alt={path ?? 'agent image'}
        thumbClassName="max-h-80 max-w-full rounded-lg border border-line"
        onError={() => setUndrawable(true)}
        onLoad={(img) => {
          if (img.naturalWidth === 0 || img.naturalHeight === 0) setUndrawable(true)
        }}
      />
    </div>
  )
}

/** An image not sent or not drawable (#1464); fades in, as the image may have shown a moment before */
function ImageNote({ path, name: viewed, note }: { path?: string; name?: string; note?: string }) {
  // A stored row's `path` is the host's own copy of the file; `name` is the path it was viewed under
  const file = viewed ?? path
  const name = file?.split(/[\\/]/).filter(Boolean).pop()
  const reason = note ? ` (${note})` : ''
  return (
    <div
      className="cc-fade rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-ink-faint"
      data-testid="msg-image-missing"
      title={file}
    >
      {name ? `Viewed an image: ${name} — could not be read${reason}` : `An image from the agent — could not be shown${reason}`}
    </div>
  )
}

/** A running tool's output tail, in lines */
const PREVIEW_LINES = 3

/**
 * The same in visible lines: one JSON blob with no newline wrapped into dozens. `3lh`, not px, which
 * would round leading-body × 11px = 17.875px and show a pixel of a fourth line.
 */
const PREVIEW_CLAMP = 'max-h-[3lh] overflow-hidden'

/**
 * An ask_project call no adapter marked as Centralu's (#371 part B): Codex names no server for a call made from inside
 * `exec`, and an older record carries no mark, yet the tool's bare name is Centralu's alone. Its card is the Centralu
 * call's all the same. Any other bare name stays an ordinary tool's (#843).
 */
function unmarkedAskProject(item: Extract<ChatItem, { kind: 'tool' }>): NonNullable<ReturnType<typeof centraluCallOf>> | null {
  return item.tool === 'ask_project' ? { tool: 'ask_project' } : null
}

/**
 * One title row until opened (docs/design-system.md §7). No scrolling inside it: a scroll area in the
 * conversation takes the wheel from it. A failure shows on the title row while closed.
 */
function ToolCard({
  item,
  sessionId,
  projectRoot,
  projectId,
}: {
  item: Extract<ChatItem, { kind: 'tool' }>
  sessionId: string
  projectRoot: string | null
  projectId: string | null
}) {
  const [open, setOpen] = useState(false)
  // A call to Centralu's own tools (#730): its own title row and a stronger edge; the rest is this card's
  const read = useMemo(() => centraluCallOf(item) ?? unmarkedAskProject(item), [item])
  /*
   * A record with no mark (an older host's) is read by its Claude name; `app-<x>` there is an app's only for an app this
   * window knows, since a repository's own server may carry that name (#730)
   */
  const knownApp = useStore(
    (s) => !read?.app || !!item.centralu || s.externalApps.some((a) => a.appId === read.app),
  )
  const call = knownApp ? read : null
  // ask_project (#371 part B) keeps the testids its e2e reads the card, its toggle and its answer by
  const ask = call?.tool === 'ask_project'
  const pieces = useMemo(
    () => titlePieces(item.title, item.paths, projectRoot),
    [item.title, item.paths, projectRoot],
  )
  const linked = pieces.some((p) => p.ref)
  const lines = item.result ? item.result.replace(/\s+$/, '').split('\n') : []
  const showInput =
    !call && open && item.title !== item.tool && (item.title.includes('\n') || item.title.length > 60)
  const running = item.result === undefined && item.ok === undefined
  // The end of a running tool's output (#58, Codex's outputDelta) until `result`, which is whole: the chunks
  // have been seen to miss the first
  const liveTail =
    open && item.result === undefined && item.live
      ? item.live.replace(/\s+$/, '').split('\n').slice(-PREVIEW_LINES)
      : []

  return (
    // A Centralu call's card (#730, docs/design-system.md §7); a failed call is dashed
    <div
      className={
        call
          ? `rounded-lg border bg-surface-hover/15 ${item.ok === false ? 'border-dashed border-ink-muted' : 'border-line-strong'}`
          : `rounded-lg border bg-surface-raised/40 ${item.ok === false ? 'border-dashed border-line-strong' : 'border-line'}`
      }
      data-testid={ask ? 'ask-project-card' : 'tool-card'}
      data-centralu-call={call ? (call.app ? 'app' : 'centralu') : undefined}
    >
      {call ? (
        <CentraluCallHeader
          item={item}
          call={call}
          sessionId={sessionId}
          open={open}
          onToggle={() => setOpen((o) => !o)}
        />
      ) : linked ? (
        // A link cannot sit in the toggle button, so the toggle is the chevron and name; the row's rest still toggles
        <div className="flex w-full items-center">
          <button
            className="flex min-w-0 shrink items-center py-2 pl-3 pr-2.5 text-left"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            data-testid="tool-card-toggle"
          >
            <span className="readout max-w-48 min-w-0 truncate rounded-md bg-surface-hover/50 px-1.5 py-0.5 text-2xs text-ink-muted" title={item.tool}>
              {item.tool}
            </span>
          </button>
          <span
            className="readout min-w-0 truncate py-2 text-xs text-ink-muted"
            data-testid="tool-card-title"
            title={item.title}
          >
            {pieces.map((p, i) =>
              p.ref ? (
                <FileLink key={i} refInfo={p.ref} projectId={projectId} sessionId={sessionId}>
                  {p.text}
                </FileLink>
              ) : (
                <span key={i}>{p.text}</span>
              ),
            )}
          </span>
          {/* Not focusable: the toggle button above is the keyboard's way to the same action */}
          <div
            className="flex min-h-[2rem] flex-1 shrink-0 items-center justify-end gap-2.5 self-stretch px-3"
            onClick={() => setOpen((o) => !o)}
            aria-hidden
          >
            {running && <span className="size-1.5 shrink-0 rounded-full bg-ink-muted" />}
            {item.ok === false && <span className="text-2xs text-ink-muted">failed</span>}
            <span className="shrink-0 text-ink-faint">
              <ChevronIcon open={open} />
            </span>
          </div>
        </div>
      ) : (
        <button
          className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-testid="tool-card-toggle"
          title={item.title}
        >
          {/* The tool on a quiet tile, then its input in the code face (owner, 2026-10-18) */}
          <span className="readout max-w-48 min-w-0 truncate rounded-md bg-surface-hover/50 px-1.5 py-0.5 text-2xs text-ink-muted" title={item.tool}>
            {item.tool}
          </span>
          <span className="readout min-w-0 flex-1 truncate text-xs text-ink-muted">
            {item.title === item.tool ? '' : item.title}
          </span>
          {running && <span className="size-1.5 shrink-0 rounded-full bg-ink-muted" aria-label="running" />}
          {item.ok === false && <span className="shrink-0 text-2xs text-ink-muted">failed</span>}
          {/* The file tree's chevron: one expand mark across the app */}
          <span className="shrink-0 text-ink-faint">
            <ChevronIcon open={open} />
          </span>
        </button>
      )}

      {/* The whole input once open, where the title cuts a long command
          to one line (owner, 2026-10-18) */}
      {showInput && (
        <div className="border-t border-line px-3 py-2" data-testid="tool-card-input">
          <Badge readout className="mb-1 block tracking-wide">
            Input
          </Badge>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-hover/25 px-2.5 py-1.5 font-mono text-xs leading-body text-ink-muted">
            {item.tool === 'Bash' && <span className="select-none text-ink-faint">$ </span>}
            {item.title}
          </pre>
        </div>
      )}

      {liveTail.length > 0 && (
        <div className="border-t border-line px-2.5 py-1.5">
          <pre
            className={`whitespace-pre-wrap break-words font-mono text-xs leading-body text-ink-faint ${PREVIEW_CLAMP}`}
            data-testid="tool-card-live"
          >
            {liveTail.join('\n')}
          </pre>
        </div>
      )}

      {/* A Centralu call's answer, only when opened (owner, 2026-10-18) */}
      {call && open && item.result && item.result.trim() && (
        <div className="border-t border-line px-3 py-2" data-testid={ask ? 'ask-project-result' : 'tool-card-output'}>
          <CentraluCallBody result={item.result} open={open} onOpen={() => setOpen(true)} />
        </div>
      )}

      {/* Output only when opened: preview lines were rarely read and made every call
          a block (owner, 2026-10-18) */}
      {!call && open && lines.length > 0 && (
        <div className="border-t border-line px-2.5 py-1.5">
          {/* Named only beside a shown input, where the two would otherwise read as one block */}
          {showInput && (
            <Badge readout className="mb-1 block px-0.5 tracking-wide">
              Output
            </Badge>
          )}
          <pre
            className="whitespace-pre-wrap break-words font-mono text-xs leading-body text-ink-muted"
            data-testid="tool-card-output"
          >
            {lines.join('\n')}
          </pre>
        </div>
      )}

      {launchesSubagent(item.tool) && item.callId && (
        <SubagentSteps
          sessionId={sessionId}
          callId={item.callId}
          projectRoot={projectRoot}
          projectId={projectId}
        />
      )}
    </div>
  )
}

/**
 * A launch card's subagent steps (#222, docs/state-management.md §4), kept out of the conversation, where
 * they read as the parent's (#98), and drawn with the conversation's own rows.
 */
export function SubagentSteps({
  sessionId,
  callId,
  projectRoot,
  projectId,
}: {
  sessionId: string
  callId: string
  projectRoot: string | null
  projectId: string | null
}) {
  const steps = useStore((s) => s.subagentSteps[sessionId]?.[callId])
  const toggle = useStore((s) => s.toggleSubagentSteps)
  const loadMore = useStore((s) => s.loadMoreSubagentSteps)
  const rows = steps?.rows
  const items = useMemo(() => (rows ? messagesToChat(rows) : []), [rows])
  const open = !!steps?.open

  return (
    <div className="border-t border-line" data-testid="subagent-steps">
      <button
        className="flex w-full items-center gap-2 px-2.5 py-1 text-left"
        onClick={() => toggle(sessionId, callId)}
        aria-expanded={open}
        data-testid="subagent-steps-toggle"
      >
        <span className="shrink-0 text-ink-faint">
          <ChevronIcon open={open} />
        </span>
        <span className="readout text-xs text-ink-faint">Subagent&apos;s steps</span>
      </button>
      {open && (
        <div
          className="flex flex-col gap-2 border-t border-line px-2.5 py-2"
          data-testid="subagent-steps-list"
        >
          {items.map((it) => (
            <ChatRow
              key={it.seq}
              item={it}
              projectRoot={projectRoot}
              projectId={projectId}
              sessionId={sessionId}
              nested
            />
          ))}
          {steps?.loading && <p className="readout text-xs text-ink-faint">Loading the steps…</p>}
          {steps?.error && (
            <p className="text-xs text-ink" data-testid="subagent-steps-error">
              Could not load the steps — {steps.error}{' '}
              <button
                className="readout text-ink-faint underline hover:text-ink"
                onClick={() => void loadMore(sessionId, callId)}
              >
                Try again
              </button>
            </p>
          )}
          {/* Archived steps (#418) are said to be there,
              or an emptied card reads as one that kept none */}
          {steps && !steps.loading && !steps.error && !!steps.trashed && (
            <p className="text-xs text-ink-faint" data-testid="subagent-steps-trashed">
              {trashedLine(steps.trashed, items.length > 0)}
            </p>
          )}
          {steps && !steps.loading && !steps.error && !steps.trashed && items.length === 0 && (
            /* Steps deleted for good from the session archive (#418) leave the card as empty as one that never kept any */
            <p className="text-xs text-ink-faint" data-testid="subagent-steps-empty">
              No steps are kept for this agent: it ran before Centralu kept them, or its steps were deleted from the
              session archive.
            </p>
          )}
          {steps?.more && !steps.loading && (
            <button
              className="readout self-start text-2xs text-ink-faint transition-colors hover:text-ink"
              onClick={() => void loadMore(sessionId, callId)}
              data-testid="subagent-steps-more"
            >
              Show more steps
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** `more`: a running subagent wrote steps under the card since, so the archived ones are "N earlier steps" (#418) */
function trashedLine(trashed: number, more: boolean): string {
  const one = trashed === 1
  const what = more ? `${formatCount(trashed)} earlier ${one ? 'step was' : 'steps were'}` : one ? 'The step was' : 'The steps were'
  return `${what} archived. Settings → Archive restores ${one ? 'it' : 'them'}.`
}

/** design-system §7 "Times". The 4px above is its own, so both sides share it; a caller gives only the side padding */
export function SaidAt({ at, className = '' }: { at: number; className?: string }) {
  return (
    <div className={`pt-1 text-2xs text-ink-faint ${className}`} data-testid="said-at">
      {formatSaidAt(at)}
    </div>
  )
}
