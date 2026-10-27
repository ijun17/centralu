import { memo, useMemo, useState } from 'react'
import { splitRunTogetherHeadings } from '@cc/core'
import { centraluCallOf, launchesSubagent } from '@cc/protocol/client'
import { messagesToChat, useStore, type ChatItem } from '../../../store/store.js'
import { ChevronIcon } from '../../../components/icons.jsx'
import { ZoomableImage } from '../ZoomableImage.jsx'
import { FileLink, Markdown } from '../Markdown.jsx'
import { titlePieces } from '../filePath.js'
import { formatCount, formatSaidAt } from '../../../app/format.js'
import { InlineViewSlot } from '../InlineView.jsx'
import { NoticeMark } from '../NoticeMark.jsx'
import { UserAttachment } from './attachments.jsx'
import { WorktreeProposalRow } from './delegation.jsx'
import { CentraluCallHeader } from './CentraluCall.jsx'
import { CentraluCallBody } from './CentraluCallBody.jsx'
import { Badge } from '../../../components/Badge.jsx'
import { Button } from '../../../components/Button.jsx'

/*
 * One row of the conversation (#428): which card a chat item is drawn as, and the cards that
 * draw a row back into themselves. `ToolCard` and `SubagentSteps` stay in this file because a
 * launch card draws its subagent's steps with `ChatRow` — split out, the three would import each
 * other in a circle (tooling/dependency-cruiser.cjs forbids one).
 */

