import type { ReactNode } from 'react'
import type { MarkKind } from '../store/transcript.js'

/**
 * Icons: SVG in `currentColor`, no emoji (docs/design-system.md §5); emoji differ per OS and carry hue, which this app
 * keeps for the body of a diff. The parent's text-* class decides the colour, so hover and disabled follow.
 */
export function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/**
 * A gear — settings. Eight even teeth around a hollow centre (computed, so every tooth is the same), drawn with the
 * magnifier's stroke weight beside it in the top bar.
 */
export function GearIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <path
        d="M6.53 2.70 L6.78 1.11 L9.22 1.11 L9.47 2.70 L10.71 3.21 L12.02 2.27 L13.73 3.98 L12.79 5.29 L13.30 6.53 L14.89 6.78 L14.89 9.22 L13.30 9.47 L12.79 10.71 L13.73 12.02 L12.02 13.73 L10.71 12.79 L9.47 13.30 L9.22 14.89 L6.78 14.89 L6.53 13.30 L5.29 12.79 L3.98 13.73 L2.27 12.02 L3.21 10.71 L2.70 9.47 L1.11 9.22 L1.11 6.78 L2.70 6.53 L3.21 5.29 L2.27 3.98 L3.98 2.27 L5.29 3.21Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  )
}

/** The window's own controls where the top bar draws them (Windows): minimize, maximize, restore. Thin, as the OS draws them */
export function WindowMinIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" aria-hidden className="shrink-0">
      <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

export function WindowMaxIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" aria-hidden className="shrink-0">
      <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

export function WindowCloseIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" aria-hidden className="shrink-0">
      <path d="m0.5 0.5 9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

/** A filled square — stop, as on any player */
export function StopIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden className="shrink-0">
      <rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  )
}

/**
 * A ring: how a run ended (the saved commands list), solid when it ended well or was stopped, dashed when it failed, as
 * in the background work list. Drawn, not a bordered span, so it is not read as a capsule. The dash divides the
 * circumference evenly, so no seam shows.
 */
export function RingIcon({ dashed = false, size = 8 }: { dashed?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" fill="none" aria-hidden className="shrink-0">
      <circle
        cx="4"
        cy="4"
        r="3.5"
        stroke="currentColor"
        strokeWidth="1"
        strokeDasharray={dashed ? '1.5 1.25' : undefined}
      />
    </svg>
  )
}

/** Two cards, one behind the other — work going on behind the conversation (background tasks) */
export function BackgroundIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <rect
        x="5"
        y="2.5"
        width="9"
        height="7.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.2"
        opacity="0.55"
      />
      <rect
        x="2"
        y="6"
        width="9"
        height="7.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="var(--color-surface-side, transparent)"
      />
    </svg>
  )
}

/** An envelope — the inbox: what waits for the person */
export function MailIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <rect x="2" y="3.5" width="12" height="9" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="m2.6 4.6 5.4 4 5.4-4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A magnifier — search (#529) */
export function SearchIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.4 10.4 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** Three dots — "there is more here". A shape, not a glyph (⋯), so it does not depend on the font */
export function DotsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </svg>
  )
}

/**
 * The crown: an Assistant's role, shared by the sidebar and the session header so a role has one face. A role, not a
 * state, so it does not compete with the border that spins while responding.
 */
export function CrownIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <path
        d="M2.6 13.5 L1.8 4.6 L5.9 7.4 L8 2.6 L10.1 7.4 L14.2 4.6 L13.4 13.5 Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** The app (M4 B-2): its row stands among session rows, so it differs from a tool-letter chip by shape */
export function AppIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <rect x="1.8" y="2.3" width="12.4" height="11.4" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.8 5.8h12.4" stroke="currentColor" strokeWidth="1.3" />
      <rect x="4.2" y="8" width="3.2" height="3.2" rx="0.6" fill="currentColor" />
    </svg>
  )
}

