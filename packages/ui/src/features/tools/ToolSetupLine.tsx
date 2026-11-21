import { useRef, type ReactNode } from 'react'
import type { ToolStatus } from '@cc/protocol/client'
import type { MachineRef } from '@cc/platform/ports'
import { Button } from '../../components/Button.jsx'
import { Fold } from '../../components/Fold.jsx'
import { ProgressBar } from '../../components/ProgressBar.jsx'
import { formatBytes } from '../../app/format.js'
import { useStore } from '../../store/store.js'
import { useMachineName } from '../../store/selectors.js'
import { setupOf, setupView, type SetupView } from './setupLine.js'
import { useToolSetupActions } from './useToolSetup.js'

/** Each place's own words for a tool set up from a terminal */
export type TerminalHints = {
  /** Installed, signed out: "<tool> needs a login, run <command> in a terminal" */
  login: (label: string, command: string) => string
  /** Not installed: "<tool> not found (<detail>)" */
  missing: (label: string, detail: string) => string
}

/**
 * A tool's setup line (#59), shared by the new-session dialog, the first-run card and the new-app dialog: why the tool
 * cannot be used yet, with the action its state allows (`setupView`). `shown` off folds it away still saying what it said
 * (docs/design-system.md §9). `refusal`: a reason not about setup, said as plain text.
 */
export function ToolSetupLine({
  status,
  label,
  login,
  machine,
  shown,
  refusal,
  terminal,
  redetect,
  testId,
  className,
}: {
  status: ToolStatus | undefined
  label: string
  /** The terminal command that signs the tool in (`ToolDescriptor.login`) */
  login: string
  machine?: MachineRef | null
  shown: boolean
  refusal?: string | null
  terminal: TerminalHints
  /** Reads the list again (a linked machine's install is followed by asking; this computer's by events) */
  redetect?: () => void
  testId: string
  className: string
}) {
  const linked = !!machine
  const machineName = useMachineName(machine)
  const live = useStore((s) => s.toolSetups[status?.name ?? ''])
  // A tool the list does not know (an older linked host) gets the terminal install line, never an empty one
  const view: SetupView = refusal ? { kind: 'ready' } : status ? setupView(setupOf(status, live, linked), linked) : shown ? { kind: 'terminal_install' } : { kind: 'ready' }
  const actions = useToolSetupActions(status?.name ?? '', machine, view.kind === 'installing', redetect)

  // What it said last, kept while it fades: the render that turns `shown` off already reads a ready or another tool
  const now = { view, refusal: refusal ?? null, label, login, detail: status?.detail ?? 'not installed', machineName }
  const last = useRef(now)
  if (shown && (refusal || view.kind !== 'ready')) last.current = now
  const said = last.current

  const id = (s: string) => `${testId}-${s}`
  const row = (text: ReactNode, buttons?: ReactNode) => (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="min-w-0">{text}</span>
      {buttons}
    </span>
  )
  const failure = actions.error ? (
    <span className="mt-1 block text-danger" data-testid={id('error')}>
      {actions.error}
    </span>
  ) : null

  function body(v: SetupView): ReactNode {
    switch (v.kind) {
      case 'ready':
        return null
      case 'terminal_login':
        return terminal.login(said.label, said.login)
      case 'terminal_install':
        return terminal.missing(said.label, said.detail)
      case 'unsupported':
        return `${said.label} is not available on this system. ${v.message}`
      case 'install':
      case 'install_app_found':
        return (
          <>
            {row(
              v.kind === 'install' ? `${said.label} is not installed.` : `${said.label} is installed on ${said.machineName ?? 'this computer'}. Install Centralu's connection to it here.`,
              <Button size="sm" busy={actions.busy} onClick={() => void actions.install()} data-testid={id('install')}>
                Install
              </Button>,
            )}
            {failure}
          </>
        )
      case 'installing': {
        const fraction = v.total !== null && v.total > 0 ? v.received / v.total : null
        return (
          <>
            {row(
              <span data-testid={id('progress-text')}>
                {fraction !== null ? `Installing ${said.label}… ${Math.round(fraction * 100)}%` : `Installing ${said.label}… ${formatBytes(v.received)}`}
              </span>,
              <Button size="sm" variant="quiet" busy={actions.busy} onClick={() => void actions.cancelInstall()} data-testid={id('stop-install')}>
                Stop
              </Button>,
            )}
            <ProgressBar className="mt-1.5" label={`Installing ${said.label}`} value={fraction} testId={id('progress')} />
            {failure}
          </>
        )
      }
      case 'install_failed':
        return (
          <>
            {row(
              `Could not install ${said.label}: ${v.message}`,
              <Button size="sm" busy={actions.busy} onClick={() => void actions.install()} data-testid={id('retry-install')}>
                Retry
              </Button>,
            )}
            {failure}
          </>
        )
      case 'sign_in':
        return (
          <>
            {row(
              `${said.label} needs a Google sign-in.`,
              <Button size="sm" busy={actions.busy} onClick={() => void actions.signIn()} data-testid={id('sign-in')}>
                Sign in
              </Button>,
            )}
            {failure}
          </>
        )
      case 'signing_in':
        return (
          <>
            {row(
              'Waiting for the browser…',
              <Button size="sm" variant="quiet" busy={actions.busy} onClick={() => void actions.cancelSignIn()} data-testid={id('stop-sign-in')}>
                Stop
              </Button>,
            )}
            {failure}
          </>
        )
      case 'sign_in_failed':
        return (
          <>
            {row(
              v.reason === 'timed_out' ? 'Sign-in timed out.' : `Sign-in did not finish: ${v.message}`,
              <Button size="sm" busy={actions.busy} onClick={() => void actions.signIn()} data-testid={id('retry-sign-in')}>
                Retry
              </Button>,
            )}
            {failure}
          </>
        )
      case 'ineligible': {
        // The verification Google gave is offered first, then Sign in again; without an address only the sentence and Sign in again
        const uri = v.verifyUri
        return (
          <>
            {row(
              uri ? 'Google needs to verify this account.' : `Google did not set up ${said.label} for this account.`,
              <span className="flex shrink-0 items-center gap-2">
                {uri && (
                  <Button size="sm" onClick={() => actions.openVerify(uri)} data-testid={id('verify')}>
                    Verify account
                  </Button>
                )}
                <Button size="sm" variant="quiet" busy={actions.busy} onClick={() => void actions.signIn()} data-testid={id('sign-in')}>
                  Sign in again
                </Button>
              </span>,
            )}
            {failure}
          </>
        )
      }
      case 'sign_in_elsewhere':
        return `${said.label} needs a Google sign-in. Sign in on ${said.machineName ?? 'that machine'}.`
    }
  }

  return (
    <Fold open={shown}>
      <div className={className} data-testid={testId} data-setup={said.refusal ? 'refused' : said.view.kind} aria-live="polite">
        <div key={said.refusal ? 'refused' : said.view.kind} className="cc-setup-swap">
          {said.refusal ?? body(said.view)}
        </div>
      </div>
    </Fold>
  )
}
