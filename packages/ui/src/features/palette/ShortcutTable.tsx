import { useNavShortcut, useShortcut } from '../../app/shortcut.js'
import { Kbd } from '../../components/primitives.jsx'

/**
 * FR-17's shortcut table, in the palette (looked up in passing, where a key is wanted), not Settings. Written by
 * meaning (issue #32): `'mod'` and `'alt'` are named by this machine's keyboard only, the one the keys are pressed on.
 */
const SHORTCUTS: [string[], string][] = [
  [['mod', 'I'], 'Waiting'],
  // `⇧` is printed on PC keyboards too, so it stays a symbol, joined to its key: better than `Ctrl+⇧+A`
  [['mod', '⇧A'], 'Jump to next waiting'],
  [['mod', 'K'], 'Command palette'],
  [['mod', '1~9'], 'Jump to project'],
  // The digits name tabs, not positions (EvidencePanel's handler), so this stays true after a drag-reorder
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
    <ul className="divide-y divide-line" data-testid="shortcut-list">
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
