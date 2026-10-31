/**
 * What the Claude probes that drive one haiku turn share (`probe-background-tasks`, `probe-subagent-stream`): a
 * throwaway folder, the prompt as a streaming input that stays open until `end()`, and the `query` options. `allow`
 * says which Bash commands the probe lets through (the Agent tool is always allowed; everything else is denied).
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function openClaudeProbe(opts: { prefix: string; prompt: string; allow: RegExp; partial: boolean }) {
  const cwd = mkdtempSync(join(tmpdir(), opts.prefix))
  let open = true
  let wake: () => void = () => {}
  async function* input() {
    yield {
      type: 'user' as const,
      parent_tool_use_id: null,
      session_id: '',
      message: { role: 'user' as const, content: [{ type: 'text' as const, text: opts.prompt }] },
    }
    while (open) await new Promise<void>((r) => (wake = r))
  }
  const q = query({
    prompt: input(),
    options: {
      cwd,
      // Uses the same CLI as the app (the adapter points to the user's installed copy via whichTool('claude'))
      pathToClaudeCodeExecutable: execFileSync('which', ['claude']).toString().trim(),
      model: 'haiku',
      includePartialMessages: opts.partial,
      settingSources: [],
      permissionMode: 'default',
      canUseTool: async (name: string, input: Record<string, unknown>) => {
        if (name === 'Agent' || name === 'Task' || (name === 'Bash' && opts.allow.test(typeof input.command === 'string' ? input.command : ''))) {
          return { behavior: 'allow' as const, updatedInput: input }
        }
        return { behavior: 'deny' as const, message: 'probe: not allowed' }
      },
    },
  })
  return {
    cwd,
    q,
    end: () => {
      open = false
      wake()
    },
  }
}
