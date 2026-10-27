import { setupOfDetection, type ToolSetup, type ToolStatus } from '@cc/protocol/client'

/**
 * What a tool's setup line says (#59, owner 2026-10-27): one mapping from where a tool stands to what the new-session
 * dialog, the first-run card and the new-app dialog draw, so the three never answer differently.
 *
 * `ready` draws nothing. Everything else is one line, with the action the state allows.
 */
export type SetupView =
  | { kind: 'ready' }
  /** Not installed, and the person installs it from a terminal (`ToolDescriptor.install`) */
  | { kind: 'terminal_install' }
  /** Installed, signed out, and the person signs in from a terminal (`ToolDescriptor.login`) */
  | { kind: 'terminal_login' }
  /** Centralu installs it (`agents.installTool`) */
  | { kind: 'install' }
  | { kind: 'installing'; received: number; total: number | null }
  | { kind: 'install_failed'; message: string }
  /** Google ships no build for this system: nothing to press */
  | { kind: 'unsupported'; message: string }
  | { kind: 'sign_in' }
  | { kind: 'signing_in' }
  /** The sign-in ended without success (it timed out, or failed): said, and offered again */
  | { kind: 'sign_in_failed'; reason: 'timed_out' | 'failed'; message: string }
  /** PROPOSAL (the owner has not decided its screen): Google did not set the account up, and may give an address to verify it at */
  | { kind: 'ineligible'; verifyUri: string | null }
  /** Signed out on a linked machine: the sign-in happens there, so this line only says so */
  | { kind: 'sign_in_elsewhere' }

/** The address Google gives to verify an account that is not eligible (`ToolSetup.failure.verifyUri`), when it gave one */
export function verifyUriOf(setup: ToolSetup): string | null {
  const uri = setup.failure?.verifyUri
  return uri?.startsWith('https://') ? uri : null
}

/**
 * A tool's setup as it stands: this computer's live one (a `tool_setup` event) when there is one, else the detection's
 * own, else the two booleans in the one shape. A linked machine has no live one here: its events are not this window's.
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
      return { kind: 'install' }
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

/**
 * The detection with this computer's live setups laid over it: a tool whose setup moved after the list was read (an
 * install finished, a sign-in succeeded) is usable, or not, from that moment, without asking again.
 */
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

/** The tools to draw an error donut for: installed, and the tool says it is signed out (`unknown`, OpenCode's, is not) */
export function signedOutTools(tools: readonly ToolStatus[]): ToolStatus[] {
  return tools.filter((t) => {
    const s = t.setup ?? setupOfDetection(t.installed, t.loggedIn)
    return s.state === 'signed_out' || s.state === 'signing_in'
  })
}
