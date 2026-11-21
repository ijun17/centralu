import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { machineProblem } from '@cc/core'
import { useStore } from '../../../store/store.js'
import { ActionRow } from './ActionRow.jsx'
import { menuTrigger } from './RowMenu.jsx'
import { connectAction, isTrying } from '../../settings/MachinesSection.jsx'

/**
 * Reconnect in the menu of a project whose machine is not connected (#1533), where the person looks: the badge's and
 * Settings' action (`machines.reconnect`, skipping the backoff; the host joins simultaneous calls into one attempt). Says
 * "Connecting…", closes the menu once connected, and on failure gives the reason in Settings → Machines' words.
 */
export function ReconnectRow({
  machine,
  projectName,
  anchorEl,
  onClose,
}: {
  machine: string
  projectName: string
  /** The box holding the menu's button: where focus goes back when the row goes */
  anchorEl: HTMLElement | null
  onClose: () => void
}) {
  const resultId = useId()
  const info = useStore((s) => s.machines[machine])
  /*
   * A result is told only once this press is seen to start an attempt, so the machine's old error never reads as its
   * failure. Watched on the store: a render can skip a state that came and went in one batch. No attempt: the toast says it.
   */
  const [pressed, setPressed] = useState(false)
  const [began, setBegan] = useState(false)
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])
  const status = info?.status
  useEffect(() => {
    if (pressed && status === 'connected') onClose()
  }, [pressed, status, onClose])
  const gone = !info || status === 'connected'
  // When the row goes (connected), focus that fell to the body returns to the menu's button, as Escape does
  const shown = useRef(false)
  useLayoutEffect(() => {
    if (!gone) {
      shown.current = true
      return
    }
    if (shown.current && (!document.activeElement || document.activeElement === document.body)) menuTrigger(anchorEl)?.focus()
    shown.current = false
  }, [gone, anchorEl])
  if (!info || gone) return null
  // An install, update or rollback is under way there: Settings → Machines hides Connect then, and so does the badge's menu
  const busy = !!info.operation
  const trying = isTrying(status)
  const action = connectAction(status ?? 'unreachable')
  const problem = pressed && began && !trying ? machineProblem(info) : null
  return (
    <>
      <ActionRow
        label={trying ? 'Connecting…' : action.label}
        title={busy ? 'Wait for the change under way there to finish' : trying ? undefined : action.title}
        disabled={busy}
        // Under way: not pressable again, but still where the keyboard is (a disabled button would drop its focus)
        pending={trying}
        // The reason an attempt failed is read with the row, which is where the keyboard is
        describedBy={problem ? resultId : undefined}
        onClick={() => {
          stop.current?.()
          setPressed(true)
          setBegan(false)
          stop.current = useStore.subscribe((s) => {
            if (isTrying(s.machines[machine]?.status)) setBegan(true)
          })
          void useStore.getState().reconnectMachine(machine)
        }}
        testId={`reconnect-${projectName}`}
      />
      {/*
        Always present, so a screen reader hears the result. aria-live, not role="status": a menu holds menu items
      */}
      <div
        id={resultId}
        aria-live="polite"
        className={problem ? 'px-2 pb-1.5 text-xs leading-body text-ink-muted' : undefined}
        data-testid={`reconnect-result-${projectName}`}
      >
        {problem && (
          <>
            Could not connect: {problem.title}
            {problem.fix ? `. ${problem.fix}` : ''}
          </>
        )}
      </div>
      <div className="my-1 border-t border-line" />
    </>
  )
}