/** An app window with a plus in place of its content: make a new app (the sidebar's Projects row) */
export function AppPlusIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <rect x="1.8" y="2.3" width="12.4" height="11.4" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.8 5.8h12.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7.8v3.9M6.05 9.75h3.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** A folder with a plus: add a folder as a project (the sidebar's Projects row) */
export function FolderPlusIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <path
        d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3.1l1.6 1.7h5.3c.7 0 1.2.5 1.2 1.2v6.6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V4.2Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8 7.2v4M6 9.2h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Centralu's mark (#730): the app icon's four panes (`apps/desktop/src-tauri/icons/sources/panes.svg`, #1705), in one
 * ink: three faint, the different one (top right, its inner corner cut) full. Outer corners rounder than inner, as there.
 * It marks a call to Centralu's own tools in a conversation, the points where an agent reaches other sessions,
 * projects, machines or apps. Kind by shape: it is emphasis, never the signal's brightness.
 */
export function CentraluMarkIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden className="shrink-0">
      <g fillOpacity="0.35">
        <path d="M1.5 6.7V3.5A2 2 0 0 1 3.5 1.5H6.7A.85 .85 0 0 1 7.55 2.35V6.7A.85 .85 0 0 1 6.7 7.55H2.35A.85 .85 0 0 1 1.5 6.7Z" />
        <path d="M1.5 12.5V9.3A.85 .85 0 0 1 2.35 8.45H6.7A.85 .85 0 0 1 7.55 9.3V13.65A.85 .85 0 0 1 6.7 14.5H3.5A2 2 0 0 1 1.5 12.5Z" />
        <path d="M8.45 13.65V9.3A.85 .85 0 0 1 9.3 8.45H13.65A.85 .85 0 0 1 14.5 9.3V12.5A2 2 0 0 1 12.5 14.5H9.3A.85 .85 0 0 1 8.45 13.65Z" />
      </g>
      <path d="M8.45 5.13V2.35A.85 .85 0 0 1 9.3 1.5H12.5A2 2 0 0 1 14.5 3.5V6.7A.85 .85 0 0 1 13.65 7.55H10.87Q10.27 7.55 9.84 7.12L8.88 6.16Q8.45 5.73 8.45 5.13Z" />
    </svg>
  )
}

export function CloseIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The expand/collapse chevron (docs/design-system.md §5): right when closed, rotated down when open. One glyph rotated,
 * since two drawings differ subtly in weight and jump on toggle.
 */
export function ChevronIcon({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
      aria-hidden
    >
      <path
        d="M6 3.5L10.5 8L6 12.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Back or forward between screens (#374): the same chevron as the fold's, pointing the way it goes */
export function StepIcon({ dir, size = 14 }: { dir: -1 | 1; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={`shrink-0 ${dir < 0 ? 'rotate-180' : ''}`}
      aria-hidden
    >
      <path
        d="M6 3.5L10.5 8L6 12.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Send. A paper airplane is nearly a universal symbol for "send", so it reads faster than text */
export function SendIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M14 2L7.2 8.8M14 2L9.6 14.2a.3.3 0 01-.56.02L7.1 9.0 1.9 7.06a.3.3 0 01.02-.56L14 2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Rename: a pencil. Beside delete at a session row's right end, a word would truncate every row's name */
export function PencilIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M11.2 2.3l2.5 2.5-8 8-3.2.7.7-3.2 8-8z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Run: a filled, drawn triangle (the chevron's rule is about font triangles); an outline reads as described, not
 * pressed. Ink, not canvas, sets perceived size: beside the restart icon's 11-unit circle at 14px, a 7 x 9.2 triangle
 * at 13px looked half as wide, so it fills 8.8 x 10.8 at 15px. Rounded corners, as every other icon's round caps.
 */
export function PlayIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4.6 3.1a.9.9 0 011.37-.76l7.1 4.9a.9.9 0 010 1.52l-7.1 4.9A.9.9 0 014.6 12.9z"
        fill="currentColor"
      />
    </svg>
  )
}

/** Restart: an arrow circling; the arrowhead makes it read as "around again", not "revert" */
export function RestartIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M13.5 8a5.5 5.5 0 11-1.61-3.89"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M13.5 2v3.2h-3.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A branching trunk: the worktree manager (#76), read at once as "something git" */
export function BranchIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.5 5.1v5.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {/* Branching and merging in one stroke */}
      <path
        d="M11.5 5.1v1.4a2.4 2.4 0 01-2.4 2.4H6.9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Uncommitted changes: a page with the diff's plus over minus, so the sidebar's count does not read as a bare number */
export function ChangesIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3.5 2.5h6l3 3v8a1 1 0 01-1 1h-8a1 1 0 01-1-1v-10a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M8 5.6v3.6M6.2 7.4h3.6M6.2 11.4h3.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

/*
 * The categories of Settings, one mark each beside its name in the rail. Drawn on the same 16-unit grid and stroke as
 * the sidebar's marks, so the rail reads as the same family.
 */

/** A clock face — a watch: Centralu wakes the session at a time, or when something it waits on happens (#1324) */
export function ClockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.8V8l2.2 1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A bell — notifications */
export function BellIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <path
        d="M4 11.2V7.4a4 4 0 0 1 8 0v3.8l1.1 1.3H2.9Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M6.6 14h2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** A screen on a stand — a machine */
export function MonitorIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 13.8h5M8 11v2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** A circle half filled — appearance (light and dark) */
export function ContrastIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 2.2a5.8 5.8 0 0 1 0 11.6Z" fill="currentColor" />
    </svg>
  )
}

/** A shield — permissions */
export function ShieldIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <path
        d="M8 1.8 13 3.7v3.9c0 3.1-2.1 5.4-5 6.6-2.9-1.2-5-3.5-5-6.6V3.7Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A box with a lid — the session archive. Not the bin: the archive is put-away sessions, and a bin invited "empty it" (#1404) */
export function ArchiveIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <rect x="2" y="2.8" width="12" height="3.2" rx="0.8" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M3.2 6v6.4c0 .6.4 1 1 1h7.6c.6 0 1-.4 1-1V6M6.4 9h3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * An icon in a line of text is the text's cap height on its baseline (docs/design-system.md §5, #2332): Pretendard's
 * 0.73em, filling its box; the inline SVG's bottom edge is the baseline a flex row aligns on.
 */
const CAP_BOX = 'inline-block size-[0.73em] shrink-0 align-baseline'

/** An icon in a line of text, on a 10-unit grid: drawn to fill its cap-height box (`CAP_BOX`) */
function CapIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={CAP_BOX}>
      {children}
    </svg>
  )
}

