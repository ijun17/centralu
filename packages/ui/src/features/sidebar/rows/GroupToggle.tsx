import { Tooltip } from '../../../components/primitives.jsx'
import { ChevronIcon } from '../../../components/icons.jsx'
import { GUTTER_WIDTH, DISCLOSURE_BUTTON, DISCLOSURE_ICON } from '../layout.js'

/**
 * The chevron of a group that folds (#666): the children a session started, the sessions an app owns.
 *
 * It stands in the **gutter to the left of its row's content**, the 28px every row keeps free after its bar, so the
 * content (tool mark, name) starts in the same column whether or not the row has a group. It is faint ink: a state, not a
 * call to act, so it spends no brightness (the project row's arrow is the same). The project row keeps its own
 * arrow; this one is for what stands under it.
 */
export function GroupToggle({ folded, label, testId, onToggle }: { folded: boolean; label: string; testId: string; onToggle: () => void }) {
  return (
    <span className={`absolute inset-y-0 left-0.5 flex ${GUTTER_WIDTH} items-center justify-center`}>
      <Tooltip content={label} testId={`${testId}-tip`}>
        <button
          type="button"
          aria-label={label}
          aria-expanded={!folded}
          onClick={onToggle}
          data-testid={testId}
          className={`flex ${DISCLOSURE_BUTTON} items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-hover/60 hover:text-ink`}
        >
          <ChevronIcon open={!folded} size={DISCLOSURE_ICON} />
        </button>
      </Tooltip>
    </span>
  )
}
