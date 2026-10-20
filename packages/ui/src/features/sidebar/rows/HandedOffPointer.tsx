import { Button } from '../../../components/Button.jsx'
import { handedOffBy } from '../../../store/sidebarTree.js'
import { useStore } from '../../../store/store.js'
import { groupAttention } from '../fold.js'

/**
 * What a session handed to another machine (#1416): "2 on ijun1", on a line under its row, one pointer per machine.
 *
 * A child `start_agent` starts on a linked machine is drawn in that machine's project, with its own "Asked by" mark,
 * not under the session that asked: a project on another machine is a project of its own. So the parent has no row of
 * it to show, and this is what stands in its place. It is quiet (the faint ink, no frame), and it speaks up in one way
 * only, the dot a folded group has (FoldedMark): a child that is waiting or has errored lights it, so a stopped child
 * is still seen from the parent. Pressing it opens what hides those rows and scrolls to the first, the one that needs
 * the person when one does.
 *
 * It is a line of its own, not part of the row's button: a button inside a button is not a thing a keyboard or a
 * screen reader can tell apart.
 */
export function HandedOffPointer({ parentId }: { parentId: string }) {
  const sessions = useStore((s) => s.sessions)
  const machines = useStore((s) => s.machines)
  const revealSessions = useStore((s) => s.revealSessions)
  const groups = handedOffBy(parentId, sessions)
  if (groups.length === 0) return null
  return (
    <div className={`flex flex-wrap items-center gap-x-1 pb-1 pl-[calc(var(--sidebar-gutter)-4px)]`} data-testid={`handed-off-${parentId}`}>
      {groups.map(({ machine, sessions: children }) => {
        const name = machines[machine]?.name ?? machine
        const attention = groupAttention(children)
        const label =
          `${children.length} ${children.length === 1 ? 'session' : 'sessions'} started on ${name}` +
          (attention === 'alert' ? ', one needs you' : attention === 'unread' ? ', one unread' : '')
        // The one to scroll to: the first that needs the person, else the first
        const target = (children.find((c) => groupAttention([c]) === 'alert') ?? children[0])?.id ?? ''
        return (
          <Button
            key={machine}
            variant="ghost"
            size="xs"
            className="flex items-center gap-1"
            aria-label={label}
            title={label}
            data-testid={`handed-off-${parentId}-${machine}`}
            data-attention={attention ?? undefined}
            onClick={() => {
              revealSessions(children.map((c) => c.id))
              // Scrolled once the rows are drawn: a folded project or group had none to scroll to a moment ago
              requestAnimationFrame(() => {
                const row = document.querySelector(`[data-testid="session-row-${target}"], [data-testid="app-session-row-${target}"]`)
                row?.scrollIntoView({ block: 'nearest' })
              })
            }}
          >
            <span className="readout">
              {children.length} on {name}
            </span>
            {attention && (
              <span
                className={`size-1.5 rounded-full ${attention === 'alert' ? 'bg-ink-signal' : 'bg-ink-muted'}`}
                data-testid={`handed-off-${parentId}-${machine}-attention`}
                data-attention={attention}
              />
            )}
          </Button>
        )
      })}
    </div>
  )
}
