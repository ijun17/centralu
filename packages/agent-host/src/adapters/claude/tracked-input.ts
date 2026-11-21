import { isNewerVersion } from '@cc/protocol'

/**
 * The first CLI whose result names every input it folded in (`user_message_uuids`): tracked notes need it (#592).
 * Measured on the installed CLI and the pinned SDK's schema.
 */
const TRACKED_INPUT_SINCE = '2.1.289'

/**
 * The first CLI known to say it read an input (`command_lifecycle` "queued" with the input's id) before the turn's init. Measured on
 * 2.1.288, 2.1.289, 2.1.296 and 2.1.316, within a second of the input even while init waits 90 s on an MCP server; older CLIs were not
 * checked, so a wait for that receipt (`TurnStartWait`) is not counted on there
 */
const INPUT_RECEIPT_SINCE = '2.1.288'

type InitMsg = { claude_code_version?: unknown; capabilities?: unknown }

/**
 * Whether the CLI that sent this init is `since` or newer. Compared as semver (`isNewerVersion`), so a suffixed version
 * (`2.1.290-beta.1`) is read, not refused; anything that does not start like a version stays unknown, and unknown is not
 */
function atLeast(m: InitMsg, since: string): boolean {
  const version = typeof m.claude_code_version === 'string' ? /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(m.claude_code_version.trim())?.[0] : undefined
  return !!version && !isNewerVersion(since, version)
}

/** Whether the CLI that sent this init message can track a parent's notes (`sendTracked`) */
export function tracksInputs(m: InitMsg): boolean {
  // The single UUID names only the first input. Older or unknown CLIs are refused before a note is recorded, not
  // guessed from results: background task notifications produce results without ids.
  return atLeast(m, TRACKED_INPUT_SINCE) && Array.isArray(m.capabilities) && m.capabilities.includes('interrupt_receipt_v1') && m.capabilities.includes('interrupt_cancel_queued_v1')
}

/** Whether the CLI that sent this init says when it read an input (`INPUT_RECEIPT_SINCE`) */
export function receiptsInputs(m: InitMsg): boolean {
  return atLeast(m, INPUT_RECEIPT_SINCE)
}
