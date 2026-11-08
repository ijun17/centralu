import { instructionsFor, toolDefsFor } from '../../sessions/centralu-tools.js'
import type { CreateSessionOpts } from '../contract.js'
import { differs, type OwnAnswers } from '../frames/replay.test-helpers.js'
import { CLAUDE_SUBAGENT_TOOL, CENTRALU_MCP_NAME } from './centralu-mcp.js'

/**
 * What Centralu writes to the CLI itself, not the CLI: its server's answers to `initialize` and `tools/list`. They are made from the
 * tool definitions and instructions in this repository, so they are checked against those (the tools by name, words and parameters),
 * not against the copy a recording holds, which every change to a tool's words would outdate. The adapter's replay and the replay
 * host of the e2e scenarios both check them this way (#2133: a renamed help topic failed only the second).
 */
export function centraluAnswers(session: Partial<CreateSessionOpts>): OwnAnswers {
  const profile = session.toolProfile ?? 'assistant'
  return {
    server: CENTRALU_MCP_NAME,
    check(method, result) {
      if (method === 'initialize') return differs('the instructions', result.instructions, instructionsFor(profile, undefined, (session.apps?.current().length ?? 0) > 0, CLAUDE_SUBAGENT_TOOL), 'the code')
      const listed = Array.isArray(result.tools) ? result.tools.map((t: { name: string; description: string; inputSchema?: { properties?: object } }) => ({ name: t.name, description: t.description, parameters: Object.keys(t.inputSchema?.properties ?? {}) })) : result.tools
      return differs('the tools', listed, toolDefsFor(profile).map((t) => ({ name: t.name, description: t.description, parameters: Object.keys(t.schema.shape) })), 'the code')
    },
  }
}
