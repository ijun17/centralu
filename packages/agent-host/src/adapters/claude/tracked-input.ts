import { isNewerVersion } from '@cc/protocol'

/**
 * The first CLI whose result names every input it folded in (`user_message_uuids`): tracked notes need it (#592).
 * Measured on the installed CLI and the pinned SDK's schema.
 */
const TRACKED_INPUT_SINCE = '2.1.289'

/** Whether the CLI that sent this init message can track a parent's notes (`sendTracked`) */
export function tracksInputs(m: { claude_code_version?: unknown; capabilities?: unknown }): boolean {
  // 2.1.289's result UUID array includes inputs folded between tool rounds (verified in
  // the installed CLI and pinned SDK schema). The single UUID only names the first input.
  // Refuse older/unknown protocols before a note is recorded, rather than guessing from
  // results: background task notifications legitimately produce results without IDs.
  // Compared as semver (`isNewerVersion`), so a suffixed version (`2.1.290-beta.1`) is read, not refused;
  // anything that does not start like a version stays unknown, and unknown is refused
  const version = typeof m.claude_code_version === 'string' ? /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(m.claude_code_version.trim())?.[0] : undefined
  const supported = !!version && !isNewerVersion(TRACKED_INPUT_SINCE, version)
  return supported && Array.isArray(m.capabilities) && m.capabilities.includes('interrupt_receipt_v1') && m.capabilities.includes('interrupt_cancel_queued_v1')
}
