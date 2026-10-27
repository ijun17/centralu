import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { machineProblem } from '@cc/core'
import type { MachineInfo } from '@cc/protocol/client'
import { useStore } from '../../../store/store.js'
import { ActionRow } from './ActionRow.jsx'
import { menuTrigger } from './RowMenu.jsx'
import { connectAction } from '../../settings/MachinesSection.jsx'

/** An attempt to connect is under way: the link opening, a host being started, or an update holding it */
const isTrying = (status: MachineInfo['status'] | undefined): boolean => status === 'connecting' || status === 'starting' || status === 'updating'

/**
 * Reconnect, first in the menu of a project whose machine is not connected (#1533). The person finds the project, not the
 * machine: its menu is where they look for a way to bring it back, and the badge's menu and Settings → Machines were two
 * clicks away. It is the same action as theirs (`reconnectMachine`, so `machines.reconnect`: one attempt now, skipping the
 * backoff), and the host joins a press and an agent's call at the same moment into one attempt.
 *
 * It says what it is doing: "Connecting…" while the attempt is under way, with the menu left open; connected, the menu
 * closes (the row is gone, there is nothing left to press); failed, the row is back with the reason in plain words under it
 * (the words Settings → Machines uses for the same state), ready to be pressed again. Hidden while the machine is connected.
 */
export function ReconnectRow({
  machine,
  projectName,
  anchorEl,
  onClose,
}: {
  machine: string
  projectName: string
  /** The box that holds the button that opened the menu: where the keyboard goes back to when the row goes while it holds it */
  anchorEl: HTMLElement | null
  onClose: () => void
}) {
  const resultId = useId()
  const info = useStore((s) => s.machines[machine])
  /*
   * What the row says about a press is what the attempt it started came to, never what the machine said before it: the
   * state that was there (with its old error) must not read as this press's failure. So a result is told only after the
   * press has been seen to start an attempt (`connecting`, `starting`): watched on the store itself, since a render can skip
   * a state that came and went within one batch. A press that started none (the host refused it, a change under way there)
   * has the toast, not a result.
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
  /*
   * The row goes when the machine connects, by this press or by itself, and keyboard focus that was on it falls to the
   * body with it. It goes back to the button that opened the menu (as Escape sends it there): the menu stays open when
   * the machine came back by itself, and closes after a press with the focus where it started. Only where it fell to the
   * body: focus on another row of the menu stays there.
   */
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
        Always there once the row is, so a screen reader that watches it hears the result when it is put in. A plain element
        with aria-live, not role="status": a menu holds menu items, and an unnamed status between them is not one
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
