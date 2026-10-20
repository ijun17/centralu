import { useNavShortcut, useShortcut } from '../../app/shortcut.js'
import { Kbd } from '../../components/primitives.jsx'

/**
 * FR-17 shortcut table — has to be viewable and checkable. It lived in Settings → Shortcuts until the owner moved it to
 * the command palette (2026-10-20): it is something looked up in passing, and the palette is where a key is wanted.
 *
 * A combination is written **by meaning**: `'mod'` and `'alt'` get named by this machine's own
 * keyboard (`⌘`/`Ctrl`, `⌥`/`Alt`), and the remaining pieces are the key's own name as is
 * (issue #32).
 *
 * The table shows **this machine's own keyboard**, right now. There is no other answer — the keys
 * written here are pressed on this machine, and listing both sets would only cost time finding the
 * one that actually applies.
 */
const SHORTCUTS: [string[], string][] = [
  [['mod', 'I'], 'Waiting'],
  // `⇧` is printed on those keyboards too, so there is no word to translate it into. Attaching
  // it to the following key reads better than `Ctrl+⇧+A`
  [['mod', '⇧A'], 'Jump to next waiting'],
  [['mod', 'K'], 'Command palette'],
  [['mod', '1~9'], 'Jump to project'],
  /*
   * The digits name tab *identities*, not positions (EvidencePanel's handler) — after a
   * drag-reorder this list stays true, which is the whole reason identity was chosen.
   * The names listed here were once "chat · files · git · viewer": tabs that predate the
   * three-lane layout. Nobody noticed because the shortcut itself didn't exist until #20.
   */
  [['mod', '⇧1~4'], 'Panel tab (changes · history · files · terminal)'],
  [['y / n / a'], 'Approve · deny · always allow'],
  [['alt', 'a'], 'Always allow (project scope)'],
  // In the composer y/n/a are letters of the message; these answer the card from there (ApprovalCard's APPROVAL_COMBOS)
  [['mod', '⇧Y'], 'Approve, while typing in the composer'],
  [['mod', '⇧D'], 'Deny, while typing in the composer'],
  [['mod', '⇧L'], 'Always allow, while typing in the composer'],
  [['d'], 'Dismiss from inbox'],
  [['j / k'], 'Move in inbox'],
  [['Enter / Esc'], 'Send · close'],
]

export function ShortcutTable() {
  const sc = useShortcut()
  const nav = useNavShortcut()
  return (
    <ul className="divide-y divide-line/70" data-testid="shortcut-list">
      {SHORTCUTS.map(([keys, label]) => (
        <li key={label} className="flex items-center gap-4 px-4 py-2">
          <span className="min-w-0 flex-1 truncate text-sm text-ink-muted">{label}</span>
          <Kbd>{sc(...keys)}</Kbd>
        </li>
      ))}
      {/* Back and forward (#374): this keyboard's browser keys, not a fixed combination (`navShortcut`) */}
      <li className="flex items-center gap-4 px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-sm text-ink-muted">Back · forward between screens</span>
        <span className="flex shrink-0 items-center gap-1 text-2xs text-ink-faint">
          <Kbd>{nav(-1)}</Kbd>
          <span aria-hidden>/</span>
          <Kbd>{nav(1)}</Kbd>
        </span>
      </li>
    </ul>
  )
}
