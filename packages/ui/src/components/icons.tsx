/**
 * Icons.
 *
 * No emoji. Emoji (1) look different across OSes and fonts, so density cannot be controlled, and
 * (2) are mostly full of hue, breaking this app's rule of "color only in the body of a diff"
 * immediately. An SVG where we control the stroke weight and color has neither problem.
 *
 * `currentColor` is used, so the color is decided by the parent's text-* class — hover and
 * disabled states follow automatically.
 */
export function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
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
 * The crown — the marker for an orchestrator's role, directing other sessions.
 *
 * It speaks a role, not a state, so it does not compete for the same spot with the border that
 * spins while responding. If the sidebar and the session header used different drawings, the
 * same role would end up with two faces, so this one icon is shared between them.
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

/**
 * The app — one window, one control surface (M4 B-2). An app's row stands alongside session rows
 * in the sidebar, so it has to be told apart from a session's tool-letter chip by shape (the
 * palette's rule: kind by shape, urgency by brightness).
 */
export function AppIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <rect x="1.8" y="2.3" width="12.4" height="11.4" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.8 5.8h12.4" stroke="currentColor" strokeWidth="1.3" />
      <rect x="4.2" y="8" width="3.2" height="3.2" rx="0.6" fill="currentColor" />
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
 * The expand/collapse indicator — an arrow with no tail (a chevron).
 *
 * Collapsed points right, expanded points down. The same glyph is rotated: drawing the two
 * directions separately leaves subtle differences in weight or size, producing a jump when
 * opening and closing, and rotation cannot do that. The rotation itself also says "this just
 * opened".
 *
 * This replaced a filled triangle (▸▾) that was used before — a triangle is drawn by the font, so
 * we cannot control its size or alignment, and its weight is heavier than text, so it caught the
 * eye before the name did in a list.
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
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={`shrink-0 ${dir < 0 ? 'rotate-180' : ''}`} aria-hidden>
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
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

/**
 * Rename — a pencil.
 *
 * Text ('Rename') is not used here because this spot (the right end of a session row) is a
 * narrow space standing next to the delete button, and adding text would truncate the name on
 * every row. A pencil is nearly a universal symbol for "edit", so switching to an icon does not
 * weaken the meaning.
 */
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
 * Run — a filled triangle.
 *
 * Filled, where the chevron next door deliberately is not. That note is about *font*
 * triangles: their weight and alignment belong to whichever font drew them, which is why
 * they lost to a drawn chevron. Drawn here, the solid mark is the right one — "run" is a
 * button you press, and an outline reads as a shape being described rather than pressed.
 */
/**
 * Run — a play triangle.
 *
 * The old triangle occupied only 7 x 9.2 inside a 16-unit canvas, and that was drawn at 13px.
 * The restart icon standing right beside it draws an 11-diameter circle at 14px, so on the same
 * row the ink width differed by nearly a factor of two. That is why it looked small even though
 * the size numbers, 13 and 14, were close — it is the ink, not the canvas, that determines
 * perceived size.
 *
 * So the canvas is filled more (8.8 x 10.8) and drawn at 15px. The corners are rounded: every
 * other icon in this file uses `strokeLinecap="round"`, and a single knife-sharp triangle looked
 * like it belonged to a different set.
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

/**
 * Restart — an arrow drawing a circle.
 *
 * Turning the word "Restart" into an icon would weaken the meaning, so a nearly universal symbol
 * is used instead. The arrowhead is what makes it read as "circling back around" rather than
 * "reverting".
 */
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

/**
 * A branching trunk — the worktree manager (#76).
 *
 * A branch drawn with three dots and lines is nearly a universal symbol, so even as a button
 * never seen in this app before, it reads immediately as "something git". There is no risk of
 * confusion with the crown (orchestrator) either: one speaks a role, the other a branching, so
 * what the shapes say is entirely different.
 */
export function BranchIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.5 5.1v5.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {/* A branch splitting off from the trunk comes back down again — branching and merging in one stroke */}
      <path
        d="M11.5 5.1v1.4a2.4 2.4 0 01-2.4 2.4H6.9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * Import — an arrow descending onto a tray (M4 E-3). It stands next to "new app" (+), so it is
 * told apart by shape: creating is a plus, bringing something in is the shape of a download.
 */
export function ImportIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 2.5v7M5 6.8 8 9.8l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.8 10.5v1.6c0 .8.6 1.4 1.4 1.4h7.6c.8 0 1.4-.6 1.4-1.4v-1.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
