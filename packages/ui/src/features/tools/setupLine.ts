import { setupOfDetection, type ToolSetup, type ToolStatus } from '@cc/protocol/client'

/** What a tool's setup line says (#59): one mapping, so the three places that draw it never differ. `ready` draws nothing */
export type SetupView =
  | { kind: 'ready' }
  /** `ToolDescriptor.install` */
  | { kind: 'terminal_install' }
  /** `ToolDescriptor.login` */
  | { kind: 'terminal_login' }
  /** `agents.installTool` */
  | { kind: 'install' }
  /** As `install`, for a tool whose own app is already on that machine (`ToolSetup.appFound`): only the sentence differs */
  | { kind: 'install_app_found' }
  | { kind: 'installing'; received: number; total: number | null }
  | { kind: 'install_failed'; message: string }
  /** Google ships no build for this system: nothing to press */
  | { kind: 'unsupported'; message: string }
  | { kind: 'sign_in' }
  | { kind: 'signing_in' }
  /** Said, and offered again */
  | { kind: 'sign_in_failed'; reason: 'timed_out' | 'failed'; message: string }
  /** Google did not set the account up, and may give an address to verify it at */
  | { kind: 'ineligible'; verifyUri: string | null }
  /** Signed out on a linked machine: the sign-in happens there */
  | { kind: 'sign_in_elsewhere' }

/** Google's address to verify an ineligible account, only if https */
export function verifyUriOf(setup: ToolSetup): string | null {
  const uri = setup.failure?.verifyUri
  return uri?.startsWith('https://') ? uri : null
}

/**
 * The live setup (`tool_setup` event), else the detection's, else the booleans. Never live for a linked machine: its
 * events are not this window's.
 */
export function setupOf(status: ToolStatus, live: ToolSetup | undefined, linked: boolean): ToolSetup {
  return (linked ? undefined : live) ?? status.setup ?? setupOfDetection(status.installed, status.loggedIn)
}

export function setupView(setup: ToolSetup, linked: boolean): SetupView {
  switch (setup.state) {
    case 'ready':
    case 'unknown':
      return { kind: 'ready' }
    case 'not_installed':
      if (setup.install === 'terminal') return { kind: 'terminal_install' }
      if (setup.failure?.reason === 'unsupported_platform') return { kind: 'unsupported', message: setup.failure.message }
      // A cancel is the person's own act: the line goes back to offering it, with nothing to apologise for
      if (setup.failure && setup.failure.reason !== 'cancelled') return { kind: 'install_failed', message: setup.failure.message }
      return { kind: setup.appFound ? 'install_app_found' : 'install' }
    case 'installing':
      return { kind: 'installing', received: setup.progress?.received ?? 0, total: setup.progress?.total ?? null }
    case 'signing_in':
      // A sign-in on a linked machine is that machine's own: this window can neither wait for it nor cancel it
      return linked ? { kind: 'sign_in_elsewhere' } : { kind: 'signing_in' }
    case 'signed_out':
      if (setup.signIn === 'none') return { kind: 'ready' }
      if (setup.signIn === 'terminal') return { kind: 'terminal_login' }
      if (linked) return { kind: 'sign_in_elsewhere' }
      if (setup.failure?.reason === 'ineligible') return { kind: 'ineligible', verifyUri: verifyUriOf(setup) }
      if (setup.failure?.reason === 'timed_out' || setup.failure?.reason === 'failed') {
        return { kind: 'sign_in_failed', reason: setup.failure.reason, message: setup.failure.message }
      }
      return { kind: 'sign_in' }
  }
}

/** The detection with this computer's live setups over it, so a finished install or sign-in counts without asking again */
export function withLiveSetups(tools: readonly ToolStatus[], live: Partial<Record<string, ToolSetup>>): ToolStatus[] {
  return tools.map((t) => {
    const s = live[t.name]
    if (!s) return t
    return {
      ...t,
      installed: s.state !== 'not_installed' && s.state !== 'installing',
      loggedIn: s.state === 'ready' || s.state === 'unknown',
      setup: s,
    }
  })
}

/** The states of the live setups as one string: a progress reading changes a setup but not what a list of tools may be used for */
export function setupStates(live: Partial<Record<string, ToolSetup>>): string {
  return Object.entries(live)
    .map(([tool, s]) => `${tool}:${s?.state}`)
    .join(',')
}

/** The tools to draw a signed-out donut for (`unknown`, OpenCode's, is not signed out) */
export function signedOutTools(tools: readonly ToolStatus[]): ToolStatus[] {
  return tools.filter((t) => {
    const s = t.setup ?? setupOfDetection(t.installed, t.loggedIn)
    return s.state === 'signed_out' || s.state === 'signing_in'
  })
}
