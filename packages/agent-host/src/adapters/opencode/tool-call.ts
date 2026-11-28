import { asObj, isObj } from '../../json-value.js'
import type { ToolCallFields } from '../acp/wire.js'

/**
 * OpenCode ends a shell call `completed` whatever its exit code, which it says only in `rawOutput.metadata.exit`
 * (1.19.4, `tool-error` and `interrupt-tool` recordings; #2045): 0, another code, or null when the command was stopped.
 * The call ends ok only on 0. Calls without that field (every other tool) are left as they are
 */
export function readOpenCodeCall(call: ToolCallFields): Partial<ToolCallFields> {
  const raw = call.rawOutput
  if (!isObj(raw)) return {}
  const metadata = asObj(raw.metadata)
  if (!('exit' in metadata)) return {}
  return { rawOutput: { ...raw, success: metadata.exit === 0 } }
}