/**
 * A single message bubble row.
 *
 * **The reason for memo is streaming.** While a response streams, each delta only changes the
 * last row (the store's message_delta leaves every other item's identity untouched), and
 * without memo, every visible bubble on screen was re-rendered **entirely** on each chunk — with
 * a long answer filling the screen, that means re-parsing markdown many times over (measured:
 * 2.7 renders per character). Markdown itself is already memoized, but that alone cannot stop
 * the shell above it from running fresh every time.
 */
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
  /** The owner of projectRoot — so file links open in this pane's project (#182) */
  projectId?: string | null
  sessionId: string
  /**
   * This is a row the list is about to detach — if it has an app view, sends teardown and
   * collapses it (M4 B-1)
   */
  leaving?: boolean
  /**
   * A subagent's step drawn inside its launch card (#222), not a row of the conversation. An app
   * view stands under the parent's own calls only — the host opens none for a subagent's.
   */
  nested?: boolean
}) {
  if (item.kind === 'user') {
    const relayed = Boolean(item.from || item.fromApp || item.fromScript)
    return (
      <div className="flex flex-col items-end" data-testid="msg-user">
        {/*
          A message that came in through delegation (FR-11). Placed in the same spot (right) as
          the person's own messages — to the session it is equally "a directive received" —
          with a source name above it and a deeper fill (surface-relayed, solid border). No color is used
          (the palette rule): the distinction is the surface step.
        */}
        {item.from && (
          <div className="pb-0.5 text-xs text-ink-muted" data-testid="msg-user-from">
            {item.from.name} ⤷
          </div>
        )}
        {/*
          A message sent by an in-conversation app view (M4 B-1). A person chose to send it, but
          the app wrote it — shown in the same look as a delegated message (deeper fill, a
          one-line source), noting that the source is an app rather than a session.
        */}
        {item.fromApp && (
          <div className="pb-0.5 text-xs text-ink-muted" data-testid="msg-user-from-app">
            {item.fromApp.name} app ⤷
          </div>
        )}
        {/* A first message a script wrote (§8.1): the person set the script up, but did not type this */}
        {item.fromScript && (
          <div className="pb-0.5 text-xs text-ink-muted" data-testid="msg-user-from-script">
            script {item.fromScript.credential} ⤷
          </div>
        )}
        {/*
          A string with no whitespace, like a long URL or path, does not wrap under the default
          rule. That makes the bubble spill sideways and puts a horizontal scrollbar on the
          whole conversation (found in dogfooding). whitespace-pre-wrap keeps line breaks the
          person typed, and break-words breaks even a long chunk that otherwise could not wrap.
        */}
        {/*
          Contrast against the background (surface-floor) is what makes "something I said" visible.
          surface-raised plus line was only two steps apart (#1d1d1d and #292929 then; Dark's wider
          steps, #725, make them #242424 and #363636, ΔL* 8.4 apart), and was effectively invisible
          in a dark room (found in dogfooding). This lifts it to surface-hover (#424242 on a #0f0f0f
          floor, ΔL* 23.7), the same as the hover background, and gives the border one step more
          brightness.
        */}
        {/*
          Attachments stand as real objects above the body text — an image as a thumbnail
          (click to zoom), a file as a named chip. This used to render "📎 name" mixed into the
          text, which was a list, not a picture, and it even caused the side effect (#75) of the
          sent text differing from the rendered text.
        */}
        {item.attachments && item.attachments.length > 0 && (
          <div className="flex max-w-[75%] flex-wrap justify-end gap-1.5 pb-0.5">
            {item.attachments.map((a, i) => (
              <UserAttachment key={`${a.path}-${i}`} att={a} />
            ))}
          </div>
        )}
        {/*
          A message that came from another session, an app or a script (relayed) is the person's
          bubble one surface step deeper (surface-relayed) with a solid border. It was dashed, but
          a dashed edge means failed or unknown everywhere else in the app (#1629). The source
          line above it stays. No hue: only the step tells it from my own. ink-relayed keeps the
          text at least as contrasty as on my bubble, which matters in the light themes where
          the deeper fill is darker.
        */}
        {/* No empty bubble is rendered for a message that only sent an image */}
        {(item.text || !item.attachments?.length) && (
          <div
            data-mine-bubble
            {...(relayed ? { 'data-relayed': '' } : {})}
            className={`max-w-[75%] whitespace-pre-wrap break-words rounded-bubble border px-3 py-2 ${
              relayed ? 'border-ink-muted/50 bg-surface-relayed text-ink-relayed' : 'border-ink-faint/40 bg-surface-hover text-ink'
            }`}
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
     * A reasoning summary (#58). It is the path to the body, not the body itself, so it is
     * dimmed one step to ink-muted — following the ink rule exactly, where brightness signals
     * importance. Codex's summary arrives as **bold heading** markdown, so this is still
     * rendered through Markdown, just left quiet with no background color.
     */
    return (
      <div className="min-w-0 text-md text-ink-muted [&_strong]:text-ink-muted" data-testid="msg-reasoning">
        {/* A row stored before the host kept two reasoning items apart has their headings run together (#1464) */}
        <Markdown text={splitRunTogetherHeadings(item.text)} projectRoot={projectRoot} projectId={projectId} linkSessionId={sessionId} />
      </div>
    )
  }
  if (item.kind === 'approval') {
    // A pending approval is already shown by the card right below it, so this row only appears
    // once a decision has been made
    if (!item.decision) return null
    return (
      <p className="readout text-xs text-ink-faint" data-testid="msg-approval-log">
        {item.decision === 'deny' ? 'Denied' : 'Allowed'} · {item.summary}
      </p>
    )
  }
  if (item.kind === 'mark') {
    /*
     * The label **shrinks and wraps.**
     *
     * This row was built for **short divider labels** like "conversation compacted here", so
     * `shrink-0` was the right value at the time. But once a failed turn started being shown on
     * screen (#107), error sentences ended up in the same spot — a single line like "Your
     * access token could not be refreshed because your refresh token was revoked…" pushed the
     * row wide and **put a horizontal scrollbar on the whole conversation** (found in
     * dogfooding). A sentence the person needs to read being pushed off screen defeats the
     * point of showing it at all.
     *
     * The lines on either side are `flex-1`, so they only ever draw whatever space the label
     * leaves over — center alignment holds even when the label wraps to several lines, and a
     * short label still looks exactly as it did before.
     */
    // A tool's notice the host made readable (#342): who, what kind, whose to act on, the tool's words on demand
    if (item.notice) return <NoticeMark notice={item.notice} />
    return (
      <div className="flex items-center gap-2 py-1" data-testid="msg-mark">
        <span className="h-px flex-1 bg-line" />
        <span className="readout min-w-0 break-words text-center text-2xs text-ink-faint">{item.text}</span>
        {item.pickModel && (
          // The provider refused this session's model (#1369): the model menu below the composer, one click away
          <Button
            size="xs"
            className="shrink-0"
            data-testid="msg-mark-pick-model"
            onClick={() => useStore.getState().requestSettingsMenu(sessionId)}
          >
            Pick another model
          </Button>
        )}
        <span className="h-px flex-1 bg-line" />
      </div>
    )
  }
  if (item.kind === 'image') {
    /*
     * An image produced by the agent (#40). The host keeps a copy (a file under the attachments, its path in the row), so a
     * reload brings it back unless the size cap swept it. When there is no `data`, this states the reason instead of a
     * silent blank (failures stay visible — an app-wide rule).
     */
    if (!item.data) return <ImageNote path={item.path} name={item.name} note={item.note} />
    return <ImageMessage mime={item.mime} data={item.data} path={item.path} name={item.name} />
  }
  // A manager's worktree proposal (#69) — a line pointing at the door rather than a tool card, and the value
  // (branch name) is pre-filled into the window
  if (/propose_worktree_session$/.test(item.tool)) return <WorktreeProposalRow item={item} />
  return (
    <>
      <ToolCard item={item} sessionId={sessionId} projectRoot={projectRoot} projectId={projectId} />
      {/* The app view this call opened (M4 B-1) — its own view is looked up by the card's id.
      Nothing is rendered if there is none */}
      {item.callId && !nested && (
        <InlineViewSlot sessionId={sessionId} callId={item.callId} leaving={leaving} />
      )}
    </>
  )
})

/**
 * An image inside the conversation (#40, extended to zoom in #62).
 *
 * In the body it is clipped at max-h-80, so text in a screenshot cannot be read — clicking it
 * opens a larger view in a modal. Why the Modal component is reused as-is: being a portal, it
 * is never trapped by a grid cell's overflow (the pitfall called out in #62), and closing via
 * Esc or an outside click does not have to be rebuilt.
 */
function ImageMessage({ mime, data, path, name }: { mime?: string; data: string; path?: string; name?: string }) {
  // Bytes the window cannot decode draw as an empty framed box (WebKit paints not even the alt text, #1464): say so instead
  const [undrawable, setUndrawable] = useState(false)
  if (undrawable) return <ImageNote path={path} name={name} note="the window could not draw it" />
  return (
    <div className="min-w-0" data-testid="msg-image">
      <ZoomableImage
        src={`data:${mime};base64,${data}`}
        alt={path ?? 'agent image'}
        /* Clipped so it never covers the whole screen vertically — the original aspect ratio is kept */
        thumbClassName="max-h-80 max-w-full rounded-lg border border-line"
        onError={() => setUndrawable(true)}
        onLoad={(img) => {
          if (img.naturalWidth === 0 || img.naturalHeight === 0) setUndrawable(true)
        }}
      />
    </div>
  )
}

/**
 * In place of an image the host did not send or the window could not draw: one line that says what it was and why it is
 * not here, in the muted style of the other notes (#1464). The file's name stands in the line and its whole path in the
 * tooltip. It fades in over 160ms (opacity only under reduced motion, `cc-fade`) as the image it replaces can have been
 * on screen a moment before the window found it undrawable.
 */
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

/**
 * The number of lines shown as a preview while collapsed — just enough to recognize what
 * command produced what
 */
const PREVIEW_LINES = 3

/**
 * The preview's **height cap** (reported by a user on 2026-09-12).
 *
 * `PREVIEW_LINES` counts lines split by `\n`. But there is no guarantee one logical line renders
 * as one visual line: something like a resource-upload response, one blob of JSON with no
 * newlines, is logically one line, so the preview truncation cuts nothing at all, and on screen
 * it wraps into dozens of lines, with the card covering the entire conversation. That is what
 * "collapsed, but everything is showing" meant.
 *
 * So one more cap is added — a height counted in **visible lines**. `lh` is one line-height unit
 * of that element, so `3lh` is always exactly three lines regardless of font size or leading
 * changes (writing it in px would mean hand-rounding a value like
 * leading-body × 11px = 17.875px, and that rounding would show one pixel of a fourth line's
 * top edge).
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
 * The tool card.
 *
 * **No scrolling inside it.** A small scroll area inside the conversation intercepts the wheel,
 * so trying to scroll the conversation instead scrolls inside the card while the conversation
 * stays put (called out as "annoying" in dogfooding). Scrolling belongs to exactly one thing,
 * the conversation itself — collapsed shows a preview, expanded shows everything. Length is
 * decided by the person.
 *
 * **Collapsed by default.**
 *
 * This used to collapse only read-only tools and expand changes (Bash, Edit, MCP). The thinking
 * was that changes need to be seen, but in practice, using a tool even a few times buried the
 * conversation in output, making the actual answer unreadable (found in dogfooding). What was
 * done is already said by the title row — whether that is a command or a path.
 *
 * Two things are never lost even while collapsed: a failure stays visible as 'Failed' in the
 * title row, and a few lines of output preview are shown as-is.
 */
export function ToolCard({
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
   * window knows, since a repository's own server may carry that name (#730 review)
   */
  const knownApp = useStore(
    (s) => !read?.app || !!item.centralu || s.externalApps.some((a) => a.appId === read.app),
  )
  const call = knownApp ? read : null
  // ask_project (#371 part B) keeps the testids its e2e reads the card, its toggle and its answer by
  const ask = call?.tool === 'ask_project'
  // The files the title names that the viewer can open are links (the audit of 2026-10, item 6)
  const pieces = useMemo(
    () => titlePieces(item.title, item.paths, projectRoot),
    [item.title, item.paths, projectRoot],
  )
  const linked = pieces.some((p) => p.ref)
  const lines = item.result ? item.result.replace(/\s+$/, '').split('\n') : []
  /*
   * The tail of output while the tool is still running (#58, Codex's outputDelta). Only shown
   * until `result` arrives — unlike the preview, this shows **the end**: for a command still
   * running, what matters is now, not the start.
   * (The sum of chunks is not the whole thing — the first chunk has been observed missing in
   * practice. The full output is what `result` delivers.)
   */
  /** The whole input shows once the card is open, when it says more than the title row can (below) */
  const showInput =
    !call && open && item.title !== item.tool && (item.title.includes('\n') || item.title.length > 60)
  /** Still running: no answer yet and no failure */
  const running = item.result === undefined && item.ok === undefined
  const liveTail =
    open && item.result === undefined && item.live
      ? item.live.replace(/\s+$/, '').split('\n').slice(-PREVIEW_LINES)
      : []

  return (
    /*
      A Centralu call's card (#730; owner, 2026-10-18: it should stand out from the other tool calls and read as what
      happened): a rounder card on its own tint with a stronger hairline, a sentence instead of a tool name, and the
      session it reached as a chip. Emphasis by shape and weight, never the signal's white, which is kept for what waits
      on the person. A failed call is dashed, as an error is on the inbox's capsule.
    */
    <div
      className={
        call
          ? `rounded-lg border bg-surface-hover/15 ${item.ok === false ? 'border-dashed border-ink-muted' : 'border-line-strong/70'}`
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
        /*
         * A title with a file the viewer can open (the audit of 2026-10, item 6). A link cannot sit inside the
         * toggle button (a button holds no button), so the toggle is the chevron and the tool's name, the
         * title follows with its path as a link, and the empty rest of the row still toggles for the pointer.
         */
        <div className="flex w-full items-center">
          <button
            className="flex shrink-0 items-center py-2 pl-3 pr-2.5 text-left"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            data-testid="tool-card-toggle"
          >
            <span className="readout shrink-0 rounded-md bg-surface-hover/50 px-1.5 py-0.5 text-2xs text-ink-muted">
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
          {/* The tool on a quiet tile, then what it was given, in the code face (owner, 2026-10-18) */}
          <span className="readout shrink-0 rounded-md bg-surface-hover/50 px-1.5 py-0.5 text-2xs text-ink-muted">
            {item.tool}
          </span>
          <span className="readout min-w-0 flex-1 truncate text-xs text-ink-muted">
            {item.title === item.tool ? '' : item.title}
          </span>
          {running && <span className="size-1.5 shrink-0 rounded-full bg-ink-muted" aria-label="running" />}
          {item.ok === false && <span className="shrink-0 text-2xs text-ink-muted">failed</span>}
          {/* There must be one expand indicator across the whole app — the same chevron as the file tree */}
          <span className="shrink-0 text-ink-faint">
            <ChevronIcon open={open} />
          </span>
        </button>
      )}

      {/*
        What the tool was given, whole, once the card is open (owner, 2026-10-18: a long command was cut to one line in
        the title and could not be read anywhere). Only when it says more than the title row could.
      */}
      {showInput && (
        <div className="border-t border-line/70 px-3 py-2" data-testid="tool-card-input">
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

      {/* A Centralu call folds to its sentence: the answer shows only when the card is opened (owner, 2026-10-18) */}
      {call && open && item.result && item.result.trim() && (
        <div className="border-t border-line/70 px-3 py-2" data-testid={ask ? 'ask-project-result' : 'tool-card-output'}>
          <CentraluCallBody result={item.result} open={open} onOpen={() => setOpen(true)} />
        </div>
      )}

      {/*
        The output only once the card is open (owner, 2026-10-18: the preview lines were rarely read and made every
        call a block). Closed, a card is its one title row; the tail of a running command shows when it is opened.
      */}
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
 * What the subagent a launch card started did (#222), collapsed under the card.
 *
 * The conversation never shows these steps: a subagent's calls landing among the parent's was
 * the confusion #98 removed. They are read from the host only when the person opens this, and
 * drawn with the conversation's own rows (`messagesToChat`, `ChatRow`) — its text, its reasoning,
 * its tool cards — so a step reads the same here as the parent's does above. An agent the
 * subagent launched is a launch card too, with its own steps inside.
 *
 * Whether it is open and what it read live in the store, keyed by the card: the virtual list
 * detaches a row that scrolls away, and a card drawn again must come back as it was left.
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
          {/*
            Steps archived without the session (#418) are said to be there, with the way back: read as "none
            were recorded", a card the person emptied looked like one that never kept anything
          */}
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

/**
 * Where a card's archived steps went (#418), in the number they are: "The step was moved… restores it" for one,
 * "…restores them" for more, and "N earlier steps" when a running subagent wrote more under the card since
 */
export function trashedLine(trashed: number, more: boolean): string {
  const one = trashed === 1
  const what = more ? `${formatCount(trashed)} earlier ${one ? 'step was' : 'steps were'}` : one ? 'The step was' : 'The steps were'
  return `${what} archived. Settings → Archive restores ${one ? 'it' : 'them'}.`
}

/**
 * When a message was said, under its bubble (owner, 2026-10-18): quiet, small, in the faintest ink. The 4px between the
 * bubble and the time (owner, 2026-10-19) is its own, so the person's row and the answer's share one value; a caller
 * gives only the side padding that lines the time up with the bubble's corner.
 */
export function SaidAt({ at, className = '' }: { at: number; className?: string }) {
  return (
    <div className={`pt-1 text-2xs text-ink-faint ${className}`} data-testid="said-at">
      {formatSaidAt(at)}
    </div>
  )
}