/** "From", after a relayed message's source line (#1948): down, then right. Drawn: the font's ⤷ sits high (#2332) */
const FROM_ARROW = 'M1.75.75v4a2.25 2.25 0 0 0 2.25 2.25h5M6.75 4.75 9 7 6.75 9.25'

export function FromArrowIcon() {
  return (
    <CapIcon>
      <path d={FROM_ARROW} strokeWidth="1.2" />
    </CapIcon>
  )
}

/**
 * A line between messages, by its kind (#2338): a compaction, a handoff, a fresh conversation, a notice, a failure. On
 * `CapIcon`'s 10-unit grid, set like the mail line's `MailIcon size={12}`: 12px, the glyph about 9px.
 */
const MARK_PATH: Record<MarkKind, string> = {
  compaction: 'M1 1.5h8M1 8.5h8M5 2.75v2.5M3.5 4 5 5.25 6.5 4',
  handoff: FROM_ARROW,
  reset: 'M8.75 5a3.75 3.75 0 1 1-1.1-2.65M5.6 2.35h2.05V.3',
  notice: 'M5 .75 9.5 9.25h-9zM5 3.75v2.5M5 7.6v.1',
  failed: 'M5 2.6v3M5 7.3v.1M9.4 5a4.4 4.4 0 1 1-8.8 0 4.4 4.4 0 0 1 8.8 0',
}

export function MarkIcon({ kind }: { kind: MarkKind }) {
  return (
    <svg width={12} height={12} viewBox="-1.5 -1.5 13 13" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d={MARK_PATH[kind]} strokeWidth="1.1" />
    </svg>
  )
}

/** A plan step's state (#58), by shape, not hue, at the text's cap height (`CAP_BOX`; docs/design-system.md §5) */
export function PlanStepIcon({ status }: { status: 'pending' | 'inProgress' | 'completed' }) {
  return (
    <CapIcon>
      {status === 'completed' ? (
        <path d="M.75 5.25 3.75 8.5 9.25 1.25" strokeWidth="1.3" />
      ) : status === 'inProgress' ? (
        <path d="M2 .5v9L9.25 5z" fill="currentColor" stroke="none" />
      ) : (
        <circle cx="5" cy="5" r="4.4" strokeWidth="1.1" />
      )}
    </CapIcon>
  )
}
